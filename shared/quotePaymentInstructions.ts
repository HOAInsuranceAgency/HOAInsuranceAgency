import { ipfsFeeSplit, usesIpfs, validateCollectionRoute, type IpfsCollectionSource } from './ipfsCollection';
import { formatUsdCents } from './money';

/** Client-facing instructions for one policy, shared by email, proposal and signed disclosure. */
export function quotePaymentInstructions(quote: IpfsCollectionSource): string {
  validateCollectionRoute(quote);
  if (usesIpfs(quote)) {
    const { feeCents, financedFeeCents, downPaymentFeeCents } = ipfsFeeSplit(quote);
    const collector = 'Pay IPFS for your down payment and installments.';
    if (!feeCents) return collector;
    if (!downPaymentFeeCents) return `${collector} The full ${formatUsdCents(feeCents)} broker fee is financed.`;
    if (!financedFeeCents) return `${collector} The full ${formatUsdCents(feeCents)} broker fee is included in the IPFS down payment.`;
    return `${collector} Of your broker fee, ${formatUsdCents(financedFeeCents)} is financed and ${formatUsdCents(downPaymentFeeCents)} is due with your down payment.`;
  }
  if (quote.billType === 'AGENCY') {
    const invoice = 'Agency billed - pay HOA Insurance Agency using your invoice payment link.';
    return quote.brokerFee ? `${invoice} Your broker fee is due in full.` : invoice;
  }
  if (quote.billType === 'DIRECT') return 'Pay the carrier directly according to its billing instructions.';
  return 'Contact HOA Insurance Agency to confirm the payment arrangements for this policy.';
}
