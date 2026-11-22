import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

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
    "pf-autopay/handler.ts": ["pfAutopay"],
    "pf-default-sweep/handler.ts": ["pfDefaultSweep"],
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

  it("discovers all 13 consumers and checks their 14 Lambda owners", () => {
    expect(consumers).toHaveLength(13);
    expect(requiredOwners).toHaveLength(14);
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
