import { randomUUID } from 'node:crypto';
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
export async function list<T>(kind: string, producer = false): Promise<T[]> {
  let cursor: Data | undefined;
  const result: T[] = [],
    seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const response = await db.send(
      new QueryCommand({
        TableName: table(),
        ...(producer ? { IndexName: 'producer' } : { ConsistentRead: true }),
        KeyConditionExpression: '#key = :value',
        ExpressionAttributeNames: { '#key': producer ? 'producerId' : 'kind' },
        ExpressionAttributeValues: { ':value': kind },
        ExclusiveStartKey: cursor,
        Limit: 100,
      }),
    );
    result.push(...((response.Items as T[]) ?? []));
    if (result.length > 5000)
      throw new Error(
        'Commission history exceeds this view’s limit. Narrow or archive the reporting scope before proceeding.',
      );
    cursor = response.LastEvaluatedKey;
    if (!cursor) return result;
    const token = JSON.stringify(cursor);
    if (seen.has(token)) break;
    seen.add(token);
  }
  throw new Error(
    'Commission history could not be completely loaded. No partial totals are available.',
  );
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
          id: randomUUID(),
          actor,
          at,
          changes: changes.map((c) => ({
            kind: c.kind,
            id: c.value.id,
            previousVersion: c.previous?.version ?? 0,
            value:
              c.kind === 'POLICY'
                ? {
                    ...c.value,
                    entries: undefined,
                    entryIds: (c.value.entries as { id: string }[]).map((e) => e.id),
                  }
                : c.value,
          })),
        },
      },
    },
    ...extras,
  );
  if (
    items.length > 100 ||
    JSON.stringify(items).length > 3_500_000 ||
    items.some((item) => Buffer.byteLength(JSON.stringify(item), 'utf8') > 300_000)
  )
    throw new Error('This operation is too large. Use a smaller statement or payroll batch.');
  await db.send(new TransactWriteCommand({ TransactItems: items }));
}
