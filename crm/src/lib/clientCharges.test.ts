import { describe, expect, it } from 'vitest';
import { clientChargeBreakdown, clientChargeTotals } from '../../../shared/clientCharges';

const charge = (amountCents: number) => ({ id: 'supplier', kind: 'WHOLESALER_FEE', description: 'Supplier placement fee', amountCents });

describe('quoted client charge breakdown', () => {
  it('keeps gross premium, supplier charges and HOA fees separate in exact cents', () => {
    expect(clientChargeBreakdown({ premium: 55541, brokerFee: 500, passThroughCharges: JSON.stringify([
      charge(25000), { id: 'tax', kind: 'SURPLUS_LINES', description: 'Surplus lines tax', amountCents: 222164 },
    ]) })).toEqual({ premiumCents: 5554100, passThroughCents: 247164, brokerFeeCents: 50000, clientTotalCents: 5851264 });
  });

  it('supports zero and absent legacy charge fields without changing the premium', () => {
    expect(clientChargeBreakdown({ premium: 0, brokerFee: 0, passThroughCharges: [] })).toEqual({ premiumCents: 0, passThroughCents: 0, brokerFeeCents: 0, clientTotalCents: 0 });
    expect(clientChargeBreakdown({ premium: 19.99 })).toEqual({ premiumCents: 1999, passThroughCents: 0, brokerFeeCents: 0, clientTotalCents: 1999 });
    expect(clientChargeTotals([])).toEqual(clientChargeBreakdown({}));
  });

  it('adds cents before converting to dollars, avoiding floating-point accumulation', () => {
    expect(clientChargeBreakdown({ premium: .1, brokerFee: .2, passThroughCharges: [charge(1)] }).clientTotalCents).toBe(31);
  });

  it('rounds each recorded premium once, preserving the existing multi-policy rule', () => {
    expect(clientChargeTotals([{ premium: .104 }, { premium: .104 }])).toEqual({ premiumCents: 20, passThroughCents: 0, brokerFeeCents: 0, clientTotalCents: 20 });
    expect(clientChargeBreakdown({ premium: 1.236 }).premiumCents).toBe(124);
  });

  it('aggregates only the supplied policies, keeping every component independently visible', () => {
    expect(clientChargeTotals([
      { premium: 100.01, brokerFee: 10.02, passThroughCharges: [charge(503)] },
      { premium: 200.02, passThroughCharges: [charge(709)] },
      { premium: 0, brokerFee: 0 },
    ])).toEqual({ premiumCents: 30003, passThroughCents: 1212, brokerFeeCents: 1002, clientTotalCents: 32217 });
  });

  it('retains large safe amounts and rejects overflow in either a policy or package', () => {
    expect(clientChargeBreakdown({ premium: 90_000_000_000_000, brokerFee: 10_000_000, passThroughCharges: [charge(1_000_000_000)] })).toEqual({ premiumCents: 9_000_000_000_000_000, passThroughCents: 1_000_000_000, brokerFeeCents: 1_000_000_000, clientTotalCents: 9_000_002_000_000_000 });
    expect(() => clientChargeBreakdown({ premium: 90_071_992_547_400, brokerFee: 10 })).toThrow(/supported amount/);
    expect(() => clientChargeTotals([{ premium: 90_000_000_000_000 }, { premium: 90_000_000_000_000 }])).toThrow(/supported amount/);
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])('rejects invalid or unsafe premium %s', premium => {
    expect(() => clientChargeBreakdown({ premium })).toThrow();
  });

  it('reuses strict fee and supplier-charge validation rather than rounding invalid charges', () => {
    expect(() => clientChargeBreakdown({ premium: 100, brokerFee: .001 })).toThrow(/two decimal places/);
    expect(() => clientChargeBreakdown({ premium: 100, passThroughCharges: [charge(.5)] })).toThrow(/whole cents/);
    expect(() => clientChargeBreakdown({ premium: 100, passThroughCharges: [charge(0)] })).toThrow(/positive/);
    expect(() => clientChargeBreakdown({ premium: 100, passThroughCharges: [charge(1_000_000_001)] })).toThrow(/supported limit/);
    expect(() => clientChargeTotals([{ premium: 100 }, { premium: 200, passThroughCharges: '{bad-json' }])).toThrow();
  });

  it('returns only client amounts and never reads or propagates private model fields', () => {
    const source = { premium: 100, brokerFee: 5, passThroughCharges: [charge(200)] };
    for (const key of ['commissionPct', 'costAmount', 'producerId', 'notes', 'accountId']) Object.defineProperty(source, key, { enumerable: true, get: () => { throw new Error('Private field read'); } });
    expect(clientChargeBreakdown(source)).toEqual({ premiumCents: 10000, passThroughCents: 200, brokerFeeCents: 500, clientTotalCents: 10700 });
    expect(clientChargeTotals([source])).toEqual(clientChargeBreakdown(source));
  });
});
