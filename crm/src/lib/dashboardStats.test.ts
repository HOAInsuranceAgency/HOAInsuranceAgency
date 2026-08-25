import { describe, expect, it } from "vitest";
import {
  commissionBySource,
  leadQuoteStanding,
  leadStats,
  moneyByCarrier,
  policyCommission,
  quoteStandingRank,
  receivables,
  renewalChipCounts,
} from "./dashboardStats";

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

describe("renewalChipCounts", () => {
  it("computes every chip from the full set — no chip depends on which is selected", () => {
    const rows = [-3, 0, 12, 30, 31, 60, 88, 91, 200].map((days) => ({ days }));
    expect(renewalChipCounts(rows)).toEqual({ overdue: 1, d30: 3, d60: 5, d90: 6 });
  });

  it("an overdue row counts toward Overdue and toward nothing else", () => {
    // The card this replaces showed overdue rows in the table while counting
    // them in no chip at all.
    expect(renewalChipCounts([{ days: -1 }])).toEqual({ overdue: 1, d30: 0, d60: 0, d90: 0 });
  });
});

describe("leadStats", () => {
  const now = new Date("2026-08-24T12:00:00Z");

  it("counts leads entered in the last 7 days, inclusive at the boundary", () => {
    const { newThisWeek } = leadStats(
      [
        { createdAt: "2026-08-23T09:00:00Z" },
        { createdAt: "2026-08-17T12:00:00Z" }, // exactly 7 days — still this week
        { createdAt: "2026-08-10T09:00:00Z" },
        { createdAt: null },
      ],
      [],
      now
    );
    expect(newThisWeek).toBe(2);
  });

  it("counts conversions in the current UTC calendar quarter", () => {
    const { convertedThisQuarter } = leadStats(
      [],
      [
        { convertedAt: "2026-07-01T00:00:00Z" },
        { convertedAt: "2026-06-30T23:59:59Z" }, // Q2, not this quarter
        { convertedAt: "2026-09-30T00:00:00Z" },
        { convertedAt: null },
      ],
      now
    );
    expect(convertedThisQuarter).toBe(2);
  });

  it("medians days-to-convert over clients with both dates, null with none", () => {
    const { medianDaysToConvert } = leadStats(
      [],
      [
        { createdAt: "2026-01-01T00:00:00Z", convertedAt: "2026-01-11T00:00:00Z" }, // 10d
        { createdAt: "2026-01-01T00:00:00Z", convertedAt: "2026-01-31T00:00:00Z" }, // 30d
        { createdAt: "2026-01-01T00:00:00Z", convertedAt: "2026-03-02T00:00:00Z" }, // 60d
        { createdAt: null, convertedAt: "2026-02-01T00:00:00Z" }, // no span to measure
      ],
      now
    );
    expect(medianDaysToConvert).toBe(30);
    expect(leadStats([], [], now).medianDaysToConvert).toBeNull();
  });

  it("a conversion stamped before its creation is corrupt data, not a fast sale", () => {
    const { medianDaysToConvert } = leadStats(
      [],
      [{ createdAt: "2026-02-01T00:00:00Z", convertedAt: "2026-01-01T00:00:00Z" }],
      now
    );
    expect(medianDaysToConvert).toBeNull();
  });
});

describe("leadQuoteStanding", () => {
  it("the most advanced open quote wins, with the count at that rung only", () => {
    expect(
      leadQuoteStanding([
        { status: "DRAFT" },
        { status: "SUBMITTED" },
        { status: "SUBMITTED" },
        { status: "QUOTED" },
      ])
    ).toEqual({ status: "QUOTED", count: 1 });
  });

  it("any open quote outranks any closed one — live work beats old outcomes", () => {
    expect(leadQuoteStanding([{ status: "LOST" }, { status: "DRAFT" }])).toEqual({
      status: "DRAFT",
      count: 1,
    });
  });

  it("all-closed shows the outcome rather than reading as untouched", () => {
    expect(
      leadQuoteStanding([{ status: "DECLINED" }, { status: "DECLINED" }, { status: "LOST" }])
    ).toEqual({ status: "DECLINED", count: 2 });
  });

  it("no quotes (or no recognizable statuses) is null", () => {
    expect(leadQuoteStanding([])).toBeNull();
    expect(leadQuoteStanding([{ status: null }])).toBeNull();
  });
});

describe("quoteStandingRank", () => {
  const rank = (status: string) => quoteStandingRank({ status, count: 1 })!;

  it("orders the column as a progression, dead outcomes below the live rungs", () => {
    expect(rank("BOUND")).toBeGreaterThan(rank("PRESENTED"));
    expect(rank("PRESENTED")).toBeGreaterThan(rank("QUOTED"));
    expect(rank("QUOTED")).toBeGreaterThan(rank("SUBMITTED"));
    expect(rank("SUBMITTED")).toBeGreaterThan(rank("DRAFT"));
    expect(rank("DRAFT")).toBeGreaterThan(rank("DECLINED"));
    expect(rank("DECLINED")).toBeGreaterThan(rank("LOST"));
  });

  it("no quotes is null, which the sort files last rather than at zero", () => {
    expect(quoteStandingRank(null)).toBeNull();
  });
});

describe("moneyByCarrier", () => {
  const carriers = [
    { id: "c1", name: "Greyhawk" },
    { id: "c2", name: "Meridian" },
  ];

  it("groups by carrier, names unknown and unassigned honestly, sorts largest first", () => {
    const rows = moneyByCarrier(
      [
        { carrierId: "c1", premium: 1000 },
        { carrierId: "c1", premium: 500 },
        { carrierId: "ghost", premium: 700 },
        { carrierId: null, premium: 200 },
      ],
      carriers,
      (p) => p.premium ?? 0
    );
    expect(rows.map((r) => [r.name, r.total, r.count])).toEqual([
      ["Greyhawk", 1500, 2],
      ["Unknown carrier", 700, 1],
      ["Unassigned", 200, 1],
    ]);
  });

  it("drops zero-total groups", () => {
    expect(
      moneyByCarrier([{ carrierId: "c2", premium: 0 }], carriers, (p) => p.premium ?? 0)
    ).toEqual([]);
  });
});
