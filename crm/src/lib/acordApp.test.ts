import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// acordApp reaches ./client for its `Account` type only, but the module graph
// still loads it, and client.ts calls generateClient() at module scope.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import {
  PRIOR_COVERAGE_FIELDS,
  legalEntityFor,
  newestPriorByLine,
} from "./acordApp";
import { LINES_OF_BUSINESS } from "./client";
import { ACORD125_LEGAL_ENTITY_FIELDS, LEGAL_ENTITY_OPTIONS } from "./enums";

/**
 * The ACORD 125's Legal Entity box.
 *
 * Worth its own test because W2 replaced a hardcoded checkbox with a table
 * lookup, and the failure mode is invisible from inside the app: a box that
 * silently stops being ticked on a PDF that goes to a carrier. Nothing in the
 * CRM's own screens would look any different.
 */
describe("legalEntityFor", () => {
  it("keeps ticking Not For Profit for an association that predates the column", () => {
    // Every account in the system is this case on the day W2 ships. Before
    // it, the 125 ticked Not-For-Profit for every ASSOCIATION unconditionally.
    expect(legalEntityFor({ type: "ASSOCIATION" })).toBe("NOT_FOR_PROFIT");
    expect(legalEntityFor({ type: "ASSOCIATION", legalEntityType: null })).toBe(
      "NOT_FOR_PROFIT"
    );
  });

  it("ticks nothing for a non-association that hasn't said", () => {
    // Also the pre-W2 behaviour: the box was only ever ticked for associations.
    expect(legalEntityFor({ type: "PERSONAL" })).toBeNull();
    expect(legalEntityFor({ type: "COMMERCIAL_OTHER" })).toBeNull();
    expect(legalEntityFor({})).toBeNull();
  });

  it("lets a stated type win, including over the association fallback", () => {
    // An HOA that is actually incorporated says so, and the fallback is a
    // stand-in for an unanswered question rather than a fact.
    expect(
      legalEntityFor({ type: "ASSOCIATION", legalEntityType: "CORPORATION" })
    ).toBe("CORPORATION");
    expect(legalEntityFor({ type: "PERSONAL", legalEntityType: "TRUST" })).toBe(
      "TRUST"
    );
  });

  it("only ever returns a member the mapping can tick", () => {
    for (const o of LEGAL_ENTITY_OPTIONS) {
      const picked = legalEntityFor({ legalEntityType: o.value });
      expect(picked).toBe(o.value);
      expect(ACORD125_LEGAL_ENTITY_FIELDS[picked!]).toBeDefined();
    }
  });
});

/**
 * The ACORD 125's prior-coverage block, which W3 turned from one hardcoded
 * General Liability row fed by five Account columns into one row per line fed
 * by the PriorCarrier table.
 */
describe("newestPriorByLine", () => {
  const row = (
    lineOfBusiness: string | null,
    expirationDate: string | null,
    policyNumber?: string,
    effectiveDate?: string
  ) => ({ lineOfBusiness, expirationDate, policyNumber, effectiveDate });

  it("keeps one row per line — the term the submission is replacing", () => {
    const picked = newestPriorByLine([
      row("General Liability", "2024-06-01", "old"),
      row("General Liability", "2026-06-01", "current"),
      row("Property", "2026-03-01", "prop"),
    ]);
    expect(picked.size).toBe(2);
    expect(picked.get("General Liability")?.policyNumber).toBe("current");
    expect(picked.get("Property")?.policyNumber).toBe("prop");
  });

  it("falls back to the term start when a row has no expiration", () => {
    // A row typed off a declarations page that never stated an end date still
    // knows when it began, and is not therefore the older of the two.
    const picked = newestPriorByLine([
      row("Property", "2024-01-01", "old"),
      row("Property", null, "newer", "2026-01-01"),
    ]);
    expect(picked.get("Property")?.policyNumber).toBe("newer");
  });

  it("prefers any dated row over one with no dates at all", () => {
    const picked = newestPriorByLine([
      row("Property", null, "undated"),
      row("Property", "2020-01-01", "dated"),
    ]);
    expect(picked.get("Property")?.policyNumber).toBe("dated");
  });

  it("drops rows with no line — there is no row on the form for them", () => {
    const picked = newestPriorByLine([row(null, "2026-01-01"), row("", "2026-01-01")]);
    expect(picked.size).toBe(0);
  });
});

describe("PRIOR_COVERAGE_FIELDS", () => {
  it("keeps the one confirmed prefix — General Liability — unchanged", () => {
    // These five field names are what acordApp filled before PriorCarrier
    // existed, and they are the only evidence in the file for what the block
    // is called. Every other entry is derived from them.
    expect(PRIOR_COVERAGE_FIELDS["General Liability"]).toEqual([
      "PriorCoverage_GeneralLiability_",
    ]);
  });

  it("does not borrow LOB_FIELDS's token for the same line", () => {
    // The counterexample that makes every other entry a guess: the two
    // sections of the same form call general liability different things.
    const src = readFileSync(resolve(process.cwd(), "src/lib/acordApp.ts"), "utf8");
    expect(src).toContain("Policy_LineOfBusiness_CommercialGeneralLiability_A");
    expect(PRIOR_COVERAGE_FIELDS["General Liability"][0]).not.toContain(
      "CommercialGeneralLiability"
    );
  });

  it("only names lines the CRM's own vocabulary has", () => {
    // A key that isn't a real line of business can never match a row, so it
    // would be a mapping that silently does nothing.
    for (const line of Object.keys(PRIOR_COVERAGE_FIELDS)) {
      expect(LINES_OF_BUSINESS, `${line} is not a line of business`).toContain(line);
    }
  });

  it("gives every line at least one candidate prefix, all in one block", () => {
    for (const [line, prefixes] of Object.entries(PRIOR_COVERAGE_FIELDS)) {
      expect(prefixes.length, `${line} has no candidates`).toBeGreaterThan(0);
      for (const p of prefixes) expect(p).toMatch(/^PriorCoverage_\w+_$/);
    }
  });
});
