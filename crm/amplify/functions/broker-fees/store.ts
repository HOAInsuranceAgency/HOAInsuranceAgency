import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { BrokerFeeAgreement, BrokerFeeRecord } from '../../../../shared/brokerFees';
export type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
export const table = () => {
  if (!process.env.BROKER_FEE_TABLE) throw new Error('Broker fee storage is not configured.');
  return process.env.BROKER_FEE_TABLE;
};
export const modelTable = (model: string) => {
  const explicit = JSON.parse(process.env.ACCESS_TABLES ?? '{}') as Record<string, string>;
  const name = model === 'Communication' ? process.env.COMMUNICATION_TABLE : explicit[model] ?? process.env[`${model.toUpperCase()}_TABLE`] ?? (process.env.ACCESS_API_ID && `${model}-${process.env.ACCESS_API_ID}-NONE`);
  if (!name) throw new Error('Broker fee account storage is not configured.');
  return name;
};
export async function getRow<T>(id: string): Promise<T | undefined> {
  return (await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }))).Item as T | undefined;
}
export const getFee = (quoteId: string) => getRow<BrokerFeeRecord>(`fee:${quoteId}`);
export const getAgreement = (id: string) => getRow<BrokerFeeAgreement>(id);
export async function getModel<T extends Record<string, unknown>>(model: string, id: string): Promise<T | undefined> {
  return (await db.send(new GetCommand({ TableName: modelTable(model), Key: { id }, ConsistentRead: true }))).Item as T | undefined;
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
  if (items.length > 100 || Buffer.byteLength(JSON.stringify(items)) > 3_500_000) throw new Error('This fee agreement is too large. Use a smaller package.');
  await db.send(new TransactWriteCommand({ TransactItems: items }));
}
/** Bounded complete reads; an unavailable payment list is never represented as empty. */
export async function accountModels<T>(model: string, accountId: string): Promise<T[]> {
  const output: T[] = []; let cursor: Record<string, unknown> | undefined;
  const indexes = JSON.parse(process.env.ACCESS_INDEXES ?? '{}') as Record<string, string | Record<string, string>>;
  const configured = indexes[`${model}.accountId`] ?? indexes[model], index = typeof configured === 'string' ? configured : configured?.accountId;
  for (let page = 0; page < 100; page++) {
    const result = await db.send(new QueryCommand({ TableName: modelTable(model), IndexName: index || 'crmBy_accountId', KeyConditionExpression: 'accountId = :account', ExpressionAttributeValues: { ':account': accountId }, ExclusiveStartKey: cursor }));
    output.push(...(result.Items ?? []) as T[]); if (output.length > 5000) throw new Error('The account payment list could not be loaded completely.');
    cursor = result.LastEvaluatedKey; if (!cursor) return output;
  }
  throw new Error('The account payment list could not be loaded completely.');
}
export async function accountFees(accountId: string): Promise<BrokerFeeRecord[]> {
  const output: BrokerFeeRecord[] = []; let cursor: Record<string, unknown> | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await db.send(new QueryCommand({ TableName: table(), IndexName: 'account', KeyConditionExpression: 'accountId = :account', ExpressionAttributeValues: { ':account': accountId }, ExclusiveStartKey: cursor }));
    output.push(...(result.Items ?? []).filter(row => row.kind === 'FEE') as BrokerFeeRecord[]);
    if (output.length > 5000) throw new Error('The fee status list could not be loaded completely.');
    cursor = result.LastEvaluatedKey; if (!cursor) return output;
  }
  throw new Error('The fee status list could not be loaded completely.');
}
