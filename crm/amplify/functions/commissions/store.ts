import { randomUUID } from 'node:crypto';
import { sendCommissionWrite } from '../live-write';
import { batchGetComplete } from '../storage/batchGet';
import { collectCompletePages } from '../storage/pages';
import { assertTransactionEnvelope } from '../storage/transactions';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
export type Data = Record<string, unknown>;
export type Change = {
  kind: string;
  value: Data & { id: string; version?: number };
  previous?: Data;
};
export type Transaction = NonNullable<TransactWriteCommandInput['TransactItems']>;
export const db = DynamoDBDocumentClient.from(new DynamoDBClient(), {
  marshallOptions: { removeUndefinedValues: true },
});
export const table = () => {
  if (!process.env.COMMISSION_TABLE) throw new Error('Commission storage is not configured.');
  return process.env.COMMISSION_TABLE;
};
export async function get<T>(kind: string, id: string): Promise<T | undefined> {
  return (
    await db.send(new GetCommand({ TableName: table(), Key: { kind, id }, ConsistentRead: true }))
  ).Item as T | undefined;
}
/** Consistent, bounded batches; never return partial financial records on throttling. */
export async function getMany<T>(refs: { kind: string; id: string }[]): Promise<T[]> {
  const keys = [
    ...new Map(
      refs.map((r) => [JSON.stringify([r.kind, r.id]), { kind: r.kind, id: r.id }]),
    ).values(),
  ];
  if (keys.length > 5000) throw new Error('Too many commission records for one request.');
  return batchGetComplete<T>({ send: command => db.send(command), table: table(), keys, maxKeys: 5000, attempts: 5,
    read: { ConsistentRead: true }, sizeError: () => new Error('Too many commission records for one request.'),
    incompleteError: () => new Error('Commission records could not be completely loaded. Retry before proceeding.') });
}
export async function list<T>(kind: string, producer = false, recordKind?: string): Promise<T[]> {
  return collectCompletePages<T>(async cursor => {
    const response = await db.send(
      new QueryCommand({
        TableName: table(),
        ...(producer ? { IndexName: 'producer' } : { ConsistentRead: true }),
        KeyConditionExpression: '#key = :value',
        ExpressionAttributeNames: {
          '#key': producer ? 'producerId' : 'kind',
          ...(recordKind ? { '#kind': 'kind' } : {}),
        },
        ExpressionAttributeValues: {
          ':value': kind,
          ...(recordKind ? { ':kind': recordKind } : {}),
        },
        ...(recordKind ? { FilterExpression: '#kind = :kind' } : {}),
        ExclusiveStartKey: cursor,
        Limit: 100,
      }),
    );
    return { items: (response.Items ?? []) as T[], next: response.LastEvaluatedKey };
  }, { maxPages: 100, maxRows: 5000,
    sizeError: () => new Error('Commission history exceeds this view’s limit. Narrow or archive the reporting scope before proceeding.'),
    error: () => new Error('Commission history could not be completely loaded. No partial totals are available.') });
}
export async function commit(changes: Change[], actor: string, extras: Transaction = []) {
  const at = new Date().toISOString();
  const items: Transaction = changes.map((c) => ({
    Put: {
      TableName: table(),
      Item: {
        ...c.value,
        kind: c.kind,
        version: ((c.previous?.version as number) ?? 0) + 1,
        updatedAt: at,
        updatedBy: actor,
      },
      ConditionExpression: c.previous ? '#v = :v' : 'attribute_not_exists(id)',
      ...(c.previous
        ? {
            ExpressionAttributeNames: { '#v': 'version' },
            ExpressionAttributeValues: { ':v': c.previous.version },
          }
        : {}),
    },
  }));
  // Private audit: changes and history commit together; shared Activity gets no pay data.
  items.push(
    {
      Put: {
        TableName: table(),
        Item: {
          kind: 'AUDIT',
          id: `audit#${at}#${randomUUID()}`,
          actor,
          at,
          changes: changes.map((c) => ({
            kind: c.kind,
            id: c.value.id,
            previousVersion: c.previous?.version ?? 0,
            newVersion: ((c.previous?.version as number) ?? 0) + 1,
            value:
              c.kind === 'POLICY'
                ? {
                    ...c.value,
                    entries: undefined,
                    entryIds: (c.value.entries as { id: string }[]).map((e) => e.id),
                  }
                : (c.kind === 'PAYROLL_REPORT_FILE' || c.kind === 'DEPARTURE_REPORT') ? { ...c.value, content: undefined }
                : c.kind === 'PAYROLL_REPORT' ? { contentHash: c.value.contentHash, cycleId: (c.value.cycle as Data).id, revision: (c.value.cycle as Data).revision, documents: c.value.documents }
                : c.value,
          })),
        },
      },
    },
    ...extras,
  );
  assertTransactionEnvelope(items, { maxBytes: 3_500_000, maxItemBytes: 300_000, keyFields: name => name === table() ? ['kind', 'id'] : undefined,
    error: () => new Error('This operation is too large. Use a smaller statement or payroll batch.') });
  const producers = changes.flatMap(change => [change.value.producerId, change.previous?.producerId])
    .filter((id): id is string => typeof id === 'string' && !!id);
  await sendCommissionWrite(db.send(new TransactWriteCommand({ TransactItems: items })), producers);
}
export async function auditPage(token?: unknown) {
  let cursor: Data | undefined;
  let legacy = false;
  if (token !== undefined) {
    if (typeof token !== 'string' || token.length > 1000) throw new Error('Invalid audit page.');
    let page: { phase?: string; key?: Data };
    try { page = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw new Error('Invalid audit page.'); }
    if (!page || !['current','legacy'].includes(page.phase ?? '') || Object.keys(page).some(k => !['phase','key'].includes(k))) throw new Error('Invalid audit page.');
    legacy = page.phase === 'legacy'; cursor = page.key;
    if (cursor && (cursor.kind !== 'AUDIT' || typeof cursor.id !== 'string' || Object.keys(cursor).length !== 2)) throw new Error('Invalid audit page.');
  }
  const result = await db.send(new QueryCommand({ TableName: table(), ConsistentRead: true,
    KeyConditionExpression: legacy ? '#kind = :kind' : '#kind = :kind AND begins_with(id, :prefix)', ExpressionAttributeNames: { '#kind': 'kind' },
    ExpressionAttributeValues: { ':kind': 'AUDIT', ':prefix': 'audit#' }, ...(legacy ? { FilterExpression: 'NOT begins_with(id, :prefix)' } : {}), ScanIndexForward: false, Limit: 25, ExclusiveStartKey: cursor }));
  const next = result.LastEvaluatedKey ? { phase: legacy ? 'legacy' : 'current', key: result.LastEvaluatedKey } : legacy ? undefined : { phase: 'legacy' };
  return { entries: result.Items ?? [], legacy, cursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : undefined };
}
