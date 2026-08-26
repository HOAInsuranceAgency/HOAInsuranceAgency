import { describe, expect, it } from "vitest";
import {
  countsAsTouch,
  resolveFiling,
  type ResolvableLink,
} from "../../amplify/functions/dialpad-webhook/resolve";

/**
 * Who a call gets filed under.
 *
 * The case that matters is the middle one. A property manager holding thirty
 * associations means one number reaching thirty accounts, and the decision
 * here is to file under the person and appear on all of them rather than
 * guess which association the call concerned. These tests are mostly about
 * holding that decision still — including the part where a SHARED call is
 * NOT service, which is what stops one conversation silencing the digest for
 * thirty leads.
 */

const link = (o: Partial<ResolvableLink> = {}): ResolvableLink => ({
  accountId: "a1",
  contactId: "c1",
  accountName: "Beacon Hill Condo Trust",
  contactName: "Marcia Webb",
  ...o,
});

describe("nobody recognises the number", () => {
  it("is UNMATCHED and belongs on no timeline", () => {
    expect(resolveFiling([])).toEqual({
      confidence: "UNMATCHED",
      contactId: null,
      contactName: null,
      accountIds: [],
      suppressed: false,
    });
  });
});

describe("one account", () => {
  it("is EXACT and names the person", () => {
    const filing = resolveFiling([link()]);
    expect(filing).toMatchObject({
      confidence: "EXACT",
      contactId: "c1",
      contactName: "Marcia Webb",
      accountIds: ["a1"],
    });
  });

  it("stays EXACT when a legacy account column duplicates the contact", () => {
    // dialpad-phone-index indexes the deprecated Account.contactPhone for
    // leads that predate contacts, so one number can produce two rows for one
    // account. Counting rows rather than accounts would turn every such lead
    // into a spurious SHARED.
    const filing = resolveFiling([
      link({ contactId: "c1" }),
      link({ contactId: null, contactName: null }),
    ]);
    expect(filing.confidence).toBe("EXACT");
    expect(filing.accountIds).toEqual(["a1"]);
    expect(filing.contactName).toBe("Marcia Webb");
  });
});

describe("one number, many accounts", () => {
  const manager = Array.from({ length: 30 }, (_, i) =>
    link({ accountId: `a${i}`, contactId: `c${i}`, accountName: `Association ${i}` })
  );

  it("is SHARED and appears on every one of them", () => {
    const filing = resolveFiling(manager);
    expect(filing.confidence).toBe("SHARED");
    expect(filing.accountIds).toHaveLength(30);
  });

  it("names the person", () => {
    expect(resolveFiling(manager).contactName).toBe("Marcia Webb");
  });

  it("claims no contact row, because each one belongs to an association", () => {
    // The thirty rows are one human recorded thirty times. Picking one would
    // assert a link to that association, which is the guess being avoided.
    expect(resolveFiling(manager).contactId).toBeNull();
  });

  it("does not rank the candidates", () => {
    // Order is DynamoDB's, and nothing here should imply a best guess.
    const filing = resolveFiling(manager);
    expect(filing.accountIds).toEqual(manager.map((l) => l.accountId));
  });
});

describe("suppression", () => {
  it("carries through when any link marks the number not-a-customer", () => {
    const filing = resolveFiling([link({ suppressed: true }), link({ accountId: "a2" })]);
    expect(filing.suppressed).toBe(true);
  });

  it("is false when nothing says otherwise", () => {
    expect(resolveFiling([link()]).suppressed).toBe(false);
  });
});

describe("what counts as having serviced an account", () => {
  it("counts an exact call and a call a person filed", () => {
    expect(countsAsTouch("EXACT")).toBe(true);
    expect(countsAsTouch("MANUAL")).toBe(true);
  });

  it("does NOT count a shared call", () => {
    // One conversation with a manager shows on thirty timelines. Counting it
    // would mark thirty associations serviced and silence the untouched-lead
    // finding for all of them — the exact failure the digest exists to catch.
    expect(countsAsTouch("SHARED")).toBe(false);
  });

  it("does not count an unidentified call", () => {
    expect(countsAsTouch("UNMATCHED")).toBe(false);
  });
});
