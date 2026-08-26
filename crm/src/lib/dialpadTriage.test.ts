import { describe, expect, it } from "vitest";
import { decideTriage } from "../../amplify/functions/dialpad-triage/decide";

/**
 * The four buttons on an unidentified call.
 *
 * Two of them look the same from the queue — the call disappears either way —
 * and differ entirely in what they leave behind. "Not a customer" remembers
 * the number so the robocaller never queues again; "Ignore" clears one call
 * and lets the same number come back. A queue that cannot forget is a queue
 * that stops being read, so that difference is the reason both exist.
 */

describe("filing on an existing account", () => {
  it("files there and can remember the number", () => {
    const d = decideTriage({
      communicationId: "m1",
      action: "FILE",
      accountId: "a1",
      rememberNumber: true,
    });
    expect(d).toEqual({
      ok: true,
      plan: { fileOn: ["a1"], createLead: null, remember: true, suppress: false },
    });
  });

  it("does not remember unless asked", () => {
    // A number reached once from a shared management-office line is not
    // necessarily that association's, so this is offered, not assumed.
    const d = decideTriage({ communicationId: "m1", action: "FILE", accountId: "a1" });
    expect(d.ok && d.plan.remember).toBe(false);
  });

  it("asks for an account rather than filing nowhere", () => {
    const d = decideTriage({ communicationId: "m1", action: "FILE" });
    expect(d).toEqual({ ok: false, error: "Choose an account to file it on." });
  });
});

describe("turning a call into a lead", () => {
  it("creates the association and always remembers the number", () => {
    // A number that just created a lead IS that lead's number — there is no
    // ambiguity to protect against, so unlike FILE this is not a choice.
    const d = decideTriage({
      communicationId: "m1",
      action: "NEW_LEAD",
      leadName: "Beacon Hill Condo Trust",
      contactName: "Marcia Webb",
    });
    expect(d).toEqual({
      ok: true,
      plan: {
        fileOn: [],
        createLead: { name: "Beacon Hill Condo Trust", contactName: "Marcia Webb" },
        remember: true,
        suppress: false,
      },
    });
  });

  it("needs a name, and does not accept whitespace as one", () => {
    for (const leadName of [undefined, "", "   "]) {
      const d = decideTriage({ communicationId: "m1", action: "NEW_LEAD", leadName });
      expect(d, String(leadName)).toEqual({ ok: false, error: "Give the new lead a name." });
    }
  });

  it("treats a blank caller name as no name rather than an empty person", () => {
    const d = decideTriage({
      communicationId: "m1",
      action: "NEW_LEAD",
      leadName: "Beacon Hill",
      contactName: "   ",
    });
    expect(d.ok && d.plan.createLead?.contactName).toBeNull();
  });
});

describe("the two ways to make a call go away", () => {
  it("NOT_CUSTOMER suppresses the number so it never queues again", () => {
    expect(decideTriage({ communicationId: "m1", action: "NOT_CUSTOMER" })).toEqual({
      ok: true,
      plan: { fileOn: [], createLead: null, remember: false, suppress: true },
    });
  });

  it("IGNORE leaves nothing behind, so the same number can come back", () => {
    expect(decideTriage({ communicationId: "m1", action: "IGNORE" })).toEqual({
      ok: true,
      plan: { fileOn: [], createLead: null, remember: false, suppress: false },
    });
  });

  it("neither files the call on any account", () => {
    for (const action of ["NOT_CUSTOMER", "IGNORE"] as const) {
      const d = decideTriage({ communicationId: "m1", action });
      expect(d.ok && d.plan.fileOn, action).toEqual([]);
    }
  });
});

describe("refusals read as instructions", () => {
  it("names what is missing rather than saying it was invalid", () => {
    expect(decideTriage({ action: "IGNORE" })).toEqual({
      ok: false,
      error: "No call was named.",
    });
    expect(decideTriage({ communicationId: "m1" })).toEqual({
      ok: false,
      error: "Choose what to do with this call.",
    });
  });
});
