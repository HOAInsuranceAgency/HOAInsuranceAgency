/**
 * Natural keys for the rows AI extraction creates.
 *
 * `ExtractionPanel` creates a child row for every selected candidate on
 * **every** apply, with no check against what already exists (INVENTORY, and
 * the button reads "Re-run extraction", which invites exactly that). W9 fixes
 * it properly — match, then create or update, with the verdict shown per row.
 * This module is the half of that W9 needs from every other workstream: one
 * normalised string per row that answers "is this the same one".
 *
 * It exists as its own module, rather than beside the card that renders each
 * model, because three different kinds of caller compute the same key:
 *
 *  - the card, so a hand-typed row is matchable by a later extraction;
 *  - `ExtractionPanel`, against candidates that are not rows yet;
 *  - a Lambda — `lead-intake` creates a Contact from a web form, and a form
 *    submitted twice must not produce two people.
 *
 * That third caller is why this file imports nothing. `client.ts` calls
 * `generateClient()` at module scope, so a handler must not reach it; this
 * follows the `pagination.ts` convention instead.
 *
 * Keys are compared literally, so every one of them lower-cases and collapses
 * whitespace. They are stored on the row (`extractionSourceKey`) rather than
 * recomputed at match time, so a key can also be a *provenance* marker —
 * `backfill:contact` says a row came from the migration script and lets the
 * script run twice without writing twice.
 *
 * W9 adds `Building`, `PriorCarrier`, `Loss` and `Blanket`. They belong here
 * for the same reasons.
 */

/** Lower-cased, whitespace-collapsed. The one normalisation every key uses. */
function norm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A person is the same person if the email matches; failing that, if the name
 * and the role do.
 *
 * Email first because it is the only field on a contact that is meant to be
 * unique to one human — two trustees can share a name and a role, and a
 * managing agent's switchboard number is on every contact at the association.
 * Name+role second because a document that names someone without an address
 * for them is the common case, and "Pat Alvarez, manager" appearing in the
 * budget and again in the prior policy is one person, not two.
 *
 * Two contacts of the same type are allowed and always were — an association
 * has several trustees — so the role is part of the key rather than the whole
 * of it.
 */
export function contactKey(c: {
  email?: string | null;
  name?: string | null;
  type?: string | null;
}): string {
  const email = norm(c.email);
  if (email) return `email:${email}`;
  return `name:${norm(c.name)}|${c.type ?? ""}`;
}

/**
 * A prior policy is the same policy if the carrier, the policy number and the
 * line all match.
 *
 * All three, rather than the policy number alone, for two reasons. Numbers are
 * only unique within a carrier — "CP-1001" is a plausible number at any of
 * them — and an association routinely has *no* number recorded for a line
 * whose declarations page never reached the agency, which would collapse
 * every such row onto one key. Including the line also keeps a package policy
 * that covers property and GL under one number as the two rows the ACORD form
 * needs it to be.
 *
 * The term dates are deliberately not in the key: a renewal that keeps the
 * same number is the same coverage moving forward, and an extraction that
 * finds this year's dates should update the row rather than add a second one
 * beside it.
 */
export function priorCarrierKey(p: {
  carrierName?: string | null;
  policyNumber?: string | null;
  lineOfBusiness?: string | null;
}): string {
  return [norm(p.carrierName), norm(p.policyNumber), norm(p.lineOfBusiness)].join(
    "|"
  );
}
