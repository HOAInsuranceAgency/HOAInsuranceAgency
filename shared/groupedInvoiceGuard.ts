export const GROUPED_INVOICE_REVIEW_ONLY = "This grouped invoice is for review only.";

/** Treat either marker as authoritative, including an incomplete grouped draft. */
export function isGroupedInvoice(invoice: { sourcePricingVersion?: number | null; groupedPolicyIds?: unknown }): boolean {
  return invoice.sourcePricingVersion === 3 || invoice.groupedPolicyIds != null;
}
