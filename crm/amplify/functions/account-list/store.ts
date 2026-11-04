import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { accountListSnapshotKey } from '../../../../shared/accountList';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { AUTHORIZED_QUOTE_TERM_FIELDS } from '../../../../shared/quoteAuthorization';
import { buildAccountListProjection, type ProjectionSource, type StoredAccountListSnapshot } from './projection';

type RecordData = Record<string, unknown>;
export type SourceModel = 'Account' | 'Contact' | 'Quote' | 'Policy' | 'Communication' | 'UserProfile';
export type SourceHints = Partial<Record<SourceModel, string[]>>;
export const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
export const projectionTable = () => {
  if (!process.env.ACCOUNT_LIST_TABLE) throw new Error('Account list projection is not configured');
  return process.env.ACCOUNT_LIST_TABLE;
};
export const sourceTables = () => JSON.parse(process.env.ACCOUNT_LIST_SOURCE_TABLES ?? '{}') as Record<SourceModel, string>;
const sourceIndexes = () => JSON.parse(process.env.ACCOUNT_LIST_SOURCE_INDEXES ?? '{}') as Partial<Record<SourceModel, string>>;
const table = (model: SourceModel) => {
  const name = sourceTables()[model];
  if (!name) throw new Error(`Account list source ${model} is not configured`);
  return name;
};
export async function readOne(TableName: string, Key: RecordData) {
  return (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item as RecordData | undefined;
}
const compactFields: Partial<Record<SourceModel, string[]>> = {
  Contact: ['id', 'accountId', 'name', 'email', 'isPrimary', 'validFrom', 'validUntil', 'updatedAt'],
  Quote: ['id', 'accountId', 'status', 'lines', 'commissionPct', 'offerExpiresAt', 'renewalPolicyId', 'notes', 'updatedAt', ...AUTHORIZED_QUOTE_TERM_FIELDS],
  Policy: ['id', 'accountId', 'status', 'expirationDate', 'updatedAt'],
  UserProfile: ['id', 'userId', 'firstName', 'lastName', 'email', 'updatedAt'],
};
export async function readSourceMany(model: SourceModel, ids: string[]) {
  const TableName = table(model), records = new Map<string, RecordData>(), unique = [...new Set(ids)];
  const fields = compactFields[model], names = fields ? Object.fromEntries(fields.map((field, i) => [`#f${i}`, field])) : undefined;
  const projection = names ? { ExpressionAttributeNames: names, ProjectionExpression: Object.keys(names).join(', ') } : {};
  for (let offset = 0; offset < unique.length; offset += 100) {
    let keys = unique.slice(offset, offset + 100).map(id => ({ id }));
    for (let attempt = 0; keys.length; attempt++) {
      if (attempt === 4) throw new Error('Account list source batch could not finish');
      const result = await db.send(new BatchGetCommand({ RequestItems: { [TableName]: { Keys: keys, ConsistentRead: true, ...projection } } }));
      for (const record of result.Responses?.[TableName] ?? []) records.set(String(record.id), record);
      keys = (result.UnprocessedKeys?.[TableName]?.Keys ?? []).map(key => ({ id: String(key.id) }));
      if (keys.length) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  return records;
}
/** GSI candidates never provide the authoritative child payload or parent. */
async function partitionIds(model: 'Contact' | 'Quote' | 'Policy' | 'UserProfile', field: string, value: string) {
  const IndexName = sourceIndexes()[model];
  if (!IndexName) throw new Error(`Account list ${model} index is not configured`);
  const ids: string[] = [], seen = new Set<string>();
  let cursor: RecordData | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await db.send(new QueryCommand({ TableName: table(model), IndexName, KeyConditionExpression: '#field = :value',
      ExpressionAttributeNames: { '#field': field, '#id': 'id' }, ExpressionAttributeValues: { ':value': value },
      ProjectionExpression: '#id', ExclusiveStartKey: cursor, Limit: 100 }));
    ids.push(...(result.Items ?? []).map(record => String(record.id)));
    cursor = result.LastEvaluatedKey;
    if (ids.length > 5000) throw new Error('Account list source partition is too large');
    if (!cursor) return ids;
    const token = JSON.stringify(cursor);
    if (seen.has(token) || ids.length > 5000) throw new Error('Account list source partition could not finish');
    seen.add(token);
  }
  throw new Error('Account list source partition is too large');
}
export async function readProjectionSource(accountId: string, hints: SourceHints = {}): Promise<ProjectionSource> {
  const child = async (model: 'Contact' | 'Quote' | 'Policy') => {
    const ids = await partitionIds(model, 'accountId', accountId);
    const current = await readSourceMany(model, [...ids, ...hints[model] ?? []]);
    return [...current.values()].filter(record => record.accountId === accountId);
  };
  const [account, contacts, quotes, policies, communication] = await Promise.all([
    readOne(table('Account'), { id: accountId }), child('Contact'), child('Quote'), child('Policy'),
    readSourceMany('Communication', [`workflow:${accountId}`, `commercial:${accountId}`, `lead-snooze:${accountId}`, `deleted-account:${accountId}`]),
  ]);
  const salespersonId = (communication.get(`workflow:${accountId}`)?.data as RecordData | undefined)?.salespersonId;
  let profile: RecordData | undefined;
  if (typeof salespersonId === 'string' && salespersonId) {
    const [eligibility, profiles] = await Promise.all([
      readSourceMany('Communication', [`eligibility:${salespersonId}`]),
      partitionIds('UserProfile', 'userId', salespersonId).then(ids => readSourceMany('UserProfile', [...ids, ...hints.UserProfile ?? []])),
    ]);
    for (const [id, row] of eligibility) communication.set(id, row);
    profile = [...profiles.values()].filter(row => row.userId === salespersonId).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  }
  return { account, contacts, quotes, policies, communication, profile };
}

/** One worker invocation owns a projection at a time. Commit every new index
 * and its snapshot pointer atomically; obsolete keys may then be cleaned up.
 * A retry reads current sources and cannot revive a previous assignment. */
export async function projectAccount(accountId: string, today: string, builtAt: string, hints: SourceHints = {}) {
  const TableName = projectionTable(), key = accountListSnapshotKey(accountId);
  const [oldRaw, source] = await Promise.all([readOne(TableName, key), readProjectionSource(accountId, hints)]);
  const old = oldRaw as unknown as StoredAccountListSnapshot | undefined;
  const projection = buildAccountListProjection(accountId, source, today, builtAt);
  const keyToken = (key: { pk: string; sk: string }) => JSON.stringify([key.pk, key.sk]);
  const clean = async (keys: { pk: string; sk: string }[]) => {
    const unique = [...new Map(keys.map(key => [keyToken(key), key])).values()];
    for (let offset = 0; offset < unique.length; offset += 100) await db.send(new TransactWriteCommand({
      TransactItems: unique.slice(offset, offset + 100).map(Key => ({ Delete: { TableName, Key } })),
    }));
  };
  if (!projection) {
    if (old) {
      // Retain the snapshot's cleanup journal until all keys are deleted, so
      // an interrupted removal can finish on the next source event/sweep.
      await clean([...old.indexKeys, ...old.obsoleteKeys ?? []]);
      await db.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName, Key: key } }] }));
    }
    return { changed: !!old, removed: !!old };
  }
  const nextKeys = new Set(projection.snapshot.indexKeys.map(keyToken));
  const obsolete = [...old?.indexKeys ?? [], ...old?.obsoleteKeys ?? []].filter(key => !nextKeys.has(keyToken(key)));
  const changed = old?.generation !== projection.snapshot.generation;
  if (changed) {
    projection.snapshot.obsoleteKeys = [...new Map(obsolete.map(key => [keyToken(key), key])).values()];
    await db.send(new TransactWriteCommand({ TransactItems: [
      ...projection.indexes.map(Item => ({ Put: { TableName, Item } })),
      { Put: { TableName, Item: projection.snapshot } },
    ] }));
  }
  const cleanup = changed ? obsolete : old?.obsoleteKeys ?? [];
  if (cleanup.length) {
    await clean(cleanup);
    await db.send(new UpdateCommand({ TableName, Key: key, UpdateExpression: 'REMOVE obsoleteKeys',
      ConditionExpression: 'generation = :generation', ExpressionAttributeValues: { ':generation': projection.snapshot.generation } }));
  }
  return { changed, removed: false };
}

