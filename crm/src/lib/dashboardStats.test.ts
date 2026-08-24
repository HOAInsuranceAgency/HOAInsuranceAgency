import { describe, expect, it } from "vitest";
import { commissionBySource, policyCommission, receivables } from "./dashboardStats";

/**
 * The dashboard's money figures. Same asymmetry the invoice seeding tests
 * state: a missing dollar gets noticed when someone reconciles, an invented
 * one steers the agency wrong silently — so every ambiguity below resolves
 * toward zero, and gaps are counted rather than papered over.
 */

describe("policyCommission", () => {
  it("is premium × pct / 100, and $0 whenever either half is unrecorded", () => {
    expect(policyCommission({ premium: 47900, commissionPct: 15 })).toBe(7185);
    expect(policyCommission({ premium: 47900, commissionPct: null })).toBe(0);
    expect(policyCommission({ premium: null, commissionPct: 15 })).toBe(0);
  });
});

describe("commissionBySource", () => {
  const accounts = [
    { id: "a", source: "Website" },
    { id: "b", source: "website " },
    { id: "c", source: "referral" },
    { id: "d", source: null },
  ];

  it("groups case- and whitespace-insensitively, keeping the first spelling", () => {
    const rows = commissionBySource(
      [
        { accountId: "a", premium: 10000, commissionPct: 10 },
        { accountId: "b", premium: 30000, commissionPct: 10 },
        { accountId: "c", premium: 5000, commissionPct: 10 },
      ],
      accounts
    );
    expect(rows.map((r) => [r.name, r.total, r.count])).toEqual([
      ["Website", 4000, 2],
      ["referral", 500, 1],
    ]);
  });

  it("keeps unattributed commission visible in its own bucket", () => {
    // A dollar with no source is a data gap someone should see, not a
    // rounding error that quietly vanishes from the chart.
    const rows = commissionBySource(
      [{ accountId: "d", premium: 10000, commissionPct: 12 }],
      accounts
    );
    expect(rows).toEqual([{ key: "(none)", name: "No source recorded", total: 1200, count: 1 }]);
  });

  it("drops zero-commission groups and sorts largest first", () => {
    const rows = commissionBySource(
      [
        { accountId: "c", premium: 5000, commissionPct: null },
        { accountId: "a", premium: 1000, commissionPct: 10 },
      ],
      accounts
    );
    expect(rows.map((r) => r.key)).toEqual(["website"]);
  });

  it("a policy on an unknown account counts as unattributed, not dropped", () => {
    const rows = commissionBySource(
      [{ accountId: "ghost", premium: 10000, commissionPct: 10 }],
      accounts
    );
    expect(rows[0].name).toBe("No source recorded");
  });
});

describe("receivables", () => {
  it("counts SENT and PROCESSING invoices at the amount the link asked for", () => {
    const r = receivables(
      [
        { status: "SENT", stripeLinkAmountCents: 1012262 },
        { status: "PROCESSING", stripeLinkAmountCents: 250000 },
        { status: "PAID", stripeLinkAmountCents: 999999 },
        { status: "DRAFT", stripeLinkAmountCents: 100 },
        { status: "VOID", stripeLinkAmountCents: 100 },
      ],
      []
    );
    expect(r.invoiceTotal).toBe(12622.62);
    expect(r.invoiceCount).toBe(2);
    expect(r.invoiceUnpriced).toBe(0);
  });

  it("says when a live invoice carries no amount instead of pretending it's $0 owed", () => {
    const r = receivables([{ status: "SENT", stripeLinkAmountCents: null }], []);
    expect(r.invoiceCount).toBe(1);
    expect(r.invoiceUnpriced).toBe(1);
    expect(r.invoiceTotal).toBe(0);
  });

  it("counts loan principal on ACCEPTED, ACTIVE and DEFAULTED — money has moved", () => {
    const r = receivables(
      [],
      [
        { status: "ACCEPTED", balance: 25306.56, amountFinanced: 25306.56 },
        { status: "ACTIVE", balance: 20000 },
        { status: "DEFAULTED", balance: 5000 },
        { status: "QUOTED", balance: 99999 }, // an offer, not a receivable
        { status: "PAID", balance: 0 },
        { status: "CANCELLED", balance: 12345 },
      ]
    );
    expect(r.loanTotal).toBe(50306.56);
    expect(r.loanCount).toBe(3);
  });

  it("falls back to amountFinanced for a balance-less row, and skips non-positive", () => {
    const r = receivables(
      [],
      [
        { status: "ACTIVE", balance: null, amountFinanced: 7500 },
        { status: "ACTIVE", balance: 0 },
      ]
    );
    expect(r.loanTotal).toBe(7500);
    expect(r.loanCount).toBe(1);
  });
});
