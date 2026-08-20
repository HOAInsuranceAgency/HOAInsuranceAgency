import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every field a website lead can carry has to be named in four places, none of
 * which the compiler connects:
 *
 *   1. `CrmLeadInput` in `web/src/lib/crmLead.ts`   — what a form may pass
 *   2. the GraphQL variable signature               — what is declared
 *   3. the `submitWebLead(...)` argument list       — what is forwarded
 *   4. `submitWebLead.arguments` in the CRM schema  — what AppSync accepts
 *
 * Miss any one and the value is dropped in silence: no type error, no GraphQL
 * error, and a lead that looks like it never answered the question. That is
 * exactly what happened to `unitCount` and `currentPolicyExpiration`, whose
 * answers reached the CRM only as a line of prose in `notes` while the columns
 * that drive the Units list and the renewal pipeline stayed empty.
 *
 * Source text rather than imports because `crmLead.ts` reads
 * `import.meta.env` at module scope and the mutation is a template string, so
 * there is nothing importable to compare.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const CRM_LEAD = read("../../../web/src/lib/crmLead.ts");
const SCHEMA = read("../../amplify/data/resource.ts");

/** The `CrmLeadInput` interface body → its field names. */
function inputFields(): string[] {
  const body = CRM_LEAD.match(/export interface CrmLeadInput \{([\s\S]*?)\n\}/)?.[1];
  if (!body) throw new Error("CrmLeadInput not found in web/src/lib/crmLead.ts");
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** `mutation SubmitWebLead( ... )` → the declared variable names. */
function declaredVariables(): string[] {
  const sig = CRM_LEAD.match(/mutation SubmitWebLead\(([\s\S]*?)\)\s*\{/)?.[1];
  if (!sig) throw new Error("mutation signature not found");
  return [...sig.matchAll(/\$(\w+):/g)].map((m) => m[1]);
}

/** `submitWebLead( ... )` inside the document → the forwarded argument names. */
function forwardedArguments(): string[] {
  const call = CRM_LEAD.match(/submitWebLead\(([\s\S]*?)\)\n\}/)?.[1];
  if (!call) throw new Error("submitWebLead call not found");
  return [...call.matchAll(/(\w+):\s*\$(\w+)/g)].map((m) => {
    // A field renamed on one side of the colon would forward the wrong value.
    expect(m[1]).toBe(m[2]);
    return m[1];
  });
}

/** `submitWebLead: a.mutation().arguments({ ... })` → what AppSync accepts. */
function schemaArguments(): string[] {
  const block = SCHEMA.match(
    /submitWebLead: a\s*\n?\s*\.mutation\(\)\s*\n?\s*\.arguments\(\{([\s\S]*?)\n      \}\)/
  )?.[1];
  if (!block) throw new Error("submitWebLead arguments not found in the schema");
  return [...block.matchAll(/^\s{8}(\w+): a\./gm)].map((m) => m[1]);
}

describe("web lead fields agree across all four declarations", () => {
  it("finds all four lists", () => {
    // Guards the regexes themselves: a reformat that silently matched nothing
    // would turn every test below into a vacuous pass.
    expect(inputFields().length).toBeGreaterThan(10);
    expect(declaredVariables().length).toBeGreaterThan(10);
    expect(forwardedArguments().length).toBeGreaterThan(10);
    expect(schemaArguments().length).toBeGreaterThan(10);
  });

  it("declares, forwards and accepts exactly the input's fields", () => {
    const input = inputFields().sort();
    expect(declaredVariables().sort()).toEqual(input);
    expect(forwardedArguments().sort()).toEqual(input);
    expect(schemaArguments().sort()).toEqual(input);
  });

  /**
   * The two that prompted this test. Named explicitly so deleting them from the
   * chain fails with the reason rather than as an anonymous set difference.
   */
  it("carries the fields that feed the Units column and the renewal pipeline", () => {
    for (const field of ["unitCount", "currentPolicyExpiration"]) {
      expect(inputFields()).toContain(field);
      expect(declaredVariables()).toContain(field);
      expect(forwardedArguments()).toContain(field);
      expect(schemaArguments()).toContain(field);
    }
  });
});
