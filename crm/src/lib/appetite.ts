/**
 * Does this carrier want this risk?
 *
 * One predicate, two callers. The Appetite Finder on the Carriers page and
 * the nightly renewal-marketing sweep used to answer this question with two
 * hand-written copies of the same rules — the Lambda's carried the comment
 * "Mirrors the Appetite Finder", which is the kind of comment that is true
 * until it isn't. Adding paper type, coastal, rental and loss restrictions
 * would have meant writing all four twice, so the copies were collapsed into
 * this module first.
 *
 * The types are structural rather than `Schema[…]["type"]` so a test fixture
 * can be an object literal instead of a full model row, and so this module
 * imports nothing at runtime — the `pagination.ts` convention that makes it
 * safe for a handler to pull in. `client.ts` calls `generateClient()` at
 * module scope and must never end up in a Lambda bundle.
 *
 * ─ The rule that governs every field below ───────────────────────────────
 * An unstated restriction never excludes, and neither does an unknown risk
 * fact. A blank guide matches everything, exactly as it did before the new
 * columns existed; an account whose rental percentage nobody has recorded is
 * not quietly dropped from a carrier that caps rentals. False negatives here
 * are invisible — the sweep just never raises the task — which is why the
 * bias runs the other way.
 */
import type { Schema } from "../../amplify/data/resource";

type PaperType = NonNullable<Schema["PaperType"]["type"]>;

/**
 * The window loss restrictions are measured over. Fixed rather than per
 * guide: the ACORD 125 asks for five years, so it is the number the agency
 * already has on paper — and the Appetite Finder asks the user for a single
 * loss count, which cannot mean a different span for each row it compares it
 * against. A carrier wanting three years says so in the guide's notes.
 */
export const LOSS_LOOKBACK_YEARS = 5;

/** The guide columns matching reads. */
export interface AppetiteGuideCriteria {
  states?: readonly (string | null)[] | null;
  linesWritten?: readonly (string | null)[] | null;
  paperType?: PaperType | null;
  minValue?: number | null;
  maxValue?: number | null;
  minConstructionYear?: number | null;
  maxConstructionYear?: number | null;
  writesCoastal?: boolean | null;
  minMilesToCoast?: number | null;
  maxRentalPct?: number | null;
  maxLosses?: number | null;
  maxLossIncurred?: number | null;
}

/** The carrier columns matching reads — its footprint, as a fallback. */
export interface AppetiteCarrierCriteria {
  states?: readonly (string | null)[] | null;
}

/**
 * The risk being placed. Every field is optional and an absent one is
 * "unknown", not "no" — see the module note.
 */
export interface AppetiteRisk {
  state?: string | null;
  totalInsuredValue?: number | null;
  yearBuilt?: number | null;
  coastal?: boolean | null;
  milesToCoast?: number | null;
  /** Percentage of units rented rather than owner-occupied. */
  rentalPct?: number | null;
  /** Losses within `LOSS_LOOKBACK_YEARS`, from `summarizeLosses`. */
  lossCount?: number | null;
  /** Paid + reserved over the same window. */
  lossIncurred?: number | null;
  lines?: readonly string[];
  /**
   * Not a property of the risk but of the search: set it to see only
   * admitted or only E&S markets. The sweep never sets it — both are places
   * a renewal can legitimately go, and a nightly job has no business
   * preferring one. A guide whose own paper type is unstated still matches,
   * because "nobody has said" is not an answer that should hide a market.
   */
  paperType?: PaperType | null;
}

/** Ranges entered backwards would silently match nothing. */
export const order = (
  a: number | null | undefined,
  b: number | null | undefined
): [number | null | undefined, number | null | undefined] =>
  a != null && b != null && a > b ? [b, a] : [a, b];

/** A loss as the count and total need it. */
export interface AppetiteLoss {
  dateOfLoss?: string | null;
  amountPaid?: number | null;
  amountReserved?: number | null;
}

/**
 * Losses inside the lookback window, counted and totalled.
 *
 * Incurred is paid + reserved: an open claim with nothing paid yet is still
 * the exposure an underwriter is declining, and counting only paid would
 * make the worst open claim in the file look like a clean year.
 *
 * `today` is passed in rather than read from the clock so the sweep's
 * five-year line is the same one its other date arithmetic uses, and so this
 * is testable without freezing time.
 */
