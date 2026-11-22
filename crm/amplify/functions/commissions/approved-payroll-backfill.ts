import {
  GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { APPROVED_PAYROLL_INDEX_STATE, APPROVED_PAYROLL_KIND } from './payroll-index';

type Client = Pick<DynamoDBDocumentClient, 'send'>;

/** Only the approval ID is projected. A concurrent payment or cancellation owns its removal. */
async function indexApproval(db: Client, table: string, id: string, version: number) {
  const key = { kind: 'PAYROLL_CYCLE', id };
  for (let attempt = 0; ; attempt++) {
    try {
      await db.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: table, Key: key,
          ConditionExpression: '#version = :version AND #status = :approved',
          ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
          ExpressionAttributeValues: { ':version': version, ':approved': 'APPROVED' } } },
        { Put: { TableName: table, Item: { kind: APPROVED_PAYROLL_KIND, id } } },
      ] }));
      return;
    } catch (error) {
      if ((error as Error).name !== 'TransactionCanceledException' || attempt >= 4) throw error;
      const { Item } = await db.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      if (Item?.status !== 'APPROVED') return;
      version = sourceVersion(Item.version);
    }
  }
}

function sourceVersion(version: unknown): number {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('An approved payroll cycle has an invalid source version.');
  }
  return version;
}

/** Run after deploying the writers that atomically maintain approval references. Safe to restart. */
export async function backfillApprovedPayroll(db: Client, table: string, apply = false) {
  const marker = { kind: 'INDEX_STATE', id: APPROVED_PAYROLL_INDEX_STATE };
  const isReady = async () => Boolean((await db.send(
    new GetCommand({ TableName: table, Key: marker, ConsistentRead: true }),
  )).Item);
  if (await isReady()) return { ready: true, examined: 0, approved: 0, applied: false };
  let examined = 0, approved = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new QueryCommand({
      TableName: table, ConsistentRead: true,
      KeyConditionExpression: '#kind = :cycle', FilterExpression: '#status = :approved',
      ProjectionExpression: '#id, #version',
      ExpressionAttributeNames: { '#kind': 'kind', '#status': 'status', '#id': 'id', '#version': 'version' },
      ExpressionAttributeValues: { ':cycle': 'PAYROLL_CYCLE', ':approved': 'APPROVED' },
      ExclusiveStartKey: cursor, Limit: 100,
    }));
    examined += page.ScannedCount ?? 0;
    for (const row of page.Items ?? []) {
      if (typeof row.id !== 'string' || !row.id) throw new Error('An approved payroll cycle is missing its ID.');
      const version = sourceVersion(row.version);
      approved++;
      if (apply) await indexApproval(db, table, row.id, version);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  if (apply) {
    try {
      await db.send(new PutCommand({
        TableName: table, Item: { ...marker, version: 1, completedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(id)',
      }));
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException' || !await isReady()) throw error;
    }
  }
  return { ready: apply, examined, approved, applied: apply };
}
