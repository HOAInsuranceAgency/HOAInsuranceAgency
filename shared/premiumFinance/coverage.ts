import { PF_COVERAGE_ALLOW, PF_COVERAGE_DENY } from "./jurisdictions";

/**
 * The commercial-lines screen — the single most important rule in the module.
 *
 * The exemptions this whole product stands on are commercial-lines exemptions.
 * One personal-lines policy financed voids the exemption for the entire book,
 * retroactively. So the classification here fails closed three separate ways:
 * a deny-list match is a hard block with no override; a line matching NEITHER
 * list blocks until a human resolves it; and flood — the one genuinely
 * ambiguous line — is on neither list by design and resolves on the account
 * type alone.
 *
 * The lists themselves are signed compliance data in
 * config/premium_finance/jurisdictions.yml, not code. `Policy.lines` is free
 * text in this schema, which is exactly why unmatched-blocks is the right
 * default: nobody has to enumerate every way a producer might type a line,
 * they only have to use the canonical names when they want financing.
 */

/**
 * Normalize for matching: lowercase, "&" → "and", every other punctuation run
 * → space, collapsed. Symmetric — applied to both the signed lists and the
 * policy's lines — so it can never widen the lists, only make matching
 * insensitive to typography. A compact (space-stripped) form is compared too,
 * so "HO-3", "HO 3" and "HO3" are one token.
 */
export function normalizeLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const compact = (s: string) => s.replace(/ /g, "");

function toKeySet(list: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const item of list) {
    const n = normalizeLine(item);
    set.add(n);
    set.add(compact(n));
  }
  return set;
}

const ALLOW = toKeySet(PF_COVERAGE_ALLOW);
const DENY = toKeySet(PF_COVERAGE_DENY);

/** "Flood" in any dress — NFIP, private flood, excess flood. */
export function isFloodLine(line: string): boolean {
  const n = normalizeLine(line);
  return /\bflood\b/.test(n) || n === "nfip" || compact(n) === "nfip";
}

export type CoverageVerdict =
  | { ok: true }
  | {
      ok: false;
      /** True only for a personal-lines match — no override exists or may be built. */
      hard: boolean;
      reason: string;
    };

/**
 * Verbatim from the brief, and load-bearing: the block message must say what
 * is actually at stake, because the person reading it is one click from
 * creating the retroactive-void case.
 */
export const PERSONAL_LINES_WARNING =
  "Financing one personal-lines policy voids our exemption for the entire book, retroactively.";

/**
 * Classify a policy's lines for financing.
 *
 * Order matters: deny beats allow beats unknown. A policy listing both a
 * commercial and a personal line is the personal-lines case — whatever else is
 * on it.
 */
export function coverageVerdict(
  lines: readonly (string | null | undefined)[],
  accountType: string | null | undefined
): CoverageVerdict {
  /**
   * The account itself first. A PERSONAL account cannot carry a financeable
   * policy whatever its lines claim to be — and this catches the case where
   * the lines are typed commercially on a personal risk.
   */
  if (accountType === "PERSONAL") {
    return {
      ok: false,
      hard: true,
      reason: `This is a personal-lines account. ${PERSONAL_LINES_WARNING}`,
    };
  }

  const named = lines.filter((l): l is string => !!l && !!l.trim());
  if (named.length === 0) {
    return {
      ok: false,
      hard: false,
      reason:
        "The policy lists no coverage lines, so it cannot be screened. Add its lines of business first.",
    };
  }

  const unknown: string[] = [];
  for (const line of named) {
    const n = normalizeLine(line);
    if (DENY.has(n) || DENY.has(compact(n))) {
      return {
        ok: false,
        hard: true,
        reason: `"${line.trim()}" is a personal line. ${PERSONAL_LINES_WARNING}`,
      };
    }
    if (isFloodLine(line)) {
      /**
       * The signed decision (2026-08-21): an association's master flood
       * program is commercial; a unit owner's flood policy is personal; bare
       * "Flood" is on neither list so nobody resolves it by editing data.
       * Allowed only for an ASSOCIATION account — the named-insured half of
       * the rule is structural today, because policies hang off the account
       * and the account IS the association. Anything else blocks for a human.
       */
      if (accountType !== "ASSOCIATION") {
        return {
          ok: false,
          hard: false,
          reason: `"${line.trim()}" — flood is financeable only on an association's own master policy. This account is not an association, so a person has to decide this one.`,
        };
      }
      continue;
    }
    if (!ALLOW.has(n) && !ALLOW.has(compact(n))) unknown.push(line.trim());
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      hard: false,
      reason: `Unrecognized coverage line${unknown.length > 1 ? "s" : ""}: ${unknown
        .map((u) => `"${u}"`)
        .join(", ")}. Only lines on the signed commercial allow-list can be financed; rename the line to its canonical form or have the list amended.`,
    };
  }
  return { ok: true };
}
