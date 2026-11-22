import { describe, expect, it } from 'vitest';
import { initialPaymentTotals } from '../../../../shared/premiumFinance/initialPayment';

describe('initial-payment units and existing rounding policies', () => {
  it.each([
    { downPayment: 8435.52, originationFee: 10, brokerFeeCents: 50000, cents: 894552 },
    { downPayment: 0, originationFee: 0, brokerFeeCents: 0, cents: 0 },
    { downPayment: 0, originationFee: 10, brokerFeeCents: 1, cents: 1001 },
    { downPayment: 0.005, originationFee: 0.005, brokerFeeCents: 0, cents: 2 },
    { downPayment: 1.005, originationFee: 10, brokerFeeCents: 0, cents: 1100 },
    { downPayment: 0.1, originationFee: 0.2, brokerFeeCents: 0, cents: 30 },
    { downPayment: 999999.99, originationFee: 10, brokerFeeCents: 1, cents: 100001000 },
  ])('preserves historical receipt cents for $downPayment + $originationFee and $brokerFeeCents fee cents', value => {
    expect(initialPaymentTotals(value).totalCents).toBe(value.cents);
  });

  it.each([undefined, null, 0])('keeps a missing or zero broker fee outside premium and origination (%s)', brokerFeeCents => {
    expect(initialPaymentTotals({ downPayment: 2500.01, originationFee: 10, brokerFeeCents })).toEqual({
      premiumCents: 250001, originationFeeCents: 1000, brokerFeeCents: 0, totalCents: 251001,
    });
  });

  it.each([
    { downPayment: -1, originationFee: 10 },
    { downPayment: NaN, originationFee: 10 },
    { downPayment: Infinity, originationFee: 10 },
    { downPayment: 1, originationFee: -1 },
    { downPayment: 1, originationFee: NaN },
    { downPayment: 1, originationFee: Infinity },
  ])('retains checkout validation for invalid dollar inputs: %j', value => {
    expect(() => initialPaymentTotals(value)).toThrow('Invalid initial payment amount');
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid already-cent broker fee (%s)', brokerFeeCents => {
    expect(() => initialPaymentTotals({ downPayment: 1, originationFee: 10, brokerFeeCents })).toThrow('Invalid broker fee amount');
  });
});
