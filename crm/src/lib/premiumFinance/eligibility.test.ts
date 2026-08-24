import { describe, expect, it } from "vitest";
import { eligibilityBlocked, evaluateEligibility } from "./eligibility";
import { PERSONAL_LINES_WARNING } from "./coverage";

/** A policy that passes everything, to mutate one screen at a time. */
const clean = {
  lines: ["Commercial Property", "General Liability"],
  accountType: "ASSOCIATION",
  producerOfRecord: true as boolean | null,
  isAuditable: false as boolean | null,
};

const check = (inputs: Parameters<typeof evaluateEligibility>[0], name: string) =>
  evaluateEligibility(inputs).find((c) => c.check === name)!;

describe("the three screens on a clean policy", () => {
  it("all pass", () => {
    const checks = evaluateEligibility(clean);
    expect(checks).toHaveLength(3);
    expect(eligibilityBlocked(checks)).toBe(false);
    for (const c of checks) expect(c.ok, c.check).toBe(true);
  });

  /**
   * The MEP screen retired 2026-08-24 (W8, signed): the agency knowingly
   * accepts early-default undersecurity on high-MEP policies. No input can
   * resurrect it — this is the pin that a merge never quietly brings it back.
   */
  it("never emits an MEP check — the screen is retired, by signed decision", () => {
    expect(evaluateEligibility(clean).map((c) => c.check)).toEqual([
      "coverage",
      "producer-of-record",
      "auditable",
    ]);
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
    // The auditable override is the only one left, and it cannot touch
    // the coverage screen; the schema has no PfOverride check for it either.
    const checks = evaluateEligibility({
      ...clean,
      lines: ["Personal Auto"],
      overrides: { auditable: { reason: "x" } },
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

describe("auditable policies", () => {
  it("blocks true, passes false, blocks unrecorded", () => {
    expect(check({ ...clean, isAuditable: true }, "auditable").ok).toBe(false);
    expect(check({ ...clean, isAuditable: false }, "auditable").ok).toBe(true);
    expect(check({ ...clean, isAuditable: null }, "auditable").ok).toBe(false);
  });

  it("passes on an admin override with a written reason, and says so", () => {
    const c = evaluateEligibility({
      ...clean,
      isAuditable: true,
      overrides: { auditable: { reason: "GL exposure is flat-rated per endorsement 7" } },
    }).find((x) => x.check === "auditable")!;
    expect(c.ok).toBe(true);
    expect(c.overridden).toContain("flat-rated");
    // The collateral arithmetic stays visible even on an overridden pass.
    expect(c.reason).toContain("collateral");
  });

  it("ignores an override with no reason — the reason is the record", () => {
    const c = evaluateEligibility({
      ...clean,
      isAuditable: true,
      overrides: { auditable: { reason: "" } },
    }).find((x) => x.check === "auditable")!;
    expect(c.ok).toBe(false);
  });
});

describe("incorporated borrower — Rhode Island's condition, nobody else's", () => {
  it("the screen does not exist where no row demands it", () => {
    // The three screens stay three everywhere but RI.
    expect(evaluateEligibility(clean)).toHaveLength(3);
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
    expect(checks).toHaveLength(4);
    expect(eligibilityBlocked(checks)).toBe(false);
    // Like producer-of-record: the fix is to confirm the fact, not waive it.
    const c = checks.find((x) => x.check === "incorporated")!;
    expect(c.overridden).toBeUndefined();
  });
});
