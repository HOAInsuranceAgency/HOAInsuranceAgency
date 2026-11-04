import { describe, expect, it } from "vitest";
import {
  brokerFeeLineFromSource,
  findAdjustmentOriginal,
  passThroughLinesFromSource,
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

  it.each([-10000, 0])('releases only finalized nonpayable adjustment statements totaling %s cents', total => {
    const statement = { id: 'credit', policyId: 'p', sourcePricingVersion: 2, status: 'SENT', sentAt: '2026-11-04T20:00:00Z',
      remittanceCarrierCents: total, remittanceCommissionCents: 0, remittanceInterestCents: 0, remittanceBrokerFeeCents: 0 };
    expect(liveAnchorIds([statement], [{ invoiceId: 'credit', policyId: 'p' }])).toEqual(new Set());
    for (const delta of [{ status: 'DRAFT' }, { remittanceCarrierCents: undefined }, { paymentUrl: 'https://payments.example.test' }, { remittanceCarrierCents: 1 }]) {
      expect(liveAnchorIds([{ ...statement, ...delta }], []).has('p')).toBe(true);
    }
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

describe("policy-sourced broker fees", () => {
  it("does not allow a direct-bill policy to collect an HOA fee", () => {
    expect(unbilledAgencyPolicies([agency("p",{billType:"DIRECT",brokerFee:500})],new Set())).toHaveLength(0);
    expect(unbilledAgencyPolicies([agency("p",{billType:"DIRECT",brokerFee:500,brokerFeeCollected:500})],new Set())).toHaveLength(0);
    expect(brokerFeeLineFromSource({id:"p",quoteId:"q",brokerFee:500},"p")).toEqual({kind:"BROKER_FEE",description:"HOA broker fee",retailAmount:500,costAmount:0,brokerFeeQuoteId:"q",policyId:"p"});
    expect(() => brokerFeeLineFromSource({ id: 'q', billType: 'DIRECT', brokerFee: 500 })).toThrow('agency billing');
  });
  it("requires the source quote and leaves zero-fee terms unchanged", () => {
    expect(brokerFeeLineFromSource({id:"q",brokerFee:0})).toBeNull();
    expect(()=>brokerFeeLineFromSource({id:"p",brokerFee:500},"p")).toThrow("original quote");
  });
});

describe("supplier charges and taxes", () => {
  const charges = [
    { id: "rt", kind: "WHOLESALER_FEE", description: "RT brokerage fee", amountCents: 25000 },
    { id: "ma-tax", kind: "SURPLUS_LINES", description: "MA surplus lines tax", amountCents: 222164 },
  ];
  it("seeds every recorded source charge at cost with stable references", () => {
    expect(passThroughLinesFromSource({ billType: "AGENCY", passThroughCharges: JSON.stringify(charges) }, "p")).toEqual([
      { sourceQuoteChargeId: "rt", kind: "WHOLESALER_FEE", description: "RT brokerage fee", retailAmount: 250, costAmount: 250, policyId: "p" },
      { sourceQuoteChargeId: "ma-tax", kind: "SURPLUS_LINES", description: "MA surplus lines tax", retailAmount: 2221.64, costAmount: 2221.64, policyId: "p" },
    ]);
    expect(passThroughLinesFromSource({ passThroughCharges: charges })).toHaveLength(2);
  });
  it("keeps legacy sources empty and never bills direct-bill supplier amounts", () => {
    expect(passThroughLinesFromSource({})).toEqual([]);
    expect(passThroughLinesFromSource({ billType: "DIRECT", passThroughCharges: charges })).toEqual([]);
  });
  it("rejects malformed recorded costs rather than omitting a charge", () => {
    expect(() => passThroughLinesFromSource({ passThroughCharges: [charges[0], { ...charges[1], amountCents: -1 }] })).toThrow();
  });
});

describe('paid original invoice eligibility', () => {
  const policy = { id: 'p', accountId: 'a', quoteId: 'q' };
  const original = { id: 'paid', accountId: 'a', policyId: 'p', status: 'PAID', sourcePricingVersion: 1 };
  const premium = { id: 'premium', invoiceId: 'paid', accountId: 'a', policyId: 'p', kind: 'PREMIUM', retailAmount: 55541 };
  it('finds a paid original for policy and pre-bind quote billing, including legacy originals', () => {
    expect(findAdjustmentOriginal(policy, [original], [premium])).toEqual({ adjustsInvoiceId: 'paid', adjustsPremiumLineId: 'premium' });
    expect(findAdjustmentOriginal(policy, [{ ...original, policyId: undefined, quoteId: 'q', sourcePricingVersion: undefined }], [{ ...premium, policyId: undefined }])).toEqual({ adjustsInvoiceId: 'paid', adjustsPremiumLineId: 'premium' });
  });
  it('does not treat fee-only receipts, later adjustments, foreign records or unsettled bills as original premium proof', () => {
    for (const row of [{ ...original, status: 'SENT' }, { ...original, sourcePricingVersion: 2 }, { ...original, accountId: 'foreign' }, { ...original, policyId: 'other' }]) {
      expect(findAdjustmentOriginal(policy, [row], [premium])).toBeNull();
    }
    for (const row of [{ ...premium, kind: 'BROKER_FEE' }, { ...premium, retailAmount: 0 }, { ...premium, invoiceId: 'other' }]) {
      expect(findAdjustmentOriginal(policy, [original], [row])).toBeNull();
    }
  });
});
