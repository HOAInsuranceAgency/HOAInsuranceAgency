import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  PF_CONFIG_SHA256,
  PF_COVERAGE_ALLOW,
  PF_COVERAGE_DENY,
  PF_JURISDICTIONS,
} from "./jurisdictions";

/**
 * The drift guard.
 *
 * The YAML is the artifact a human signs; the generated module is what runs.
 * This suite re-parses the YAML independently and asserts the module matches
 * it exactly — so neither file can be edited without the other, and "never
 * edit the YAML to make a test pass" has teeth: if these fail, the fix is a
 * regeneration or a conversation, not an edit here.
 */

// cwd is crm/ under vitest; import.meta.url is not reliably a file: URL here —
// the stripeWebhook.test.ts convention.
const YAML_PATH = resolve(process.cwd(), "config/premium_finance/jurisdictions.yml");
const raw = readFileSync(YAML_PATH, "utf8");
const doc = load(raw) as {
  jurisdictions: {
    name: string;
    status: string;
    max_apr: number | null;
    max_apr_verified: boolean;
    min_principal: number | null;
    note: string;
  }[];
  coverage_lines: { allow: string[]; deny: string[] };
};

describe("the generated module matches the signed YAML", () => {
  it("row for row, field for field", () => {
    expect(PF_JURISDICTIONS.length).toBe(doc.jurisdictions.length);
    for (const [i, y] of doc.jurisdictions.entries()) {
      const g = PF_JURISDICTIONS[i];
      expect(g.name, y.name).toBe(y.name);
      expect(g.status, y.name).toBe(y.status);
      expect(g.maxApr, y.name).toBe(y.max_apr);
      expect(g.maxAprVerified, y.name).toBe(y.max_apr_verified);
      expect(g.minPrincipal, y.name).toBe(y.min_principal);
      expect(g.note, y.name).toBe(y.note);
    }
  });

  it("coverage lists verbatim, in order", () => {
    expect([...PF_COVERAGE_ALLOW]).toEqual(doc.coverage_lines.allow);
    expect([...PF_COVERAGE_DENY]).toEqual(doc.coverage_lines.deny);
  });

  it("carries the SHA-256 of the YAML bytes it was built from", () => {
    // The admin screen shows this hash so a running deployment can be checked
    // against the signed file by eye. If this fails, the module was built from
    // a different file than the one in the tree: regenerate.
    expect(PF_CONFIG_SHA256).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("maps every jurisdiction to a unique USPS code", () => {
    const codes = PF_JURISDICTIONS.map((j) => j.code);
    expect(new Set(codes).size).toBe(51);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
    // Spot checks against reference facts.
    const by = Object.fromEntries(PF_JURISDICTIONS.map((j) => [j.name, j.code]));
    expect(by["Massachusetts"]).toBe("MA");
    expect(by["District of Columbia"]).toBe("DC");
    expect(by["Rhode Island"]).toBe("RI");
  });
});

describe("the signed counts", () => {
  // From the brief, asserted as written: 32 open, 3 conditional, 16 closed;
  // two open rows unverified and therefore closed in behavior; 30 usable.
  const byStatus = (s: string) => PF_JURISDICTIONS.filter((j) => j.status === s);

  it("32 open, 3 conditional, 16 closed — 51 in all", () => {
    expect(byStatus("open").length).toBe(32);
    expect(byStatus("conditional").length).toBe(3);
    expect(byStatus("closed").length).toBe(16);
    expect(PF_JURISDICTIONS.length).toBe(51);
  });

  it("exactly Arkansas is unverified", () => {
    // Explicitly false — closed rows carry null, which is "not applicable",
    // not "unverified". The distinction is the amended decision 1.
    // Rhode Island left this list 2026-08-24: Jake verified § 6-26-2 (21%
    // governs, fee counts toward the ceiling, incorporated borrowers only).
    const unverified = PF_JURISDICTIONS.filter((j) => j.maxAprVerified === false);
    expect(unverified.map((j) => j.name).sort()).toEqual(["Arkansas"]);
    // Still status:open — which is what makes the verified flag load-bearing.
    for (const j of unverified) expect(j.status).toBe("open");
  });

  it("Rhode Island carries the two conditions its verification came with", () => {
    const ri = PF_JURISDICTIONS.find((j) => j.code === "RI")!;
    expect(ri.status).toBe("open");
    expect(ri.maxApr).toBe(21.0);
    expect(ri.maxAprVerified).toBe(true);
    expect(ri.requiresIncorporatedBorrower).toBe(true);
    expect(ri.feeCountsTowardCap).toBe(true);
    // And nobody else does — the fields exist for RI's statute, and a row
    // acquiring them is a signing event, not a default.
    const withEither = PF_JURISDICTIONS.filter(
      (j) => j.requiresIncorporatedBorrower !== null || j.feeCountsTowardCap !== null
    );
    expect(withEither.map((j) => j.name)).toEqual(["Rhode Island"]);
  });

  it("verified is stated on every row that could lend, and on no closed row", () => {
    // The safety property: a closed→open upgrade starts with no verified
    // value, so the ceiling must be re-checked before the row can lend — a
    // stale `true` cannot ride through the status change.
    for (const j of PF_JURISDICTIONS) {
      if (j.status === "closed") {
        expect(j.maxAprVerified, j.name).toBeNull();
      } else {
        expect(typeof j.maxAprVerified, j.name).toBe("boolean");
      }
    }
  });

  it("31 usable — RI joined 2026-08-24", () => {
    const usable = byStatus("open").filter((j) => j.maxAprVerified === true);
    expect(usable.length).toBe(31);
  });

  it("Ohio is the only jurisdiction with a minimum principal", () => {
    const withMin = PF_JURISDICTIONS.filter((j) => j.minPrincipal !== null);
    expect(withMin.map((j) => j.name)).toEqual(["Ohio"]);
    expect(withMin[0].minPrincipal).toBe(100000);
  });

  it("the conditional three are Ohio, Utah, Virginia", () => {
    expect(byStatus("conditional").map((j) => j.name).sort()).toEqual([
      "Ohio",
      "Utah",
      "Virginia",
    ]);
  });

  it("flood appears on neither coverage list", () => {
    // The signed decision: flood resolves in logic, on account type — nobody
    // gets to settle the ambiguous line by editing data.
    for (const line of [...PF_COVERAGE_ALLOW, ...PF_COVERAGE_DENY]) {
      expect(line).not.toMatch(/flood/i);
    }
  });

  it("every note is present — it is the text a blocked user reads", () => {
    for (const j of PF_JURISDICTIONS) {
      expect(j.note.trim().length, j.name).toBeGreaterThan(0);
    }
  });
});
