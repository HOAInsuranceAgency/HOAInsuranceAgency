import type { IpfsCollectionSource } from '../../../../shared/ipfsCollection';
import { advanceIpfsAgreement, normalizeIpfsQuoteRef, remainingIpfsOffersAfterBind } from '../../../../shared/ipfsAgreementAllocation';
import { ipfsAgreementKey, readIpfsAgreementBalance } from '../broker-fees/ipfsAgreements';
import { feePut, modelTable, versionCheck } from '../broker-fees/store';
import { loanWithoutCheckoutGuard } from '../broker-fees/payments';
import { isRetiredInvoiceSend, invoiceSendSettled } from '../send-invoice/sendOperation';
import type { Data, Transaction } from './store';

export const normalizedIpfsRef = normalizeIpfsQuoteRef;

/** Bind and offer preparation contend on the same private agreement balance. */
export async function allocateIpfsAgreement(accountId: string, reference: string, quote: IpfsCollectionSource & { id?: unknown }) {
  const id = ipfsAgreementKey(accountId, reference);
  const prior = await readIpfsAgreementBalance(accountId, reference);
  const next = advanceIpfsAgreement(quote, prior);
  const offers = remainingIpfsOffersAfterBind(prior, typeof quote.id === 'string' ? quote.id : undefined, next);
  const { split, ...balance } = next;
  const write = feePut({ ...prior, id, kind:'IPFS_AGREEMENT', accountId, ...balance, offers, hasBoundTerms:true }, prior);
  return { split, write };
}

/** The quote-edit workflow closes active offers and invoices. Bind only accepts
 * verified terminal records and rechecks them in the same policy transaction. */
export function assertPriorIpfsBilling(invoices: Data[], loans: Data[]): Transaction {
  const checks: Transaction = [];
  for (const invoice of invoices) {
    if (invoice.status !== 'VOID' || !invoiceSendSettled(invoice) ||
        ![1,2].includes(Number(invoice.sourcePricingVersion)) && (invoice.stripePaymentLinkId || invoice.paymentUrl) && !isRetiredInvoiceSend(invoice))
      throw new Error('Void the existing HOA invoice and resolve its payment or delivery before binding with IPFS.');
    checks.push(versionCheck(modelTable('Invoice'), invoice as {id:string;updatedAt:string}));
  }
  for (const loan of loans) {
    if (loan.status !== 'CANCELLED' || loan.electedAt || loan.agreementSignedAt || loan.downPaidAt ||
        loan.activatedAt || loan.cancellationEffectiveAt || loan.expectedCarrierRefundAt || Number(loan.paidThrough) > 0)
      throw new Error('Resolve the existing finance agreement or payment before binding with IPFS.');
    checks.push(loanWithoutCheckoutGuard(loan));
  }
  return checks;
}

/** Native metadata saves can repeat a timestamp. Fence the billing route and
 * payment owners themselves in the same write that closes the accepted quote. */
export function bindBillingConditions(quote: Data) {
  const names: Record<string,string> = {};
  const values: Data = {};
  const conditions: string[] = [];
  for (const [index, field] of ['billType','clientBillingSelected','carrierBillToAgency','ipfsAmountFinanced',
    'ipfsPriorBrokerFees','ipfsQuoteRef','ipfsRegisteredPolicyId','sourcePricingInvoiceId','sourcePricingLoanId'].entries()) {
    const name = '#billing' + index, token = ':billing' + index;
    names[name] = field;
    if (quote[field] !== undefined) { values[token] = quote[field]; conditions.push(name + ' = ' + token); }
    else conditions.push('attribute_not_exists(' + name + ')');
  }
  return { expression:conditions.join(' AND '), names, values };
}
