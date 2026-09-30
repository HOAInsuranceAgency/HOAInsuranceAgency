import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { db } from './store';

/** Report joins use projected, bounded batches; throttled keys are retried,
 * never mistaken for missing records. Callers supply fixed field allowlists. */
export async function reportBatchGet(tableName: string, ids: string[], fields: string[]) {
  if (!tableName) throw new Error('Dashboard storage is not configured');
  const keys = [...new Set(ids)];
  if (keys.length > 500) throw new Error('Choose up to 500 report records');
  const found = new Map<string, Record<string, unknown>>();
  const names: Record<string, string> = {};
  const projection = [...new Set(['id', ...fields])].map(field => field.split('.').map(part => {
    const existing = Object.keys(names).find(key => names[key] === part);
    const key = existing ?? `#f${Object.keys(names).length}`;
    names[key] = part;
    return key;
  }).join('.')).join(', ');
  for (let start = 0; start < keys.length; start += 400) {
    const batchResults = await Promise.allSettled(Array.from({ length: Math.ceil(Math.min(400, keys.length - start) / 100) }, async (_, offset) => {
      let pending = keys.slice(start + offset * 100, start + (offset + 1) * 100).map(id => ({ id }));
      for (let attempt = 0; pending.length; attempt++) {
        const result = await db.send(new BatchGetCommand({ RequestItems: { [tableName]: {
          Keys: pending, ConsistentRead: true, ProjectionExpression: projection, ExpressionAttributeNames: names,
        } } }));
        for (const record of result.Responses?.[tableName] ?? []) found.set(record.id, record);
        pending = (result.UnprocessedKeys?.[tableName]?.Keys ?? []).map(key => ({ id: String(key.id) }));
        if (pending.length) {
          if (attempt === 3) throw new Error('Report details are incomplete. Refresh to try again.');
          await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
    }));
    const failure = batchResults.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  return found;
}

export function reportIds(value: unknown, max = 500): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
    throw new Error(`Choose up to ${max} valid report records`);
  }
  return [...new Set(value)] as string[];
}
