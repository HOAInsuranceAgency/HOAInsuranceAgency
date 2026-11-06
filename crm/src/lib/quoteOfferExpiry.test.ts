import { describe, expect, it } from "vitest";
import { agencyDay } from "../../../shared/agencyTime";
import { matchesQuoteOfferFilter, quoteOfferDate, quoteOfferUrgency } from "./quoteOfferExpiry";

const today = "2026-11-03";
describe("carrier offer validity", () => {
  it.each([
    ["2026-11-02", "expired"], ["2026-11-03", "today"],
    ["2026-11-04", "soon"], ["2026-11-10", "soon"], ["2026-11-11", null],
  ])("classifies valid-through %s relative to the agency day", (offerExpiresAt, expected) => {
    expect(quoteOfferUrgency({ status: "QUOTED", offerExpiresAt }, today)).toBe(expected);
    expect(quoteOfferUrgency({ status: "PRESENTED", offerExpiresAt }, today)).toBe(expected);
  });

  it.each(["DRAFT", "SUBMITTED", "BOUND", "DECLINED", "LOST", "unknown", null])("does not create urgency for %s", status => {
    const quote = { status, offerExpiresAt: "2026-11-02" };
    expect(quoteOfferDate(quote)).toBe("2026-11-02");
    expect(quoteOfferUrgency(quote, today)).toBeNull();
    expect(matchesQuoteOfferFilter(quote, "expired", today)).toBe(false);
    expect(matchesQuoteOfferFilter({ ...quote, offerExpiresAt: today }, "expiring", today)).toBe(false);
  });

  it.each([undefined, null, "", " ", "tomorrow", "2026-02-30", "2026-02-29", "2026-11-03T00:00:00Z"])("does not invent an expiry for %s", offerExpiresAt => {
    const quote = { status: "QUOTED", offerExpiresAt };
    expect(quoteOfferDate(quote)).toBeNull();
    expect(quoteOfferUrgency(quote, today)).toBeNull();
    expect(matchesQuoteOfferFilter(quote, "expired", today)).toBe(false);
    expect(matchesQuoteOfferFilter(quote, "expiring", today)).toBe(false);
    expect(matchesQuoteOfferFilter(quote, "all", today)).toBe(true);
  });

  it("uses calendar days across a DST transition, a year boundary and leap day", () => {
    expect(quoteOfferUrgency({ status: "QUOTED", offerExpiresAt: "2026-03-14" }, "2026-03-07")).toBe("soon");
    expect(quoteOfferUrgency({ status: "QUOTED", offerExpiresAt: "2027-01-04" }, "2026-12-28")).toBe("soon");
    expect(quoteOfferUrgency({ status: "QUOTED", offerExpiresAt: "2028-02-29" }, "2028-02-22")).toBe("soon");
    expect(quoteOfferUrgency({ status: "QUOTED", offerExpiresAt: "2027-01-05" }, "2026-12-28")).toBeNull();
  });

  it("keeps today's offer valid past UTC midnight until the agency day changes", () => {
    const quote = { status: "QUOTED", offerExpiresAt: today };
    expect(quoteOfferUrgency(quote, agencyDay("2026-11-04T00:30:00Z"))).toBe("today");
    expect(quoteOfferUrgency(quote, agencyDay("2026-11-04T05:30:00Z"))).toBe("expired");
    expect(matchesQuoteOfferFilter(quote, "expiring", today)).toBe(true);
    expect(matchesQuoteOfferFilter(quote, "expired", today)).toBe(false);
  });

  it("leaves an invalid agency day unclassified", () => {
    expect(quoteOfferUrgency({ status: "QUOTED", offerExpiresAt: today }, "invalid")).toBeNull();
  });
});
