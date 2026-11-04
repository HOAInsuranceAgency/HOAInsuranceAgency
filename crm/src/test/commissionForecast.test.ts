import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  carrierReconciliationBalances,
  policyTotals,
  selectCarrierPaymentTerms,
  validateCarrierPaymentTerms,
  validateReceiptForecast,
  type CarrierCommissionTerms,
  type CarrierPaymentArrangement,
  type CommissionPolicy,
} from '../../../shared/commissions';
import { commissionPolicy, line, statement } from './commissionFixtures';

function arrangement(overrides: Partial<CarrierPaymentArrangement> = {}): CarrierPaymentArrangement {
  return {
    id: 'default', from: '2020-01-01', basis: 'WRITTEN', payor: 'Carrier or MGA',
    trigger: 'EFFECTIVE', cadence: 'MONTHLY', lagDays: 0, paymentDay: 15,
    evidence: 'Executed carrier agreement, commission schedule', ...overrides,
  };
}
function terms(arrangements = [arrangement()]): CarrierCommissionTerms {
  return { ...commissionPolicy().carrierTerms, arrangements };
}
function policy(payment = arrangement(), overrides: Partial<CommissionPolicy> = {}): CommissionPolicy {
  return {
    ...commissionPolicy(),
    carrierTerms: selectCarrierPaymentTerms(terms([payment]), {
      effectiveDate: overrides.effectiveDate ?? '2026-01-01', transaction: 'NEW',
    }),
    ...overrides,
  };
}
const context = { effectiveDate: '2026-01-01', transaction: 'NEW' as const, billType: 'DIRECT' as const, lines: ['PROPERTY'] };

