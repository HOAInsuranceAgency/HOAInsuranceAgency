import { agencyDay } from "../../../../shared/agencyTime";
import { isGroupedInvoice } from "../../../../shared/groupedInvoiceGuard";
import { invoiceTotals } from "../../../../shared/invoiceTotals";
import { normalizePassThroughCharges } from "../../../../shared/passThroughCharges";
import { isRealIsoDay } from "../../../../shared/premiumFinance/noticeSequence";
import type { Invoice, InvoiceLine, Policy } from "../../lib/client";

interface GroupedInvoiceCandidate { policy: Policy; term: string; draft: Invoice | null; amount: number }

export function parseSupplierGrossCents(value: string): number | null {
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) return null;
  const [dollars = "", fraction = ""] = value.split(".");
  const cents = Number(`${dollars}${fraction.padEnd(2, "0")}`);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function policyTermKey(policy: Pick<Policy, "effectiveDate" | "expirationDate">): string | null {
  const { effectiveDate, expirationDate } = policy;
  if (!isRealIsoDay(effectiveDate) || !isRealIsoDay(expirationDate) || effectiveDate >= expirationDate) return null;
  return `${effectiveDate}/${expirationDate}`;
}

function hasDelivery(invoice: Invoice) {
  return [invoice.sentAt, invoice.paidAt, invoice.paymentUrl, invoice.stripePaymentLinkId, invoice.stripePaymentIntentId,
    invoice.stripeLinkAmountCents, invoice.brokerFeeAllocations, invoice.brokerFeeFinanceUrl].some(value => value != null && value !== "");
}

function wholeCents(amount: number | null | undefined): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 &&
    Number.isSafeInteger(Math.round(amount * 100)) && Math.abs(amount * 100 - Math.round(amount * 100)) < .000001;
}

function hasNoSupplierCharges(policy: Policy) {
  try { return normalizePassThroughCharges(policy.passThroughCharges).length === 0; }
  catch { return false; }
}

export function groupedInvoiceCandidates(policies: readonly Policy[], invoices: readonly Invoice[], lines: readonly InvoiceLine[]) {
  const today = agencyDay(new Date());
  return policies.flatMap<GroupedInvoiceCandidate>(policy => {
    const term = policyTermKey(policy);
    if (!term || !policy.expirationDate || policy.expirationDate <= today || policy.status !== "ACTIVE" || policy.billType !== "AGENCY" ||
      policy.groupedDraftInvoiceId || (policy.brokerFee ?? 0) !== 0 || (policy.brokerFeeCollected ?? 0) !== 0 ||
      !wholeCents(policy.premium) || policy.premium <= 0 || !policy.lines?.length || policy.lines.some(line => !line?.trim())) return [];

    const billedInvoiceIds = new Set(lines.filter(line => line.policyId === policy.id).map(line => line.invoiceId));
    const related = invoices.filter(invoice => invoice.policyId === policy.id ||
      (!!policy.quoteId && invoice.quoteId === policy.quoteId) ||
      invoice.groupedPolicyIds?.includes(policy.id) || billedInvoiceIds.has(invoice.id));
    if (related.some(hasDelivery)) return [];
    const live = related.filter(invoice => invoice.status !== "VOID");
    if (policy.carrierBillType === "DIRECT") {
      return !live.length && policy.policyNumber?.trim() && hasNoSupplierCharges(policy)
        ? [{ policy, term, draft: null, amount: policy.premium }] : [];
    }

    const draft = live[0];
    if (live.length !== 1 || !draft || isGroupedInvoice(draft) || draft.status !== "DRAFT" || draft.sourcePricingVersion !== 1 ||
      draft.adjustsInvoiceId || draft.adjustsPremiumLineId || draft.policyId !== policy.id || draft.quoteId) return [];

    const draftLines = lines.filter(line => line.invoiceId === draft.id);
    const premiums = draftLines.filter(line => line.kind === "PREMIUM");
    if (premiums.length !== 1 || premiums[0]?.retailAmount !== policy.premium) return [];
    if (draftLines.some(line => line.kind === "BROKER_FEE" || line.brokerFeeQuoteId || line.policyId !== policy.id ||
      !wholeCents(line.retailAmount) || !wholeCents(line.costAmount))) return [];
    return [{ policy, term, draft, amount: invoiceTotals(draftLines).retail }];
  });
}
