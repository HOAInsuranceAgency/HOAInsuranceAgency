import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aprCapViolation,
  jurisdictionFor,
  minPrincipalViolation,
  originationGate,
} from "./gate";
import { coverageVerdict, normalizeLine, PERSONAL_LINES_WARNING } from "./coverage";
import { PF_COVERAGE_ALLOW, PF_COVERAGE_DENY, PF_JURISDICTIONS } from "./jurisdictions";

describe("jurisdictionFor", () => {
  it("resolves USPS codes, full names, any casing, stray whitespace", () => {
    for (const input of ["MA", "ma", " Massachusetts ", "massachusetts"]) {
      expect(jurisdictionFor(input)?.name, input).toBe("Massachusetts");
    }
    expect(jurisdictionFor("DC")?.name).toBe("District of Columbia");
    expect(jurisdictionFor("district of columbia")?.name).toBe("District of Columbia");
  });

  it("returns null for anything unrecognized", () => {
    for (const bad of ["", "  ", null, undefined, "Puerto Rico", "XX", "Mass."]) {
      expect(jurisdictionFor(bad), String(bad)).toBeNull();
    }
  });
});

describe("originationGate", () => {
  it("opens an open, verified jurisdiction", () => {
    const d = originationGate("MA");
    expect(d.open).toBe(true);
  });

  it("blocks every closed jurisdiction with its note as the reason", () => {
    for (const j of PF_JURISDICTIONS.filter((x) => x.status === "closed")) {
      const d = originationGate(j.code);
      expect(d.open, j.name).toBe(false);
      if (!d.open) expect(d.reason, j.name).toBe(j.note);
    }
  });

  it("treats an unverified ceiling as closed, whatever the status says", () => {
    // Arkansas and Rhode Island ship status:open with verified:false —
    // deliberately. Their ceilings are unresolved, so they behave closed.
    for (const code of ["AR", "RI"]) {
      const d = originationGate(code);
      expect(d.open, code).toBe(false);
      if (!d.open) expect(d.reason).toContain("unverified");
    }
  });

  it("blocks conditional jurisdictions until a current counsel opinion exists", () => {
    for (const code of ["OH", "UT", "VA"]) {
      const blocked = originationGate(code);
      expect(blocked.open, code).toBe(false);
      if (!blocked.open) expect(blocked.reason).toContain("counsel opinion");
      const opened = originationGate(code, { hasCurrentCounselOpinion: true });
      expect(opened.open, code).toBe(true);
    }
  });

  it("fails closed on a missing or unrecognized state", () => {
    for (const bad of [null, undefined, "", "Guam", "XX"]) {
      const d = originationGate(bad);
      expect(d.open, String(bad)).toBe(false);
    }
  });
});

/**
 * Addition B from the signed decisions: the gate keys off the association's
 * PHYSICAL address state and must never move to a mailing address, even if
 * one is added to the Account model someday. The gate takes a bare state
 * string, so the enforceable property is that this module never mentions any
 * other address concept.
 */
describe("the gate reads nothing but a state", () => {
  it("references no mailing/city/zip/address field", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/premiumFinance/gate.ts"),
      "utf8"
    );
    // Strip comments — the warning about mailing addresses lives there.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of ["mailing", "city", "zip", "address"]) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

describe("aprCapViolation", () => {
  it("rejects above a verified cap, naming the cap only in the rejection", () => {
    const fl = jurisdictionFor("FL")!;
    expect(aprCapViolation(18.0, fl)).toBeNull();
    expect(aprCapViolation(18.01, fl)).toContain("18");
    expect(aprCapViolation(14.0, fl)).toBeNull();
  });

  it("accepts any positive rate where there is no statutory cap", () => {
    const ma = jurisdictionFor("MA")!;
    expect(aprCapViolation(14.0, ma)).toBeNull();
    expect(aprCapViolation(24.0, ma)).toBeNull();
  });

  it("rejects nonsense rates everywhere", () => {
    const ma = jurisdictionFor("MA")!;
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(aprCapViolation(bad, ma), String(bad)).not.toBeNull();
    }
  });

  it("never treats the cap as a default anywhere in the module", () => {
    // Decision E. The only place a cap value may surface is a rejection
    // message; no pf source assigns a default from maxApr.
    for (const file of ["gate.ts", "quote.ts", "coverage.ts"]) {
      const src = readFileSync(
        resolve(process.cwd(), "src/lib/premiumFinance", file),
        "utf8"
      );
      expect(src, file).not.toMatch(/DEFAULT_APR\s*=\s*[^;]*maxApr/);
      expect(src, file).not.toMatch(/apr\s*\?\?\s*[^;]*maxApr/i);
    }
  });
});

describe("minPrincipalViolation", () => {
  it("measures against amount financed, generically", () => {
    const oh = jurisdictionFor("OH")!;
    expect(minPrincipalViolation(99_999.99, oh)).toContain("100,000");
    expect(minPrincipalViolation(100_000, oh)).toBeNull();
    // Everywhere else the field is null and nothing fires.
    expect(minPrincipalViolation(500, jurisdictionFor("MA")!)).toBeNull();
  });
});

describe("coverageVerdict — the most important rule in the module", () => {
  it("passes every line on the signed allow-list", () => {
    for (const line of PF_COVERAGE_ALLOW) {
      const v = coverageVerdict([line], "ASSOCIATION");
      expect(v.ok, line).toBe(true);
    }
  });

  it("hard-blocks every line on the signed deny-list, with the retroactive-void warning", () => {
    for (const line of PF_COVERAGE_DENY) {
      const v = coverageVerdict([line], "ASSOCIATION");
      expect(v.ok, line).toBe(false);
      if (!v.ok) {
        expect(v.hard, line).toBe(true);
        expect(v.reason, line).toContain(PERSONAL_LINES_WARNING);
      }
    }
  });

  it("hard-blocks a PERSONAL account whatever its lines claim", () => {
    const v = coverageVerdict(["Commercial Property"], "PERSONAL");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.hard).toBe(true);
  });

  it("deny beats allow when both appear", () => {
    const v = coverageVerdict(["General Liability", "HO-6"], "ASSOCIATION");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.hard).toBe(true);
  });

  it("blocks unrecognized lines and names them", () => {
    const v = coverageVerdict(["Property"], "ASSOCIATION");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.hard).toBe(false);
      expect(v.reason).toContain('"Property"');
    }
  });

  it("blocks a policy with no lines at all", () => {
    expect(coverageVerdict([], "ASSOCIATION").ok).toBe(false);
    expect(coverageVerdict([null, "  "], "ASSOCIATION").ok).toBe(false);
  });

  it("matches typography, not spelling: HO-3 in any dress is still personal", () => {
    for (const dress of ["HO-3", "HO 3", "ho3", "H.O.-3"]) {
      const v = coverageVerdict([dress], "ASSOCIATION");
      expect(v.ok, dress).toBe(false);
      if (!v.ok) expect(v.hard, dress).toBe(true);
    }
    expect(normalizeLine("Directors & Officers")).toBe("directors and officers");
  });
});

