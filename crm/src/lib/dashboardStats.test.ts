import { describe, expect, it } from "vitest";
import {
  buildRenewalRows,
  commissionBySource,
  invoiceAging,
  leadFunnel,
  leadQuoteStanding,
  leadStats,
  moneyByCarrier,
  pfInstallmentsDue,
  policyCommission,
  premiumByMonth,
  quoteStandingRank,
  quotedWithinWindow,
  quoteWinRate,
  receivables,
  renewalChipCounts,
  renewalMarketing,
  sumInWindow,
} from "./dashboardStats";

/** Linear civil-day fake anchored to 2026-08-24, for the date-taking helpers. */
const fakeDaysUntil = (d: string) =>
  Math.round(
    (Date.parse(`${d.slice(0, 10)}T12:00:00Z`) -
      Date.parse("2026-08-24T12:00:00Z")) /
      86_400_000
  );

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

describe("buildRenewalRows", () => {
  it("client policies need ACTIVE + expiration + a real account; leads need an incumbent date", () => {
    const rows = buildRenewalRows(
      [
        { id: "l1", name: "Willow", currentPolicyExpiration: "2026-09-11" },
        { id: "l2", name: "No Date", currentPolicyExpiration: null },
      ],
      [{ id: "c1", name: "Harbor" }],
      [
        { accountId: "c1", status: "ACTIVE", expirationDate: "2026-09-19", premium: 61300, carrierId: "car1", lines: ["Property", null], policyNumber: "P-1" },
        { accountId: "c1", status: "EXPIRED", expirationDate: "2026-01-01", premium: 1 },
        { accountId: "c1", status: "ACTIVE", expirationDate: null, premium: 1 },
        { accountId: "ghost", status: "ACTIVE", expirationDate: "2026-09-01", premium: 1 },
      ],
      fakeDaysUntil
    );
    expect(rows).toEqual([
      {
        accountId: "c1", name: "Harbor", kind: "CLIENT", date: "2026-09-19", days: 26,
        premium: 61300, carrierId: "car1", lines: ["Property"], policyNumber: "P-1",
      },
      {
        accountId: "l1", name: "Willow", kind: "LEAD", date: "2026-09-11", days: 18,
        premium: null, carrierId: null, lines: null, policyNumber: null,
      },
    ]);
  });
});

describe("renewalMarketing", () => {
  const TODAY = "2026-08-24";

  it("a quote anywhere settles it, whatever else is open", () => {
    expect(
      renewalMarketing(
        [
          { status: "COMPLETE", resolution: "QUOTED" },
          { status: "OPEN", submitBy: "2026-08-01" },
        ],
        TODAY
      )
    ).toEqual({ kind: "quoted" });
  });

  it("an open task past submit-by is missed, reporting the earliest blown deadline", () => {
    expect(
      renewalMarketing(
        [
          { status: "OPEN", submitBy: "2026-08-21" },
          { status: "OPEN", submitBy: "2026-08-15" },
          { status: "OPEN", submitBy: "2026-09-05" },
        ],
        TODAY
      )
    ).toEqual({ kind: "missed", submitBy: "2026-08-15" });
  });

  it("open tasks in window report the count and the next deadline", () => {
    expect(
      renewalMarketing(
        [
          { status: "OPEN", submitBy: "2026-09-05" },
          { status: "OPEN", submitBy: "2026-08-28" },
        ],
        TODAY
      )
    ).toEqual({ kind: "open", count: 2, submitBy: "2026-08-28" });
  });

  it("all-settled-without-a-quote is a pass, not 'not started'", () => {
    expect(
      renewalMarketing([{ status: "COMPLETE", resolution: "OUT_OF_APPETITE" }], TODAY)
    ).toEqual({ kind: "passed" });
    expect(renewalMarketing([], TODAY)).toEqual({ kind: "none" });
  });

  it("a quote found on the account settles it even with no task trail", () => {
    // The sweep never creates a task for an already-quoted carrier, so a
    // renewal quoted before the first sweep has quotes but no tasks.
    expect(renewalMarketing([], TODAY, true)).toEqual({ kind: "quoted" });
    expect(
      renewalMarketing([{ status: "OPEN", submitBy: "2026-08-01" }], TODAY, true)
    ).toEqual({ kind: "quoted" });
  });
});

