import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
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

/** Every shipped source file under src/, tests excluded. */
function srcFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe("the premium finance flag", () => {
  const SCHEMA = read("amplify/data/resource.ts");
  const HANDLER = read("amplify/functions/pf-admin/handler.ts");

  it("is flipped only through an Admin/Owner-gated mutation", () => {
    expect(SCHEMA).toMatch(
      /setPremiumFinanceEnabled:[\s\S]{0,400}allow\.groups\(\["ADMIN", "OWNER"\]\)/
    );
  });

  it("logs every flip, with the ruleset hash on the row", () => {
    expect(HANDLER).toContain('rule: "module-flag"');
    expect(HANDLER).toMatch(/enabled \? "ENABLED" : "DISABLED"/);
    expect(HANDLER).toContain("configSha256: PF_CONFIG_SHA256");
  });

  it("orders each direction for its own invariant", () => {
    // Enable: log before flip — flag on implies a row exists, absolutely.
    // Disable: flip before log — off always wins, whatever the log does.
    // Proven behaviorally in pfAdminHandler.test.ts; pinned here in shape.
    expect(HANDLER).toContain("log first, flip second");
    expect(HANDLER).toContain("LOG WRITE FAILED ON DISABLE");
    // "The flag never turns on unlogged" is behavioral, and proven that way:
    // pfAdminHandler.test.ts mocks a dead log table and asserts zero flag
    // writes on enable. A source regex for it pinned the old shape instead.
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

  /**
   * 2026-08-25: the module is always on. The UI's fail-closed context is
   * gone — with no switch, there is no "off" for the screens to discover —
   * and what these three assertions now hold is the shape that replaced it:
   * the app cannot flip the flag, the app does not gate on it, and the
   * interlock that actually stops lending still sits on the writes.
   */
  it("no client code can flip the module", () => {
    // The mutation still exists for an operator with API access; nothing
    // the browser ships may call it, or the switch is back by another name.
    const uiCallers = srcFiles().filter((f) =>
      read(f).includes("setPremiumFinanceEnabled")
    );
    expect(uiCallers).toEqual([]);
  });

  it("no client code gates on the flag any more", () => {
    // A screen reading the flag would be a second answer to "is the module
    // on" — one that can disagree with the stored one the Lambdas enforce.
    const readers = srcFiles().filter((f) =>
      read(f).includes("premiumFinanceEnabled")
    );
    expect(readers).toEqual([]);
  });

  it("the write-time interlock survives the button", () => {
    // The UI switch is gone; these are what actually stop a loan being
    // written under a disabled module, and they are conditions DynamoDB
    // evaluates, not code a deploy can skip.
    for (const f of [
      "amplify/functions/pfOrigination.ts",
      "amplify/functions/pf-election/handler.ts",
    ]) {
      expect(read(f), f).toContain(
        'ConditionExpression: "premiumFinanceEnabled = :on"'
      );
    }
  });
});

describe("servicing never consults the origination gate", () => {
  it("the shared origination core is the only function-side gate importer", () => {
    // Addition A: a jurisdiction closing must stop NEW lending only.
    // Since W8 both loan writers — the pf-originate mutation and the
    // invoice send — drive one core, and THAT is the one legitimate
    // importer; payment posting, notices and payoff never may — an active
    // loan in a closed state must keep servicing, because we cannot un-lend.
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
    expect(offenders.map((p) => p.split("/functions/")[1])).toEqual([
      "pfOrigination.ts",
    ]);
  });

  it("both loan writers delegate to the shared core — gates cannot drift apart", () => {
    const originate = read("amplify/functions/pf-originate/handler.ts");
    const send = read("amplify/functions/send-invoice/handler.ts");
    expect(originate).toContain('import { originateLoan } from "../pfOrigination"');
    expect(send).toContain('import { originateLoan } from "../pfOrigination"');
  });
});

describe("the origination core", () => {
  const SCHEMA = readFileSync(resolve(process.cwd(), "amplify/data/resource.ts"), "utf8");
  const HANDLER = readFileSync(
    resolve(process.cwd(), "amplify/functions/pfOrigination.ts"),
    "utf8"
  );

  it("is the only way a loan can exist — the model takes no client writes", () => {
    const at = SCHEMA.indexOf("PfLoan: a");
    const block = SCHEMA.slice(at, SCHEMA.indexOf(".authorization", at) + 200);
    expect(block).toContain('allow.authenticated().to(["read"])');
    expect(block).not.toMatch(/"create"|"update"|"delete"/);
    expect(block).not.toContain("allow.groups");
  });

  it("re-checks the module flag server-side — a hidden button is not a gate", () => {
    // Every caller reads the flag before asking, and the core refuses and
    // logs when it arrives off — belt at the door, braces in the core.
    expect(read("amplify/functions/pf-originate/handler.ts")).toContain(
      "premiumFinanceEnabled === true"
    );
    expect(read("amplify/functions/send-invoice/handler.ts")).toContain(
      "premiumFinanceEnabled !== true) return null"
    );
    expect(HANDLER).toMatch(/rule: "module-flag"/);
  });

  it("holds the 25% down floor at the API, not just in the UI", () => {
    expect(HANDLER).toContain("downPctViolation(req.downPct)");
    expect(HANDLER).toMatch(/rule: "min-down"/);
  });

  it("rejects an APR above the cap at the API, not just in the UI", () => {
    // The quote rides along since RI joined: a fee-in-cap jurisdiction
    // tests the effective rate, which only the schedule can answer — so the
    // quote must be built before the cap decision, and passed into it.
    expect(HANDLER).toContain("aprCapViolation(req.apr, gate.jurisdiction, quote)");
    expect(HANDLER.indexOf("const quote = buildQuote(")).toBeLessThan(
      HANDLER.indexOf("aprCapViolation(req.apr, gate.jurisdiction, quote)")
    );
    expect(HANDLER).toMatch(/rule: "apr-cap"/);
  });

  it("checks the minimum principal against amount financed", () => {
    expect(HANDLER).toContain("minPrincipalViolation(");
    expect(HANDLER).toContain("quote.amountFinanced");
  });

  it("stamps the ruleset SHA on the loan and on every decision row", () => {
    expect(HANDLER).toContain("configSha256: PF_CONFIG_SHA256");
    expect((HANDLER.match(/configSha256: PF_CONFIG_SHA256/g) ?? []).length).toBe(2);
  });

  it("creates no loan when the compliance log cannot be written", () => {
    // The kill switch's failure direction, worn by origination: no record,
    // no loan. A refusal, by contrast, is safe even unlogged.
    expect(HANDLER).toContain("was NOT issued");
    const guard = HANDLER.indexOf("was NOT issued");
    const create = HANDLER.indexOf("TransactWriteCommand({");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
  });

  it("freezes the schedule on the loan rather than recomputing later", () => {
    expect(HANDLER).toContain("schedule: JSON.stringify(quote.schedule)");
  });
});

/**
 * Every Lambda that builds an Amplify data client has the API grant it needs.
 *
 * The failure this guards is silent until runtime and has now happened twice:
 * stripe-webhook shipped calling getAmplifyDataClientConfig with no
 * allow.resource() and threw "data environment variables are malformed" on
 * its first real event, and pf-originate nearly shipped the same way — a
 * python replace missed its anchor and the grant quietly never landed. tsc
 * and synth both pass on that state; only a deploy fails. This maps every
 * handler that uses the data client to an allow.resource() on its imported
 * name, so the gap is a test failure instead of a production incident.
 */
describe("data-client Lambdas carry their grants", () => {
  // Independent deployment ownership: the shared communications module serves
  // both the API handler and its delivery worker, not every function in that directory.
  const owners = {
    "activity-log/handler.ts": ["activityLog"],
    "communications/data.ts": ["communications", "communicationWorker"],
    "extract-lead/handler.ts": ["extractLead"],
    "form-filler/handler.ts": ["formFiller"],
    "lead-reply/handler.ts": ["leadReply"],
    "lead-upload/handler.ts": ["leadUpload"],
    "pf-agreement/handler.ts": ["pfAgreement"],
    "pf-autopay/handler.ts": ["pfAutopay"],
    "pf-default-sweep/handler.ts": ["pfDefaultSweep"],
    "pf-election/handler.ts": ["pfElection"],
    "pf-originate/handler.ts": ["pfOriginate"],
    "pf-servicing/handler.ts": ["pfServicing"],
    "portal-sweep/handler.ts": ["portalSweep"],
    "process-document/handler.ts": ["processDocument"],
    "send-invoice/handler.ts": ["sendInvoice"],
    "upload-portal/handler.ts": ["uploadPortal"],
  };

  function initializesDataClient(source: string): boolean {
    const file = ts.createSourceFile("consumer.ts", source, ts.ScriptTarget.Latest, true);
    const initializers = new Set<string>();
    const namespaces = new Map<string, string>();
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
      const exported = node.moduleSpecifier.text.endsWith("/data-client") ? "createDataClientGetter"
        : node.moduleSpecifier.text === "@aws-amplify/backend/function/runtime" ? "getAmplifyDataClientConfig" : undefined;
      const bindings = node.importClause?.namedBindings;
      if (!exported || !bindings) continue;
      if (ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, exported);
      else for (const binding of bindings.elements) if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === exported) initializers.add(binding.name.text);
    }
    let found = false;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && initializers.has(node.expression.text)) found = true;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && namespaces.get(node.expression.expression.text) === node.expression.name.text) found = true;
      ts.forEachChild(node, visit);
    }
    visit(file);
    return found;
  }

  function discoverConsumers(directory = "amplify/functions", prefix = ""): string[] {
    return readdirSync(resolve(process.cwd(), directory), { withFileTypes: true }).flatMap(entry => {
      const path = `${directory}/${entry.name}`, name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return discoverConsumers(path, `${name}/`);
      if (!entry.name.endsWith(".ts") || name === "data-client.ts") return [];
      const source = read(path);
      return /createDataClientGetter|getAmplifyDataClientConfig/.test(source) && initializesDataClient(source) ? [name] : [];
    }).sort();
  }

  function requireGrants(consumers: string[], schema: string) {
    if (!consumers.length) throw new Error("No data-client Lambda consumers were discovered");
    if (JSON.stringify([...consumers].sort()) !== JSON.stringify(Object.keys(owners).sort())) throw new Error("Data-client consumer ownership inventory changed");
    const file = ts.createSourceFile("schema.ts", schema, ts.ScriptTarget.Latest, true);
    const imported = new Map<string, string>(), granted = new Set<string>();
    for (const node of file.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) continue;
      const directory = /^\.\.\/functions\/([^/]+)\/resource$/.exec(node.moduleSpecifier.text)?.[1];
      const bindings = node.importClause?.namedBindings;
      if (!directory || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) if (!binding.isTypeOnly) imported.set(`${directory}:${(binding.propertyName ?? binding.name).text}`, binding.name.text);
    }
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resource"
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "allow" && node.arguments[0] && ts.isIdentifier(node.arguments[0])) granted.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(file);
    const missing = Object.entries(owners).flatMap(([module, names]) => names.filter(name => {
      const local = imported.get(`${module.split("/")[0]}:${name}`);
      return !local || !granted.has(local);
    }));
    if (missing.length) throw new Error(`Missing allow.resource grants: ${missing.join(", ")}`);
  }

  const consumers = discoverConsumers(), schema = read("amplify/data/resource.ts");
  const requiredOwners = Object.values(owners).flat();

  it("discovers all 16 consumers and checks their 17 Lambda owners", () => {
    expect(consumers).toHaveLength(16);
    expect(requiredOwners).toHaveLength(17);
    requireGrants(consumers, schema);
  });

  it.each(requiredOwners)("fails when the required %s grant is removed", owner => {
    const changed = schema.replace(`allow.resource(${owner}),`, "");
    expect(changed).not.toBe(schema);
    expect(() => requireGrants(consumers, changed)).toThrow(owner);
  });

  it("refuses vacuous discovery", () => {
    expect(() => requireGrants([], schema)).toThrow("No data-client Lambda consumers");
    expect(() => requireGrants(consumers.slice(1), schema)).toThrow("ownership inventory changed");
  });

  it("recognizes actual factory and legacy calls, including aliases, rather than comments or unused imports", () => {
    expect(initializesDataClient(`import { createDataClientGetter as lazy } from '../data-client'; const getClient = lazy();`)).toBe(true);
    expect(initializesDataClient(`import { getAmplifyDataClientConfig as config } from '@aws-amplify/backend/function/runtime'; async function getClient() { return config(process.env); }`)).toBe(true);
    expect(initializesDataClient(`import * as clients from '../data-client'; const getClient = clients.createDataClientGetter();`)).toBe(true);
    expect(initializesDataClient(`import { createDataClientGetter } from '../data-client'; // createDataClientGetter()`)).toBe(false);
  });
});
