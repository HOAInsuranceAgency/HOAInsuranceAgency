import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db } from './store';

const WINDOW_MS = 30 * 86_400_000;
function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** One indexed page in a fixed reporting window. Existing model metadata is
 * backfilled by DynamoDB; callers never fall back to a historical table scan. */
export async function reportDatePage(options: {
  table: string; index: string; type: string; dateField: string; fields: readonly string[];
  from: unknown; to: unknown; nextToken?: unknown;
}) {
  const { table, index, type, dateField, fields, from, to, nextToken } = options;
  if (!table || !index) throw new Error('Dashboard storage is not configured');
  if (!iso(from) || !iso(to) || from > to || Date.parse(to) - Date.parse(from) > WINDOW_MS) throw new Error('Choose a report window of up to 30 days');
  const key = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report page token');
    const row = value as Record<string, unknown>, date = row[dateField];
    if (Object.keys(row).length !== 3 || typeof row.id !== 'string' || !row.id || row.id.length > 200 || row.__typename !== type || !iso(date) || date < from || date > to) throw new Error('Invalid report page token');
    return { id: row.id, __typename: type, [dateField]: date };
  };
  let cursor: ReturnType<typeof key> | undefined;
  if (nextToken != null) {
    if (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4000) throw new Error('Invalid report page token');
    try {
      const page = JSON.parse(Buffer.from(nextToken, 'base64url').toString());
      if (page.version !== 1 || page.type !== type || page.dateField !== dateField || page.from !== from || page.to !== to) throw new Error();
      cursor = key(page.key);
    } catch { throw new Error('Invalid report page token'); }
  }
  const names: Record<string, string> = { '#type': '__typename', '#date': dateField };
  const projection = [...new Set(['id', dateField, ...fields])].map((field, i) => {
    if (field === dateField) return '#date';
    const alias = `#p${i}`; names[alias] = field; return alias;
  }).join(', ');
  const result = await db.send(new QueryCommand({
    TableName: table, IndexName: index,
    KeyConditionExpression: '#type = :type AND #date BETWEEN :from AND :to',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ':type': type, ':from': from, ':to': to },
    ProjectionExpression: projection, ExclusiveStartKey: cursor, Limit: 500, ScanIndexForward: true,
  }));
  const items = result.Items ?? [];
  for (const item of items) if (typeof item.id !== 'string' || !iso(item[dateField]) || item[dateField] < from || item[dateField] > to) throw new Error('Report rows are incomplete; refresh to try again');
  const last = result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length ? key(result.LastEvaluatedKey) : undefined;
  return { items, nextToken: last ? Buffer.from(JSON.stringify({ version: 1, type, dateField, from, to, key: last })).toString('base64url') : undefined };
}
