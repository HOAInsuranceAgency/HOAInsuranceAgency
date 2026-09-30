import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db } from './store';
import { reportBatchGet, reportIds } from './dashboardStore';

const WINDOW_MS = 30 * 86_400_000;
const TYPE = 'PfLoanPayment';
function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function configured(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Dashboard finance storage is not configured');
  return value;
}
type PaymentKey = { id: string; __typename: string; postedAt: string };
function paymentKey(value: unknown, from: string, to: string): PaymentKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid finance page token');
  const key = value as Record<string, unknown>;
  if (Object.keys(key).length !== 3 || typeof key.id !== 'string' || !key.id || key.id.length > 200 ||
    key.__typename !== TYPE || !iso(key.postedAt) || key.postedAt < from || key.postedAt > to) {
    throw new Error('Invalid finance page token');
  }
  return { id: key.id, __typename: TYPE, postedAt: key.postedAt };
}

/** The caller enforces ADMIN. Query the automatically backfilled index over
 * existing __typename/postedAt attributes, with one bounded page per request.
 * Never substitute a Scan if the index is unavailable: a partial recent-income
 * report would look complete, while a full-history fallback defeats its bound. */
export async function dashboardInterestPage(input: Record<string, unknown>) {
  const { from, to, nextToken } = input;
  if (!iso(from) || !iso(to) || from > to || Date.parse(to) - Date.parse(from) > WINDOW_MS) {
    throw new Error('Choose a finance window of up to 30 days');
  }
  let cursor: PaymentKey | undefined;
  if (nextToken != null) {
    if (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4000) throw new Error('Invalid finance page token');
    try {
      const page = JSON.parse(Buffer.from(nextToken, 'base64url').toString()) as Record<string, unknown>;
      if (page.version !== 1 || page.from !== from || page.to !== to) throw new Error();
      cursor = paymentKey(page.key, from, to);
    } catch { throw new Error('Invalid finance page token'); }
  }
  const result = await db.send(new QueryCommand({
    TableName: configured('DASHBOARD_PAYMENT_TABLE'),
    IndexName: configured('DASHBOARD_PAYMENT_INDEX'),
    KeyConditionExpression: '#type = :type AND #posted BETWEEN :from AND :to',
    ExpressionAttributeNames: { '#type': '__typename', '#posted': 'postedAt', '#id': 'id', '#account': 'accountId', '#interest': 'interest' },
    ExpressionAttributeValues: { ':type': TYPE, ':from': from, ':to': to },
    ProjectionExpression: '#id, #account, #posted, #interest',
    ExclusiveStartKey: cursor,
    Limit: 500,
    ScanIndexForward: true,
  }));
  const items = (result.Items ?? []).map(item => {
    if (typeof item.id !== 'string' || typeof item.accountId !== 'string' || !iso(item.postedAt) || item.postedAt < from || item.postedAt > to) {
      throw new Error('Recent finance receipts are incomplete; refresh to try again');
    }
    return { id: item.id, accountId: item.accountId, postedAt: item.postedAt,
      interest: typeof item.interest === 'number' && Number.isFinite(item.interest) ? item.interest : null };
  });
  const key = result.LastEvaluatedKey ? paymentKey(result.LastEvaluatedKey, from, to) : undefined;
  return { items, nextToken: key ? Buffer.from(JSON.stringify({ version: 1, from, to, key })).toString('base64url') : undefined };
}

/** Only policies referenced by outstanding loans/open bills are needed for
 * quote-to-policy anchor matching. Missing policies remain explicit; unprocessed
 * keys must be retried and never mistaken for deleted historical records. */
export async function dashboardPolicyAnchors(input: Record<string, unknown>) {
  const ids = reportIds(input.policyIds, 100);
  if (!ids.length) return { items: [], missingIds: [] };
  const found = await reportBatchGet(configured('DASHBOARD_POLICY_TABLE'), ids, ['accountId', 'quoteId']);
  const items = ids.flatMap(id => {
    const item = found.get(id);
    if (!item) return [];
    if (typeof item.id !== 'string' || typeof item.accountId !== 'string') throw new Error('Policy anchors are incomplete; refresh to try again');
    return [{ id: item.id, accountId: item.accountId, ...(typeof item.quoteId === 'string' ? { quoteId: item.quoteId } : {}) }];
  });
  return { items, missingIds: ids.filter(id => !found.has(id)) };
}
