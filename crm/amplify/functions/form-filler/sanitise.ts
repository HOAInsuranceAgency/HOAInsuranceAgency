/**
 * The form filler's output gate.
 *
 * Everything the model returns passes through here before it can reach a PDF
 * that goes to a carrier. Pure and dependency-free on purpose: this is the
 * part worth testing, and it can be exercised without a Lambda, an account or
 * a model — see `src/lib/formFiller.test.ts`.
 */

/**
 * How many field names one call will answer.
 *
 * Both halves of the feature enforce this — the browser slices before it
 * sends, the Lambda slices before it asks — so it lives here, in the one
 * module in this folder that imports nothing and both can reach. Two
 * constants that had to agree would eventually not, and the failure is
 * silent in the worst direction: the browser reports what *it* dropped, so a
 * lower cap on the Lambda would trim the tail with nobody told.
 *
 * 600 rather than the 150 this shipped with. That number was a guess made
 * before the feature had ever run; measured on staging, a 125 asks for 150
 * names in 3,339 input tokens and 5.7 seconds against a 29-second budget —
 * and left 223 of its blanks unoffered. 600 covers a whole 125 (373 blanks)
 * and a whole 140 (276) in one call, so the cap stops being something a
 * producer has to work around and goes back to being a backstop.
 */
export const MAX_FIELDS = 600;

export interface Suggestion {
  /** The PDF text-field name the value belongs in. */
  field: string;
  /** The value, non-empty and not a placeholder. */
  value: string;
  /** One line saying where in the account data the value came from. */
  why: string;
}

/**
 * Never emit a placeholder. A blank field on an ACORD form is a blank field;
 * "pending" is a factual claim the agency did not make — an underwriter reads
 * it as "there is an answer and it is coming", and nobody at the agency ever
 * said that. The empty field is the honest one.
 */
export const PLACEHOLDER_RE =
  /^\s*(pending(\s+info(rmation)?)?|tbd|to be (determined|advised|provided)|n\/?a|unknown|none provided|see attached|refer to|various|\?+|-+)\s*$/i;

/** Longest justification kept. It is one line under a field name, not prose. */
const WHY_MAX = 200;

/**
 * Keep only what the caller asked for and can be believed.
 *
 * Dropped: anything for a field name that wasn't requested (the model is not
 * allowed to decide which fields get written), blank values, placeholders,
 * non-strings, and the second answer for a field already answered.
 *
 * NOT checked here: whether the value fits the field's `maxLength`, and
 * whether the deterministic pass already filled it. Both need the PDF, which
 * lives in the browser — `src/lib/aiFill.ts` is the second gate and applies
 * them there.
 */
export function sanitiseSuggestions(
  raw: unknown,
  requested: readonly string[]
): Suggestion[] {
  const allowed = new Set(requested);
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { fields?: unknown } | null)?.fields)
      ? ((raw as { fields: unknown[] }).fields as unknown[])
      : [];

  const out: Suggestion[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { field, value, why } = row as Record<string, unknown>;
    if (typeof field !== "string" || !allowed.has(field)) continue;
    if (seen.has(field)) continue;
    if (typeof value !== "string") continue;

    const trimmed = value.trim();
    if (!trimmed) continue;
    if (PLACEHOLDER_RE.test(trimmed)) continue;

    seen.add(field);
    out.push({
      field,
      value: trimmed,
      why: (typeof why === "string" ? why.trim() : "").slice(0, WHY_MAX),
    });
  }

  return out;
}
