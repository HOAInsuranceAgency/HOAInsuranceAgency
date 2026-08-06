/**
 * What an extraction candidate would do to the record if you applied it.
 *
 * The bug this exists to kill: `ExtractionPanel` used to create a row for
 * every selected candidate on every apply, and the button reads "Re-run
 * extraction", which invites exactly that. Re-running and applying again
 * duplicated everything.
 *
 * Matching on the *stored* key alone was not enough either, which staging
 * showed by duplicating three contacts and a building on a first apply. See
 * `aliasesOf` below and the note above `contactAliases` in extractionKeys.ts:
 * a row's identity is a set of names, not one string, because the string a row
 * was stored under is derived from whichever identifying fields it had at the
 * time and the candidate may not have the same ones.
 *
 * Matching alone is not enough to fix it, because a candidate that matches a
 * stored row and changes nothing about it is still a write — one that shows
 * as an edit in the activity log, bumps `updatedAt`, and tells a reviewer
 * something happened when nothing did. So there are three verdicts, not two:
 *
 *   new       — nothing on the account has this key. Creates.
 *   update    — same key, and at least one supplied field differs. Updates.
 *   identical — same key, nothing differs. Does nothing at all.
 *
 * Only *supplied* fields are compared. The apply path merges rather than
 * replaces — a budget that names the manager but not their phone number must
 * not blank a phone number somebody typed by hand — so a field the documents
 * were silent about is not a difference, it is an absence.
 *
 * Pure and importing nothing: this is the rule worth testing, and it is also
 * the rule a Lambda needs (`lead-intake` creates a Contact from a web form,
 * and a form submitted twice must not produce two people).
 */

export type Verdict = "new" | "update" | "identical";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface Match<E> {
  verdict: Verdict;
  /** The stored row this lands on, when there is one. */
  existing?: E;
  /** What would change. Empty unless the verdict is "update". */
  changes: FieldChange[];
}

/** A stored row carries the key it was written under. */
interface Keyed {
  extractionSourceKey?: string | null;
}

/**
 * Compare two stored-column values.
 *
 * Loose about number-vs-string because the two sides come from different
 * places: a supplied value has been coerced toward the column's type, and a
 * stored one is whatever the API returned. 1985 and "1985" are the same year,
 * and treating them as a difference would make every re-apply an update.
 * Strict about everything else — `null` and `""` are both "no value", and
 * neither is a change from the other.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const blank = (v: unknown) => v == null || v === "";
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (typeof a === "number" || typeof b === "number") {
    return String(a) === String(b);
  }
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return String(a) === String(b);
}

/**
 * Every name a row answers to: what it was stored under, plus what its current
 * contents say it is.
 *
 * Both, not either. The stored key is the only record of an identity the row
 * has since edited away from — a loss keyed on its amount before anyone knew
 * the amount — and the recomputed aliases are the only identity a row that was
 * never keyed at all has.
 *
 * Applied to stored rows, this is also where the asymmetry that makes late
 * edits safe comes from: a stored row answers to its history as well as its
 * contents, and a candidate — which has no history — answers only to its
 * contents. That is what lets a row be recognised after the field its key was
 * derived from changed, without letting two candidates that merely resemble
 * each other collapse into one.
 *
 * Blank entries are dropped so that two rows which have said nothing about
 * themselves do not collide on "".
 */
function namesOf(
  stored: string | null | undefined,
  computed: readonly string[]
): string[] {
  return [stored ?? "", ...computed].filter(Boolean);
}

export function classifyCandidate<E extends Keyed>(
  key: string,
  supplied: Record<string, unknown>,
  existing: readonly E[],
  /**
   * How to derive a row's identities from its fields. Applied to stored rows
   * and to `supplied` alike — which is why it takes the loose shape both are.
   *
   * Optional so a model with a single stable key can go on passing three
   * arguments. Omitting it matches on the stored key alone, which is the
   * behaviour that let staging duplicate three contacts and a building.
   */
  aliasesOf?: (row: Record<string, unknown>) => string[]
): Match<E> {
  const wanted = new Set(namesOf(key, aliasesOf?.(supplied) ?? []));
  const found = existing.find((e) =>
    namesOf(
      e.extractionSourceKey,
      aliasesOf?.(e as unknown as Record<string, unknown>) ?? []
    ).some((n) => wanted.has(n))
  );
  if (!found) return { verdict: "new", changes: [] };

  const row = found as unknown as Record<string, unknown>;
  const changes: FieldChange[] = [];
  // Sorted, so one candidate always renders the same list of changes in the
  // same order however the payload object happened to be built.
  for (const field of Object.keys(supplied).sort()) {
    const to = supplied[field];
    // A supplied value is only ever a value — the apply path omits the key
    // entirely when the documents said nothing — so an undefined here is a
    // caller mistake, not an instruction to blank the column.
    if (to === undefined) continue;
    if (!same(row[field], to)) changes.push({ field, from: row[field] ?? null, to });
  }

  return {
    verdict: changes.length ? "update" : "identical",
    existing: found,
    changes,
  };
}

/** How a verdict reads in the review table. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  new: "add",
  update: "update",
  identical: "no change",
};
