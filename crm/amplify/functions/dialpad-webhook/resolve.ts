import type { MatchConfidence } from "../../../src/lib/enums";

/**
 * Whose call was that, and whose timelines should show it.
 *
 * Pure — no data client, no DynamoDB — so the filing rules are testable
 * without a table. `handler.ts` reads the `PhoneLink` rows and does the
 * writing. Same split as `stripe-webhook`'s decide/persist and
 * `dialpad-phone-index`'s links/handler.
 */

/** The `PhoneLink` fields this reads. Structural, so a Schema row fits. */
export interface ResolvableLink {
  accountId: string;
  contactId?: string | null;
  accountName?: string | null;
  contactName?: string | null;
  suppressed?: boolean | null;
}

/**
 * Where one conversation is filed.
 *
 * `accountIds` is the set of timelines it appears on, and it is a set rather
 * than a single id because a property manager's number belongs to every
 * association they hold. Deliberately NOT ordered by likelihood: nothing here
 * ranks candidates, because ranking them is the guess this design rejects.
 */
export interface Filing {
  confidence: MatchConfidence;
  contactId: string | null;
  contactName: string | null;
  accountIds: string[];
  /** True when the number was marked "not a customer" from the triage queue. */
  suppressed: boolean;
}

/**
 * Resolve the links found for a number into a filing.
 *
 * Three outcomes, and the middle one is the whole design:
 *
 *   0 links  → UNMATCHED. Filed under nobody, shown on no timeline, lands in
 *              the triage queue for a person to identify.
 *   1 account → EXACT. One person, one association, no ambiguity.
 *   2+        → SHARED. One person, several associations. The call is filed
 *              under the person and appears on all of them.
 *
 * SHARED is not a degraded EXACT and must not be treated as one. It is a
 * different claim: we know who rang and not which association they rang
 * about. Guessing the likeliest and marking it uncertain reads better and is
 * worse — a miss puts a conversation on an association that never had one,
 * and takes it away from the one that did. Both halves are wrong, and W7 then
 * reads the wrong half.
 *
 * ── Distinct ACCOUNTS, not distinct rows ──────────────────────────────
 * A number can produce two links to the same account: one from a `Contact`
 * and one from the deprecated `Account.contactPhone` column, which
 * `dialpad-phone-index` indexes for leads that predate contacts. Two rows
 * pointing at one account is not ambiguity, and counting rows here would turn
 * every such legacy lead into a spurious SHARED.
 */
export function resolveFiling(links: ResolvableLink[]): Filing {
  const usable = links.filter((l) => l.accountId);
  if (usable.length === 0) {
    return {
      confidence: "UNMATCHED",
      contactId: null,
      contactName: null,
      accountIds: [],
      suppressed: false,
    };
  }

  // Any link marking the number suppressed suppresses it. One row saying "not
  // a customer" is a person's answer, and a second row that happens to match
  // does not overturn it.
  const suppressed = usable.some((l) => l.suppressed === true);

  const accountIds = [...new Set(usable.map((l) => l.accountId))];

  // The person, when the links agree on one. They disagree exactly when a
  // number reaches several accounts through several contact rows — which is
  // the property-manager case, where every row is the same human recorded
  // once per association. Preferring a named contact over none, and the
  // first name over a later one, keeps the label stable across calls rather
  // than rotating through thirty identical names in DynamoDB's order.
  const named = usable.find((l) => l.contactName) ?? usable[0];

  return {
    confidence: accountIds.length === 1 ? "EXACT" : "SHARED",
    // Only meaningful when one contact row is in play. On a SHARED call the
    // thirty rows are thirty different Contact ids for one person, and
    // picking one of them would assert a link to that association.
    contactId: accountIds.length === 1 ? (named.contactId ?? null) : null,
    contactName: named.contactName ?? null,
    accountIds,
    suppressed,
  };
}

/**
 * Does this call count as having serviced an account?
 *
 * Read by W7, and the reason it lives beside the filing rule rather than in
 * the digest: it is a direct consequence of how a call is filed, and putting
 * it in `ops-rollup` would let the two drift into disagreeing about what a
 * touch is.
 *
 * A SHARED call is not a touch. One conversation with a manager appears on
 * thirty timelines; counting it would mark thirty associations serviced on
 * the strength of one call and silence the untouched-lead finding across all
 * of them — which is precisely the failure the digest exists to catch.
 */
export const countsAsTouch = (confidence: MatchConfidence): boolean =>
  confidence === "EXACT" || confidence === "MANUAL";
