import { describe, expect, it } from "vitest";
import {
  invoiceableQuotes,
  liveAnchorIds,
  seededLineDescription,
  seededQuoteLineDescription,
  unbilledAgencyPolicies,
} from "./invoiceSeed";

/**
 * Which policies a new invoice opens with.
 *
 * The failure mode this guards is asymmetric, and the tests are written around
 * that: seeding one policy too few is an omission a producer notices when they
 * look at the invoice, and seeding one too many is a bill sent for money that
 * is not owed. So every exclusion below errs toward the empty table.
 */

const agency = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "ACTIVE",
  billType: "AGENCY",
  premium: 10000,
  ...over,
});

describe("unbilledAgencyPolicies", () => {
  const none = new Set<string>();

  it("takes an active, agency-billed, unbilled policy", () => {
    expect(unbilledAgencyPolicies([agency("a")], none).map((p) => p.id)).toEqual([
      "a",
    ]);
  });

  it("leaves out direct bill", () => {
    // The carrier collects that premium. Seeding it would put a bill in front
    // of a producer for money that is not ours to take.
    const out = unbilledAgencyPolicies([agency("a", { billType: "DIRECT" })], none);
    expect(out).toEqual([]);
  });

  it("offers a policy with no bill type recorded, labeled — not hidden", () => {
    // Revised 2026-08-24: since W8 this picker is the ONLY creation path,
    // so excluding the unrecorded made those policies permanently
    // unbillable — a prohibition where the old seeding rule was a safe
    // omission. Only an explicit DIRECT is excluded; the picker labels the
    // gap and the editor's direct-bill warning still guards the send.
    for (const billType of [null, undefined, ""]) {
      expect(
        unbilledAgencyPolicies([agency("a", { billType })], none).map((p) => p.id),
        String(billType)
      ).toEqual(["a"]);
    }
  });

  it("leaves out anything not active", () => {
    for (const status of ["EXPIRED", "CANCELLED", "NON_RENEWED", null, undefined]) {
      expect(
        unbilledAgencyPolicies([agency("a", { status })], none),
        String(status)
      ).toEqual([]);
    }
  });

  it("leaves out one that is already on a live invoice", () => {
    const out = unbilledAgencyPolicies([agency("a"), agency("b")], new Set(["a"]));
    expect(out.map((p) => p.id)).toEqual(["b"]);
  });

  it("keeps the order it was given", () => {
    // The caller sorts; this must not resort, or the line order on the invoice
    // stops matching the policies table it was read from.
    const out = unbilledAgencyPolicies(
      [agency("c"), agency("a"), agency("b")],
      none
    );
    expect(out.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("seeds a policy with no premium, so it is not silently dropped", () => {
    // The line arrives with an empty cost box. That is a policy someone has to
    // look at, and an empty row says so where an absent row says nothing.
    expect(
      unbilledAgencyPolicies([agency("a", { premium: null })], none).map((p) => p.id)
    ).toEqual(["a"]);
  });

  it("returns nothing for an account with no policies", () => {
    expect(unbilledAgencyPolicies([], none)).toEqual([]);
  });
});

describe("liveAnchorIds — void frees the slot", () => {
  const inv = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    status,
    ...over,
  });

  it("holds anchors for DRAFT, SENT and PROCESSING invoices", () => {
    const busy = liveAnchorIds(
      [
        inv("i1", "DRAFT", { policyId: "p1" }),
        inv("i2", "SENT", { quoteId: "q1" }),
        inv("i3", "PROCESSING", { policyId: "p2" }),
      ],
      []
    );
    expect([...busy].sort()).toEqual(["p1", "p2", "q1"]);
  });

  it("VOID and PAID free their anchors — a voided bill can be raised again", () => {
    const busy = liveAnchorIds(
      [inv("i1", "VOID", { policyId: "p1" }), inv("i2", "PAID", { quoteId: "q1" })],
      [{ invoiceId: "i1", policyId: "p1" }]
    );
    expect(busy.size).toBe(0);
  });

  it("line-level policy ids of live legacy invoices still hold their slot", () => {
    const busy = liveAnchorIds(
      [inv("i1", "SENT")],
      [{ invoiceId: "i1", policyId: "p9" }]
    );
    expect([...busy]).toEqual(["p9"]);
  });
});

describe("seededLineDescription", () => {
  it("leads with the policy number, then the lines of business", () => {
    expect(
      seededLineDescription({
        id: "a",
        policyNumber: "WC-2026-000841",
        lines: ["Property", "General Liability"],
      })
    ).toBe("WC-2026-000841 — Property, General Liability");
  });

  it("falls back to whichever it has", () => {
    expect(seededLineDescription({ id: "a", policyNumber: "P-1" })).toBe("P-1");
    expect(seededLineDescription({ id: "a", lines: ["Umbrella"] })).toBe("Umbrella");
  });

  it("never returns an empty string", () => {
    // An empty description renders as a blank row that reads as a bug.
    expect(seededLineDescription({ id: "a" })).toBe("Premium");
    expect(seededLineDescription({ id: "a", policyNumber: "  ", lines: [null] })).toBe(
      "Premium"
    );
  });
});

/**
 * Which quotes an invoice can anchor to (W8). Same asymmetry as the policy
 * rule above: a quote left off the picker is a click away on a refresh; a
 * closed or unpriced quote offered for billing is a bill for coverage that
 * may never exist.
 */
describe("invoiceableQuotes", () => {
  const none = new Set<string>();
  const isOpen = (s: string | null | undefined) => s === "PRESENTED" || s === "DRAFT";
  const q = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    status: "PRESENTED",
    premium: 40000,
    ...over,
  });

  it("takes an open, priced, unbilled quote", () => {
    expect(invoiceableQuotes([q("a")], none, isOpen).map((x) => x.id)).toEqual(["a"]);
  });

  it("leaves out closed quotes — a bound quote's billing belongs to its policy", () => {
    for (const status of ["BOUND", "LOST", null, undefined]) {
      expect(invoiceableQuotes([q("a", { status })], none, isOpen), String(status)).toEqual([]);
    }
  });

  it("leaves out an unpriced quote — there is no figure to bill", () => {
    for (const premium of [null, undefined, 0, -1]) {
      expect(invoiceableQuotes([q("a", { premium })], none, isOpen), String(premium)).toEqual([]);
    }
  });

  it("leaves out one already carrying a live invoice", () => {
    expect(
      invoiceableQuotes([q("a"), q("b")], new Set(["a"]), isOpen).map((x) => x.id)
    ).toEqual(["b"]);
  });
});

