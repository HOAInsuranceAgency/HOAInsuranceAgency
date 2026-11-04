import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
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

/** Index discovery selects only agreements covering this quote. Consistent
 * batches supply current signed state without one request per historical agreement. */
export async function accountAgreements(accountId: string, quoteId: string): Promise<BrokerFeeAgreement[]> {
  // Agreements contain at most 25 quotes. Filter their existing nested IDs;
  // no new index, denormalized association, or browser-owned selector is needed.
  const coversQuote = Array.from({ length: 25 }, (_, index) => `#quotes[${index}].#id = :quote`).join(' OR ');
  const ids = new Set<string>(); let cursor: Record<string, unknown> | undefined;
  for (let page = 0; page < 100; page++) {
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
    cursor = result.LastEvaluatedKey;
    if (!cursor) {
      const agreements: BrokerFeeAgreement[] = [], keys = [...ids];
      const name=table();
      for (let offset = 0; offset < keys.length; offset += 100) {
        let pending=keys.slice(offset,offset+100).map(id=>({id}));
        const requested=new Set(pending.map(key=>key.id));
        for(let attempt=0;pending.length&&attempt<5;attempt++){
          const result=await db.send(new BatchGetCommand({RequestItems:{[name]:{Keys:pending,ConsistentRead:true}}}));
          agreements.push(...(result.Responses?.[name]??[]).filter((row):row is BrokerFeeAgreement=>
            requested.has(row.id) && row.kind==='AGREEMENT' && row.accountId===accountId &&
            Array.isArray(row.quotes) && row.quotes.some(quote=>quote.id===quoteId && quote.accountId===accountId)));
          pending=(result.UnprocessedKeys?.[name]?.Keys??[]).map(key=>({id:String(key.id)}));
          if(pending.length&&attempt<4)await new Promise(resolve=>setTimeout(resolve,Math.min(25*2**attempt,200)));
        }
        if(pending.length)throw new Error('The signed agreement list could not be loaded completely.');
      }
      return agreements;
    }
  }
  throw new Error('The signed agreement list could not be loaded completely.');
}
