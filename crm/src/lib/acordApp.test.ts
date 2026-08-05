import { describe, expect, it, vi } from "vitest";

// acordApp reaches ./client for its `Account` type only, but the module graph
// still loads it, and client.ts calls generateClient() at module scope.
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {} }),
}));

import { legalEntityFor } from "./acordApp";
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