interface NameRefresh { pk: 'FANOUT'; sk: string; cursor?: RecordData; nextCursor?: RecordData; pendingIds?: string[]; profileIds: string[] }
export async function queueNameRefresh(userId: string, profileIds: string[] = []) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new Error('Invalid account list teammate');
  await db.send(new PutCommand({ TableName: projectionTable(), Item: { pk: 'FANOUT', sk: userId, profileIds: [...new Set(profileIds)] } }));
}
/** Re-check each bounded discovery page against current assignment records. */
async function assignmentPage(userId: string, cursor?: RecordData) {
  const result = await db.send(new QueryCommand({ TableName: table('Communication'), IndexName: 'assignment',
    KeyConditionExpression: '#owner = :owner', ExpressionAttributeNames: { '#owner': 'assignedSalespersonId', '#id': 'id' },
    ExpressionAttributeValues: { ':owner': userId }, ProjectionExpression: '#id', ExclusiveStartKey: cursor, Limit: 25 }));
  const rows = await readSourceMany('Communication', (result.Items ?? []).map(row => String(row.id)));
  const ids = [...rows.values()].flatMap(row => {
    const data = row.data as RecordData | undefined;
    return row.kind === 'WORKFLOW' && data?.salespersonId === userId && typeof data.accountId === 'string' ? [data.accountId] : [];
  });
  return { ids: [...new Set(ids)], cursor: result.LastEvaluatedKey };
}
/** One short scheduled slice advances large rename fan-outs. Partial pages
 * survive a budget cutoff, and repeated source changes restart discovery. */
