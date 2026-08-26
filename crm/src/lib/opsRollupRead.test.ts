import { describe, expect, it } from "vitest";
import {
  allowedNumbers,
  citedNumbers,
  verifyNumbers,
} from "../../amplify/functions/ops-rollup/read";

/**
 * The guard on the model's paragraph.
 *
 * A language model writing about money will eventually produce a plausible
 * figure that is not in the data, and the top of the owner's morning email is
 * the worst place in the system for that to happen: it is the line he is most
 * likely to repeat to somebody else and least likely to check against the
 * rows underneath it.
 *
 * So the paragraph is not trusted, it is verified. These are the assertions
 * that make "it cannot print a number the data does not contain" a property
 * rather than a hope.
 */

const PAYLOAD = {
  covering: "Monday",
  exposed: [
    { subject: "Maple Ridge Condominium", clause: "expired 4d ago", amount: 41200 },
  ],
  progress: { mtdPremium: 412000, pacePct: 0.18, mtdPolicies: 7 },
  done: { invoicesSent: 4, invoicesSentTotal: 52100 },
};

describe("what the data actually says", () => {
  it("accepts a figure lifted straight out of the payload", () => {
    const allowed = allowedNumbers(PAYLOAD);
    expect(verifyNumbers("Premium bound is $412,000 across 7 policies.", allowed)).toEqual({
      ok: true,
    });
  });

  it("accepts a rate written the way a person reads it", () => {
    // Stored as 0.18; nobody writes "0.18 ahead".
    const allowed = allowedNumbers(PAYLOAD);
    expect(verifyNumbers("Running 18% ahead of last month.", allowed).ok).toBe(true);
  });

  it("accepts a number embedded in a composed clause", () => {
    const allowed = allowedNumbers(PAYLOAD);
    expect(verifyNumbers("Maple Ridge expired 4 days ago.", allowed).ok).toBe(true);
  });

  /**
   * The failure this exists for: a total nobody computed, sitting at the top
   * of the email looking exactly as authoritative as the verified rows below.
   */
  it("rejects a total the model worked out for itself", () => {
    const allowed = allowedNumbers(PAYLOAD);
    const verdict = verifyNumbers(
      "Between them the two exposures come to $464,100.",
      allowed
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.offending).toBe("464100");
  });

  /**
   * Small counts are NOT waived. "3 renewals" when the data says 2 is exactly
   * the error a reader is least likely to catch.
   */
  it("rejects a small count that is off by one", () => {
    const allowed = allowedNumbers({ exposed: [], standingCounts: { "quote-stalled": 2 } });
    expect(verifyNumbers("There are 2 stalled quotes.", allowed).ok).toBe(true);
    expect(verifyNumbers("There are 3 stalled quotes.", allowed).ok).toBe(false);
  });

  it("rejects a premium rounded to a nicer number", () => {
    const allowed = allowedNumbers({ premium: 41200 });
    expect(verifyNumbers("about $40,000 of premium", allowed).ok).toBe(false);
  });

  it("passes a paragraph with no figures at all", () => {
    expect(verifyNumbers("A quiet morning; nothing needs a decision today.", new Set()).ok).toBe(
      true
    );
  });
});

describe("reading numbers out of prose", () => {
  it("normalises thousands separators and currency", () => {
    expect(citedNumbers("$412,000 and 7 policies")).toEqual(["412000", "7"]);
  });

  it("finds numbers nested anywhere in the payload", () => {
    const allowed = allowedNumbers({ a: [{ b: { c: 99 } }] });
    expect(allowed.has("99")).toBe(true);
  });
});
