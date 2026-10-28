import { describe, expect, it } from 'vitest';
import { appendEntry, decimal, policyTotals, validatePlan } from '../../../shared/commissions';
import { commissionPolicy, line, statement } from './commissionFixtures';
describe('commission accounting', () => {
  it('records a forecast at bind and only earns on received commission', () => {
    const p = commissionPolicy();
    expect(policyTotals(p)).toMatchObject({
      expectedAgency: 1200000,
      earned: 0,
      receivedAgency: 0,
    });
    const paid = appendEntry(p, line(), statement(), 'e');
    expect(policyTotals(paid)).toMatchObject({
      earned: 16000,
      receivedAgency: 100000,
      unbatched: 16000,
    });
  });
  it('does not lose pennies across 12 installments', () => {
    let p = { ...commissionPolicy(), producerBps: 3333 };
    for (let i = 0; i < 12; i++)
      p = appendEntry(p, line({ agencyCents: 1, lineRef: String(i) }), statement(), String(i));
    expect(policyTotals(p).earned).toBe(4);
  });
  it('keeps explicit zero rates separate from incomplete numbers', () => {
    expect(
      policyTotals(appendEntry({ ...commissionPolicy(), producerBps: 0 }, line(), statement(), 'e'))
        .earned,
    ).toBe(0);
    for (const value of ['', '1.001', 'NaN', '1e3', 'Infinity'])
      expect(() => decimal(value)).toThrow();
    expect(decimal('12.3456', 4)).toBe(123456);
    expect(decimal('100000.01')).toBe(10000001);
  });
  it('calculates proportional reversals without reducing earned unpaid wages', () => {
    const received = appendEntry(
      commissionPolicy(),
      line({ agencyCents: 1200000 }),
      statement(),
      'e',
    );
    const reversed = appendEntry(
      received,
      line({ kind: 'REVERSAL', agencyCents: -200000, originalId: 'e' }),
      statement(),
      'r',
    );
    expect(policyTotals(reversed)).toMatchObject({
      earned: 192000,
      unbatched: 192000,
      proposedRecovery: 32000,
      receivedAgency: 1000000,
    });
  });
  it('caps multiple reversals at their original commission and restores without earning twice', () => {
    let p = appendEntry(commissionPolicy(), line({ agencyCents: 3 }), statement(), 'e');
    p = appendEntry(
      p,
      line({ kind: 'REVERSAL', agencyCents: -1, originalId: 'e' }),
      statement(),
      'r1',
    );
    p = appendEntry(
      p,
      line({ kind: 'REVERSAL', agencyCents: -2, originalId: 'e' }),
      statement(),
      'r2',
    );
    expect(policyTotals(p).proposedRecovery).toBe(0); // original 3 cents at 16% rounds to zero
    expect(() =>
      appendEntry(
        p,
        line({ kind: 'REVERSAL', agencyCents: -1, originalId: 'e' }),
        statement(),
        'r3',
      ),
    ).toThrow(/exceed/);
    const normal = appendEntry(commissionPolicy(), line(), statement(), 'e');
    const reversed = appendEntry(
      normal,
      line({ kind: 'REVERSAL', agencyCents: -100000, originalId: 'e' }),
      statement(),
      'r',
    );
    const restored = appendEntry(
      reversed,
      line({ kind: 'RESTORATION', agencyCents: 100000, originalId: 'r' }),
      statement(),
      'restore',
    );
    expect(policyTotals(restored)).toMatchObject({
      earned: 16000,
      proposedRecovery: 0,
      receivedAgency: 100000,
    });
    expect(() =>
      appendEntry(
        restored,
        line({ kind: 'RESTORATION', agencyCents: 1, originalId: 'r' }),
        statement(),
        'extra',
      ),
    ).toThrow(/exceed/);
  });
  it('excludes ineligible receipts from earnings and recovers nothing for them', () => {
    const p = appendEntry(commissionPolicy(), line({ eligible: false }), statement(), 'e');
    const r = appendEntry(
      p,
      line({ kind: 'REVERSAL', agencyCents: -100000, originalId: 'e' }),
      statement(),
      'r',
    );
    expect(policyTotals(r)).toMatchObject({ earned: 0, proposedRecovery: 0 });
  });
  it.each([
    line({ kind: 'REVERSAL', agencyCents: -1, originalId: 'missing' }),
    line({ agencyCents: 0 }),
    line({ agencyCents: 1.5 }),
    line({ agencyCents: -1 }),
    line({ eligibilityNote: '' }),
  ])('rejects invalid or unmatched posting %#', (l) =>
    expect(() => appendEntry(commissionPolicy(), l, statement(), 'e')).toThrow(),
  );
  it('rejects overlapping agreements but accepts explicit zero and separate renewal rates', () => {
    const plan = {
      id: 'producer',
      producerId: 'producer',
      name: 'Avery',
      version: 0,
      terms: [{ from: '2026-01-01', newBps: 1600, renewalBps: 800, agreement: 'Signed' }],
    };
    expect(validatePlan(plan).terms[0].renewalBps).toBe(800);
    expect(() =>
      validatePlan({ ...plan, terms: [...plan.terms, { ...plan.terms[0], from: '2026-06-01' }] }),
    ).toThrow(/overlap/);
    expect(() => validatePlan({ ...plan, terms: [{ ...plan.terms[0], newBps: 10001 }] })).toThrow();
  });
});

it('separates paid recovery proposals from adjustments to unpaid earnings', async () => {
  const { recoveryBalances } = await import('../../../shared/commissions');
  let p = appendEntry(commissionPolicy(), line(), statement(), 'receipt');
  p.entries[0].batchId = 'batch';
  p = appendEntry(
    p,
    line({ kind: 'REVERSAL', originalId: 'receipt', agencyCents: -100000 }),
    statement(),
    'reverse',
  );
  expect(recoveryBalances(p, [])).toEqual({ paidRecovery: 0, unpaidAdjustment: 16000 });
  const batch = {
    id: 'batch',
    status: 'PAID',
  } as import('../../../shared/commissions').CommissionBatch;
  expect(recoveryBalances(p, [batch])).toEqual({ paidRecovery: 16000, unpaidAdjustment: 0 });
  p = appendEntry(
    p,
    line({ kind: 'RESTORATION', originalId: 'reverse', agencyCents: 100000 }),
    statement(),
    'restore',
  );
  expect(recoveryBalances(p, [batch])).toEqual({ paidRecovery: 0, unpaidAdjustment: 0 });
  p = appendEntry(
    p,
    line({ kind: 'REVERSAL', originalId: 'restore', agencyCents: -50000 }),
    statement(),
    'reverse-again',
  );
  expect(recoveryBalances(p, [batch])).toEqual({ paidRecovery: 8000, unpaidAdjustment: 0 });
  expect(policyTotals(p).earned).toBe(16000);
});
it('rejects a mixed payroll snapshot instead of showing incorrect unpaid totals', async () => {
  const { validateAllocationSnapshot } = await import('../../../shared/commissions');
  const p = appendEntry(commissionPolicy(), line(), statement(), 'e');
  p.entries[0].batchId = 'batch';
  expect(() => validateAllocationSnapshot([p], [])).toThrow(/changed while loading/);
});
