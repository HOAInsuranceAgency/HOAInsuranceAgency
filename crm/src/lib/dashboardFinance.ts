import type { ChartRow, ChartSeries } from '../components/StackedBars';
import type { CommercialEntry } from './commercial';
import { isInLast30Days, salespersonKey } from './dashboardPeople';

export const LIVE_FINANCE_STATUSES: readonly string[] = ['ACCEPTED', 'ACTIVE', 'DEFAULTED'];
interface Anchor { accountId: string; policyId?: string | null; quoteId?: string | null }
export interface FinanceLoan extends Anchor {
  id: string;
  status?: string | null;
  balance?: number | null;
  amountFinanced?: number | null;
  paidThrough?: number | null;
  activatedAt?: string | null;
  downPaidAt?: string | null;
  cancellationEffectiveAt?: string | null;
  expectedCarrierRefundAt?: string | null;
}
interface FinanceInvoice extends Anchor { id: string; status?: string | null }
interface FinancePolicy { id: string; accountId: string; quoteId?: string | null }
interface FinanceInvoiceLine { invoiceId: string; policyId?: string | null }

/** Cancelling coverage does not repay its loan. Retain funded cancellations
 * until their principal is reconciled; an unused cancelled offer is not debt. */
export function hasFinancingReceivable(loan: FinanceLoan): boolean {
  return LIVE_FINANCE_STATUSES.includes(loan.status ?? '') ||
    (loan.status === 'CANCELLED' && Boolean(loan.activatedAt || loan.downPaidAt ||
      loan.cancellationEffectiveAt || loan.expectedCarrierRefundAt || (loan.paidThrough ?? 0) > 0));
}

/** A missing balance after payments began is unknown, not the original debt. */
export function outstandingPrincipal(loan: FinanceLoan): number | null {
  const amount = loan.balance ?? ((loan.paidThrough ?? 0) === 0 ? loan.amountFinanced : null);
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** Financing replaces the pay-in-full bill with a loan; monthly installments
 * post directly to its payment ledger, without creating invoices. Remaining
 * principal is therefore non-billed A/R. A live invoice on the same premium is
 * an inconsistent/legacy overlap: do not add that loan to non-billed A/R or
 * guess which portion of a gross invoice represents financed principal.
 * Policy quote links and old line-only invoice anchors survive bind rollover. */
export function nonBilledReceivables(
  loans: readonly FinanceLoan[],
  invoices: readonly FinanceInvoice[],
  policies: readonly FinancePolicy[] = [],
  lines: readonly FinanceInvoiceLine[] = [],
) {
  const policyById = new Map(policies.map(policy => [policy.id, policy]));
  const linePolicies = new Map<string, string[]>();
  for (const line of lines) if (line.policyId) {
    const ids = linePolicies.get(line.invoiceId) ?? [];
    ids.push(line.policyId);
    linePolicies.set(line.invoiceId, ids);
  }
  const anchors = (row: Anchor, extraPolicies: readonly string[] = []) => {
    const result = new Set<string>();
    if (row.quoteId) result.add(`quote:${row.quoteId}`);
    for (const id of [...extraPolicies, ...(row.policyId ? [row.policyId] : [])]) {
      result.add(`policy:${id}`);
      const policy = policyById.get(id);
      if (policy?.accountId === row.accountId && policy.quoteId) result.add(`quote:${policy.quoteId}`);
    }
    return result;
  };
  // Match once-indexed account/anchor buckets, not every loan against the
  // entire invoice book. Keep a separate account-wide bucket for the legacy
  // unanchored case: that ambiguity still overlaps every bill on its account.
  interface BilledAccount {
    all: Map<string, number>;
    unanchored: Map<string, number>;
    byAnchor: Map<string, Map<string, number>>;
  }
  const billedByAccount = new Map<string, BilledAccount>();
  invoices.forEach((invoice, position) => {
    if (invoice.status !== 'SENT' && invoice.status !== 'PROCESSING') return;
    const invoiceId = invoice.id, accountId = invoice.accountId;
    let billed = billedByAccount.get(accountId);
    if (!billed) {
      billed = { all: new Map(), unanchored: new Map(), byAnchor: new Map() };
      billedByAccount.set(accountId, billed);
    }
    billed.all.set(invoiceId, position);
    const invoiceAnchors = anchors(invoice, linePolicies.get(invoiceId));
    if (!invoiceAnchors.size) billed.unanchored.set(invoiceId, position);
    for (const key of invoiceAnchors) {
      let bucket = billed.byAnchor.get(key);
      if (!bucket) { bucket = new Map(); billed.byAnchor.set(key, bucket); }
      bucket.set(invoiceId, position);
    }
  });
  let totalCents = 0, count = 0, unknown = 0;
  const overlaps: { loanId: string; invoiceIds: string[] }[] = [];
  for (const loan of loans) {
    if (!hasFinancingReceivable(loan)) continue;
    const principal = outstandingPrincipal(loan);
    if (principal === 0) continue;
    const loanAnchors = anchors(loan);
    const billed = billedByAccount.get(loan.accountId);
    const matching = new Map<string, number>();
    if (billed) {
      if (!loanAnchors.size) {
        for (const [id, position] of billed.all) matching.set(id, position);
      } else {
        for (const [id, position] of billed.unanchored) matching.set(id, position);
        for (const key of loanAnchors) {
          for (const [id, position] of billed.byAnchor.get(key) ?? []) matching.set(id, position);
        }
      }
    }
    if (matching.size) {
      // Multiple anchors can name the same invoice. Deduplicate it and retain
      // input order so the reconciliation list stays stable after indexing.
      const invoiceIds = [...matching].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      overlaps.push({ loanId: loan.id, invoiceIds });
      continue;
    }
    if (principal == null) { unknown += 1; continue; }
    totalCents += Math.round(principal * 100);
    count += 1;
  }
  return { total: totalCents / 100, count, unknown, overlaps };
}

/** Earned interest comes only from posted receipts, never the loan's future
 * totalInterest or the user who happened to quote/post it. */
export function interestIncomeBySalesperson(
  payments: readonly { accountId: string; postedAt?: string | null; interest?: number | null }[],
  entries: Record<string, CommercialEntry>,
  series: readonly ChartSeries[],
  now: Date,
) {
  const cents = new Map(series.map(person => [person.key, 0]));
  let count = 0, unknown = 0;
  for (const payment of payments) {
    if (!isInLast30Days(payment.postedAt, now)) continue;
    if (typeof payment.interest !== 'number' || !Number.isFinite(payment.interest)) { unknown += 1; continue; }
    const key = salespersonKey(payment.accountId, entries);
    cents.set(key, (cents.get(key) ?? 0) + Math.round(payment.interest * 100));
    count += 1;
  }
  const rows: ChartRow[] = series.map(person => ({
    key: person.key, label: person.label, values: { [person.key]: (cents.get(person.key) ?? 0) / 100 },
  }));
  return { rows, count, unknown, total: [...cents.values()].reduce((sum, amount) => sum + amount, 0) / 100 };
}
