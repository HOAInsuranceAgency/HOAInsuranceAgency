import { describe, expect, it } from "vitest";
import {
  SMS_SEGMENT,
  leadText,
  textRecipients,
  toE164,
  unreachableOptIns,
  type NotifiableProfile,
} from "../../amplify/functions/lead-intake/sms";

/**
 * Who gets a lead text, and what it says.
 *
 * The rule has to be exactly two conditions — asked for it, and left a number
 * we can reach — because each half fails silently on its own: a toggle with
 * no number sends nothing, and a number with no toggle is somebody who never
 * consented being texted at 2am.
 */

const p = (o: Partial<NotifiableProfile> = {}): NotifiableProfile => ({
  firstName: "Jake",
  lastName: "Greasley",
  mobilePhone: "508-233-2261",
  leadTextAlerts: true,
  ...o,
});

describe("toE164", () => {
  it("accepts the shapes people actually type", () => {
    for (const raw of [
      "5082332261",
      "508-233-2261",
      "(508) 233-2261",
      "508.233.2261",
      "  508 233 2261  ",
      "1-508-233-2261",
      "+1 (508) 233-2261",
    ]) {
      expect(toE164(raw), raw).toBe("+15082332261");
    }
  });

  it("trusts an international number already in + form", () => {
    expect(toE164("+442071838750")).toBe("+442071838750");
  });

  it("returns null rather than guessing", () => {
    // A malformed number is a per-message failure buried in the SNS console;
    // the person who typed it would never learn nothing was arriving.
    for (const raw of ["", "   ", null, undefined, "call me", "12345", "555-1234"]) {
      expect(toE164(raw as string), String(raw)).toBeNull();
    }
    // Too long for E.164, and a lone "+" with nothing after it.
    expect(toE164("+1234567890123456")).toBeNull();
    expect(toE164("+")).toBeNull();
  });
});

describe("textRecipients", () => {
  it("needs both the switch and a reachable number", () => {
    expect(textRecipients([p()])).toHaveLength(1);
    expect(textRecipients([p({ leadTextAlerts: false })])).toHaveLength(0);
    expect(textRecipients([p({ leadTextAlerts: null })])).toHaveLength(0);
    expect(textRecipients([p({ mobilePhone: null })])).toHaveLength(0);
    expect(textRecipients([p({ mobilePhone: "call me" })])).toHaveLength(0);
  });

  it("normalises the number it hands back", () => {
    expect(textRecipients([p({ mobilePhone: "(508) 233-2261" })])[0].phone).toBe(
      "+15082332261"
    );
  });

  it("texts a shared number once", () => {
    const two = textRecipients([
      p({ firstName: "Jake", mobilePhone: "508-233-2261" }),
      p({ firstName: "Dana", mobilePhone: "(508) 233-2261" }),
    ]);
    expect(two).toHaveLength(1);
    expect(two[0].profile.firstName).toBe("Jake");
  });

  it("keeps everyone else when one profile is unreachable", () => {
    const some = textRecipients([
      p({ firstName: "Jake", mobilePhone: "nope" }),
      p({ firstName: "Dana", mobilePhone: "617-555-0143" }),
    ]);
    expect(some.map((r) => r.profile.firstName)).toEqual(["Dana"]);
  });
});

describe("unreachableOptIns", () => {
  it("surfaces the switch-on-no-number case", () => {
    // The one state that looks like it works and doesn't.
    const flagged = unreachableOptIns([
      p({ firstName: "Jake", mobilePhone: null }),
      p({ firstName: "Dana" }),
      p({ firstName: "Sam", leadTextAlerts: false, mobilePhone: null }),
    ]);
    expect(flagged.map((x) => x.firstName)).toEqual(["Jake"]);
  });
});

describe("leadText", () => {
  const lead = {
    id: "acct-1",
    name: "Willow Creek Condominium Trust",
    city: "Concord",
    state: "MA",
    contactName: "Marion Delacroix",
    contactPhone: "978-555-0117",
  };

  it("leads with the association and ends with a link to it", () => {
    const msg = leadText(lead, "https://app.protectmyhoa.com");
    expect(msg).toBe(
      "New HOA lead: Willow Creek Condominium Trust. Concord, MA - Marion Delacroix 978-555-0117. https://app.protectmyhoa.com/accounts/acct-1"
    );
  });

  it("does not double the slash on a base URL that has one", () => {
    expect(leadText(lead, "https://app.protectmyhoa.com/")).toContain(
      "com/accounts/acct-1"
    );
  });

  it("drops the detail clause rather than writing an empty one", () => {
    const bare = leadText(
      { id: "a", name: "Someone", city: null, state: null },
      "https://x.co"
    );
    expect(bare).toBe("New HOA lead: Someone. https://x.co/accounts/a");
    expect(bare).not.toContain(". . ");
  });

  it("truncates the name, never the link", () => {
    const long = leadText(
      { ...lead, name: "A".repeat(300) },
      "https://app.protectmyhoa.com"
    );
    expect(long).toHaveLength(SMS_SEGMENT);
    expect(long.endsWith("https://app.protectmyhoa.com/accounts/acct-1")).toBe(true);
    expect(long).toContain("...");
  });

  it("stays on one segment for a realistic lead", () => {
    // Every non-GSM character silently re-encodes the whole message as UCS-2
    // and halves the limit to 70, so the body is plain ASCII by construction.
    const msg = leadText(lead, "https://app.protectmyhoa.com");
    expect(msg.length).toBeLessThanOrEqual(SMS_SEGMENT);
    expect(msg).toMatch(/^[\x20-\x7E]+$/);
  });
});
