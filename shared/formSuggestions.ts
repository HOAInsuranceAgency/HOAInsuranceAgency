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
 * ACORD field names that hold an amount of money.
 *
 * The deterministic mapping renders every figure through `amt` — `1,000,000`,
 * grouped, no currency sign, because the box already has a printed `$`. The
 * model does not, so a certificate came off the line with `1,000,000` in the
 * boxes the mapping filled and `300000` in the boxes the AI filled, on the
 * same page, going to a mortgagee. Matching the two is not cosmetic: an
 * ungrouped seven-digit number in a narrow box is the one a reader miscounts.
 *
 * Matched on the name because the model is told the field names and nothing
 * about their types. The words below are ACORD's own and appear in the names
 * of the money boxes across the 25, the 125, the 126 and the 140.
 */
const CURRENCY_FIELD_RE =
  /(Amount|Limit|Premium|Deductible|Aggregate|Payroll|Revenue|Receipts|Valuation|Retention)/i;

/**
 * A bare non-negative number, optionally with cents, and nothing else — no
 * `$`, no commas, no words.
 *
 * Anything the model has already formatted, qualified ("per occurrence") or
 * written as a range is left exactly as it came: reformatting a value we do
 * not fully understand is how a number gets changed rather than restyled.
 */
const BARE_NUMBER_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Group a money value the way `acordFormat.amt` does.
 *
 * Reimplemented rather than imported: this module deliberately imports
 * nothing, which is what lets the browser take `MAX_FIELDS` from it without
 * pulling a Lambda's dependencies into the bundle.
 *
 * Values under 1,000 are returned untouched — there is nothing to group, and
 * the guard keeps a four-digit year out of the way of anything named, say,
 * `…ValuationYear…`.
 */
function groupCurrency(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1000) return value;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Keep only what the caller asked for and can be believed.
 *
 * Dropped: anything for a field name that wasn't requested (the model is not
 * allowed to decide which fields get written), blank values, placeholders,
 * non-strings, and the second answer for a field already answered.
 *
 * Changed rather than dropped: a bare number in a money box gains its
 * thousands separators, so an AI-filled figure and a mapping-filled one on the
 * same form read alike. See CURRENCY_FIELD_RE.
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
      value:
        CURRENCY_FIELD_RE.test(field) && BARE_NUMBER_RE.test(trimmed)
          ? groupCurrency(trimmed)
          : trimmed,
      why: (typeof why === "string" ? why.trim() : "").slice(0, WHY_MAX),
    });
  }

  return out;
}
