import { normalizePassThroughCharges, PASS_THROUGH_CHARGE_KINDS } from '../../../../shared/passThroughCharges';
import { validateAdjustmentLines } from '../../../../shared/invoiceAdjustments';

interface ChargeSource { id?: string; accountId: string; premium?: number | null; billType?: string | null; passThroughCharges?: unknown; }
interface ChargeLine {
  accountId?: string | null; kind?: string | null; description?: string | null;
  sourceQuoteChargeId?: string | null; retailAmount?: number | null; costAmount?: number | null;
}
function cents(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > .00001) throw new Error('Record each invoice amount in whole cents.');
  return Math.round(value * 100);
}

/** Reviewed supplier charges are pass-throughs, never additional agency revenue. */
export function validateInvoiceSourceCharges(input: { invoice: { accountId: string; policyId?: string | null; status?: string | null; sourcePricingVersion?: number | null }; source: ChargeSource | null; lines: readonly ChargeLine[]; requireAll?: boolean }): void {
  const { invoice, source, lines } = input;
  if (source && source.accountId !== invoice.accountId) throw new Error('The invoice charges belong to a different account.');
  if(invoice.sourcePricingVersion===2) {
    if(!invoice.policyId||!source||source.id!==invoice.policyId)throw new Error('The original policy is required for this adjustment invoice.');
    if(lines.some(line=>line.accountId!==invoice.accountId))throw new Error('The adjustment line belongs to a different account.');
    validateAdjustmentLines(lines,{complete:input.requireAll!==false,billType:source.billType});
    return;
  }
  const legacy = invoice.sourcePricingVersion == null;
  const charges = legacy && !lines.some(line=>line.sourceQuoteChargeId) ? [] : normalizePassThroughCharges(source?.passThroughCharges);
  const byId = new Map(charges.map(charge => [charge.id, charge]));
  const initial = invoice.sourcePricingVersion === 1;
  // These values come from the persisted invoice and its actual loaded Policy,
  // never a caller-supplied "legacy" switch. New binds always store an array.
  const legacyPolicy = initial && !!invoice.policyId && !!source && invoice.policyId === source.id && source.passThroughCharges == null;
  if(invoice.sourcePricingVersion != null && !initial)throw new Error('The invoice source pricing version is not supported.');
  if(initial) {
    if(!source)throw new Error('The original quote or policy is required for this initial invoice.');
    if(lines.some(line=>!['PREMIUM','BROKER_FEE',...PASS_THROUGH_CHARGE_KINDS].includes(line.kind??'')))throw new Error('An initial policy invoice may only bill its reviewed premium, supplier charges and HOA broker fee.');
    const premiums=lines.filter(line=>line.kind==='PREMIUM');
    if(source.billType==='DIRECT') {
      if(premiums.length)throw new Error('A direct-bill initial invoice cannot collect the carrier premium.');
    } else if((input.requireAll!==false&&premiums.length!==1)||premiums.some(line=>cents(line.retailAmount)!==cents(source.premium)))throw new Error('The initial invoice must contain the source quote gross premium exactly once. Change the quote before changing the client price.');
  }
  const seen = new Set<string>(), structured = !legacy&&(charges.length > 0 || initial && !legacyPolicy);
  for (const line of lines) {
    if (input.requireAll !== false && ['PREMIUM', 'ENDORSEMENT'].includes(line.kind ?? '') && Number(line.retailAmount) > 0 && (line.costAmount == null || typeof line.costAmount !== 'number' || !Number.isFinite(line.costAmount) || line.costAmount < 0)) throw new Error('Enter the actual carrier or wholesaler remittance cost for each premium line before sending. An explicitly reviewed zero cost is allowed.');
    const passThroughKind = PASS_THROUGH_CHARGE_KINDS.includes(line.kind as typeof PASS_THROUGH_CHARGE_KINDS[number]);
    if (!line.sourceQuoteChargeId && !passThroughKind) continue;
    if (line.accountId !== invoice.accountId) throw new Error('The invoice charge belongs to a different account.');
    const amount = cents(line.retailAmount), cost = cents(line.costAmount);
    if (amount !== cost) throw new Error('Carrier, wholesaler and tax charges must pass through at their actual cost without agency markup.');
    if (!line.sourceQuoteChargeId) {
      if (structured || !legacy&&!legacyPolicy && ['CARRIER_FEE', 'WHOLESALER_FEE'].includes(line.kind ?? '')) throw new Error('Each pass-through invoice charge must match its reviewed source quote charge.');
      if(legacyPolicy&&(amount<0||input.requireAll!==false&&amount===0))throw new Error('Enter a positive supplier or tax charge before sending. Draft charge amounts cannot be negative.');
      if(legacyPolicy&&input.requireAll!==false&&(typeof line.description!=='string'||!line.description.trim()||line.description.length>160||/[\x00-\x1f\x7f]/.test(line.description)))throw new Error('Give each supplier or tax charge a client label of no more than 160 characters before sending.');
      continue; // Preserve existing manually entered tax/stamping lines on legacy sources.
    }
    const charge = byId.get(line.sourceQuoteChargeId);
    if (!charge || seen.has(charge.id) || line.kind !== charge.kind || line.description?.trim() !== charge.description || amount !== charge.amountCents) throw new Error('An invoice pass-through charge is duplicated or differs from its reviewed source quote. Refresh the invoice charges.');
    seen.add(charge.id);
  }
  if (!legacy&&input.requireAll !== false && seen.size !== charges.length) throw new Error('A reviewed carrier, wholesaler or tax charge is missing from the invoice. Refresh the invoice charges before sending.');
}
