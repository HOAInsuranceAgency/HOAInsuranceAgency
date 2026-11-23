import { brokerFeeCents } from './brokerFees';

export interface IpfsCollectionSource {
  ipfsAmountFinanced?: unknown;
  ipfsPriorBrokerFees?: number | null;
  ipfsQuoteRef?: unknown;
  clientBillingSelected?: unknown;
  brokerFee?: number | null;
  billType?: unknown;
  carrierBillToAgency?: unknown;
}

/** The IPFS quote supplies the agreement's financed amount in dollars. A missing
 * amount preserves the existing carrier or agency collection route. */
export function ipfsFinancedCents(amount: unknown): number {
  if (amount == null) return 0;
  const cents = typeof amount === 'number' ? Math.round(amount * 100) : NaN;
  if (!Number.isSafeInteger(cents * 3) || cents < 1 || Math.abs(Number(amount) * 100 - cents) > 0.00001) {
    throw new Error('Enter a positive IPFS amount in dollars and cents.');
  }
  return cents;
}

export function usesIpfs(source: object | null | undefined): boolean {
  return !!source && 'ipfsAmountFinanced' in source && source.ipfsAmountFinanced != null;
}

/** An unpresented draft with no lender reference has no issued request to close. */
export function needsIpfsClosure(source: { status?: unknown; ipfsQuoteRef?: unknown; presentedAt?: unknown; bindAuthorizedAt?: unknown } | null | undefined): boolean {
  return usesIpfs(source) && !!(source?.ipfsQuoteRef || source?.presentedAt || source?.bindAuthorizedAt || ['PRESENTED', 'BOUND'].includes(String(source?.status)));
}

export function ipfsFeeSplit(source: IpfsCollectionSource) {
  const amountCents = ipfsFinancedCents(source.ipfsAmountFinanced);
  const feeCents = brokerFeeCents(source.brokerFee);
  const priorFees = brokerFeeCents(source.ipfsPriorBrokerFees);
  const remainingCap = Math.max(0, Math.floor(amountCents * 3 / 10) - priorFees);
  const financedFeeCents = Math.min(feeCents, remainingCap);
  return { feeCents, financedFeeCents, downPaymentFeeCents: feeCents - financedFeeCents };
}

export function validateCollectionRoute(source: IpfsCollectionSource) {
  if (source.clientBillingSelected === true && source.billType !== 'AGENCY' && source.billType !== 'DIRECT') throw new Error('Select who collects the payment.');
  if (source.ipfsQuoteRef != null && (!usesIpfs(source) || typeof source.ipfsQuoteRef !== 'string' || !source.ipfsQuoteRef.trim() || source.ipfsQuoteRef.length > 200)) throw new Error('Enter a valid IPFS reference for this agreement.');
  if (brokerFeeCents(source.ipfsPriorBrokerFees) && !usesIpfs(source)) {
    throw new Error('Prior IPFS fees require a financed agreement.');
  }
  if (ipfsFinancedCents(source.ipfsAmountFinanced) && source.billType !== 'AGENCY') {
    throw new Error('IPFS collection requires agency billing.');
  }
  if (source.carrierBillToAgency === true && source.billType !== 'AGENCY') {
    throw new Error('Select agency billing for a carrier bill sent to HOA.');
  }
}
