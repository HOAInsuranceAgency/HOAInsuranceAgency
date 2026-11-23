import { ipfsFinancedCents } from './ipfsCollection';
import { brokerFeeCents } from './brokerFees';
import { normalizeClientConditions, normalizePassThroughCharges } from './passThroughCharges';
/** Exact business terms approved by the client; workflow timestamps are excluded. */
export function authorizedQuoteTerms(q: Record<string, unknown>) {
  const fields = ['carrierId','premium','effectiveDate','expirationDate','perOccurrenceDeductible','perUnitDeductible','blanketLimit','coinsurancePct','replacementCostType','glEachOccurrence','glDamageToRentedPremises','glMedicalExpense','glPersonalAdvInjury','glGeneralAggregate','glProductsCompletedOps','glClaimsMade','glAggregateAppliesTo','minimumEarnedPremiumPct'];
  // Keep the exact legacy fingerprint for fee-free quotes. A positive fee is
  // part of the client's accepted cost, so changing it invalidates approval.
  const fee = brokerFeeCents(q.brokerFee as number | null | undefined);
  const financedCents = ipfsFinancedCents(q.ipfsAmountFinanced);
  const priorIpfsCents = brokerFeeCents(q.ipfsPriorBrokerFees as number | null | undefined);
  const charges = normalizePassThroughCharges(q.passThroughCharges), conditions = normalizeClientConditions(q.clientConditions);
  return JSON.stringify({ ...Object.fromEntries(fields.map(k => [k,q[k] ?? null])), lines:Array.isArray(q.lines)?q.lines.filter(Boolean).map(String).sort():[], ...(fee > 0 ? { brokerFee: fee / 100, billType: q.billType ?? null } : {}), ...(financedCents ? { ipfsAmountFinanced: financedCents / 100 } : {}), ...(typeof q.ipfsQuoteRef === 'string' && q.ipfsQuoteRef.trim() ? { ipfsQuoteRef: q.ipfsQuoteRef.trim() } : {}), ...(!fee && q.clientBillingSelected === true ? { clientBillType: q.billType ?? null } : {}), ...(priorIpfsCents ? { ipfsPriorBrokerFees: priorIpfsCents / 100 } : {}), ...(q.carrierBillToAgency === true ? { carrierBillToAgency: true } : {}), ...(charges.length ? { passThroughCharges: charges } : {}), ...(conditions ? { clientConditions: conditions } : {}) });
}
