/**
 * What a new invoice should already contain.
 *
 * An invoice raised at renewal almost always bills the policies that have come
 * due and nothing else, so starting from an empty table means retyping what the
 * policy records already say — and the failure that produces is not a typo, it
 * is an omission: a policy quietly left off the bill and noticed a month later.
 *
 * Pure and dependency-free, like `invoiceTotals.ts`, so the rule can be
 * asserted without a data client.
 */

/** The fields the seeding rule reads off a Policy. */
export interface PolicyLike {
  id: string;
  status?: string | null;
  billType?: string | null;
  premium?: number | null;
  policyNumber?: string | null;
  lines?: (string | null)[] | null;
}

/**
 * The policies a new invoice can bill.
 *
 * Three conditions, each excluding a different mistake:
 *
 * - **Not direct bill.** A direct-bill policy's premium is collected by the
 *   carrier. Offering it would put a bill in front of a producer for money
 *   that is not ours to take — the same error `directBillWarning` catches
 *   after the fact, avoided before it. A policy with no bill type recorded
 *   IS offered (revised 2026-08-24): since W8 this picker is the ONLY way
 *   an invoice gets created, so excluding the unrecorded made those
 *   policies permanently unbillable — a prohibition where the old seeding
 *   rule was merely a safe omission. The picker labels the gap and the
 *   editor's direct-bill warning still guards the send.
 *
 * - **Active.** Expired, cancelled and non-renewed policies are history. They
 *   are not what "what is due now" means; audit or adjustment billing on a
 *   closed term is its own question for its own day.
 *
 * - **Not already billed.** `billedPolicyIds` is every anchor of a LIVE
 *   invoice (DRAFT/SENT/PROCESSING — see `liveAnchorIds`). PAID and VOID
 *   free the slot, which is what lets a voided bill be raised again rather
 *   than leaving its policy permanently unbillable.
 *
 * Order follows the policies given, so the caller's sort is the line order.
 */
export function unbilledAgencyPolicies<T extends PolicyLike>(
  policies: readonly T[],
  billedPolicyIds: ReadonlySet<string>
): T[] {
  return policies.filter(
    (p) =>
      p.billType !== "DIRECT" &&
      p.status === "ACTIVE" &&
      !billedPolicyIds.has(p.id)
  );
}

/** The invoice fields the busy-anchor rule reads. */
export interface InvoiceAnchorLike {
  id: string;
  status?: string | null;
  policyId?: string | null;
  quoteId?: string | null;
}

/**
 * Every anchor a LIVE invoice currently holds — the ids the one-live-per-
 * anchor rule refuses to double-bill. Live is DRAFT, SENT or PROCESSING:
 * a PAID invoice is settled history and a VOID one is a cancelled claim,
 * and both free their policy or quote to be billed again. Header ids are
 * the W8 anchor; line-level policy ids still count so invoices from before
 * the header existed keep holding their slot.
 */
export function liveAnchorIds(
  invoices: readonly InvoiceAnchorLike[],
  lines: readonly { invoiceId: string; policyId?: string | null }[]
): Set<string> {
  const live = new Set(
    invoices
      .filter((i) => ["DRAFT", "SENT", "PROCESSING"].includes(i.status ?? ""))
      .map((i) => i.id)
  );
  const busy = new Set<string>();
  for (const i of invoices) {
    if (!live.has(i.id)) continue;
    if (i.policyId) busy.add(i.policyId);
    if (i.quoteId) busy.add(i.quoteId);
  }
  for (const l of lines) {
    if (live.has(l.invoiceId) && l.policyId) busy.add(l.policyId);
  }
  return busy;
}

/**
 * The description a seeded line carries.
 *
 * The policy number first, because that is what an association's treasurer
 * matches against their own records; the lines of business after it, because
 * that is what tells a producer at a glance what the figure is for. Falls back
 * to whichever exists.
 */
export function seededLineDescription(policy: PolicyLike): string {
  const number = policy.policyNumber?.trim();
  const lines = (policy.lines ?? []).filter(Boolean).join(", ");
  if (number && lines) return `${number} — ${lines}`;
  return number || lines || "Premium";
}

/** The fields the W8 anchor rules read off a Quote. */
export interface QuoteLike {
  id: string;
  status?: string | null;
  premium?: number | null;
  lines?: (string | null)[] | null;
  effectiveDate?: string | null;
}

/**
 * The quotes an invoice can anchor to (W8): open — a bound quote's billing
 * belongs to its policy, a lost one bills nobody — priced, and not already
 * carrying a live invoice. `isOpen` is injected rather than imported so this
 * module stays dependency-free like the policy rule above it.
 */
export function invoiceableQuotes<T extends QuoteLike>(
  quotes: readonly T[],
  billedAnchorIds: ReadonlySet<string>,
  isOpen: (status: string | null | undefined) => boolean
): T[] {
  return quotes.filter(
    (q) =>
      isOpen(q.status) &&
      typeof q.premium === "number" &&
      q.premium > 0 &&
      !billedAnchorIds.has(q.id)
  );
}

/**
 * A quote's seeded line: no policy number exists yet, so the lines of
 * business carry the identification, marked as quoted so the treasurer
 * reading the bill knows the paper is still being placed.
 */
export function seededQuoteLineDescription(quote: QuoteLike): string {
  const lines = (quote.lines ?? []).filter(Boolean).join(", ");
  return lines ? `${lines} — quoted coverage` : "Quoted coverage";
}