describe('carrier arrangement selection and validation', () => {
  it('selects the most specific applicable scope and freezes an independent copy', () => {
    const input = terms([
      arrangement(),
      arrangement({ id: 'direct', billType: 'DIRECT', payor: 'Direct payor' }),
      arrangement({ id: 'property-direct', billType: 'DIRECT', lines: ['property'], payor: 'Property MGA' }),
    ]);
    const original = JSON.stringify(input);
    const selected = selectCarrierPaymentTerms(input, context);
    expect(selected.payment?.id).toBe('property-direct');
    expect(selected.payment?.payor).toBe('Property MGA');
    selected.payment!.lines!.push('LIABILITY');
    expect(JSON.stringify(input)).toBe(original);
  });

  it('uses effective dates inclusively and rejects a coverage gap', () => {
    const input = terms([
      arrangement({ id: 'old', to: '2025-12-31' }),
      arrangement({ id: 'new', from: '2026-01-01', to: '2026-12-31' }),
    ]);
    expect(selectCarrierPaymentTerms(input, context).payment?.id).toBe('new');
    expect(selectCarrierPaymentTerms(input, { ...context, effectiveDate: '2025-12-31' }).payment?.id).toBe('old');
    expect(() => selectCarrierPaymentTerms(input, { ...context, effectiveDate: '2027-01-01' })).toThrow(/covering/);
  });

  it('rejects equally specific overlaps including different scope dimensions', () => {
    expect(() => validateCarrierPaymentTerms(terms([
      arrangement({ id: 'direct', billType: 'DIRECT' }),
      arrangement({ id: 'new', transaction: 'NEW' }),
    ]))).toThrow(/overlap/);
    expect(() => validateCarrierPaymentTerms(terms([
      arrangement({ id: 'old', to: '2026-01-01' }),
      arrangement({ id: 'new', from: '2026-01-01' }),
    ]))).toThrow(/overlap/);
  });

  it('rejects ambiguous multi-line matches instead of choosing an arbitrary product', () => {
    const input = terms([
      arrangement({ id: 'property', lines: ['PROPERTY'] }),
      arrangement({ id: 'liability', lines: ['LIABILITY'] }),
    ]);
    expect(() => selectCarrierPaymentTerms(input, { ...context, lines: ['PROPERTY', 'LIABILITY'] })).toThrow(/covering all/);
    expect(() => selectCarrierPaymentTerms(terms([
      arrangement(), arrangement({ id: 'property', lines: ['PROPERTY'] }),
    ]), { ...context, lines: ['PROPERTY', 'LIABILITY'] })).toThrow(/covering all/);
    const matching = selectCarrierPaymentTerms(terms([
      arrangement(), arrangement({ id: 'package', lines: ['PROPERTY', 'LIABILITY'] }),
    ]), { ...context, lines: ['PROPERTY', 'LIABILITY'] });
    expect(matching.payment?.id).toBe('package');
  });

  it('requires missing historical billing or coverage metadata when an override could apply', () => {
    const billing = terms([
      arrangement(), arrangement({ id: 'direct', billType: 'DIRECT', basis: 'COLLECTED', trigger: 'COLLECTION' }),
    ]);
    const historical = { effectiveDate: '2026-01-01', transaction: 'NEW' as const };
    expect(() => selectCarrierPaymentTerms(billing, historical)).toThrow(/Confirm.*billing type/);
    expect(selectCarrierPaymentTerms(billing, { ...historical, billType: 'DIRECT' }).payment?.id).toBe('direct');
    expect(selectCarrierPaymentTerms(billing, { ...historical, billType: 'AGENCY' }).payment?.id).toBe('default');
    const coverage = terms([
      arrangement(), arrangement({ id: 'property', lines: ['PROPERTY'] }),
    ]);
    expect(() => selectCarrierPaymentTerms(coverage, historical)).toThrow(/Confirm.*coverage lines/);
    expect(() => selectCarrierPaymentTerms(coverage, { ...historical, lines: [] })).toThrow(/Confirm.*coverage lines/);
    expect(selectCarrierPaymentTerms(coverage, { ...historical, lines: ['PROPERTY'] }).payment?.id).toBe('property');
    expect(selectCarrierPaymentTerms(coverage, { ...historical, lines: ['LIABILITY'] }).payment?.id).toBe('default');
  });

  it('ignores expired or known contrary scopes when historical metadata is missing', () => {
    const historical = { effectiveDate: '2026-01-01', transaction: 'NEW' as const };
    const expired = terms([
      arrangement(), arrangement({ id: 'expired', to: '2025-12-31', billType: 'DIRECT', lines: ['PROPERTY'] }),
    ]);
    expect(selectCarrierPaymentTerms(expired, historical).payment?.id).toBe('default');
    const contrary = terms([
      arrangement(), arrangement({ id: 'direct-property', billType: 'DIRECT', lines: ['PROPERTY'] }),
    ]);
    expect(selectCarrierPaymentTerms(contrary, { ...historical, billType: 'AGENCY' }).payment?.id).toBe('default');
    expect(selectCarrierPaymentTerms(contrary, { ...historical, lines: ['LIABILITY'] }).payment?.id).toBe('default');
    const lowerPriority = terms([
      arrangement(), arrangement({ id: 'property', lines: ['PROPERTY'] }),
      arrangement({ id: 'direct-new', billType: 'DIRECT', transaction: 'NEW' }),
    ]);
    expect(selectCarrierPaymentTerms(lowerPriority, { ...historical, billType: 'DIRECT' }).payment?.id).toBe('direct-new');
    expect(selectCarrierPaymentTerms(terms(), historical).payment?.id).toBe('default');
  });

  it.each([
    { basis: 'EARNED', trigger: 'COLLECTION' },
    { basis: 'COLLECTED', trigger: 'EARNED' },
    { basis: 'WRITTEN', trigger: 'COLLECTION' },
    { cadence: 'ONCE', cutoffDay: 20 },
    { lagDays: -1 },
    { paymentDay: 32 },
    { cutoffDay: 0 },
    { evidence: '' },
    { earningMethod: 'DAILY_PRORATA' },
    { basis: 'EARNED', trigger: 'EARNED', earningMethod: undefined },
  ] as Partial<CarrierPaymentArrangement>[])('rejects invalid or unsourced terms %j', (invalid) => {
    expect(() => validateCarrierPaymentTerms(terms([arrangement(invalid)]))).toThrow();
  });

  it('allows legacy reads while requiring structured arrangements for new writes', () => {
    const legacy = commissionPolicy().carrierTerms;
    expect(selectCarrierPaymentTerms(legacy, context)).toEqual(legacy);
    expect(() => validateCarrierPaymentTerms(legacy)).toThrow(/arrangements/);
    expect(carrierReconciliationBalances(commissionPolicy(), '2026-10-01')).toMatchObject({
      fullTermEstimate: 1_200_000, expectedToDate: null, forecastTotal: null, overdue: null, status: 'UNKNOWN',
    });
  });
});

