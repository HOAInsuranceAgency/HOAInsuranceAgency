import { describe, expect, it } from "vitest";
import { eligibilityBlocked, evaluateEligibility } from "./eligibility";
import { PERSONAL_LINES_WARNING } from "./coverage";

/** A policy that passes everything, to mutate one screen at a time. */
const clean = {
  lines: ["Commercial Property", "General Liability"],
  accountType: "ASSOCIATION",
  producerOfRecord: true as boolean | null,
  minimumEarnedPremiumPct: 0 as number | null,
  isAuditable: false as boolean | null,
  downPct: 25,
};

const check = (inputs: typeof clean & { overrides?: never } | Parameters<typeof evaluateEligibility>[0], name: string) =>
  evaluateEligibility(inputs).find((c) => c.check === name)!;

describe("the four screens on a clean policy", () => {
  it("all pass", () => {
    const checks = evaluateEligibility(clean);
    expect(checks).toHaveLength(4);
    expect(eligibilityBlocked(checks)).toBe(false);
    for (const c of checks) expect(c.ok, c.check).toBe(true);
  });
});

describe("commercial lines — hard block, no override, ever", () => {
  it("blocks a personal line with the retroactive-void warning", () => {
    const c = check({ ...clean, lines: ["HO-6"] }, "coverage");
    expect(c.ok).toBe(false);
    expect(c.hard).toBe(true);
    expect(c.reason).toContain(PERSONAL_LINES_WARNING);
  });

  it("has no override path — an override row changes nothing", () => {
    // Overrides exist for MEP and auditable only. Passing them cannot touch
    // the coverage screen; the schema has no PfOverride check for it either.
    const checks = evaluateEligibility({
      ...clean,
      lines: ["Personal Auto"],
      overrides: { mep: { reason: "x" }, auditable: { reason: "x" } },
    });
    expect(checks.find((c) => c.check === "coverage")!.ok).toBe(false);
  });
});

describe("producer of record — explicit true or nothing", () => {
  it("blocks null: an unconfirmed policy is where wholesale enters", () => {
    const c = check({ ...clean, producerOfRecord: null }, "producer-of-record");
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("not been confirmed");
  });

  it("blocks false, in plainer words", () => {
    const c = check({ ...clean, producerOfRecord: false }, "producer-of-record");
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("wholesale");
  });
});

describe("minimum earned premium vs the down payment", () => {
  it("blocks when MEP meets or exceeds the down, showing the arithmetic", () => {
    const c = check(
      { ...clean, minimumEarnedPremiumPct: 25, downPct: 25 },
      "mep"
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toBe(
      "25% MEP against a 25% down payment leaves no collateral cushion at inception."
    );
  });

  it("passes when the down clears the MEP", () => {
    expect(
      check({ ...clean, minimumEarnedPremiumPct: 20, downPct: 25 }, "mep").ok
    ).toBe(true);
  });

  it("blocks an unrecorded MEP — blank is not an answer, zero is", () => {
    expect(check({ ...clean, minimumEarnedPremiumPct: null }, "mep").ok).toBe(false);
    expect(check({ ...clean, minimumEarnedPremiumPct: 0 }, "mep").ok).toBe(true);
  });

  it("passes on an admin override with a written reason, and says so", () => {
    const c = evaluateEligibility({
      ...clean,
      minimumEarnedPremiumPct: 25,
      overrides: { mep: { reason: "Carrier confirmed pro-rata return by email 8/21" } },
    }).find((x) => x.check === "mep")!;
    expect(c.ok).toBe(true);
    expect(c.overridden).toContain("pro-rata");
    // The arithmetic stays visible even on an overridden pass.
    expect(c.reason).toContain("collateral cushion");
  });

  it("ignores an override with no reason — the reason is the record", () => {
    const c = evaluateEligibility({
      ...clean,
      minimumEarnedPremiumPct: 25,
      overrides: { mep: { reason: "" } },
    }).find((x) => x.check === "mep")!;
    expect(c.ok).toBe(false);
  });

  it("does not let an MEP override touch an unrecorded MEP", () => {
    // Null blocks as a data gap; the override is for the arithmetic case.
    const c = evaluateEligibility({
      ...clean,
      minimumEarnedPremiumPct: null,
      overrides: { mep: { reason: "x" } },
    }).find((x) => x.check === "mep")!;
    expect(c.ok).toBe(false);
  });
});

describe("auditable policies", () => {
  it("blocks true, passes false, blocks unrecorded", () => {
    expect(check({ ...clean, isAuditable: true }, "auditable").ok).toBe(false);
    expect(check({ ...clean, isAuditable: false }, "auditable").ok).toBe(true);
    expect(check({ ...clean, isAuditable: null }, "auditable").ok).toBe(false);
  });

  it("passes on an admin override, on the same terms as MEP", () => {
    const c = evaluateEligibility({
      ...clean,
      isAuditable: true,
      overrides: { auditable: { reason: "GL exposure is flat-rated per endorsement 7" } },
    }).find((x) => x.check === "auditable")!;
    expect(c.ok).toBe(true);
    expect(c.overridden).toContain("flat-rated");
  });
});

describe("incorporated borrower — Rhode Island's condition, nobody else's", () => {
  it("the screen does not exist where no row demands it", () => {
    // The four screens stay four everywhere but RI.
    expect(evaluateEligibility(clean)).toHaveLength(4);
  });

  it("unrecorded blocks — the statute does not take our word for it", () => {
    const c = check(
      { ...clean, requiresIncorporatedBorrower: true, jurisdictionName: "Rhode Island" },
      "incorporated"
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("has not been recorded");
    expect(c.reason).toContain("Rhode Island");
  });

  it("recorded unincorporated blocks, with the statute's own condition", () => {
    const c = check(
      {
        ...clean,
        requiresIncorporatedBorrower: true,
        incorporated: false,
        jurisdictionName: "Rhode Island",
      },
      "incorporated"
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("recorded as unincorporated");
  });

  it("recorded incorporated passes, and there is no override path", () => {
    const checks = evaluateEligibility({
      ...clean,
      requiresIncorporatedBorrower: true,
      incorporated: true,
      jurisdictionName: "Rhode Island",
    });
    expect(checks).toHaveLength(5);
    expect(eligibilityBlocked(checks)).toBe(false);
    // Like producer-of-record: the fix is to confirm the fact, not waive it.
    const c = checks.find((x) => x.check === "incorporated")!;
    expect(c.overridden).toBeUndefined();
  });
});
