import { describe, expect, it } from "vitest";
import { eligibilityBlocked, evaluateEligibility } from "./eligibility";
import { PERSONAL_LINES_WARNING } from "./coverage";

/** A placement that passes everything, to mutate one screen at a time. */
const clean = {
  lines: ["Commercial Property", "General Liability"],
  accountType: "ASSOCIATION",
  producerOfRecord: true as boolean | null,
};

const check = (inputs: Parameters<typeof evaluateEligibility>[0], name: string) =>
  evaluateEligibility(inputs).find((c) => c.check === name)!;

describe("the two screens on a clean placement", () => {
  it("all pass", () => {
    const checks = evaluateEligibility(clean);
    expect(checks).toHaveLength(2);
    expect(eligibilityBlocked(checks)).toBe(false);
    for (const c of checks) expect(c.ok, c.check).toBe(true);
  });

  /**
   * Two screens retired by signed decision, both 2026-08-24: MEP (the
   * agency knowingly accepts early-default undersecurity) and auditable
   * (Jake: "everything we do is final once entered"). No input can
   * resurrect either — this is the pin that a merge never quietly brings
   * one back. With them went every override.
   */
  it("never emits an MEP or auditable check — both screens retired, signed", () => {
    expect(evaluateEligibility(clean).map((c) => c.check)).toEqual([
      "coverage",
      "producer-of-record",
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
});

describe("producer of record — explicit true or nothing", () => {
  it("blocks null: an unconfirmed placement is where wholesale enters", () => {
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

describe("incorporated borrower — Rhode Island's condition, nobody else's", () => {
  it("the screen does not exist where no row demands it", () => {
    // The two screens stay two everywhere but RI.
    expect(evaluateEligibility(clean)).toHaveLength(2);
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
    expect(checks).toHaveLength(3);
    expect(eligibilityBlocked(checks)).toBe(false);
  });
});

describe("no override exists anywhere any more", () => {
  it("the inputs type has no overrides field and no check reports one", () => {
    // Structural pin: every surviving screen blocks on a fact only
    // confirming can fix — an overrides parameter reappearing is a design
    // change someone must sign, not a refactor.
    const checks = evaluateEligibility({ ...clean, producerOfRecord: null });
    for (const c of checks) {
      expect("overridden" in c).toBe(false);
    }
  });
});
