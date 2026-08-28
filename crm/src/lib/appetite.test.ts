import { describe, expect, it } from "vitest";
import {
  guideFits,
  LOSS_LOOKBACK_YEARS,
  order,
  restrictionSummary,
  summarizeLosses,
  type AppetiteGuideCriteria,
} from "./appetite";

/** A guide that states nothing — the baseline every case starts from. */
const OPEN: AppetiteGuideCriteria = {};
const NO_FOOTPRINT = {};

describe("an unstated restriction never excludes", () => {
  it("matches a fully-specified risk against an empty guide", () => {
    expect(
      guideFits(OPEN, NO_FOOTPRINT, {
        state: "MA",
        totalInsuredValue: 40_000_000,
        yearBuilt: 1962,
        coastal: true,
        milesToCoast: 0.2,
        rentalPct: 90,
        lossCount: 11,
        lossIncurred: 2_000_000,
        lines: ["Commercial Property"],
      })
    ).toBe(true);
  });

  it("matches an empty risk against a fully-specified guide", () => {
    // The account nobody has finished entering. Every one of these would
    // exclude if "unknown" were read as "fails" — and the failure would be
    // silent: the sweep would simply never raise the task.
    const strict: AppetiteGuideCriteria = {
      states: ["MA"],
      linesWritten: ["Commercial Property"],
      paperType: "ADMITTED",
      minValue: 1_000_000,
      maxValue: 20_000_000,
      minConstructionYear: 1980,
      maxConstructionYear: 2020,
      writesCoastal: false,
      minMilesToCoast: 5,
      maxRentalPct: 25,
      maxLosses: 2,
      maxLossIncurred: 50_000,
    };
    expect(guideFits(strict, NO_FOOTPRINT, {})).toBe(true);
  });
});

describe("coastal", () => {
  it("declines a coastal risk when the guide says it doesn't write coastal", () => {
    expect(guideFits({ writesCoastal: false }, NO_FOOTPRINT, { coastal: true })).toBe(
      false
    );
  });

  it("keeps an inland risk at a carrier that declines coastal", () => {
    expect(guideFits({ writesCoastal: false }, NO_FOOTPRINT, { coastal: false })).toBe(
      true
    );
  });

  it("does not read an unanswered coastal question as coastal", () => {
    expect(guideFits({ writesCoastal: false }, NO_FOOTPRINT, { coastal: null })).toBe(
      true
    );
  });

  it("enforces the distance line separately from the outright decline", () => {
    const g = { minMilesToCoast: 5 };
    expect(guideFits(g, NO_FOOTPRINT, { milesToCoast: 4.9 })).toBe(false);
    expect(guideFits(g, NO_FOOTPRINT, { milesToCoast: 5 })).toBe(true);
    // A carrier that writes coastal but not on the water: `writesCoastal`
    // true must not cancel the distance rule.
    expect(
      guideFits({ writesCoastal: true, minMilesToCoast: 5 }, NO_FOOTPRINT, {
        coastal: true,
        milesToCoast: 0.5,
      })
    ).toBe(false);
  });
});

describe("rentals and losses", () => {
  it("excludes over the rental cap and keeps the boundary", () => {
    expect(guideFits({ maxRentalPct: 25 }, NO_FOOTPRINT, { rentalPct: 26 })).toBe(false);
    expect(guideFits({ maxRentalPct: 25 }, NO_FOOTPRINT, { rentalPct: 25 })).toBe(true);
  });

  it("excludes over the loss count and over the incurred total, independently", () => {
    expect(guideFits({ maxLosses: 2 }, NO_FOOTPRINT, { lossCount: 3 })).toBe(false);
    expect(guideFits({ maxLosses: 2 }, NO_FOOTPRINT, { lossCount: 2 })).toBe(true);
    // Two losses is within the count, but they were expensive.
    expect(
      guideFits({ maxLosses: 2, maxLossIncurred: 50_000 }, NO_FOOTPRINT, {
        lossCount: 2,
        lossIncurred: 90_000,
      })
    ).toBe(false);
  });

  it("treats a clean account as clean rather than as unknown", () => {
    expect(
      guideFits({ maxLosses: 0 }, NO_FOOTPRINT, { lossCount: 0, lossIncurred: 0 })
    ).toBe(true);
  });
});

describe("paper type filters the search, not the sweep", () => {
  it("hides the other paper when the search asks for one", () => {
    expect(
      guideFits({ paperType: "SURPLUS_LINES" }, NO_FOOTPRINT, { paperType: "ADMITTED" })
    ).toBe(false);
    expect(
      guideFits({ paperType: "ADMITTED" }, NO_FOOTPRINT, { paperType: "ADMITTED" })
    ).toBe(true);
  });

  it("keeps a guide whose paper nobody has recorded", () => {
    // "Nobody has said" must not hide a market — the alternative is a carrier
    // silently missing from the finder until someone backfills a column.
    expect(guideFits(OPEN, NO_FOOTPRINT, { paperType: "ADMITTED" })).toBe(true);
  });

  it("ignores paper entirely when the search doesn't ask — the sweep's case", () => {
    expect(guideFits({ paperType: "SURPLUS_LINES" }, NO_FOOTPRINT, {})).toBe(true);
  });
});