describe("quotedWithinWindow", () => {
  it("counts only quotes created inside the expiration's marketing window", () => {
    const expiration = "2026-09-11"; // 18d out
    expect(
      quotedWithinWindow([{ createdAt: "2026-08-01T09:00:00Z" }], expiration, fakeDaysUntil)
    ).toBe(true);
    // A quote from the prior term's marketing is not this renewal's.
    expect(
      quotedWithinWindow([{ createdAt: "2025-09-01T09:00:00Z" }], expiration, fakeDaysUntil)
    ).toBe(false);
    // A quote after the expiration belongs to whatever comes next.
    expect(
      quotedWithinWindow([{ createdAt: "2026-10-01T09:00:00Z" }], expiration, fakeDaysUntil)
    ).toBe(false);
    expect(quotedWithinWindow([], expiration, fakeDaysUntil)).toBe(false);
    expect(quotedWithinWindow([{ createdAt: null }], expiration, fakeDaysUntil)).toBe(false);
  });
});

describe("invoiceAging", () => {
  it("buckets open invoices by days past due, prices by the link, counts the unpriced", () => {
    const aging = invoiceAging(
      [
        { status: "SENT", dueAt: "2026-09-02", stripeLinkAmountCents: 100000 }, // in 9d → current
        { status: "SENT", dueAt: null, stripeLinkAmountCents: 50000 }, // no deadline → current
        { status: "PROCESSING", dueAt: "2026-08-12", stripeLinkAmountCents: 200000 }, // 12d overdue
        { status: "SENT", dueAt: "2026-07-10", stripeLinkAmountCents: 300000 }, // 45d overdue
        { status: "SENT", dueAt: "2026-05-01", stripeLinkAmountCents: 400000 }, // 115d overdue
        { status: "SENT", dueAt: "2026-08-12", stripeLinkAmountCents: null }, // overdue, unpriced
        { status: "PAID", dueAt: "2026-01-01", stripeLinkAmountCents: 999999 },
      ],
      fakeDaysUntil
    );
    expect(aging.current).toEqual({ total: 1500, count: 2 });
    expect(aging.d1to30).toEqual({ total: 2000, count: 2 });
    expect(aging.d31to60).toEqual({ total: 3000, count: 1 });
    expect(aging.d60plus).toEqual({ total: 4000, count: 1 });
    expect(aging.overdueTotal).toBe(9000);
    expect(aging.overdueCount).toBe(4);
    expect(aging.unpriced).toBe(1);
  });
});

describe("sumInWindow", () => {
  const rows = [
    { at: "2026-08-03T10:00:00Z", v: 100 },
    { at: "2026-08-24", v: 50 },
    { at: "2026-07-31", v: 999 },
    { at: null, v: 999 },
  ];

  it("cuts datetimes to their day and compares lexicographically, inclusive", () => {
    expect(sumInWindow(rows, (r) => r.at, (r) => r.v, "2026-08-01", "2026-08-31")).toEqual({
      total: 150,
      count: 2,
    });
  });

  it("open-ended bounds admit everything dated", () => {
    expect(sumInWindow(rows, (r) => r.at, (r) => r.v, "", "")).toEqual({
      total: 1149,
      count: 3,
    });
  });
});