export async function drainNameRefresh(options: { budgetMs?: number; maxPages?: number } = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 10_000);
  for (let page = 0; page < (options.maxPages ?? 20) && Date.now() < deadline; page++) {
    const next = await db.send(new QueryCommand({ TableName: projectionTable(), ConsistentRead: true,
      KeyConditionExpression: 'pk = :kind', ExpressionAttributeValues: { ':kind': 'FANOUT' }, Limit: 1 }));
    let job = next.Items?.[0] as NameRefresh | undefined;
    if (!job) return;
    if (!job.pendingIds) {
      const found = await assignmentPage(job.sk, job.cursor);
      job = { ...job, pendingIds: found.ids, nextCursor: found.cursor };
    }
    const ids = job.pendingIds!;
    for (let offset = 0; offset < ids.length; offset += 4) {
      if (Date.now() >= deadline) return;
      const group = ids.slice(offset, offset + 4);
      const results = await Promise.allSettled(group.map(id => projectAccount(id, agencyDay(new Date().toISOString()), new Date().toISOString(), { UserProfile: job!.profileIds })));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      job = { ...job, pendingIds: ids.slice(offset + group.length) };
      await db.send(new PutCommand({ TableName: projectionTable(), Item: job }));
    }
    if (job.nextCursor) await db.send(new PutCommand({ TableName: projectionTable(), Item: { pk: 'FANOUT', sk: job.sk, profileIds: job.profileIds, cursor: job.nextCursor } }));
    else await db.send(new DeleteCommand({ TableName: projectionTable(), Key: { pk: 'FANOUT', sk: job.sk } }));
  }
}
export async function writeControl(sk: string, fields: RecordData) {
  await db.send(new PutCommand({ TableName: projectionTable(), Item: { pk: 'CONTROL', sk, ...fields } }));
}
