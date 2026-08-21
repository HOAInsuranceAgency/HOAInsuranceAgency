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
 * The policies a new invoice should open with a line for.
 *
 * Three conditions, each excluding a different mistake:
 *
 * - **Agency bill.** A direct-bill policy's premium is collected by the
 *   carrier. Seeding it would put a bill in front of a producer for money that
 *   is not ours to take — the same error `directBillWarning` catches after the
 *   fact, avoided before it. A policy with no bill type recorded is not seeded
 *   either: it was bound before that field existed and has no answer, and
 *   guessing "agency" here guesses in the direction that costs someone money.
 *
 * - **Active.** Expired, cancelled and non-renewed policies are history. They
 *   can still be billed by hand — an audit or a mid-term adjustment is real —
 *   but they are not what "what is due now" means, and seeding them would put
 *   every policy the association has ever held on its next invoice.
 *
 * - **Not already billed.** `billedPolicyIds` is every policy that appears on
 *   a line of a live invoice. Void invoices are excluded by the caller, which
 *   is what lets a voided bill be raised again rather than leaving its policies
 *   permanently unbillable.
 *
 * Order follows the policies given, so the caller's sort is the line order.
 */
export function unbilledAgencyPolicies<T extends PolicyLike>(
  policies: readonly T[],
  billedPolicyIds: ReadonlySet<string>
): T[] {
  return policies.filter(
    (p) =>
      p.billType === "AGENCY" &&
      p.status === "ACTIVE" &&
      !billedPolicyIds.has(p.id)
  );
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
