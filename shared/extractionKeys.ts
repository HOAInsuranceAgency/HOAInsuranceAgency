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
 * ## Why the `*Aliases` functions exist
 *
 * A single key per row turned out to be too few, and staging proved it: an
 * extraction re-created three contacts that were already on the account.
 *
 * The reason is that a key here is derived from whichever identifying fields
 * happen to be *present*. `contactKey` prefers the email and falls back to
 * name+role, so the same person is `email:marion@…` when the CRM knows their
 * address and `name:marion delacroix|MANAGER` when a document names them
 * without one. Two strings, one human — and comparing the two strings says
 * "different person", which is a new row.
 *
 * So identity is a *set* of names a row can be known by, and two rows are the
 * same when their sets intersect. The primary key — what gets stored in
 * `extractionSourceKey` — stays the first alias, so nothing about what is
 * written changes; what changes is that matching no longer depends on the
 * stored key having been derived from the same fields the candidate has.
 *
 * That also makes matching survive the two things a stored key cannot:
 * a row edited after it was created (adding an email rewrites its identity but
 * not the column), and a row created by a path that never set the column at
 * all.
 *
 * Aliases are computed from stored rows and from candidate payloads alike, so
 * they take the loose shape both satisfy and coerce what they read.
 */
type Fields = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

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
  return contactAliases(c)[0];
}

/**
 * Every name this person can be matched by, most specific first.
 *
 * Both are emitted when both are knowable, which is the whole point: a stored
 * contact with an email still answers to name+role, so a document that names
 * them without an address lands on them instead of beside them.
 *
 * A nameless, addressless contact gets the empty-name alias dropped rather
 * than kept. `name:|` would otherwise be a key that every other anonymous row
 * shares, and merging two rows that have nothing in common is a worse error
 * than the duplicate this file exists to prevent. Such a row is left with no
 * alias at all, so it never matches anything — and `ExtractionPanel` filters
 * nameless candidates out before they get here anyway.
 */
export function contactAliases(c: Fields): string[] {
  const out: string[] = [];
  const email = norm(text(c.email));
  if (email) out.push(`email:${email}`);
  const name = norm(text(c.name));
  if (name) out.push(`name:${name}|${text(c.type)}`);
  // Never empty: `contactKey` reads `[0]`, and a key of "" is still a
  // deterministic key. It simply matches nothing, which is correct for a row
  // that has said nothing about who it is.
  return out.length ? out : [""];
}

/**
 * A building is identified by its label, which is the only thing about it a
 * document names consistently.
 *
 * Not the square footage or the year built: those are what an extraction is
 * for, they are exactly what a second pass over a better document is expected
 * to change, and keying on them would file the corrected version beside the
 * old one instead of over it. A label is also what a person types when they
 * add a building by hand, which is what lets a hand-made row be matched by a
 * later extraction rather than duplicated.
 *
 * A blank label is a real key — "" — and deliberately so. `ExtractionPanel`
 * names an unlabelled candidate "Building N" before it writes, so the stored
 * row always has a label; a candidate that reaches here unnamed is one the
 * panel is about to name, and two of them in the same result are two
 * buildings the documents never distinguished.
 */
export function buildingKey(b: { label?: string | null }): string {
  return `building:${norm(b.label)}`;
}

/**
 * A building has one name, so this is a list of one — and it is still worth
 * having, because the value of an alias list is not only its length. Matching
 * against a *recomputed* key is what lets a building that was added by hand be
 * recognised at all: `BuildingsCard` never wrote `extractionSourceKey`, so
 * every such row was invisible to the stored-key comparison and an extraction
 * filed a second copy of the property schedule beside it.
 */
export function buildingAliases(b: Fields): string[] {
  return [buildingKey({ label: text(b.label) })];
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

/**
 * A blanket is identified by its number, which is what the prior carrier
 * printed on the declarations page and the only thing about it that is meant
 * to be stable. The amount changes at every renewal and the type is written
 * differently by every carrier.
 */
export function blanketKey(b: { blanketNumber?: string | null }): string {
  return `blanket:${norm(b.blanketNumber)}`;
}

/**
 * A loss is identified by when it happened, what line it fell under, and what
 * it cost.
 *
 * Not the claim number, which the CRM does not record and loss runs report
 * inconsistently across carriers. Not the description either — the same event
 * is written up differently by every adjuster, so keying on it would make one
 * loss into several. Date, line and amount together are what a loss run
 * actually pins down, and two genuine losses on the same day under the same
 * line for the same amount are rare enough that merging them is the better
 * error than duplicating every re-import.
 */
export function lossKey(l: {
  dateOfLoss?: string | null;
  lineOfBusiness?: string | null;
  amountOfLoss?: number | string | null;
}): string {
  const amount = l.amountOfLoss == null ? "" : String(l.amountOfLoss);
  return `loss:${norm(l.dateOfLoss)}|${norm(l.lineOfBusiness)}|${norm(amount)}`;
}

/**
 * One name, recomputed from the row's current fields.
 *
 * A shorter date-and-line alias was tried and removed. The reasoning for it
 * was sound — the amount is in the key and is also the field most likely to
 * arrive late, so a loss whose amount was typed in afterwards no longer
 * answers to the key it was stored under — but emitting that alias from *both*
 * sides collapses the case the amount is in the key for: two occurrences on
 * one day under one line both claim `loss:date|line|` and get merged. Losing a
 * loss off a submission is a worse error than filing one twice.
 *
 * The late amount is handled anyway, and without the risk, by `namesOf` in
 * extractionMatch: a stored row is known by its remembered key *and* its
 * recomputed one, so the row keeps answering to the identity it was written
 * under. A candidate has no history to be known by, which is exactly the
 * asymmetry this needs.
 */
export function lossAliases(l: Fields): string[] {
  const date = norm(text(l.dateOfLoss));
  const line = norm(text(l.lineOfBusiness));
  // Same rule as a nameless contact: a loss with no date and no line has said
  // nothing that identifies it, so it gets no alias to collide on.
  if (!date && !line) return [""];
  return [
    lossKey({
      dateOfLoss: date,
      lineOfBusiness: line,
      amountOfLoss: l.amountOfLoss as number | string | null | undefined,
    }),
  ];
}
