import { client } from "./client";
import { listAllPages } from "../../../shared/pagination";
import { communicationRequest } from './communications';
import { loadAssignments } from './dashboardAssignments';
import { hasFinancingReceivable, outstandingPrincipal } from './dashboardFinance';
import { allWithAuthorizationPriority } from './allWithAuthorizationPriority';
import type { ReportBrokerFeePolicy } from './brokerFeeReporting';

export interface FinancePaymentReceipt { id: string; accountId: string; postedAt: string; interest: number | null }
export interface FinancePolicyAnchor { id: string; accountId: string; quoteId?: string | null }
export interface FinanceLineAnchor { invoiceId: string; policyId?: string | null }
interface FinanceLineReceipt extends FinanceLineAnchor { id: string }

/** The read window is fixed before the first page. Refresh starts a new
 * snapshot; later pages cannot move its boundary or repeat its receipts. */
export async function loadRecentFinanceInterest(asOf: Date): Promise<FinancePaymentReceipt[]> {
  const to = asOf.toISOString(), from = new Date(asOf.getTime() - 30 * 86_400_000).toISOString();
  const found = new Map<string, FinancePaymentReceipt>(), tokens = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await communicationRequest(
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
  await allWithAuthorizationPriority(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await read(items[index]); }
  }));
  return results;
}

export async function loadFinancePolicyAnchors(ids: readonly string[]): Promise<FinancePolicyAnchor[]> {
  const unique = [...new Set(ids)], batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 100) batches.push(unique.slice(offset, offset + 100));
  const pages = await mapLimited(batches, async policyIds => {
    const result = await communicationRequest('dashboardPolicyAnchors', { policyIds });
    if (!Array.isArray(result.items) || !Array.isArray(result.missingIds)) throw new Error('Policy anchors are incomplete; refresh to try again');
    const resolved = new Set([...result.items.map(item => item.id), ...result.missingIds]);
    if (resolved.size !== policyIds.length || policyIds.some(id => !resolved.has(id))) throw new Error('Policy anchors are incomplete; refresh to try again');
    return result.items;
  });
  return pages.flat();
}

/** Several invoice partitions travel in one indexed report request. Complete
 * every page before using an absent line as evidence that debt is unbilled. */
export async function loadFinanceInvoiceAnchors(ids: readonly string[]): Promise<FinanceLineAnchor[]> {
  const unique = [...new Set(ids)].sort(), batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 25) batches.push(unique.slice(offset, offset + 25));
  const pages = await mapLimited(batches, async invoiceIds => {
    const found = new Map<string, FinanceLineReceipt>(), tokens = new Set<string>(), requested = new Set(invoiceIds);
    let nextToken: string | undefined;
    do {
      const page = await communicationRequest(
        'dashboardInvoiceAnchors', { invoiceIds, ...(nextToken ? { nextToken } : {}) },
      );
      if (!Array.isArray(page.items)) throw new Error('Invoice anchors are incomplete; refresh to try again');
      for (const item of page.items) {
        if (typeof item.id !== 'string' || !item.id || !requested.has(item.invoiceId)) throw new Error('Invoice anchors are incomplete; refresh to try again');
        found.set(item.id, item);
      }
      nextToken = page.nextToken;
      if (nextToken) {
        if (tokens.has(nextToken)) throw new Error('Invoice anchor pages did not advance; refresh to try again');
        tokens.add(nextToken);
      }
    } while (nextToken);
    return [...found.values()].map(({ invoiceId, policyId }) => ({ invoiceId, policyId }));
  });
  return pages.flat();
}

/** Fee-bearing policies have a dedicated partition. Read every page without a
 * status filter so retained fees on cancelled policies remain in the report. */
export async function loadFinanceBrokerFeePolicies(): Promise<ReportBrokerFeePolicy[]> {
  const tokens = new Set<string>();
  return listAllPages(nextToken => {
    if (nextToken) {
      if (tokens.has(nextToken)) throw new Error('Broker fee policy pages did not advance; refresh to try again');
      tokens.add(nextToken);
    }
    return client.models.Policy.listPolicyByBrokerFeeReportingKey({ brokerFeeReportingKey: 'BROKER_FEE' }, {
      nextToken,
      selectionSet: ['id', 'accountId', 'brokerFee', 'brokerFeeCollected', 'brokerFeeRefunded', 'status'],
    });
  });
}

/** Retain the existing invoice/loan snapshot, but read growing ledgers and
 * relations only for this report: recent receipts, open-bill line anchors,
 * referenced policies, and assignments for accounts represented here. */
export async function loadFinanceDashboard() {
  const asOf = new Date();
  const [invoices, pfLoans, payments, brokerFeePolicies] = await allWithAuthorizationPriority([
    listAllPages(nextToken => client.models.Invoice.list({ nextToken,
      filter: { or: [{ status: { eq: 'SENT' } }, { status: { eq: 'PROCESSING' } }] },
    })),
    listAllPages(nextToken => client.models.PfLoan.list({ nextToken, filter: { status: { ne: 'PAID' } } })),
    loadRecentFinanceInterest(asOf),
    loadFinanceBrokerFeePolicies(),
  ]);
  const outstanding = pfLoans.filter(loan => hasFinancingReceivable(loan) && outstandingPrincipal(loan) !== 0);
  const loanAccounts = new Set(outstanding.map(loan => loan.accountId));
  const overlapInvoices = invoices.filter(invoice =>
    (invoice.status === 'SENT' || invoice.status === 'PROCESSING') && loanAccounts.has(invoice.accountId));
  const [invoiceLines, commercial] = await allWithAuthorizationPriority([
    loadFinanceInvoiceAnchors(overlapInvoices.map(invoice => invoice.id)),
    loadAssignments([...new Set([...invoices, ...outstanding, ...payments, ...brokerFeePolicies].map(record => record.accountId))]),
  ]);
  const overlapAccounts = new Set(overlapInvoices.map(invoice => invoice.accountId));
  const policyIds = [...outstanding.filter(loan => overlapAccounts.has(loan.accountId)), ...overlapInvoices, ...invoiceLines]
    .map(row => row.policyId).filter((id): id is string => Boolean(id));
  const policies = await loadFinancePolicyAnchors(policyIds);
  return { invoices, pfLoans, payments, policies, invoiceLines, brokerFeePolicies: brokerFeePolicies as ReportBrokerFeePolicy[], commercial, accounts: commercial.accounts, asOf };
}
