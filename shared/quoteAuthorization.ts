/** Exact business terms approved by the client; workflow timestamps are excluded. */
export function authorizedQuoteTerms(q: Record<string, unknown>) {
  const fields = ['carrierId','premium','effectiveDate','expirationDate','perOccurrenceDeductible','perUnitDeductible','blanketLimit','coinsurancePct','replacementCostType','glEachOccurrence','glDamageToRentedPremises','glMedicalExpense','glPersonalAdvInjury','glGeneralAggregate','glProductsCompletedOps','glClaimsMade','glAggregateAppliesTo','minimumEarnedPremiumPct'];
  return JSON.stringify({ ...Object.fromEntries(fields.map(k => [k,q[k] ?? null])), lines:Array.isArray(q.lines)?q.lines.filter(Boolean).map(String).sort():[] });
}
