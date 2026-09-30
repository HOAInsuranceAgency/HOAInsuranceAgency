import { client, listAllPages } from './client';
import { communicationRequest } from './communications';
import { loadAssignments } from './dashboardAssignments';
import { hasFinancingReceivable, outstandingPrincipal } from './dashboardFinance';

export interface FinancePaymentReceipt { id: string; accountId: string; postedAt: string; interest: number | null }
export interface FinancePolicyAnchor { id: string; accountId: string; quoteId?: string | null }
export interface FinanceLineAnchor { invoiceId: string; policyId?: string | null }

/** The read window is fixed before the first page. Refresh starts a new
 * snapshot; later pages cannot move its boundary or repeat its receipts. */
export async function loadRecentFinanceInterest(asOf: Date): Promise<FinancePaymentReceipt[]> {
  const to = asOf.toISOString(), from = new Date(asOf.getTime() - 30 * 86_400_000).toISOString();
  const found = new Map<string, FinancePaymentReceipt>(), tokens = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await communicationRequest<{ items: FinancePaymentReceipt[]; nextToken?: string }>(
      'dashboardInterestPage', { from, to, ...(nextToken ? { nextToken } : {}) },
    );
    if (!Array.isArray(page.items)) throw new Error('Recent finance receipts are incomplete; refresh to try again');
    for (const receipt of page.items) found.set(receipt.id, receipt);
    nextToken = page.nextToken;
    if (nextToken) {
      if (tokens.has(nextToken)) throw new Error('Recent finance receipt pages did not advance; refresh to try again');
      tokens.add(nextToken);
    }
  } while (nextToken);
  return [...found.values()];
}

async function mapLimited<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await read(items[index]); }
  }));
  return results;
}

export async function loadFinancePolicyAnchors(ids: readonly string[]): Promise<FinancePolicyAnchor[]> {
  const unique = [...new Set(ids)], batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 100) batches.push(unique.slice(offset, offset + 100));
  const pages = await mapLimited(batches, async policyIds => {
    const result = await communicationRequest<{ items: FinancePolicyAnchor[]; missingIds: string[] }>('dashboardPolicyAnchors', { policyIds });
    if (!Array.isArray(result.items) || !Array.isArray(result.missingIds)) throw new Error('Policy anchors are incomplete; refresh to try again');
    const resolved = new Set([...result.items.map(item => item.id), ...result.missingIds]);
    if (resolved.size !== policyIds.length || policyIds.some(id => !resolved.has(id))) throw new Error('Policy anchors are incomplete; refresh to try again');
    return result.items;
  });
  return pages.flat();
}

/** Retain the existing invoice/loan snapshot, but read growing ledgers and
 * relations only for this report: recent receipts, open-bill line anchors,
 * referenced policies, and assignments for accounts represented here. */
export async function loadFinanceDashboard() {
  const asOf = new Date();
  const [invoices, pfLoans, payments] = await Promise.all([
    listAllPages(nextToken => client.models.Invoice.list({ nextToken,
      filter: { or: [{ status: { eq: 'SENT' } }, { status: { eq: 'PROCESSING' } }] },
    })),
    listAllPages(nextToken => client.models.PfLoan.list({ nextToken, filter: { status: { ne: 'PAID' } } })),
    loadRecentFinanceInterest(asOf),
  ]);
  const outstanding = pfLoans.filter(loan => hasFinancingReceivable(loan) && outstandingPrincipal(loan) !== 0);
  const loanAccounts = new Set(outstanding.map(loan => loan.accountId));
  const overlapInvoices = invoices.filter(invoice =>
    (invoice.status === 'SENT' || invoice.status === 'PROCESSING') && loanAccounts.has(invoice.accountId));
  const [invoiceLines, commercial] = await Promise.all([
    mapLimited(overlapInvoices, async invoice =>
      (await listAllPages(nextToken => invoice.lines({ nextToken }))).map(line => ({ invoiceId: line.invoiceId, policyId: line.policyId })),
    ).then(pages => pages.flat()),
    loadAssignments([...new Set([...invoices, ...outstanding, ...payments].map(record => record.accountId))]),
  ]);
  const overlapAccounts = new Set(overlapInvoices.map(invoice => invoice.accountId));
  const policyIds = [...outstanding.filter(loan => overlapAccounts.has(loan.accountId)), ...overlapInvoices, ...invoiceLines]
    .map(row => row.policyId).filter((id): id is string => Boolean(id));
  const policies = await loadFinancePolicyAnchors(policyIds);
  return { invoices, pfLoans, payments, policies, invoiceLines, commercial, accounts: commercial.accounts, asOf };
}
