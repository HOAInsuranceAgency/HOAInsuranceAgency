import { reportBatchGet, reportIds } from './dashboardStore';
import { reportIndexPage } from './reportIndexPage';
import { reportDatePage } from './reportDatePage';

function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function configured(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Dashboard finance storage is not configured');
  return value;
}
/** The caller enforces ADMIN. Query the automatically backfilled index over
 * existing __typename/postedAt attributes, with one bounded page per request.
 * Never substitute a Scan if the index is unavailable: a partial recent-income
 * report would look complete, while a full-history fallback defeats its bound. */
export async function dashboardInterestPage(input: Record<string, unknown>) {
  const page = await reportDatePage({
    table: configured('DASHBOARD_PAYMENT_TABLE'),
    index: configured('DASHBOARD_PAYMENT_INDEX'),
    type: 'PfLoanPayment', dateField: 'postedAt',
    fields: ['id', 'accountId', 'postedAt', 'interest'],
    from: input.from, to: input.to, nextToken: input.nextToken,
  });
  const from = input.from as string, to = input.to as string;
  const items = page.items.map(item => {
    if (typeof item.id !== 'string' || typeof item.accountId !== 'string' || !iso(item.postedAt) || item.postedAt < from || item.postedAt > to) {
      throw new Error('Recent finance receipts are incomplete; refresh to try again');
    }
    return { id: item.id, accountId: item.accountId, postedAt: item.postedAt,
      interest: typeof item.interest === 'number' && Number.isFinite(item.interest) ? item.interest : null };
  });
  return { items, nextToken: page.nextToken };
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

/** Resolve legacy line-only/multi-policy anchors for several open invoices
 * together. invoiceId is the existing relation index partition key, so this
 * reads just the requested bills and never walks all historical line items. */
export async function dashboardInvoiceAnchors(input: Record<string, unknown>) {
  const invoiceIds = reportIds(input.invoiceIds, 25);
  const page = await reportIndexPage({
    table: configured('DASHBOARD_INVOICE_LINE_TABLE'),
    index: configured('DASHBOARD_INVOICE_LINE_INDEX'),
    partition: 'invoiceId',
    fields: ['id', 'invoiceId', 'policyId'],
    values: invoiceIds,
    nextToken: input.nextToken,
  });
  const requested = new Set(invoiceIds);
  return { items: page.items.map(item => {
    if (typeof item.id !== 'string' || !item.id || typeof item.invoiceId !== 'string' || !requested.has(item.invoiceId) ||
      item.policyId != null && (typeof item.policyId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.policyId))) {
      throw new Error('Invoice anchors are incomplete; refresh to try again');
    }
    return { id: item.id, invoiceId: item.invoiceId, policyId: item.policyId as string | null | undefined };
  }), nextToken: page.nextToken };
}
