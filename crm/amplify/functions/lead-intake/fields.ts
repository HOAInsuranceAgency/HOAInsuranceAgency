/**
 * Parsing the two web-lead fields whose columns are not strings.
 *
 * Pure and separate from the handler because the rule that matters is what
 * happens to a value that does not parse: it must reach a producer anyway, in
 * `notes`, rather than be dropped or take the whole lead down with it.
 *
 * `unitCount` feeds the Units column on the accounts list, and
 * `currentPolicyExpiration` feeds "Incumbent expires" there and the renewal
 * pipeline on the dashboard. Neither reads `notes`, which is why a lead whose
 * expiry only ever landed in prose never showed up as renewing.
 */

/**
 * Above this it is a typo rather than an association. The largest HOAs in the
 * country run to the low tens of thousands of units, so this rejects no real one.
 *
 * It does NOT catch a ZIP pasted into the unit box: "1752" is a plausible unit
 * count and no bound can tell the two apart. A *leading zero* can, and is
 * rejected below, which covers the New England ZIPs this agency mostly sees.
 */
const MAX_UNITS = 100_000;

/** A positive unit count, or null if it is not one. */
export function parseUnitCount(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 && raw <= MAX_UNITS ? raw : null;
  }
  if (typeof raw !== "string") return null;
  // Commas because "1,200" is how a person types it.
  const trimmed = raw.trim().replace(/,/g, "");
  // A leading zero means this is not a count. Nobody types "048" units, so it
  // is a ZIP or a unit *number* in the wrong box.
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_UNITS ? n : null;
}

/**
 * A date the `a.date()` column will accept, or null.
 *
 * `YYYY-MM-DD` is what a native date input produces and is the only thing
 * AWSDate takes. `MM/DD/YYYY` is accepted and converted because a returning
 * visitor can have that shape persisted in their session from before the field
 * became a date picker, and because a hand-typed US date looks like that.
 *
 * The round-trip check at the end is what rejects the 31st of February: the
 * `Date` constructor rolls it forward to March rather than failing.
 */
export function parsePolicyExpiration(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();

  let y: string, m: string, d: string;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (iso) {
    [, y, m, d] = iso;
  } else if (us) {
    [, m, d, y] = us;
    m = m.padStart(2, "0");
    d = d.padStart(2, "0");
  } else {
    return null;
  }

  // A year outside this is a mistyped digit, not a policy term.
  const year = Number(y);
  if (year < 1900 || year > 2100) return null;

  const out = `${y}-${m}-${d}`;
  const parsed = new Date(`${out}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === out ? out : null;
}
