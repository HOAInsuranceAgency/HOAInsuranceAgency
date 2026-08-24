import { describe, expect, it } from "vitest";
import { eligibilityBlocked, evaluateEligibility } from "./eligibility";
import { PERSONAL_LINES_WARNING } from "./coverage";

/** A placement that passes everything, to mutate one screen at a time. */
const clean = {
  lines: ["Commercial Property", "General Liability"],
  accountType: "ASSOCIATION",
};

const check = (inputs: Parameters<typeof evaluateEligibility>[0], name: string) =>
  evaluateEligibility(inputs).find((c) => c.check === name)!;

describe("the one screen on a clean placement", () => {
  it("passes", () => {
    const checks = evaluateEligibility(clean);
    expect(checks).toHaveLength(1);
    expect(eligibilityBlocked(checks)).toBe(false);
  });

  /**
   * Three screens retired by signed decision, all 2026-08-24: MEP, auditable
   * ("everything we do is final once entered"), and producer-of-record ("we
   * are always the producer of record" — no wholesale paper exists in this
   * book). No input resurrects any of them — this is the pin that a merge
   * never quietly brings one back. With them went every override.
   */
  it("emits only the coverage check — MEP, auditable and POR are retired, signed", () => {
    expect(evaluateEligibility(clean).map((c) => c.check)).toEqual(["coverage"]);
  });
});

describe("commercial lines — hard block, no override, ever", () => {
  it("blocks a personal line with the retroactive-void warning", () => {
    const c = check({ ...clean, lines: ["HO-6"] }, "coverage");
    expect(c.ok).toBe(false);
    expect(c.hard).toBe(true);
    expect(c.reason).toContain(PERSONAL_LINES_WARNING);
  });

  it("blocks a PERSONAL account whatever its lines claim", () => {
    const c = check({ ...clean, accountType: "PERSONAL" }, "coverage");
    expect(c.ok).toBe(false);
    expect(c.hard).toBe(true);
  });
});

describe("incorporated borrower — Rhode Island's condition, nobody else's", () => {
  it("the screen does not exist where no row demands it", () => {
    expect(evaluateEligibility(clean)).toHaveLength(1);
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
    expect(checks).toHaveLength(2);
    expect(eligibilityBlocked(checks)).toBe(false);
  });
});

describe("no override exists anywhere any more", () => {
  it("no check ever reports one", () => {
    const checks = evaluateEligibility({ ...clean, lines: ["HO-6"] });
    for (const c of checks) {
      expect("overridden" in c).toBe(false);
    }
  });
});