describe('contractual timing forecasts', () => {
  it('keeps written commission upfront even when the payor remits monthly', () => {
    const p = policy();
    expect(carrierReconciliationBalances(p, '2026-02-14')).toMatchObject({
      forecastTotal: 1_200_000, expectedToDate: 0, futureForecast: 1_200_000, overdue: 0,
    });
    expect(carrierReconciliationBalances(p, '2026-02-15')).toMatchObject({
      expectedToDate: 1_200_000, futureForecast: 0, overdue: 0, confirmed: true,
    });
    expect(carrierReconciliationBalances(p, '2026-02-16').overdue).toBe(1_200_000);
  });

  it('rolls past a cutoff, clamps payment days, then adds calendar-day lag', () => {
    const p = policy(arrangement({ cutoffDay: 20, paymentDay: 31, lagDays: 2 }), {
      effectiveDate: '2026-01-21', expirationDate: '2027-01-21',
    });
    // Jan 21 misses Jan 20; Feb 20 cutoff -> Mar 31 payment -> Apr 2 due.
    expect(carrierReconciliationBalances(p, '2026-04-01').expectedToDate).toBe(0);
    expect(carrierReconciliationBalances(p, '2026-04-02').expectedToDate).toBe(1_200_000);
    const leap = policy(arrangement({ paymentDay: 31, lagDays: 1 }), {
      effectiveDate: '2024-01-01', expirationDate: '2025-01-01',
    });
    expect(carrierReconciliationBalances(leap, '2024-02-29').expectedToDate).toBe(0);
    expect(carrierReconciliationBalances(leap, '2024-03-01').expectedToDate).toBe(1_200_000);
  });

  it('uses the agency timezone for bind-date triggers and handles year rollover', () => {
    const p = policy(arrangement({ trigger: 'BIND' }), {
      boundAt: '2026-11-01T00:30:00Z', effectiveDate: '2026-12-01', expirationDate: '2027-12-01',
    });
    // The bind took place Oct 31 in New York, so it belongs to October's statement.
    expect(carrierReconciliationBalances(p, '2026-11-15').expectedToDate).toBe(1_200_000);
    const historical = policy(arrangement({ trigger: 'BIND', cadence: 'ONCE', paymentDay: undefined }), {
      boundAt: '2026-01-01',
    });
    expect(carrierReconciliationBalances(historical, '2025-12-31').expectedToDate).toBe(0);
    expect(carrierReconciliationBalances(historical, '2026-01-01').expectedToDate).toBe(1_200_000);
    const december = policy(arrangement({ cadence: 'QUARTERLY', paymentDay: 31 }), {
      effectiveDate: '2026-12-31', expirationDate: '2027-12-31',
    });
    expect(carrierReconciliationBalances(december, '2027-01-30').expectedToDate).toBe(0);
    expect(carrierReconciliationBalances(december, '2027-01-31').expectedToDate).toBe(1_200_000);
  });

  it('supports a one-time trigger lag without inventing installments', () => {
    const p = policy(arrangement({ cadence: 'ONCE', paymentDay: undefined, lagDays: 45 }));
    expect(carrierReconciliationBalances(p, '2026-02-14').expectedToDate).toBe(0);
    expect(carrierReconciliationBalances(p, '2026-02-15').expectedToDate).toBe(1_200_000);
  });

  it('uses actual coverage days including leap day and reconciles the final cent', () => {
    const p = policy(arrangement({ basis: 'EARNED', trigger: 'EARNED', earningMethod: 'DAILY_PRORATA' }), {
      effectiveDate: '2024-01-01', expirationDate: '2025-01-01',
    });
    expect(carrierReconciliationBalances(p, '2024-02-15').expectedToDate).toBe(Math.round(1_200_000 * 31 / 366));
    expect(carrierReconciliationBalances(p, '2024-03-15').expectedToDate).toBe(Math.round(1_200_000 * 60 / 366));
    expect(carrierReconciliationBalances(p, '2025-01-15')).toMatchObject({
      forecastTotal: 1_200_000, expectedToDate: 1_200_000, futureForecast: 0,
    });
  });

  it('handles partial calendar periods rather than assuming twelve equal receipts', () => {
    const p = policy(arrangement({ basis: 'EARNED', trigger: 'EARNED', earningMethod: 'DAILY_PRORATA' }), {
      effectiveDate: '2026-01-16', expirationDate: '2026-03-01', premiumCents: 44_000, agencyRateUnits: 100_000,
    });
    expect(carrierReconciliationBalances(p, '2026-02-15').expectedToDate).toBe(1_600);
    expect(carrierReconciliationBalances(p, '2026-03-15').expectedToDate).toBe(4_400);
    const quarter = policy(arrangement({ basis: 'EARNED', trigger: 'EARNED', earningMethod: 'DAILY_PRORATA', cadence: 'QUARTERLY' }), {
      effectiveDate: '2026-01-01', expirationDate: '2026-07-01', premiumCents: 181_000, agencyRateUnits: 100_000,
    });
    expect(carrierReconciliationBalances(quarter, '2026-04-15').expectedToDate).toBe(9_000);
    expect(carrierReconciliationBalances(quarter, '2026-07-15').expectedToDate).toBe(18_100);
  });

  it('accrues earned commission through each configured statement cutoff', () => {
    const p = policy(arrangement({
      basis: 'EARNED', trigger: 'EARNED', earningMethod: 'DAILY_PRORATA',
      cutoffDay: 25, paymentDay: undefined,
    }), { premiumCents: 365_000, agencyRateUnits: 100_000 });
    expect(carrierReconciliationBalances(p, '2026-01-24').expectedToDate).toBe(0);
    expect(carrierReconciliationBalances(p, '2026-01-25')).toMatchObject({ expectedToDate: 2_500, overdue: 0 });
    expect(carrierReconciliationBalances(p, '2026-02-25').expectedToDate).toBe(5_600);
    expect(carrierReconciliationBalances(p, '2027-01-25').expectedToDate).toBe(36_500);
    const quarter = policy(arrangement({
      basis: 'EARNED', trigger: 'EARNED', earningMethod: 'DAILY_PRORATA', cadence: 'QUARTERLY',
      cutoffDay: 25, paymentDay: undefined,
    }), { premiumCents: 365_000, agencyRateUnits: 100_000 });
    expect(carrierReconciliationBalances(quarter, '2026-03-25').expectedToDate).toBe(8_400);
    expect(carrierReconciliationBalances(quarter, '2026-06-25').expectedToDate).toBe(17_600);
  });

  it.each([
    arrangement({ basis: 'COLLECTED', trigger: 'COLLECTION' }),
    arrangement({ basis: 'EARNED', trigger: 'EARNED', earningMethod: 'MANUAL' }),
  ])('leaves collection-dependent and manual earned timing unknown', (payment) => {
    expect(carrierReconciliationBalances(policy(payment), '2026-12-31')).toMatchObject({
      expectedToDate: null, overdue: null, futureForecast: null, confirmed: false, status: 'UNKNOWN',
    });
  });
});