/**
 * Flood: the one genuinely ambiguous line, and the most likely path to an
 * accidental personal-lines financing — so it gets its own suite (decision 3).
 */
describe("flood", () => {
  it("is financeable on an association's own master policy", () => {
    for (const dress of ["Flood", "NFIP", "Private Flood", "Excess Flood"]) {
      expect(coverageVerdict([dress], "ASSOCIATION").ok, dress).toBe(true);
    }
  });

  it("blocks for a human on any other account type", () => {
    for (const type of ["COMMERCIAL_OTHER", "PERSONAL", null, undefined]) {
      const v = coverageVerdict(["Flood"], type as never);
      expect(v.ok, String(type)).toBe(false);
    }
  });

  it("rides along with allowed commercial lines on an association", () => {
    expect(
      coverageVerdict(["Commercial Property", "Flood"], "ASSOCIATION").ok
    ).toBe(true);
  });
});

/**
 * Counsel opinions expire (decision D). Reliance runs from effective to
 * reviewBy; outside the window a conditional jurisdiction is blocked again,
 * whatever paper is on file.
 */
describe("opinion currency", () => {
  const opinion = { effectiveAt: "2026-08-01", reviewBy: "2028-08-01" };

  it("is current inside the window, inclusive at both ends", async () => {
    const { isOpinionCurrent } = await import("./gate");
    expect(isOpinionCurrent(opinion, "2026-08-01")).toBe(true);
    expect(isOpinionCurrent(opinion, "2027-01-15")).toBe(true);
    expect(isOpinionCurrent(opinion, "2028-08-01")).toBe(true);
  });

  it("is not current before effective or past review", async () => {
    const { isOpinionCurrent } = await import("./gate");
    expect(isOpinionCurrent(opinion, "2026-07-31")).toBe(false);
    // A 2026 opinion must not silently authorize a later origination.
    expect(isOpinionCurrent(opinion, "2028-08-02")).toBe(false);
  });

  it("any current opinion among several suffices", async () => {
    const { hasCurrentOpinion } = await import("./gate");
    const stale = { effectiveAt: "2022-01-01", reviewBy: "2024-01-01" };
    expect(hasCurrentOpinion([stale, opinion], "2027-01-01")).toBe(true);
    expect(hasCurrentOpinion([stale], "2027-01-01")).toBe(false);
    expect(hasCurrentOpinion([], "2027-01-01")).toBe(false);
  });

  it("defaults the review horizon to 24 months, clamped at month ends", async () => {
    const { defaultReviewBy } = await import("./gate");
    expect(defaultReviewBy("2026-08-21")).toBe("2028-08-21");
    expect(defaultReviewBy("2024-02-29")).toBe("2026-02-28"); // leap → not
  });
});

/**
 * The no-compensation schema guard (W6). Nine states prohibit any payment
 * flowing from the lending operation to the producer side; in this structure
 * it is one entity so the concept is meaningless — and the schema must not
 * be able to express it anyway, because a field built "for later" is how it
 * gets filled in.
 */
describe("the lending schema cannot express producer compensation", () => {
  it("no pf model carries a compensation field", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const SCHEMA = readFileSync(
      resolve(process.cwd(), "amplify/data/resource.ts"),
      "utf8"
    );
    for (const model of [
      "PfLoan: a",
      "PfLoanPayment: a",
      "PfNotice: a",
      "PfOverride: a",
      "PfCounselOpinion: a",
      "PfComplianceLog: a",
    ]) {
      const at = SCHEMA.indexOf(model);
      expect(at, model).toBeGreaterThan(-1);
      const block = SCHEMA.slice(at, SCHEMA.indexOf(".authorization", at));
      expect(block, model).not.toMatch(
        /commission|referral|bonus|kickback|producer(Fee|Pay|Split|Comp)|revenue.?share/i
      );
      // The only fee anywhere in lending is the flat origination fee.
      const fees = [...block.matchAll(/\w*[Ff]ee\w*/g)].map((m) => m[0]);
      expect(fees.every((f) => /originationFee/i.test(f)), `${model}: ${fees}`).toBe(true);
    }
  });
});
