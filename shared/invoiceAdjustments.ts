import { PASS_THROUGH_CHARGE_KINDS } from './passThroughCharges';

export interface AdjustmentPolicy { id: string; accountId: string; quoteId?: string | null; billType?: string | null; }
export interface OriginalInvoice {
  id: string; accountId: string; policyId?: string | null; quoteId?: string | null; status?: string | null;
  sourcePricingVersion?: number | null; adjustsInvoiceId?: string | null; adjustsPremiumLineId?: string | null;
}
export interface OriginalPremiumLine { id: string; invoiceId: string; accountId?: string | null; policyId?: string | null; kind?: string | null; retailAmount?: number | null; }
const wholeCents = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < .00001;

/** UI discovery and trusted rereads share the same original-invoice rules. */
export function isPaidOriginalPremium(policy: AdjustmentPolicy, invoice: OriginalInvoice, line: OriginalPremiumLine): boolean {
  if (!policy.id || !invoice.id || !line.id || invoice.accountId !== policy.accountId || invoice.status !== 'PAID' || invoice.sourcePricingVersion != null && invoice.sourcePricingVersion !== 1 || invoice.adjustsInvoiceId || invoice.adjustsPremiumLineId) return false;
  if (invoice.policyId) { if(invoice.policyId!==policy.id)return false; }
  else if(invoice.quoteId) { if(!policy.quoteId||invoice.quoteId!==policy.quoteId)return false; }
  else if(invoice.sourcePricingVersion!=null||line.policyId!==policy.id)return false;
  if (invoice.quoteId && policy.quoteId && invoice.quoteId !== policy.quoteId) return false;
  return line.invoiceId === invoice.id && line.kind === 'PREMIUM' && wholeCents(line.retailAmount) && line.retailAmount > 0 && (!line.accountId || line.accountId === policy.accountId) && (!line.policyId || line.policyId === policy.id);
}
export interface AdjustmentLine {
  kind?: string | null; description?: string | null; retailAmount?: number | null; costAmount?: number | null;
  sourceQuoteChargeId?: string | null; brokerFeeQuoteId?: string | null;
}
/** Version two bills a signed delta, never the original term premium or fees. */
export function validateAdjustmentLines(lines: readonly AdjustmentLine[], options: { complete?: boolean; billType?: string | null } = {}): void {
  const complete = options.complete !== false;
  if (complete && !lines.length) throw new Error('Record an endorsement, audit or supplier adjustment before sending.');
  for (const line of lines) {
    if (!['ENDORSEMENT', ...PASS_THROUGH_CHARGE_KINDS].includes(line.kind ?? '') || line.sourceQuoteChargeId || line.brokerFeeQuoteId) throw new Error('An adjustment may bill only endorsement or audit premium and its supplier or tax adjustments. Original premium and broker fees cannot be billed again.');
    if (line.kind === 'ENDORSEMENT' && options.billType === 'DIRECT') throw new Error('The carrier collects endorsement premium on a direct-bill policy.');
    if (complete && (typeof line.description !== 'string' || !line.description.trim() || line.description.length > 160 || /[\x00-\x1f\x7f]/.test(line.description))) throw new Error('Give each adjustment a client label of no more than 160 characters before sending.');
    if (line.retailAmount == null && !complete) continue;
    if (!wholeCents(line.retailAmount) || complete && line.retailAmount === 0) throw new Error('Enter a nonzero adjustment amount in whole cents before sending.');
    if (line.costAmount == null && !complete) continue;
    if (!wholeCents(line.costAmount)) throw new Error('Enter the actual carrier or wholesaler adjustment cost in whole cents before sending.');
    if (line.kind === 'ENDORSEMENT') {
      if (line.costAmount !== 0 && line.retailAmount !== 0 && Math.sign(line.costAmount) !== Math.sign(line.retailAmount)) throw new Error('The adjustment premium and actual cost must have the same sign; an explicitly reviewed zero cost is allowed.');
    } else if (Math.round(line.retailAmount * 100) !== Math.round(line.costAmount * 100)) throw new Error('Supplier and tax adjustments must pass through at actual cost without agency markup.');
  }
}
