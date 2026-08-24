import { describe, expect, it } from "vitest";
import {
  linkFields,
  linkKeyOf,
  matchesLink,
  policyLinkLabel,
  quoteLinkLabel,
} from "./documentLinks";

/**
 * One string key moves through the select, the URL, and the update payload —
 * these tests hold the round trip together, and the clearing rule that keeps
 * a re-linked document from pointing two ways at once.
 */

describe("linkKeyOf", () => {
  it("names the policy, the quote, or nothing", () => {
    expect(linkKeyOf({ policyId: "p1" })).toBe("policy:p1");
    expect(linkKeyOf({ quoteId: "q1" })).toBe("quote:q1");
    expect(linkKeyOf({})).toBe("");
    expect(linkKeyOf({ policyId: null, quoteId: null })).toBe("");
  });

  it("the policy speaks for the anchor after a bind rollover leaves both", () => {
    expect(linkKeyOf({ policyId: "p1", quoteId: "q1" })).toBe("policy:p1");
  });
});

describe("linkFields", () => {
  it("sets one side and explicitly CLEARS the other", () => {
    expect(linkFields("policy:p1")).toEqual({ policyId: "p1", quoteId: null });
    expect(linkFields("quote:q1")).toEqual({ policyId: null, quoteId: "q1" });
  });

  it("unlinking clears both", () => {
    expect(linkFields("")).toEqual({ policyId: null, quoteId: null });
  });

  it("garbage clears rather than guessing", () => {
    expect(linkFields("policy:")).toEqual({ policyId: null, quoteId: null });
    expect(linkFields("nonsense")).toEqual({ policyId: null, quoteId: null });
  });

  it("round-trips with linkKeyOf", () => {
    for (const key of ["policy:p1", "quote:q1", ""]) {
      expect(linkKeyOf(linkFields(key))).toBe(key);
    }
  });
});

describe("matchesLink", () => {
  it("empty key shows everything; a key shows its own", () => {
    expect(matchesLink({ policyId: "p1" }, "")).toBe(true);
    expect(matchesLink({}, "")).toBe(true);
    expect(matchesLink({ policyId: "p1" }, "policy:p1")).toBe(true);
    expect(matchesLink({ policyId: "p2" }, "policy:p1")).toBe(false);
    expect(matchesLink({}, "policy:p1")).toBe(false);
  });
});

describe("labels", () => {
  it("a policy leads with its number, falling back to lines", () => {
    expect(
      policyLinkLabel({ policyNumber: "PKG-001", effectiveDate: "2026-08-15" })
    ).toBe("PKG-001 (2026-08-15)");
    expect(policyLinkLabel({ lines: ["Commercial Property", null] })).toBe(
      "Commercial Property"
    );
    expect(policyLinkLabel({})).toBe("Policy");
  });

  it("a quote is identified by its lines — it has no number yet", () => {
    expect(
      quoteLinkLabel({ lines: ["Commercial Property", "General Liability"], effectiveDate: "2026-09-01" })
    ).toBe("Quote — Commercial Property, General Liability (2026-09-01)");
    expect(quoteLinkLabel({})).toBe("Quote — coverage");
  });
});
