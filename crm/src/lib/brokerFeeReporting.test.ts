import { expect, it } from 'vitest';
import { brokerFeeBalances } from './brokerFeeReporting';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';

it('keeps gross receipts and refunds distinct without recharging a refunded fee', () => {
  expect(brokerFeeBalances([
    { id: 'cancelled', accountId: 'a', status: 'CANCELLED', brokerFee: 500, brokerFeeCollected: 500, brokerFeeRefunded: 100 },
    { id: 'unpaid', accountId: 'b', brokerFee: 200, brokerFeeCollected: 50 },
  ])).toEqual({ booked: 700, grossCollected: 550, refunded: 100, netCollected: 450, netRevenue: 600, uncollected: 150, count: 2 });
});

it('fails inconsistent or duplicated fee aggregates instead of overstating income', () => {
  const policy = { id: 'p', accountId: 'a', brokerFee: 100, brokerFeeCollected: 101 };
  expect(() => brokerFeeBalances([policy])).toThrow('reconciliation');
  expect(() => brokerFeeBalances([{ ...policy, brokerFeeCollected: 50, brokerFeeRefunded: 60 }])).toThrow('reconciliation');
  expect(() => brokerFeeBalances([{ id: 'p', accountId: 'a' }, { id: 'p', accountId: 'a' }])).toThrow('repeated');
});

it('preserves fee-free authorization fingerprints but invalidates acceptance when a fee changes', () => {
  const quote = { premium: 1000, lines: ['Property'], commissionPct: 10 };
  expect(authorizedQuoteTerms(quote)).toBe(authorizedQuoteTerms({ ...quote, brokerFee: 0 }));
  expect(authorizedQuoteTerms(quote)).toBe(authorizedQuoteTerms({ ...quote, brokerFee: null }));
  expect(authorizedQuoteTerms({ ...quote, brokerFee: 500 })).not.toBe(authorizedQuoteTerms({ ...quote, brokerFee: 501 }));
  expect(authorizedQuoteTerms({ ...quote, brokerFee: 500 })).not.toBe(authorizedQuoteTerms({ ...quote, brokerFee: 0 }));
  expect(authorizedQuoteTerms({ ...quote, brokerFee: 500, billType: 'DIRECT' })).not.toBe(authorizedQuoteTerms({ ...quote, brokerFee: 500, billType: 'AGENCY' }));
});