describe("the rules that predate the new columns still hold", () => {
  it("falls back to the carrier's states when the guide names none", () => {
    expect(guideFits(OPEN, { states: ["MA", "RI"] }, { state: "CT" })).toBe(false);
    expect(guideFits(OPEN, { states: ["MA", "RI"] }, { state: "RI" })).toBe(true);
    // The guide's own list wins when it has one — that is what "narrower
    // than the carrier's footprint" means.
    expect(guideFits({ states: ["MA"] }, { states: ["MA", "RI"] }, { state: "RI" })).toBe(
      false
    );
  });

  it("bounds TIV and construction year", () => {
    const g = {
      minValue: 1_000_000,
      maxValue: 20_000_000,
      minConstructionYear: 1980,
      maxConstructionYear: 2020,
    };
    expect(guideFits(g, NO_FOOTPRINT, { totalInsuredValue: 900_000 })).toBe(false);
    expect(guideFits(g, NO_FOOTPRINT, { totalInsuredValue: 20_000_000 })).toBe(true);
    expect(guideFits(g, NO_FOOTPRINT, { yearBuilt: 1979 })).toBe(false);
    expect(guideFits(g, NO_FOOTPRINT, { yearBuilt: 1980 })).toBe(true);
  });

  it("survives a range entered backwards", () => {
    // Legacy rows predate the entry-time guard, and an inverted range that
    // matched nothing would look exactly like no appetite.
    expect(
      guideFits({ minValue: 20_000_000, maxValue: 1_000_000 }, NO_FOOTPRINT, {
        totalInsuredValue: 5_000_000,
      })
    ).toBe(true);
    expect(order(9, 2)).toEqual([2, 9]);
    expect(order(2, 9)).toEqual([2, 9]);
    expect(order(null, 9)).toEqual([null, 9]);
  });

  it("does not exclude a lead-sourced risk on lines it has not got yet", () => {
    const g = { linesWritten: ["Commercial Property"] };
    expect(guideFits(g, NO_FOOTPRINT, { lines: [] })).toBe(true);
    expect(guideFits(g, NO_FOOTPRINT, { lines: ["D&O"] })).toBe(false);
    expect(
      guideFits(g, NO_FOOTPRINT, { lines: ["D&O", "Commercial Property"] })
    ).toBe(true);
  });
});

describe("summarizeLosses", () => {
  const losses = [
    { dateOfLoss: "2024-06-01", amountPaid: 10_000, amountReserved: 5_000 },
    { dateOfLoss: "2022-01-15", amountPaid: 2_000 },
    // Outside the window by a day.
    { dateOfLoss: "2021-08-27", amountPaid: 500_000 },
  ];

  it("counts and totals only what falls inside the window", () => {
    expect(summarizeLosses(losses, "2026-08-28")).toEqual({
      count: 2,
      incurred: 17_000,
    });
  });

  it("counts reserves, so an open claim is not a clean year", () => {
    expect(
      summarizeLosses([{ dateOfLoss: "2026-01-01", amountReserved: 250_000 }], "2026-08-28")
    ).toEqual({ count: 1, incurred: 250_000 });
  });

  it("ignores a loss with no date rather than dropping it into the window", () => {
    expect(summarizeLosses([{ amountPaid: 99 }], "2026-08-28")).toEqual({
      count: 0,
      incurred: 0,
    });
  });

  it("uses the window the guides advertise", () => {
    expect(LOSS_LOOKBACK_YEARS).toBe(5);
  });
});

describe("restrictionSummary", () => {
  it("says nothing when the guide restricts nothing", () => {
    expect(restrictionSummary(OPEN)).toBe("");
  });

  it("names every restriction that would exclude a carrier", () => {
    const summary = restrictionSummary({
      writesCoastal: false,
      minMilesToCoast: 5,
      maxRentalPct: 25,
      maxLosses: 2,
      maxLossIncurred: 50_000,
    });
    expect(summary).toBe(
      "no coastal · ≥5 mi to coast · rentals ≤25% · ≤2 losses/5yr · ≤$50,000 incurred"
    );
  });

  it("distinguishes writing the coast from not having been asked", () => {
    expect(restrictionSummary({ writesCoastal: true })).toBe("writes coastal");
    expect(restrictionSummary({ writesCoastal: null })).toBe("");
  });

  it("reports a zero cap rather than treating it as unset", () => {
    // `maxLosses: 0` is the strictest possible answer — "no losses at all" —
    // and a falsy check here would render it as no restriction.
    expect(restrictionSummary({ maxLosses: 0 })).toBe("≤0 losses/5yr");
  });
});
