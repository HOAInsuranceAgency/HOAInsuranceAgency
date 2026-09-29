import { describe, expect, it } from 'vitest';
import type { CommercialEntry } from './commercial';
import { interestIncomeBySalesperson, nonBilledReceivables, outstandingPrincipal, type FinanceLoan } from './dashboardFinance';

const loan = (fields: Partial<FinanceLoan> = {}): FinanceLoan => ({
  id: 'loan-1', accountId: 'account-1', policyId: 'policy-1', status: 'ACTIVE',
  amountFinanced: 8000, balance: 6000, paidThrough: 2, ...fields,
});

describe('non-billed financed receivables', () => {
  it('counts remaining principal, excluding quoted offers and closed loans', () => {
    const result = nonBilledReceivables([
      loan(), loan({ id: 'accepted', status: 'ACCEPTED', balance: 8000 }),
      loan({ id: 'defaulted', status: 'DEFAULTED', balance: 4000.25 }),
      loan({ id: 'zero', balance: 0 }),
      ...['QUOTED', 'PAID', 'CANCELLED'].map(status => loan({ id: status, status, balance: 99999, paidThrough: 0 })),
    ], []);
    expect(result).toEqual({ total: 18000.25, count: 3, unknown: 0, overlaps: [] });
  });

  it('retains cancelled funded debt until carrier refunds reconcile the balance', () => {
    const result = nonBilledReceivables([
      loan({ id: 'cancelled-funded', status: 'CANCELLED', balance: 3000, expectedCarrierRefundAt: '2026-10-15' }),
      loan({ id: 'cancelled-unused', status: 'CANCELLED', paidThrough: 0, balance: 8000 }),
      loan({ id: 'cancelled-settled', status: 'CANCELLED', balance: 0, cancellationEffectiveAt: '2026-08-15' }),
    ], []);
    expect(result).toEqual({ total: 3000, count: 1, unknown: 0, overlaps: [] });
  });

  it('includes a financed loan after its original pay-in-full invoice is voided', () => {
    const result = nonBilledReceivables([loan()], [
      { id: 'old-premium', accountId: 'account-1', policyId: 'policy-1', status: 'VOID' },
      { id: 'unsent', accountId: 'account-1', policyId: 'policy-1', status: 'DRAFT' },
      { id: 'settled', accountId: 'account-1', policyId: 'policy-1', status: 'PAID' },
    ]);
    expect(result.total).toBe(6000);
    expect(result.overlaps).toEqual([]);
  });

  it('does not count the same premium as both billed and non-billed debt', () => {
    const result = nonBilledReceivables([loan()], [
      { id: 'bill', accountId: 'account-1', policyId: 'policy-1', status: 'PROCESSING' },
    ]);
    expect(result).toEqual({ total: 0, count: 0, unknown: 0, overlaps: [{ loanId: 'loan-1', invoiceIds: ['bill'] }] });
  });

  it('catches quote-to-policy rollover and legacy line-only invoice overlaps', () => {
    const result = nonBilledReceivables([loan({ policyId: null, quoteId: 'quote-1' })], [
      { id: 'bill', accountId: 'account-1', status: 'SENT' },
    ], [{ id: 'policy-1', accountId: 'account-1', quoteId: 'quote-1' }], [
      { invoiceId: 'bill', policyId: 'policy-1' },
    ]);
    expect(result.total).toBe(0);
    expect(result.overlaps).toEqual([{ loanId: 'loan-1', invoiceIds: ['bill'] }]);
  });

  it('keeps separate policies on one account separate and does not match another account', () => {
    const result = nonBilledReceivables([loan()], [
      { id: 'other-policy', accountId: 'account-1', policyId: 'policy-2', status: 'SENT' },
      { id: 'other-account', accountId: 'account-2', policyId: 'policy-1', status: 'SENT' },
    ]);
    expect(result.total).toBe(6000);
    expect(result.overlaps).toEqual([]);
  });

  it('flags unanchored legacy billing instead of assuming it is separate debt', () => {
    expect(nonBilledReceivables([loan()], [{ id: 'legacy', accountId: 'account-1', status: 'SENT' }]).overlaps)
      .toEqual([{ loanId: 'loan-1', invoiceIds: ['legacy'] }]);
  });

  it('falls back to original principal only before payments, and counts unknown balances', () => {
    expect(outstandingPrincipal(loan({ balance: null, paidThrough: 0 }))).toBe(8000);
    expect(outstandingPrincipal(loan({ balance: null, paidThrough: 2 }))).toBeNull();
    expect(outstandingPrincipal(loan({ balance: -5 }))).toBeNull();
    expect(nonBilledReceivables([loan({ balance: null, paidThrough: 2 })], []))
      .toEqual({ total: 0, count: 0, unknown: 1, overlaps: [] });
  });
});

describe('interest income by salesperson', () => {
  const now = new Date('2026-09-29T16:00:00.000Z');
  const entries: Record<string, CommercialEntry> = {
    'account-1': { accountId: 'account-1', salespersonId: 'sales-1' } as CommercialEntry,
    'account-2': { accountId: 'account-2', salespersonId: 'sales-2' } as CommercialEntry,
  };
  const series = [
    { key: 'sales-1', label: 'Alex' },
    { key: 'sales-2', label: 'Sam' },
    { key: 'unassigned', label: 'Unassigned' },
  ];

  it('attributes actual receipts to current account owners and retains unknown accounts', () => {
    const result = interestIncomeBySalesperson([
      { accountId: 'account-1', postedAt: now.toISOString(), interest: 10.11 },
      { accountId: 'account-1', postedAt: now.toISOString(), interest: 20.22 },
      { accountId: 'account-2', postedAt: now.toISOString(), interest: 5.33 },
      { accountId: 'deleted-account', postedAt: now.toISOString(), interest: 1.34 },
    ], entries, series, now);
    expect(result.rows.map(row => [row.label, row.values[row.key]])).toEqual([
      ['Alex', 30.33], ['Sam', 5.33], ['Unassigned', 1.34],
    ]);
    expect(result.total).toBe(37);
    expect(result.count).toBe(4);
  });

  it('includes both 30-day boundaries but excludes older, future, and undated receipts', () => {
    const result = interestIncomeBySalesperson([
      { postedAt: '2026-08-30T16:00:00.000Z', interest: 1 },
      { postedAt: '2026-08-30T15:59:59.999Z', interest: 99 },
      { postedAt: '2026-09-29T16:00:00.000Z', interest: 2 },
      { postedAt: '2026-09-29T16:00:00.001Z', interest: 99 },
      { postedAt: null, interest: 99 },
      { postedAt: 'invalid', interest: 99 },
      { postedAt: now.toISOString(), interest: null },
    ].map(payment => ({ accountId: 'account-1', ...payment })), entries, series, now);
    expect(result.total).toBe(3);
    expect(result.count).toBe(2);
    expect(result.unknown).toBe(1);
  });
});