describe('manual receipt forecasts and actual reconciliation', () => {
  it('retains an unknown remainder on an incomplete forecast', () => {
    const p = policy();
    p.receiptForecast = {
      items: [{ dueOn: '2026-01-15', agencyCents: 100_000 }, { dueOn: '2026-03-15', agencyCents: 100_000 }],
      evidence: 'First two known carrier installments only', complete: false, confirmed: true,
    };
    expect(carrierReconciliationBalances(p, '2026-02-01')).toMatchObject({
      forecastTotal: null, expectedToDate: 100_000, futureForecast: 100_000,
      unallocatedForecast: 1_000_000, status: 'PARTIAL_FORECAST',
    });
  });

  it('allows a complete reviewed zero forecast to replace the original estimate', () => {
    const p = policy();
    p.receiptForecast = validateReceiptForecast({ items: [], evidence: 'Carrier confirms cancellation before commission', confirmed: true, complete: true });
    expect(carrierReconciliationBalances(p, '2026-12-31')).toMatchObject({
      fullTermEstimate: 1_200_000, forecastTotal: 0, expectedToDate: 0, futureForecast: 0, overdue: 0,
    });
  });

  it('does not age unconfirmed forecasts as overdue', () => {
    const p = policy();
    p.receiptForecast = { items: [{ dueOn: '2026-01-15', agencyCents: 100_000 }], evidence: 'Unconfirmed illustration', confirmed: false, complete: true };
    expect(carrierReconciliationBalances(p, '2026-02-01')).toMatchObject({ expectedToDate: 100_000, overdue: null, status: 'ESTIMATED' });
  });

  it('uses only actual receipts through asOf and keeps future scheduled money separate', () => {
    let p = policy();
    p.receiptForecast = {
      items: [{ dueOn: '2026-01-15', agencyCents: 100_000 }, { dueOn: '2026-02-15', agencyCents: 100_000 }],
      evidence: 'Carrier schedule', confirmed: true, complete: true,
    };
    p = appendEntry(p, line(), { ...statement(), receivedOn: '2026-01-15' }, 'first');
    p = appendEntry(p, line({ lineRef: 'TX-2' }), { ...statement(), receivedOn: '2026-02-15' }, 'second');
    expect(carrierReconciliationBalances(p, '2026-02-01')).toMatchObject({ expectedToDate: 100_000, receivedToDate: 100_000, overdue: 0, futureForecast: 100_000 });
  });

  it('applies early receipts to future items without overstating the collectible balance', () => {
    let p = policy();
    p.receiptForecast = {
      items: [{ dueOn: '2026-01-15', agencyCents: 100_000 }, { dueOn: '2026-02-15', agencyCents: 100_000 }],
      evidence: 'Carrier installment schedule', confirmed: true, complete: true,
    };
    p = appendEntry(p, line({ agencyCents: 150_000 }), { ...statement(), receivedOn: '2026-01-15' }, 'advance');
    expect(carrierReconciliationBalances(p, '2026-02-01')).toMatchObject({ expectedToDate: 100_000, receivedToDate: 150_000, overdue: 0, futureForecast: 50_000 });
    p = appendEntry(p, line({ agencyCents: 50_000, lineRef: 'FINAL' }), { ...statement(), receivedOn: '2026-02-01' }, 'final');
    expect(carrierReconciliationBalances(p, '2026-02-01').futureForecast).toBe(0);
  });

  it('requires a fresh forecast review after a reversal without changing producer wages', () => {
    let p = appendEntry(policy(), line(), { ...statement(), receivedOn: '2026-01-15' }, 'receipt');
    p = appendEntry(p, line({ kind: 'REVERSAL', agencyCents: -20_000, originalId: 'receipt', lineRef: 'REV-1' }), { ...statement(), receivedOn: '2026-02-01' }, 'reversal');
    const ledger = JSON.stringify(p.entries), earnings = policyTotals(p);
    expect(carrierReconciliationBalances(p, '2026-03-01')).toMatchObject({ receivedToDate: 80_000, overdue: null, adjustmentReview: true, status: 'ADJUSTMENT_REVIEW' });
    p.receiptForecast = {
      items: [{ dueOn: '2026-01-15', agencyCents: 80_000 }], evidence: 'Reviewed carrier cancellation and retained commission',
      complete: true, confirmed: true, reviewedEntryCount: p.entries.length,
    };
    expect(carrierReconciliationBalances(p, '2026-03-01')).toMatchObject({ overdue: 0, adjustmentReview: false, forecastTotal: 80_000 });
    expect(JSON.stringify(p.entries)).toBe(ledger);
    expect(policyTotals(p)).toEqual(earnings);
    expect(earnings.earned).toBe(16_000);
    expect(earnings.proposedRecovery).toBe(3_200);
    p = appendEntry(p, line({ agencyCents: 10_000, lineRef: 'LATER' }), { ...statement(), receivedOn: '2026-03-02' }, 'later-receipt');
    expect(carrierReconciliationBalances(p, '2026-03-03').adjustmentReview).toBe(false);
    p = appendEntry(p, line({ kind: 'REVERSAL', agencyCents: -1_000, originalId: 'later-receipt', lineRef: 'LATER-REV' }), { ...statement(), receivedOn: '2026-03-04' }, 'later-reversal');
    expect(carrierReconciliationBalances(p, '2026-03-03').adjustmentReview).toBe(false);
    expect(carrierReconciliationBalances(p, '2026-03-04')).toMatchObject({ adjustmentReview: true, overdue: null });
  });

  it.each([
    { items: [{ dueOn: '2026-02-30', agencyCents: 10 }] },
    { items: [{ dueOn: '2026-02-01', agencyCents: 1.5 }] },
    { items: [{ dueOn: '2026-02-01', agencyCents: -1 }] },
    { items: Array.from({ length: 101 }, () => ({ dueOn: '2026-02-01', agencyCents: 1 })) },
    { items: [], complete: false },
    { evidence: '' },
    { reviewedEntryCount: 501 },
  ])('rejects malformed forecast input %j', (invalid) => {
    expect(() => validateReceiptForecast({ items: [], evidence: 'Source', confirmed: true, complete: true, ...invalid })).toThrow();
  });
});
