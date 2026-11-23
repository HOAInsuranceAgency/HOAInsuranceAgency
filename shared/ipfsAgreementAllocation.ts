import { brokerFeeCents } from './brokerFees';
import { ipfsFeeSplit, ipfsFinancedCents, usesIpfs, validateCollectionRoute, type IpfsCollectionSource } from './ipfsCollection';

export class IpfsAllocationError extends Error {}

export type IpfsFeeOffer = {
  feeCents: number; financedFeeCents: number; priorFeeCents: number;
  termsHash: string; expiresAt: string | null;
};
type BoundAmounts = { amountFinancedCents: number; brokerFeesCents: number; financedBrokerFeesCents: number };
export type IpfsAgreementBalance = BoundAmounts & {
  id: string; kind: 'IPFS_AGREEMENT'; accountId: string; version: number;
  hasBoundTerms?: boolean;
  offers?: Record<string, IpfsFeeOffer>;
};

export function normalizeIpfsQuoteRef(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

/** Pricing cannot infer a shared agreement from coincidentally equal dollar amounts. */
export function ipfsOfferGroups<T extends IpfsCollectionSource>(quotes: readonly T[]) {
  const financed = quotes.filter(usesIpfs);
  const groups = new Map<string, T[]>();
  for (const quote of financed) {
    validateCollectionRoute(quote);
    const ref = typeof quote.ipfsQuoteRef === 'string' ? normalizeIpfsQuoteRef(quote.ipfsQuoteRef) : '';
    if (!ref) {
      if (financed.length > 1 || brokerFeeCents(quote.brokerFee) || brokerFeeCents(quote.ipfsPriorBrokerFees)) {
        throw new IpfsAllocationError('Enter the IPFS quote or agreement reference on each financed policy before presenting these terms.');
      }
      continue;
    }
    const group = groups.get(ref) ?? [];
    if (group.length && ipfsFinancedCents(group[0].ipfsAmountFinanced) !== ipfsFinancedCents(quote.ipfsAmountFinanced)) {
      throw new IpfsAllocationError('Use the same amount financed for policies on the same IPFS agreement.');
    }
    group.push(quote);
    groups.set(ref, group);
  }
  return groups;
}

function validateAmounts(prior: BoundAmounts, amountFinancedCents: number) {
  if (prior.amountFinancedCents !== amountFinancedCents) throw new IpfsAllocationError('The IPFS amount financed must match the existing agreement for this account.');
  if (!Number.isSafeInteger(prior.brokerFeesCents) || prior.brokerFeesCents < 0
    || prior.financedBrokerFeesCents !== Math.min(Math.floor(amountFinancedCents * 3 / 10), prior.brokerFeesCents)) {
    throw new IpfsAllocationError('Review the recorded IPFS agreement allocation before continuing.');
  }
}

export function advanceIpfsAgreement(quote: IpfsCollectionSource, prior?: BoundAmounts) {
  const amountFinancedCents = ipfsFinancedCents(quote.ipfsAmountFinanced);
  if (prior) validateAmounts(prior, amountFinancedCents);
  const split = ipfsFeeSplit(quote);
  const brokerFeesCents = (prior?.brokerFeesCents ?? 0) + split.feeCents;
  const financedBrokerFeesCents = (prior?.financedBrokerFeesCents ?? 0) + split.financedFeeCents;
  if (!Number.isSafeInteger(brokerFeesCents) || financedBrokerFeesCents !== Math.min(Math.floor(amountFinancedCents * 3 / 10), brokerFeesCents)) {
    throw new IpfsAllocationError('The broker fee split differs from the remaining cap on this IPFS agreement. Check fees from other policies and bind earlier terms first.');
  }
  return { amountFinancedCents, brokerFeesCents, financedBrokerFeesCents, split };
}

/** Every promised split must still be possible after accounting for bound
 * policies and earlier fee allocations on the lender quote. */
export function validateIpfsOffers(offers: Record<string, IpfsFeeOffer>, bound: BoundAmounts) {
  validateAmounts(bound, bound.amountFinancedCents);
  const cap = Math.floor(bound.amountFinancedCents * 3 / 10);
  let allocated = bound.brokerFeesCents;
  for (const offer of Object.values(offers).sort((a, b) => a.priorFeeCents - b.priorFeeCents || b.financedFeeCents - a.financedFeeCents)) {
    if (!Number.isSafeInteger(offer.feeCents) || offer.feeCents <= 0 || !Number.isSafeInteger(offer.priorFeeCents) || offer.priorFeeCents < 0
      || offer.financedFeeCents !== Math.min(offer.feeCents, Math.max(0, cap - allocated))) {
      throw new IpfsAllocationError('The proposed fee split conflicts with other policies on this IPFS agreement. Check the agreement reference and broker fees allocated before each policy.');
    }
    allocated += offer.feeCents;
    if (!Number.isSafeInteger(allocated)) throw new IpfsAllocationError('Review the total broker fees on the IPFS agreement.');
  }
}

export function remainingIpfsOffersAfterBind(prior: IpfsAgreementBalance | undefined, quoteId: string | undefined, next: ReturnType<typeof advanceIpfsAgreement>) {
  const offers = { ...prior?.offers };
  if (quoteId) delete offers[quoteId];
  validateIpfsOffers(offers, next);
  return offers;
}
