import { brokerFeeCents } from './brokerFees';
import { normalizeClientConditions, normalizePassThroughCharges } from './passThroughCharges';
/** Shared with compact read-model builders so approval comparisons retain every term. */
export const AUTHORIZED_QUOTE_TERM_FIELDS = ['carrierId','premium','effectiveDate','expirationDate','perOccurrenceDeductible','perUnitDeductible','blanketLimit','coinsurancePct','replacementCostType','glEachOccurrence','glDamageToRentedPremises','glMedicalExpense','glPersonalAdvInjury','glGeneralAggregate','glProductsCompletedOps','glClaimsMade','glAggregateAppliesTo','minimumEarnedPremiumPct'] as const;
/** Exact business terms approved by the client; workflow timestamps are excluded. */
export function authorizedQuoteTerms(q: Record<string, unknown>) {
  // Keep the exact legacy fingerprint for fee-free quotes. A positive fee is
  // part of the client's accepted cost, so changing it invalidates approval.
  const fee = brokerFeeCents(q.brokerFee as number | null | undefined);
  const charges = normalizePassThroughCharges(q.passThroughCharges), conditions = normalizeClientConditions(q.clientConditions);
  return JSON.stringify({ ...Object.fromEntries(AUTHORIZED_QUOTE_TERM_FIELDS.map(k => [k,q[k] ?? null])), lines:Array.isArray(q.lines)?q.lines.filter(Boolean).map(String).sort():[], ...(fee > 0 ? { brokerFee: fee / 100, billType: q.billType ?? null } : {}), ...(charges.length ? { passThroughCharges: charges } : {}), ...(conditions ? { clientConditions: conditions } : {}) });
}
