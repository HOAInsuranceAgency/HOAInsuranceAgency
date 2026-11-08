import { describe, expect, it } from "vitest";
import { jurisdictionFor, aprCapViolation } from "../../../../shared/premiumFinance/gate";
import { financePricing, financeRateLimit, financeInterestLimit, financeRateDates } from "../../../../shared/premiumFinance/pricing";
import { buildQuote, effectiveAprWithFee } from "../../../../shared/premiumFinance/quote";
import { PF_JURISDICTIONS } from "../../../../shared/premiumFinance/jurisdictions";

const inputs = { premium: 10_000, downPct: 25, months: 11, effectiveDate: "2026-11-07", coverageEffectiveDate: "2026-11-07" };
const state = (code: string) => jurisdictionFor(code)!;

describe("automatic state pricing", () => {
  it.each(["HI", "ID", "IN", "LA", "ME", "MN", "NH", "NM", "VT", "WI", "WY", "UT", "MO"])("uses the agency's 18%% agreed rate in %s", code => {
    expect(financePricing(state(code), inputs)?.apr).toBe(18);
  });

  it.each([["AR", 17], ["CO", 45], ["MA", 20], ["NE", 16], ["OK", 45], ["VA", 18], ["WV", 18], ["MI", 7], ["RI", 21], ["FL", 18], ["OR", 18], ["TN", 24]] as const)("selects the highest basis-point rate inside %s's %s%% fee-inclusive ceiling", (code, cap) => {
    const j = state(code);
    const result = financePricing(j, inputs)!;
    expect(result.apr).toBeGreaterThan(0);
    expect(effectiveAprWithFee(result.quote)).toBeLessThanOrEqual(cap);
    const next = buildQuote({ ...inputs, apr: result.apr + 0.01 });
    expect(effectiveAprWithFee(next)).toBeGreaterThan(cap);
    expect(aprCapViolation(result.apr, j, result.quote, inputs.effectiveDate)).toBeNull();
  });

  it("keeps Alaska's separately permitted fee outside its 15% nominal ceiling", () => {
    expect(financePricing(state("AK"), inputs)?.apr).toBe(15);
  });

  it.each([["DE", 9], ["KS", 12]] as const)("converts %s's %s%% add-on budget for the actual term", (code, addOn) => {
    for (const months of [1, 9, 11, 12]) {
      const result = financePricing(state(code), { ...inputs, months })!;
      const days = (Date.parse(result.quote.schedule.at(-1)!.dueDate) - Date.parse(inputs.coverageEffectiveDate)) / 86_400_000;
      const budget = Math.floor(7500 * addOn / 100 * days / 365 * 100 + 1e-8) / 100;
      expect(result.quote.totalInterest).toBeLessThanOrEqual(budget);
      const next = buildQuote({ ...inputs, months, apr: result.apr + 0.01 });
      expect(next.totalInterest).toBeGreaterThan(budget);
      expect(aprCapViolation(result.apr, state(code), result.quote, inputs.effectiveDate, inputs.coverageEffectiveDate)).toBeNull();
      expect(financeInterestLimit(state(code), result.quote, inputs.coverageEffectiveDate)).toBe(budget);
    }
  });

  it("uses coverage inception rather than invoice send for an add-on budget", () => {
    const j = state("DE");
    const earlier = financePricing(j, inputs)!;
    const later = financePricing(j, { ...inputs, coverageEffectiveDate: "2026-12-01" })!;
    expect(later.apr).toBeLessThan(earlier.apr);
    const budget = Math.floor(7500 * 0.09 * 310 / 365 * 100) / 100;
    expect(later.quote.totalInterest).toBeLessThanOrEqual(budget);
    expect(financePricing(j, { ...inputs, coverageEffectiveDate: undefined })).toBeNull();
    expect(financePricing(j, { ...inputs, coverageEffectiveDate: "2028-01-01" })).toBeNull();
    const year = financePricing(j, { ...inputs, months: 12, effectiveDate: "2027-11-07", coverageEffectiveDate: "2027-11-07" })!;
    expect(financeInterestLimit(j, year.quote, "2027-11-07")).toBe(675);
  });

  it("uses Iowa's published agreement-month rate and refuses unpublished months", () => {
    const j = state("IA");
    expect(financeRateLimit(j, 7500, "2026-11-30")).toBe(7);
    expect(financeRateLimit(j, 7500, "2026-12-01")).toBe(7.25);
    expect(financePricing(j, { ...inputs, effectiveDate: "2027-01-01" })).toBeNull();
    expect(financePricing(j, { ...inputs, effectiveDate: "2026-10-31" })).toBeNull();
    const november = financePricing(j, { ...inputs, effectiveDate: "2026-12-07" }, "2026-11-07")!;
    expect(effectiveAprWithFee(november.quote)).toBeLessThanOrEqual(7);
  });

  it("waits for the state's local calendar before changing monthly ceilings", () => {
    const j = state("IA");
    expect(financeRateDates(j, new Date("2026-12-01T00:30:00Z"))).toEqual(["2026-11-30"]);
    expect(financeRateDates(j, new Date("2026-12-01T06:00:00Z"))).toEqual(["2026-12-01"]);
    const november = financePricing(j, inputs, financeRateDates(j, new Date("2026-12-01T00:30:00Z")))!;
    expect(effectiveAprWithFee(november.quote)).toBeLessThanOrEqual(7);
    const nd = state("ND");
    const boundary = financeRateDates(nd, new Date("2026-12-01T06:30:00Z"));
    expect(boundary).toEqual(["2026-12-01", "2026-11-30"]);
    expect(financePricing(nd, inputs, boundary)).toBeNull();
  });

  it("applies North Dakota's monthly ceiling through exactly $35,000 and 18% above", () => {
    const j = state("ND");
    expect(financeRateLimit(j, 35000, "2026-11-07")).toBe(9.393);
    expect(financeRateLimit(j, 35000.01, "2026-11-07")).toBeNull();
    expect(financePricing(j, { ...inputs, premium: 48000 })?.apr).toBe(18);
    const limited = financePricing(j, { ...inputs, premium: 40000 })!;
    expect(effectiveAprWithFee(limited.quote)).toBeLessThanOrEqual(9.393);
    expect(financePricing(j, { ...inputs, effectiveDate: "2026-12-01" })).toBeNull();
    expect(financePricing(j, { ...inputs, premium: 48000, effectiveDate: "2026-12-01" })?.apr).toBe(18);
  });

  it("does not use Ohio's >$100,000 exemption at exactly $100,000", () => {
    const j = state("OH");
    expect(financeRateLimit(j, 100000, inputs.effectiveDate)).toBe(8);
    expect(financeRateLimit(j, 100000.01, inputs.effectiveDate)).toBeNull();
    expect(financePricing(j, { ...inputs, premium: 140000 })?.apr).toBe(18);
  });

  it("offers no rate in a closed, unresolved, or unfiled state", () => {
    for (const code of ["NY", "MS", "SC", "NV", "XX"]) {
      const j = jurisdictionFor(code);
      if (j) expect(financePricing(j, inputs), code).toBeNull();
      else expect(j).toBeNull();
    }
  });

  it("refuses a positive rate when the fee alone exceeds the ceiling", () => {
    expect(financePricing(state("MA"), { ...inputs, premium: 10 })).toBeNull();
  });

  it("validates each configured lendable state's actual schedule", () => {
    for (const j of PF_JURISDICTIONS.filter(j => j.status !== "closed" && j.maxAprVerified)) {
      const terms = { ...inputs, premium: j.code === "OH" ? 200_000 : 25_000 };
      const result = financePricing(j, terms)!;
      expect(result, j.code).not.toBeNull();
      expect(aprCapViolation(result.apr, j, result.quote, terms.effectiveDate, terms.coverageEffectiveDate), j.code).toBeNull();
      expect(result.quote.schedule.at(-1)?.balance, j.code).toBe(0);
    }
  });

  it("rejects malformed terms instead of producing a nonfinite price", () => {
    for (const override of [{ premium: NaN }, { premium: Infinity }, { premium: 0.001 }, { downPct: 100 }, { months: 0 }, { months: 1.5 }, { effectiveDate: "2026-02-30" }]) {
      expect(financePricing(state("HI"), { ...inputs, ...override })).toBeNull();
    }
  });
});
