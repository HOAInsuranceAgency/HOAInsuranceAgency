import { expect, it } from 'vitest';
import { ipfsFeeSplit, ipfsFinancedCents, validateCollectionRoute } from '../../../shared/ipfsCollection';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';

it.each([[0,0,0],[2500,250000,0],[3000,300000,0],[3500,300000,50000]])(
  'allocates one $%s fee against $10,000 financed', (brokerFee, financedFeeCents, downPaymentFeeCents) => {
    expect(ipfsFeeSplit({ ipfsAmountFinanced: 10000, brokerFee })).toEqual({ feeCents: brokerFee*100, financedFeeCents, downPaymentFeeCents });
  },
);
it('never exceeds 30% on a fractional cent', () => {
  expect(ipfsFeeSplit({ ipfsAmountFinanced: 100.03, brokerFee: 30.01 })).toEqual({ feeCents: 3001, financedFeeCents: 3000, downPaymentFeeCents: 1 });
});
it.each([0, -1, 0.001, '200', NaN, Infinity])('rejects an invalid financed amount %s', amount => {
  expect(() => ipfsFinancedCents(amount)).toThrow('positive IPFS amount');
});
it('protects the payment route in fee-free as well as fee-bearing authorizations', () => {
  for (const brokerFee of [0, 3500]) {
    const pif = { billType: 'AGENCY', brokerFee };
    const ipfs = { ...pif, ipfsAmountFinanced: 10000 };
    expect(authorizedQuoteTerms(pif)).toEqual(authorizedQuoteTerms({ ...pif, ipfsAmountFinanced: null }));
    expect(authorizedQuoteTerms(ipfs)).not.toEqual(authorizedQuoteTerms(pif));
    expect(authorizedQuoteTerms(ipfs)).not.toEqual(authorizedQuoteTerms({ ...ipfs, ipfsAmountFinanced: 9000 }));
  }
  expect(() => validateCollectionRoute({ billType: 'DIRECT', ipfsAmountFinanced: 10000 })).toThrow();
});

it('shares the cap across fees on the same agreement', () => {
  const first = ipfsFeeSplit({ ipfsAmountFinanced: 10000, brokerFee: 2000 });
  const next = ipfsFeeSplit({ ipfsAmountFinanced: 10000, ipfsPriorBrokerFees: 2000, brokerFee: 1500 });
  expect(first.financedFeeCents + next.financedFeeCents).toBe(300000);
  expect(next.downPaymentFeeCents).toBe(50000);
  expect(() => validateCollectionRoute({ ipfsPriorBrokerFees: 2000 })).toThrow();
});
