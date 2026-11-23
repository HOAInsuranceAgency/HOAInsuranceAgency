import { createHash } from 'node:crypto';
import type { BrokerFeeQuote } from '../../../../shared/brokerFees';
import { brokerFeeCents } from '../../../../shared/brokerFees';
import { ipfsFeeSplit, ipfsFinancedCents } from '../../../../shared/ipfsCollection';
import { IpfsAllocationError, ipfsOfferGroups, normalizeIpfsQuoteRef, validateIpfsOffers, type IpfsAgreementBalance, type IpfsFeeOffer } from '../../../../shared/ipfsAgreementAllocation';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import { feePut, getModel, getRow, type Write } from './store';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function ipfsAgreementKey(accountId: string, reference: string): string {
  return 'ipfs-agreement:' + hash(JSON.stringify([accountId, normalizeIpfsQuoteRef(reference)]));
}

export async function readIpfsAgreementBalance(accountId: string, reference: string): Promise<IpfsAgreementBalance | undefined> {
  const id = ipfsAgreementKey(accountId, reference);
  const row = await getRow<IpfsAgreementBalance>(id);
  if (!row) return undefined;
  if (row.id !== id || row.kind !== 'IPFS_AGREEMENT' || row.accountId !== accountId) throw new Error('The stored IPFS agreement could not be verified.');
  const entries = Object.entries(row.offers ?? {}), active: [string, IpfsFeeOffer][] = [];
  for (let offset = 0; offset < entries.length; offset += 5) {
    const batch = await Promise.all(entries.slice(offset, offset + 5).map(async ([quoteId, offer]) => {
      if (offer.expiresAt != null && Date.parse(offer.expiresAt) <= Date.now()) return null;
      const quote = await getModel<Record<string, unknown>>('Quote', quoteId);
      if (quote?.accountId !== accountId || !['QUOTED', 'PRESENTED'].includes(String(quote.status)) || hash(authorizedQuoteTerms(quote)) !== offer.termsHash) return null;
      return [quoteId, offer] as [string, IpfsFeeOffer];
    }));
    for (const item of batch) if (item) active.push(item);
  }
  return { ...row, offers: Object.fromEntries(active) };
}

export async function ipfsOfferWrites(accountId: string, quotes: readonly BrokerFeeQuote[], expiresAt: string | null): Promise<Write[]> {
  const writes: Write[] = [];
  for (const [reference, group] of ipfsOfferGroups(quotes)) {
    const prior = await readIpfsAgreementBalance(accountId, reference);
    const amountFinancedCents = ipfsFinancedCents(group[0].ipfsAmountFinanced);
    if (prior && prior.amountFinancedCents !== amountFinancedCents &&
      (prior.hasBoundTerms || prior.brokerFeesCents || Object.keys(prior.offers ?? {}).length)) throw new IpfsAllocationError('The IPFS amount financed must match the existing agreement for this account.');
    const balance: IpfsAgreementBalance = prior ?? { kind: 'IPFS_AGREEMENT', id: ipfsAgreementKey(accountId, reference), accountId, amountFinancedCents, brokerFeesCents: 0, financedBrokerFeesCents: 0, version: 0 };
    const offers = new Map(Object.entries(balance.offers ?? {}));
    for (const quote of group) {
      const split = ipfsFeeSplit(quote);
      if (!split.feeCents) continue;
      const termsHash = hash(quote.terms), previous = offers.get(quote.id);
      let through = expiresAt;
      if (previous?.termsHash === termsHash) {
        if (previous.expiresAt === null) through = null;
        else if (through && previous.expiresAt > through) through = previous.expiresAt;
      }
      offers.set(quote.id, { feeCents: split.feeCents, financedFeeCents: split.financedFeeCents,
        priorFeeCents: brokerFeeCents(quote.ipfsPriorBrokerFees), termsHash,
        expiresAt: through });
    }
    const next = { ...balance, amountFinancedCents, offers: Object.fromEntries(offers) };
    validateIpfsOffers(next.offers, next);
    if (expiresAt === null) {
      // A signed down-payment split must survive expiry of another package's
      // unsigned offer. Terms in this signature are promoted together.
      const signed = Object.fromEntries([...offers].filter(([, offer]) => offer.expiresAt === null));
      try { validateIpfsOffers(signed, next); }
      catch (error) {
        if (error instanceof IpfsAllocationError) throw new IpfsAllocationError('An earlier policy on this IPFS quote must be signed first. Ask the agency for the current disclosure.');
        throw error;
      }
    }
    // The same version is used by presenting, signing and binding. Concurrent
    // callers must recalculate if the other transaction commits first.
    writes.push(feePut(next, prior));
  }
  return writes;
}
