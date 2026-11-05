import { db } from './store';
import { batchGetComplete } from '../storage/batchGet';

/** Report joins use projected, bounded batches; throttled keys are retried,
 * never mistaken for missing records. Callers supply fixed field allowlists. */
export async function reportBatchGet(tableName: string, ids: string[], fields: string[]) {
  if (!tableName) throw new Error('Dashboard storage is not configured');
  const keys = [...new Set(ids)];
  if (keys.length > 500) throw new Error('Choose up to 500 report records');
  const names: Record<string, string> = {};
  const projection = [...new Set(['id', ...fields])].map(field => field.split('.').map(part => {
    const existing = Object.keys(names).find(key => names[key] === part);
    const key = existing ?? `#f${Object.keys(names).length}`;
    names[key] = part;
    return key;
  }).join('.')).join(', ');
  const rows = await batchGetComplete<Record<string, unknown>>({ send: command => db.send(command), table: tableName,
    keys: keys.map(id => ({ id })), maxKeys: 500, attempts: 4, concurrency: 4,
    read: { ConsistentRead: true, ProjectionExpression: projection, ExpressionAttributeNames: names },
    sizeError: () => new Error('Choose up to 500 report records'),
    incompleteError: () => new Error('Report details are incomplete. Refresh to try again.') });
  return new Map(rows.map(record => [String(record.id), record]));
}

export function reportIds(value: unknown, max = 500): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
    throw new Error(`Choose up to ${max} valid report records`);
  }
  return [...new Set(value)] as string[];
}
