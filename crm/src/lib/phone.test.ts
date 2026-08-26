import { describe, expect, it } from "vitest";
import { callerIdE164, toE164 } from "./phone";

/**
 * The two normalisations, and the gap between them.
 *
 * `toE164` answers "can I send to this", `callerIdE164` answers "whose number
 * is this". An extension is exactly where those two disagree, so most of what
 * is worth testing here is that they still disagree in the right direction.
 */

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

describe("callerIdE164", () => {
  it("indexes a number that carries an extension", () => {
    // toE164 refuses these, and should: you cannot text x14. But the person
    // rings from the main line, so refusing to index them would send every
    // call they ever make to the triage queue.
    for (const raw of [
      "508-233-2261 x14",
      "508-233-2261 x 14",
      "(508) 233-2261 ext 212",
      "508.233.2261 ext. 9",
      "5082332261 extension 4",
      "508-233-2261 #14",
      "508-233-2261,14",
    ]) {
      expect(toE164(raw), `toE164 ${raw}`).toBeNull();
      expect(callerIdE164(raw), raw).toBe("+15082332261");
    }
  });

  it("agrees with toE164 when there is no extension", () => {
    for (const raw of [
      "5082332261",
      "508-233-2261",
      "(508) 233-2261",
      "  508 233 2261  ",
      "1-508-233-2261",
      "+442071838750",
    ]) {
      expect(callerIdE164(raw), raw).toBe(toE164(raw));
    }
  });

  it("does not mistake trailing digits for an extension", () => {
    // The marker is required. Without it this would eat the last digits of
    // every number written without separators.
    expect(callerIdE164("5082332261")).toBe("+15082332261");
    expect(callerIdE164("+442071838750")).toBe("+442071838750");
  });

  it("returns null rather than picking one of two numbers", () => {
    // A field holding two numbers is wrong in the safe direction: unindexed,
    // so a call from either lands in triage where a human sees both.
    expect(callerIdE164("508-233-2261 / 508-555-1000")).toBeNull();
    expect(callerIdE164("508-233-2261 or 508-555-1000")).toBeNull();
  });

  it("returns null on nothing, and on an extension with no number", () => {
    for (const raw of ["", "   ", null, undefined, "x14", "ext 212", "call me"]) {
      expect(callerIdE164(raw as string), String(raw)).toBeNull();
    }
  });
});
