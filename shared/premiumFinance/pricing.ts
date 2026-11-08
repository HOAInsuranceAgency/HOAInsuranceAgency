import type { PfJurisdiction } from "./jurisdictions";
import { addMonthsClamped, buildQuote, effectiveAprWithFee, PF_DEFAULT_APR, type PfQuote, type QuoteInputs } from "./quote";
import { isRealIsoDay } from "./noticeSequence";

export type FinanceRateDate = string | readonly string[];
export type FinancePricingInputs = Omit<QuoteInputs, "apr"> & { coverageEffectiveDate?: string | null };

/** Published monthly ceilings follow the state's calendar, not UTC midnight. */
export function financeRateDates(jurisdiction: PfJurisdiction, now: Date): readonly string[] {
  const zones = jurisdiction.code === "IA" ? ["America/Chicago"]
    : jurisdiction.code === "ND" ? ["America/Chicago", "America/Denver"] : ["UTC"];
  return [...new Set(zones.map(timeZone => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }))];
}

/** Both add-on jurisdictions separately permit the product's $10 fee. */
export function financeInterestLimit(jurisdiction: PfJurisdiction, quote: PfQuote, coverageEffectiveDate?: string | null): number | null | undefined {
  if (jurisdiction.maxAddOnApr === null) return null;
  if (!isRealIsoDay(coverageEffectiveDate)) return undefined;
  const finalDate = quote.schedule.at(-1)?.dueDate;
  if (!finalDate) return undefined;
  const days = (Date.parse(finalDate) - Date.parse(coverageEffectiveDate)) / 86_400_000;
  if (days <= 0) return undefined;
  let years = Number(finalDate.slice(0, 4)) - Number(coverageEffectiveDate.slice(0, 4));
  if (addMonthsClamped(coverageEffectiveDate, years * 12) > finalDate) years--;
  const anniversary = Date.parse(addMonthsClamped(coverageEffectiveDate, years * 12));
  const nextAnniversary = Date.parse(addMonthsClamped(coverageEffectiveDate, (years + 1) * 12));
  const yearFraction = years + (Date.parse(finalDate) - anniversary) / (nextAnniversary - anniversary);
  return Math.floor(quote.amountFinanced * jurisdiction.maxAddOnApr / 100 * yearFraction * 100 + 1e-8) / 100;
}

/** Null means an agreed rate; undefined means no current rate is configured. */
export function financeRateLimit(
  jurisdiction: PfJurisdiction,
  amountFinanced: number,
  effectiveDate: FinanceRateDate
): number | null | undefined {
  if (jurisdiction.uncappedAbovePrincipal !== null && amountFinanced > jurisdiction.uncappedAbovePrincipal) return null;
  if (jurisdiction.maxAprPeriods !== null) {
    const dates = typeof effectiveDate === "string" ? [effectiveDate] : effectiveDate;
    const caps = dates.map(date => jurisdiction.maxAprPeriods!.find(period => period.from <= date && date <= period.through)?.apr);
    // ND spans two time zones. At a month boundary apply the lower of the two
    // published ceilings; neither a higher new rate nor an expired rate wins.
    if (!caps.length || caps.some(cap => cap === undefined)) return undefined;
    return Math.min(...caps as number[]);
  }
  return jurisdiction.maxApr;
}

/** The highest whole basis-point rate inside the configured state's ceiling. */
export function financePricing(
  jurisdiction: PfJurisdiction,
  inputs: FinancePricingInputs,
  rateDate: FinanceRateDate = inputs.effectiveDate
): { apr: number; quote: PfQuote } | null {
  if (jurisdiction.status === "closed" || jurisdiction.maxAprVerified !== true) return null;
  const rateDates = typeof rateDate === "string" ? [rateDate] : rateDate;
  if (!Number.isFinite(inputs.premium) || inputs.premium <= 0 || !Number.isFinite(inputs.downPct) || inputs.downPct < 0 || inputs.downPct >= 100 || !Number.isInteger(inputs.months) || inputs.months < 1 || inputs.months > 12 || !isRealIsoDay(inputs.effectiveDate) || !rateDates.length || rateDates.some(date => !isRealIsoDay(date))) return null;
  const base = buildQuote({ ...inputs, apr: 0 });
  if (!Number.isFinite(base.amountFinanced) || base.amountFinanced <= 0) return null;
  const interestLimit = financeInterestLimit(jurisdiction, base, inputs.coverageEffectiveDate);
  if (interestLimit === undefined) return null;
  const cap = financeRateLimit(jurisdiction, base.amountFinanced, rateDate);
  if (cap === undefined || (cap !== null && (!Number.isFinite(cap) || cap <= 0))) return null;
  // Even the first installment's interest cannot exceed the entire budget.
  const ceiling = interestLimit === null ? cap ?? PF_DEFAULT_APR : interestLimit / base.amountFinanced * 1200;
  let basisPoints = Math.floor(ceiling * 100 + 1e-8);
  if (interestLimit !== null || (cap !== null && jurisdiction.feeCountsTowardCap)) {
    const allowed = (rate: number) => {
      const quote = buildQuote({ ...inputs, apr: rate / 100 });
      return interestLimit !== null ? quote.totalInterest <= interestLimit : effectiveAprWithFee(quote) <= cap!;
    };
    if (!allowed(0)) return null;
    let lo = 0;
    let hi = basisPoints;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (allowed(mid)) lo = mid;
      else hi = mid - 1;
    }
    basisPoints = lo;
  }
  if (basisPoints <= 0) return null;
  const apr = basisPoints / 100;
  return { apr, quote: buildQuote({ ...inputs, apr }) };
}
