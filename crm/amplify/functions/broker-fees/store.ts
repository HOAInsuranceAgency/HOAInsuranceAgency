import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { sendCrmWrite } from '../live-write';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { batchGetComplete } from '../storage/batchGet';
import { collectCompletePages } from '../storage/pages';
import { assertTransactionEnvelope } from '../storage/transactions';
import { modelKey, resolveModelTable, storedModel } from '../storage/models';
import type { BrokerFeeAgreement, BrokerFeeRecord } from '../../../../shared/brokerFees';
export type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
export const table = () => {
  if (!process.env.BROKER_FEE_TABLE) throw new Error('Broker fee storage is not configured.');
  return process.env.BROKER_FEE_TABLE;
};
export const modelTable = (model: string) => {
  const error = () => new Error('Broker fee account storage is not configured.');
  return resolveModelTable(storedModel(model, error), { envNames: [`${model.toUpperCase()}_TABLE`], error });
};
export async function getRow<T>(id: string): Promise<T | undefined> {
  return (await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }))).Item as T | undefined;
}
export const getFee = (quoteId: string) => getRow<BrokerFeeRecord>(`fee:${quoteId}`);
export const getAgreement = (id: string) => getRow<BrokerFeeAgreement>(id);
export async function getModel<T extends Record<string, unknown>>(model: string, id: string): Promise<T | undefined> {
  return (await db.send(new GetCommand({ TableName: modelTable(model), Key: modelKey(storedModel(model, () => new Error('Broker fee account storage is not configured.')), id), ConsistentRead: true }))).Item as T | undefined;
}
export function feePut<T extends { id: string; version?: number }>(next: T, previous?: { version?: number }): Write {
  return { Put: { TableName: table(), Item: { ...next, version: (previous?.version ?? 0) + 1 }, ConditionExpression: previous ? '#v = :v' : 'attribute_not_exists(id)', ...(previous ? { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': previous.version } } : {}) } };
}
export function versionCheck(name: string, row: { id: string; version?: number; updatedAt?: unknown }): Write {
  const field = row.version == null ? 'updatedAt' : 'version', value = row[field];
  if (value == null) throw new Error('The current broker fee source version could not be verified.');
  return { ConditionCheck: { TableName: name, Key: { id: row.id }, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': field }, ExpressionAttributeValues: { ':v': value } } };
}
export async function transact(items: Write[]) {
  assertTransactionEnvelope(items, { maxBytes: 3_500_000, keyFields: name => name === table() ? ['id'] : undefined,
    error: () => new Error('This fee agreement is too large. Use a smaller package.') });
  const write = db.send(new TransactWriteCommand({ TransactItems: items }));
  if (items.some(item => item.Put || item.Update || item.Delete)) await sendCrmWrite(write); else await write;
}
/** Bounded complete reads; an unavailable payment list is never represented as empty. */
export async function accountModels<T>(model: string, accountId: string): Promise<T[]> {
  const indexes = JSON.parse(process.env.ACCESS_INDEXES ?? '{}') as Record<string, string | Record<string, string>>;
  const configured = indexes[`${model}.accountId`] ?? indexes[model], index = typeof configured === 'string' ? configured : configured?.accountId;
  return collectCompletePages<T>(async cursor => {
    const result = await db.send(new QueryCommand({ TableName: modelTable(model), IndexName: index || 'crmBy_accountId', KeyConditionExpression: 'accountId = :account', ExpressionAttributeValues: { ':account': accountId }, ExclusiveStartKey: cursor }));
    return { items: (result.Items ?? []) as T[], next: result.LastEvaluatedKey };
  }, { maxPages: 100, maxRows: 5000, error: () => new Error('The account payment list could not be loaded completely.') });
}
export async function accountFees(accountId: string): Promise<BrokerFeeRecord[]> {
  return collectCompletePages<BrokerFeeRecord>(async cursor => {
    const result = await db.send(new QueryCommand({ TableName: table(), IndexName: 'account', KeyConditionExpression: 'accountId = :account', ExpressionAttributeValues: { ':account': accountId }, ExclusiveStartKey: cursor }));
    return { items: (result.Items ?? []).filter(row => row.kind === 'FEE') as BrokerFeeRecord[], next: result.LastEvaluatedKey };
  }, { maxPages: 100, maxRows: 5000, error: () => new Error('The fee status list could not be loaded completely.') });
}

/** Index discovery selects only agreements covering this quote. Consistent
 * batches supply current signed state without one request per historical agreement. */
export async function accountAgreements(accountId: string, quoteId: string): Promise<BrokerFeeAgreement[]> {
  // Agreements contain at most 25 quotes. Filter their existing nested IDs;
  // no new index, denormalized association, or browser-owned selector is needed.
  const coversQuote = Array.from({ length: 25 }, (_, index) => `#quotes[${index}].#id = :quote`).join(' OR ');
  const ids = new Set<string>();
  await collectCompletePages<never>(async cursor => {
    const result = await db.send(new QueryCommand({
      TableName: table(), IndexName: 'account',
      KeyConditionExpression: 'accountId = :account AND begins_with(id, :agreement)',
      FilterExpression: `#kind = :kind AND (${coversQuote})`,
      ExpressionAttributeNames: { '#kind': 'kind', '#quotes': 'quotes', '#id': 'id' },
      ExpressionAttributeValues: { ':account': accountId, ':agreement': 'bfa_', ':kind': 'AGREEMENT', ':quote': quoteId },
      ProjectionExpression: 'id', Limit: 100, ExclusiveStartKey: cursor,
    }));
    for (const row of result.Items ?? []) if (typeof row.id === 'string') ids.add(row.id);
    if (ids.size > 5000) throw new Error('The signed agreement list could not be loaded completely.');
    return { items: [], next: result.LastEvaluatedKey };
  }, { maxPages: 100, error: () => new Error('The signed agreement list could not be loaded completely.') });
  const rows = await batchGetComplete<BrokerFeeAgreement>({ send: command => db.send(command), table: table(),
    keys: [...ids].map(id => ({ id })), maxKeys: 5000, attempts: 5, read: { ConsistentRead: true },
    sizeError: () => new Error('The signed agreement list could not be loaded completely.'),
    incompleteError: () => new Error('The signed agreement list could not be loaded completely.') });
  return rows.filter(row => ids.has(row.id) && row.kind === 'AGREEMENT' && row.accountId === accountId &&
    Array.isArray(row.quotes) && row.quotes.some(quote => quote.id === quoteId && quote.accountId === accountId));
}