describe("seededQuoteLineDescription", () => {
  it("identifies by lines of business and says the coverage is quoted", () => {
    expect(
      seededQuoteLineDescription({ id: "a", lines: ["Property", "GL"] })
    ).toBe("Property, GL — quoted coverage");
  });

  it("never returns an empty string", () => {
    expect(seededQuoteLineDescription({ id: "a" })).toBe("Quoted coverage");
    expect(seededQuoteLineDescription({ id: "a", lines: [null] })).toBe("Quoted coverage");
  });
});

/**
 * The due date a new invoice opens with.
 *
 * Imported from the tab rather than duplicated, so a change to the term shows
 * up here rather than passing silently.
 */
describe("addDays", () => {
  it("gives fourteen days by default", async () => {
    const { DEFAULT_TERM_DAYS, addDays } = await import(
      "../pages/account/InvoicesTab"
    );
    expect(DEFAULT_TERM_DAYS).toBe(14);
    expect(addDays("2026-08-21", DEFAULT_TERM_DAYS)).toBe("2026-09-04");
  });

  it("crosses a month, a year and a leap day without arithmetic of its own", async () => {
    const { addDays } = await import("../pages/account/InvoicesTab");
    expect(addDays("2026-12-24", 14)).toBe("2027-01-07");
    expect(addDays("2028-02-20", 14)).toBe("2028-03-05"); // 2028 is a leap year
    expect(addDays("2027-02-20", 14)).toBe("2027-03-06");
  });

  it("does not slip a day for a machine behind UTC", async () => {
    // The reason it parses as `T00:00:00Z` and shifts in UTC: `new Date("2026-08-21")`
    // is midnight UTC, and reading it back with local getters in New York is
    // the 20th. Every invoice raised in the afternoon would have been dated a
    // day early.
    const { addDays } = await import("../pages/account/InvoicesTab");
    const original = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(addDays("2026-08-21", 14)).toBe("2026-09-04");
      expect(addDays("2026-08-21", 0)).toBe("2026-08-21");
    } finally {
      process.env.TZ = original;
    }
  });
});
