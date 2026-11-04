/** Shared with compact read-model builders so approval comparisons retain every term. */
export const AUTHORIZED_QUOTE_TERM_FIELDS = ['carrierId','premium','effectiveDate','expirationDate','perOccurrenceDeductible','perUnitDeductible','blanketLimit','coinsurancePct','replacementCostType','glEachOccurrence','glDamageToRentedPremises','glMedicalExpense','glPersonalAdvInjury','glGeneralAggregate','glProductsCompletedOps','glClaimsMade','glAggregateAppliesTo','minimumEarnedPremiumPct'] as const;
/** Exact business terms approved by the client; workflow timestamps are excluded. */
export function authorizedQuoteTerms(q: Record<string, unknown>) {
  return JSON.stringify({ ...Object.fromEntries(AUTHORIZED_QUOTE_TERM_FIELDS.map(k => [k,q[k] ?? null])), lines:Array.isArray(q.lines)?q.lines.filter(Boolean).map(String).sort():[] });
}
