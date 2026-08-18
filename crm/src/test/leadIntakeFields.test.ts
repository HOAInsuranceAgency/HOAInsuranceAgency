import { describe, expect, it } from "vitest";
import {
  parsePolicyExpiration,
  parseUnitCount,
} from "../../amplify/functions/lead-intake/fields";
import { flattenExtraction } from "../../amplify/functions/lead-reply/extraction";
import { priorCarrierKey } from "../lib/extractionKeys";

describe("parseUnitCount", () => {
  it("takes what a form actually sends", () => {
    expect(parseUnitCount("48")).toBe(48);
    expect(parseUnitCount(" 48 ")).toBe(48);
    // The calculator and the assessment hold it as a number.
    expect(parseUnitCount(48)).toBe(48);
    // "1,200" is how a person types it.
    expect(parseUnitCount("1,200")).toBe(1200);
  });

  it("refuses anything that is not a count", () => {
    for (const bad of ["", "  ", "twelve", "12 units", "1.5", "-3", "0", null, undefined, {}]) {
      expect(parseUnitCount(bad)).toBeNull();
    }
  });

  it("refuses a leading zero, which no unit count has", () => {
    // A New England ZIP in the unit box. "1752" is indistinguishable from a
    // real count and is deliberately accepted; the leading zero is the signal.
    expect(parseUnitCount("01752")).toBeNull();
    expect(parseUnitCount("048")).toBeNull();
    expect(parseUnitCount("1752")).toBe(1752);
  });

  it("refuses a count larger than any real association", () => {
    expect(parseUnitCount("100001")).toBeNull();
    expect(parseUnitCount("99999")).toBe(99999);
  });
});

describe("parsePolicyExpiration", () => {
  it("takes what the date picker produces", () => {
    expect(parsePolicyExpiration("2026-09-30")).toBe("2026-09-30");
  });

  it("converts a hand-typed US date", () => {
    // A visitor with session state from before the field became a date picker.
    expect(parsePolicyExpiration("9/30/2026")).toBe("2026-09-30");
    expect(parsePolicyExpiration("09/30/2026")).toBe("2026-09-30");
  });

  it("rejects a date that does not exist", () => {
    // `new Date("2026-02-31")` rolls forward to March rather than failing, so
    // the round-trip comparison is what catches this.
    expect(parsePolicyExpiration("2026-02-31")).toBeNull();
    expect(parsePolicyExpiration("2026-13-01")).toBeNull();
  });

  it("rejects prose and mistyped years", () => {
    for (const bad of ["", "Sept 2026", "next year", "26-09-30", "0202-09-30", null, 20260930]) {
      expect(parsePolicyExpiration(bad)).toBeNull();
    }
  });

  it("never returns something the a.date() column would reject", () => {
    for (const input of ["2026-09-30", "9/30/2026", "1/1/2100"]) {
      expect(parsePolicyExpiration(input)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

/**
 * The bug that made a successful extraction read as an unreadable upload.
 *
 * `Account.aiExtraction` is `a.json()`, so it arrives as an AWSJSON *string*,
 * and `extract-lead` stores it with its own `JSON.stringify` on top. The old
 * guard was `typeof raw !== "object"`, so every real result exited as null and
 * the reply told the lead their document could not be read.
 */
describe("flattenExtraction", () => {
  const cells = {
    currentCarrier: { value: "Acadia", confidence: "high", evidence: "..." },
    masterPolicyExpiration: { value: "2026-09-30", confidence: "high", evidence: "..." },
  };

  it("reads a result stored as a JSON string", () => {
    expect(flattenExtraction(JSON.stringify(cells))).toEqual({
      currentCarrier: "Acadia",
      masterPolicyExpiration: "2026-09-30",
    });
  });

  it("reads one wrapped twice, as AWSJSON delivers it", () => {
    expect(flattenExtraction(JSON.stringify(JSON.stringify(cells)))).toEqual({
      currentCarrier: "Acadia",
      masterPolicyExpiration: "2026-09-30",
    });
  });

  it("still reads a plain object", () => {
    expect(flattenExtraction(cells)).toEqual({
      currentCarrier: "Acadia",
      masterPolicyExpiration: "2026-09-30",
    });
  });

  it("leaves the run's own bookkeeping out of the prompt", () => {
    const stored = JSON.stringify({
      ...cells,
      extractedAt: "2026-08-18T15:35:32.000Z",
      documentCount: 1,
      usage: { inputTokens: 92817, outputTokens: 2046 },
    });
    const out = flattenExtraction(stored);
    expect(Object.keys(out ?? {}).sort()).toEqual([
      "currentCarrier",
      "masterPolicyExpiration",
    ]);
  });

  it("drops the reviewer's lists, which are not for a first email", () => {
    const out = flattenExtraction(
      JSON.stringify({ ...cells, buildings: [{ label: "A" }], losses: [], contacts: [] })
    );
    expect(out).not.toHaveProperty("buildings");
    expect(out).toHaveProperty("currentCarrier");
  });

  it("returns null for nothing usable, so the prompt says so honestly", () => {
    expect(flattenExtraction(null)).toBeNull();
    expect(flattenExtraction("")).toBeNull();
    expect(flattenExtraction("not json")).toBeNull();
    expect(flattenExtraction("{}")).toBeNull();
    expect(flattenExtraction(JSON.stringify({ documentCount: 1 }))).toBeNull();
    expect(flattenExtraction(JSON.stringify({ a: { value: "   " } }))).toBeNull();
  });
});

/**
 * A web lead's incumbent carrier now gets a `PriorCarrier` row instead of a
 * line of prose in `notes`, and the row has to be *matchable*: the account's
 * Prior carriers tab computes `extractionSourceKey` from `priorCarrierKey` when
 * someone types a row by hand, and a later extraction over the declarations
 * page matches on the same string. Intake computing a different one would file
 * a second copy of the carrier beside the first.
 */
describe("the intake carrier row is keyed like a hand-typed one", () => {
  it("agrees with the tab for a carrier with no line or number", () => {
    // What intake passes: nulls, because a form gives neither.
    const fromIntake = priorCarrierKey({
      carrierName: "Acadia",
      policyNumber: null,
      lineOfBusiness: null,
    });
    // What `PriorCarrierTab` passes: its blank form fields are empty strings.
    const fromTab = priorCarrierKey({
      carrierName: "Acadia",
      policyNumber: "",
      lineOfBusiness: "",
    });
    expect(fromIntake).toBe(fromTab);
  });

  it("normalises what a visitor types, so case and spacing do not split it", () => {
    expect(
      priorCarrierKey({ carrierName: "  ACADIA   Insurance ", policyNumber: null })
    ).toBe(priorCarrierKey({ carrierName: "Acadia Insurance", policyNumber: "" }));
  });

  it("keys a named carrier distinctly from a nameless row", () => {
    // A blank name must not collide with a real one.
    expect(priorCarrierKey({ carrierName: "Acadia" })).not.toBe(
      priorCarrierKey({ carrierName: "" })
    );
  });
});
