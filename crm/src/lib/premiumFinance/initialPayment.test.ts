import { describe, expect, it } from 'vitest';
import {
  initialPaymentTotalDollars,
  initialPaymentTotalRoundedDollars,
  initialPaymentTotals,
} from '../../../../shared/premiumFinance/initialPayment';

describe('initial-payment units and existing rounding policies', () => {
  it.each([
    { downPayment: 8435.52, originationFee: 10, brokerFee: 500, brokerFeeCents: 50000, cents: 894552, raw: 8945.52, rounded: 8945.52 },
    { downPayment: 0, originationFee: 0, brokerFee: 0, brokerFeeCents: 0, cents: 0, raw: 0, rounded: 0 },
    { downPayment: 0, originationFee: 10, brokerFee: 0.01, brokerFeeCents: 1, cents: 1001, raw: 10.01, rounded: 10.01 },
    { downPayment: 0.005, originationFee: 0.005, brokerFee: 0, brokerFeeCents: 0, cents: 2, raw: 0.01, rounded: 0.01 },
    { downPayment: 1.005, originationFee: 10, brokerFee: 0, brokerFeeCents: 0, cents: 1100, raw: 11.004999999999999, rounded: 11.01 },
    { downPayment: 0.1, originationFee: 0.2, brokerFee: 0, brokerFeeCents: 0, cents: 30, raw: 0.30000000000000004, rounded: 0.3 },
    { downPayment: 999999.99, originationFee: 10, brokerFee: 0.01, brokerFeeCents: 1, cents: 100001000, raw: 1000010, rounded: 1000010 },
  ])('preserves checkout cents and dollar presentation for $downPayment + $originationFee + $brokerFee', value => {
    expect(initialPaymentTotals(value).totalCents).toBe(value.cents);
    expect(initialPaymentTotalDollars(value)).toBe(value.raw);
    expect(initialPaymentTotalRoundedDollars(value)).toBe(value.rounded);
  });

  it.each([undefined, null, 0])('keeps a missing or zero broker fee outside premium and origination (%s)', brokerFeeCents => {
    expect(initialPaymentTotals({ downPayment: 2500.01, originationFee: 10, brokerFeeCents })).toEqual({
      premiumCents: 250001, originationFeeCents: 1000, brokerFeeCents: 0, totalCents: 251001,
    });
    expect(initialPaymentTotalDollars({ downPayment: 2500.01, originationFee: 10, brokerFee: brokerFeeCents })).toBe(2510.01);
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