describe("premiumByMonth", () => {
  const policies = [
    { effectiveDate: "2026-03-10", premium: 1000 },
    { effectiveDate: "2026-03-20", premium: 500 },
    { effectiveDate: "2026-08-01", premium: 200 },
    { effectiveDate: "2025-12-01", premium: 999 },
    { effectiveDate: null, premium: 999 },
  ];

  it("a YTD-shaped window (starts Jan 1) pads to the full Jan–Dec, marking months still to come", () => {
    const cols = premiumByMonth(policies, "2026-01-01", "2026-08-24", "2026-08-24");
    expect(cols).toHaveLength(12);
    expect(cols[0]).toMatchObject({ key: "2026-01", label: "Jan", future: false, total: 0 });
    expect(cols[2]).toMatchObject({ key: "2026-03", total: 1500, count: 2 });
    expect(cols[7]).toMatchObject({ key: "2026-08", total: 200, future: false });
    expect(cols[8]).toMatchObject({ key: "2026-09", future: true, total: 0 });
  });

  it("a mid-year custom window renders ONLY its months — a padded month would show real production as $0", () => {
    const cols = premiumByMonth(policies, "2026-06-01", "2026-08-24", "2026-08-24");
    expect(cols.map((c) => c.key)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("a from-only window runs to the current month; a to-only window shows the year ending there", () => {
    const fromOnly = premiumByMonth(policies, "2026-06-01", "", "2026-08-24");
    expect(fromOnly.map((c) => c.key)).toEqual(["2026-06", "2026-07", "2026-08"]);
    const toOnly = premiumByMonth(policies, "", "2026-03-31", "2026-08-24");
    expect(toOnly).toHaveLength(12);
    expect(toOnly[0].key).toBe("2025-04");
    expect(toOnly[11].key).toBe("2026-03");
  });

  it("a cross-year window renders exactly its months", () => {
    const cols = premiumByMonth(policies, "2025-09-01", "2026-08-24", "2026-08-24");
    expect(cols).toHaveLength(12);
    expect(cols[0].key).toBe("2025-09");
    expect(cols[3]).toMatchObject({ key: "2025-12", total: 999 });
  });

  it("no window means the current calendar year", () => {
    const cols = premiumByMonth(policies, "", "", "2026-08-24");
    expect(cols[0].key).toBe("2026-01");
    expect(cols[11].key).toBe("2026-12");
  });
});

describe("quoteWinRate", () => {
  it("only decided quotes vote, and no decisions is null rather than 0%", () => {
    expect(
      quoteWinRate([
        { status: "BOUND" },
        { status: "BOUND" },
        { status: "DECLINED" },
        { status: "LOST" },
        { status: "SUBMITTED" },
        { status: "DRAFT" },
      ])
    ).toEqual({ bound: 2, decided: 4, rate: 0.5 });
    expect(quoteWinRate([{ status: "SUBMITTED" }])).toEqual({
      bound: 0,
      decided: 0,
      rate: null,
    });
  });
});

describe("pfInstallmentsDue", () => {
  it("forecasts one installment per ACTIVE loan due inside the horizon, overdue excluded", () => {
    expect(
      pfInstallmentsDue(
        [
          { status: "ACTIVE", nextDueAt: "2026-09-01", payment: 1000 }, // in 8d
          { status: "ACTIVE", nextDueAt: "2026-09-15", payment: 2000 }, // in 22d
          { status: "ACTIVE", nextDueAt: "2026-10-15", payment: 999 }, // beyond
          { status: "ACTIVE", nextDueAt: "2026-08-20", payment: 999 }, // overdue → the sweep's story
          { status: "DEFAULTED", nextDueAt: "2026-09-01", payment: 999 },
          { status: "ACTIVE", nextDueAt: null, payment: 999 },
        ],
        fakeDaysUntil
      )
    ).toEqual({ count: 2, total: 3000 });
  });
});

describe("leadFunnel", () => {
  it("stages by most advanced quote; closed-everywhere leads sit in no stage", () => {
    const quotes = new Map([
      ["l2", [{ status: "DRAFT" }]],
      ["l3", [{ status: "SUBMITTED" }, { status: "QUOTED" }]],
      ["l4", [{ status: "DECLINED" }, { status: "LOST" }]],
    ]);
    const funnel = leadFunnel(
      [{ id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }],
      quotes,
      [
        { convertedAt: "2026-08-10T00:00:00Z" },
        { convertedAt: "2026-05-01T00:00:00Z" },
        { convertedAt: null },
      ],
      new Date("2026-08-24T12:00:00Z")
    );
    expect(funnel).toEqual({ unworked: 1, marketing: 1, presented: 1, bound30d: 1 });
  });
});
