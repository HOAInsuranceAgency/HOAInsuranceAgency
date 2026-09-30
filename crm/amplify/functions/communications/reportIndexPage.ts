import { createHash } from 'node:crypto';
import { ExecuteStatementCommand } from '@aws-sdk/lib-dynamodb';
import { db } from './store';
import { reportIds } from './dashboardStore';

export interface ReportIndexPageOptions {
  table: string;
  index: string;
  partition: string;
  fields: readonly string[] | '*';
  values: readonly string[];
  nextToken?: unknown;
  /** Evaluated rows per API response, 1–500; use a smaller page for full rows. */
  pageSize?: number;
}

/** PartiQL IN on an index partition key reads several item collections in
 * one request. Values are parameters; callers supply fixed index/projection
 * definitions, and IAM disallows full scans. No per-record GraphQL hydration.
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ql-reference.select.html */
export async function reportIndexPage(options: ReportIndexPageOptions) {
  const { table, index, partition, fields, nextToken, pageSize = 500 } = options;
  const values = reportIds(options.values, 25).sort();
  if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(table) || !/^[a-zA-Z0-9_.-]{3,255}$/.test(index) ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(partition) ||
    fields !== '*' && (!Array.isArray(fields) || !fields.length || fields.length > 100 || fields.some(field => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)))) {
    throw new Error('Dashboard index read is not configured');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('Choose a report page size from 1 to 500');
  const projection = fields === '*' ? '*' : [...new Set(fields)].sort().map(field => `"${field}"`).join(', ');
  const scope = createHash('sha256').update(JSON.stringify({ table, index, partition, projection, values, pageSize })).digest('hex');
  let cursor: string | undefined;
  if (nextToken != null) {
    if (typeof nextToken !== 'string' || !nextToken || nextToken.length > 50_000) throw new Error('Invalid report page token');
    try {
      const parsed = JSON.parse(Buffer.from(nextToken, 'base64url').toString());
      if (parsed.version !== 1 || parsed.scope !== scope || typeof parsed.cursor !== 'string' || !parsed.cursor || parsed.cursor.length > 32_768) throw new Error();
      cursor = parsed.cursor;
    } catch { throw new Error('Invalid report page token'); }
  }
  if (!values.length) {
    if (cursor) throw new Error('Invalid report page token');
    return { items: [] as Record<string, unknown>[], nextToken: undefined };
  }
  const result = await db.send(new ExecuteStatementCommand({
    Statement: `SELECT ${projection} FROM "${table}"."${index}" WHERE "${partition}" IN [${values.map(() => '?').join(', ')}]`,
    Parameters: values,
    Limit: pageSize,
    ...(cursor ? { NextToken: cursor } : {}),
  }));
  // ExecuteStatement exposes NextToken as its continuation input. Do not
  // quietly call a key-only/truncated response a complete financial report.
  if (result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length && !result.NextToken) {
    throw new Error('Report rows are incomplete. Refresh to try again.');
  }
  if (result.NextToken && (result.NextToken.length > 32_768 || result.NextToken === cursor)) {
    throw new Error('Report pages did not advance. Refresh to try again.');
  }
  return {
    items: (result.Items ?? []) as Record<string, unknown>[],
    nextToken: result.NextToken
      ? Buffer.from(JSON.stringify({ version: 1, scope, cursor: result.NextToken })).toString('base64url') : undefined,
  };
}
