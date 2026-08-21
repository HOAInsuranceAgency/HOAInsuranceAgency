import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The kill switch and its audit trail cannot come apart.
 *
 * Decision 2 (2026-08-21): the module flag is runtime-flippable so counsel can
 * stop originations in minutes — and every flip must land in PfComplianceLog
 * with who, when, and which way, because an ADMIN-writable toggle on a lending
 * product without an audit trail is worse than an env var. Source-asserted,
 * the stripeWebhook.test.ts way: the properties are structural.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("the premium finance flag", () => {
  const SCHEMA = read("amplify/data/resource.ts");
  const HANDLER = read("amplify/functions/pf-admin/handler.ts");

  it("is flipped only through an ADMIN-gated mutation", () => {
    expect(SCHEMA).toMatch(
      /setPremiumFinanceEnabled:[\s\S]{0,400}allow\.groups\(\["ADMIN"\]\)/
    );
  });

  it("logs every flip, with the ruleset hash on the row", () => {
    expect(HANDLER).toContain('rule: "module-flag"');
    expect(HANDLER).toMatch(/enabled \? "ENABLED" : "DISABLED"/);
    expect(HANDLER).toContain("configSha256: PF_CONFIG_SHA256");
  });

  it("reverts only the enable direction — off always wins", () => {
    // The behavior itself is proven in pfAdminHandler.test.ts against a
    // mocked table; this pins the shape so a refactor that loses the
    // asymmetry is visible in review.
    expect(HANDLER).toContain("reverting the enable");
    expect(HANDLER).toContain("LOG WRITE FAILED ON DISABLE");
    expect(HANDLER).toMatch(/!logged && enabled[\s\S]{0,200}writeFlag\(false\)/);
    // No path writes the flag back to true after a failed log.
    expect(HANDLER).not.toMatch(/!logged[\s\S]{0,300}writeFlag\(true\)/);
  });

  it("keeps the settings screen away from the field", () => {
    // The only writer of premiumFinanceEnabled outside the schema and the
    // pf-admin handler is nobody: the ordinary settings save must not touch
    // it, or flips escape the log.
    const settingsLib = read("src/lib/agencySettings.ts");
    expect(settingsLib).not.toContain("premiumFinanceEnabled");
  });

  it("PfComplianceLog accepts no client writes at all — ADMIN included", () => {
    const at = SCHEMA.indexOf("PfComplianceLog: a");
    expect(at).toBeGreaterThan(-1);
    const block = SCHEMA.slice(at, SCHEMA.indexOf(".authorization", at) + 300);
    expect(block).toContain('allow.authenticated().to(["read"])');
    // No group grant, no create/update/delete for anyone over userPool.
    expect(block).not.toContain('allow.groups');
    expect(block).not.toMatch(/"create"|"update"|"delete"/);
  });

  it("the UI fails closed when the settings read fails", () => {
    const ctx = read("src/lib/premiumFinance/PfContext.tsx");
    expect(ctx).toMatch(/catch\s*\{\s*setEnabled\(false\)/);
  });
});

describe("servicing never consults the origination gate", () => {
  it("no amplify function imports the gate module today", () => {
    // Addition A: a jurisdiction closing must stop NEW lending only. The
    // issuance Lambda (W2+) will import the gate; payment posting, notices
    // and payoff never may. Enumerated when those functions land — for now
    // the invariant is that no function imports it at all.
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const root = resolve(process.cwd(), "amplify/functions");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = resolve(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("premiumFinance/gate")) {
          offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