export function summarizeLosses(
  losses: readonly AppetiteLoss[],
  today: string
): { count: number; incurred: number } {
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - LOSS_LOOKBACK_YEARS);
  const since = cutoff.toISOString().slice(0, 10);
  const inWindow = losses.filter((l) => (l.dateOfLoss ?? "") >= since);
  return {
    count: inWindow.length,
    incurred: inWindow.reduce(
      (sum, l) => sum + (l.amountPaid ?? 0) + (l.amountReserved ?? 0),
      0
    ),
  };
}

/**
 * Whether one appetite guide covers one risk.
 *
 * `bestFitBusiness` is deliberately absent. It is judgement — "clean condo",
 * "difficult condo" — and no account carries a column that answers it, so a
 * filter on it could only ever exclude carriers on data nobody entered. It
 * is displayed beside these results instead, which is what it is for.
 */
export function guideFits(
  guide: AppetiteGuideCriteria,
  carrier: AppetiteCarrierCriteria,
  risk: AppetiteRisk
): boolean {
  // Only this paper, when the search asked for one. An unstated guide passes.
  if (risk.paperType && guide.paperType && guide.paperType !== risk.paperType)
    return false;

  const states = (guide.states?.filter(Boolean).length ? guide.states : carrier.states) ?? [];
  if (risk.state && states.filter(Boolean).length > 0 && !states.includes(risk.state))
    return false;

  const [loV, hiV] = order(guide.minValue, guide.maxValue);
  if (risk.totalInsuredValue != null) {
    if (loV != null && risk.totalInsuredValue < loV) return false;
    if (hiV != null && risk.totalInsuredValue > hiV) return false;
  }

  const [loY, hiY] = order(guide.minConstructionYear, guide.maxConstructionYear);
  if (risk.yearBuilt != null) {
    if (loY != null && risk.yearBuilt < loY) return false;
    if (hiY != null && risk.yearBuilt > hiY) return false;
  }

  // Two ways to decline the coast, and a carrier can state either or both:
  // the outright "we don't write it", and the distance line.
  if (guide.writesCoastal === false && risk.coastal === true) return false;
  if (
    guide.minMilesToCoast != null &&
    risk.milesToCoast != null &&
    risk.milesToCoast < guide.minMilesToCoast
  )
    return false;

  if (
    guide.maxRentalPct != null &&
    risk.rentalPct != null &&
    risk.rentalPct > guide.maxRentalPct
  )
    return false;

  if (guide.maxLosses != null && risk.lossCount != null && risk.lossCount > guide.maxLosses)
    return false;
  if (
    guide.maxLossIncurred != null &&
    risk.lossIncurred != null &&
    risk.lossIncurred > guide.maxLossIncurred
  )
    return false;

  // Lead-sourced risks have no lines yet — don't exclude on them.
  const written = (guide.linesWritten ?? []).filter(Boolean);
  if (risk.lines?.length && written.length) {
    if (!risk.lines.some((l) => written.includes(l))) return false;
  }
  return true;
}

/**
 * The restrictions on one guide, as one line of text.
 *
 * Lives beside the rules rather than in the component so that a restriction
 * added to `guideFits` and forgotten here is a change to one file, not a
 * column that quietly stops mentioning the reason a carrier was skipped.
 * Returns "" when the guide states none, which the callers render as "—".
 */
export function restrictionSummary(guide: AppetiteGuideCriteria): string {
  const parts: string[] = [];
  if (guide.writesCoastal === false) parts.push("no coastal");
  else if (guide.writesCoastal === true) parts.push("writes coastal");
  if (guide.minMilesToCoast != null) parts.push(`≥${guide.minMilesToCoast} mi to coast`);
  if (guide.maxRentalPct != null) parts.push(`rentals ≤${guide.maxRentalPct}%`);
  if (guide.maxLosses != null)
    parts.push(`≤${guide.maxLosses} losses/${LOSS_LOOKBACK_YEARS}yr`);
  if (guide.maxLossIncurred != null)
    parts.push(`≤$${guide.maxLossIncurred.toLocaleString("en-US")} incurred`);
  return parts.join(" · ");
}
