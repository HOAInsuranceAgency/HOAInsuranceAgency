/**
 * What an extraction candidate would do to the record if you applied it.
 *
 * The bug this exists to kill: `ExtractionPanel` used to create a row for
 * every selected candidate on every apply, and the button reads "Re-run
 * extraction", which invites exactly that. Re-running and applying again
 * duplicated everything.
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

export function classifyCandidate<E extends Keyed>(
  key: string,
  supplied: Record<string, unknown>,
  existing: readonly E[]
): Match<E> {
  const found = existing.find((e) => e.extractionSourceKey === key);
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
