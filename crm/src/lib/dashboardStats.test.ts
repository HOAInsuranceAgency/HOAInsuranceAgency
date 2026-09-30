import { describe, expect, it } from "vitest";
import {
  invoiceAging,
  leadQuoteStanding,
  policyCommission,
  quoteStandingRank,
} from "./dashboardStats";

/** Linear civil-day fake anchored to 2026-08-24. */
const fakeDaysUntil = (d: string) =>
  Math.round(
    (Date.parse(`${d.slice(0, 10)}T12:00:00Z`) -
      Date.parse("2026-08-24T12:00:00Z")) /
      86_400_000
  );

describe("policyCommission", () => {
  it("is premium × pct / 100, and $0 whenever either half is unrecorded", () => {
    expect(policyCommission({ premium: 47900, commissionPct: 15 })).toBe(7185);
    expect(policyCommission({ premium: 47900, commissionPct: null })).toBe(0);
    expect(policyCommission({ premium: null, commissionPct: 15 })).toBe(0);
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
