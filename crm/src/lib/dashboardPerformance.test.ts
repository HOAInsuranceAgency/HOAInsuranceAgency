import { describe, expect, it } from "vitest";
import { effectiveInWindow, performanceBySalesperson } from "./dashboardPerformance";

const series = [
  { key: "avery", label: "Avery" }, { key: "blake", label: "Blake" },
  { key: "former", label: "Unavailable teammate (former)" }, { key: "unassigned", label: "Unassigned" },
];
const entries = { a: { salespersonId: "avery" }, b: { salespersonId: "blake" }, c: { salespersonId: "former" }, d: {} };
const accounts = [
  { id: "a", leadSource: "GOOGLE_AD_WEBSITE", source: "website-quote" },
  { id: "b", source: "Referral" }, { id: "c", source: "referral " }, { id: "d" },
];
const carriers = [{ id: "carrier", name: "Test Carrier" }];
const base = { entries, series, accounts, carriers, policies: [], quotes: [] };

describe("performance by salesperson", () => {
  it("reconciles all stacked totals and retains absent account, owner, carrier and date data", () => {
    const result = performanceBySalesperson({ ...base, policies: [
      { accountId: "a", carrierId: "carrier", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10 },
      { accountId: "b", carrierId: "carrier", effectiveDate: "2026-09-20", premium: 2000, commissionPct: 15 },
      { accountId: "c", carrierId: "old-carrier", effectiveDate: "2026-10-01", premium: 3000, commissionPct: 10 },
      { accountId: "d", premium: 4000, commissionPct: 10 },
      { accountId: "deleted-account", premium: 5000, commissionPct: 10 },
    ] });
    const premiumTotal = 15000, commissionTotal = 1600;
    for (const rows of [result.months, result.premiumCarriers]) {
      expect(rows.reduce((total, row) => total + row.total, 0)).toBe(premiumTotal);
      for (const row of rows) expect(Object.values(row.values).reduce((sum, value) => sum + value, 0)).toBe(row.total);
    }
    for (const rows of [result.commissionSources, result.commissionCarriers]) {
      expect(rows.reduce((total, row) => total + row.total, 0)).toBe(commissionTotal);
      for (const row of rows) expect(Object.values(row.values).reduce((sum, value) => sum + value, 0)).toBe(row.total);
    }
    expect(result.people.map(person => [person.key, person.commission])).toEqual([["avery", 100], ["blake", 300], ["former", 300], ["unassigned", 900]]);
    expect(result.months.find(row => row.key === "undated")).toMatchObject({ label: "No effective date", total: 9000, count: 2 });
    expect(result.premiumCarriers.find(row => row.key === "old-carrier")).toMatchObject({ label: "Unknown carrier", values: { former: 3000 } });
    expect(result.commissionSources.find(row => row.key === "referral")).toMatchObject({ total: 600, values: { blake: 300, former: 300 } });
    expect(JSON.stringify(result)).not.toContain("website-quote");
  });

  it("attributes production to the current account owner regardless of the policy creator", () => {
    const policies = [{ accountId: "a", premium: 10000, commissionPct: 12 }];
    const moved = performanceBySalesperson({ ...base, entries: { ...entries, a: { salespersonId: "blake" } }, policies });
    expect(moved.people.find(person => person.key === "avery")?.commission).toBe(0);
    expect(moved.people.find(person => person.key === "blake")?.commission).toBe(1200);
    expect(moved.months[0].values).toEqual({ blake: 10000 });
  });

  it("uses inclusive effective dates, excludes cancelled policies by default and reports missing commission", () => {
    const policies = [
      { accountId: "a", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10 },
      { accountId: "a", effectiveDate: "2026-09-30", premium: 2000, commissionPct: null },
      { accountId: "a", effectiveDate: "2026-08-31", premium: 4000, commissionPct: 10 },
      { accountId: "a", effectiveDate: "2026-10-01", premium: 8000, commissionPct: 10 },
      { accountId: "a", premium: 16000, commissionPct: 10 },
      { accountId: "a", effectiveDate: "2026-09-01", premium: 32000, commissionPct: 10, status: "CANCELLED" },
    ];
    const selected = { ...base, policies, from: "2026-09-01", to: "2026-09-30" };
    const result = performanceBySalesperson(selected);
    expect(result.months).toEqual([{ key: "2026-09", label: "Sep 2026", values: { avery: 3000 }, total: 3000, count: 2 }]);
    expect(result.people[0]).toMatchObject({ commission: 100, policies: 2, missingCommissionPct: 1 });
    expect(result.missingCommissionPct).toBe(1);
    expect(performanceBySalesperson({ ...selected, excludeCancelled: false }).people[0].commission).toBe(3300);
    expect(performanceBySalesperson({ ...selected, from: "2026-10-01" }).people[0].commission).toBe(0);
  });

  it("computes per-person decisions without open quotes diluting the denominator or no decisions becoming zero", () => {
    const result = performanceBySalesperson({ ...base, from: "2026-01-01", to: "2026-12-31", quotes: [
      { accountId: "a", status: "BOUND", effectiveDate: "2026-01-01" },
      { accountId: "a", status: "LOST", effectiveDate: "2026-03-01" },
      { accountId: "a", status: "DECLINED", effectiveDate: "2026-12-31" },
      { accountId: "a", status: "SENT", effectiveDate: "2026-05-01" },
      { accountId: "a", status: "BOUND", effectiveDate: "2025-12-31" },
      { accountId: "a", status: "BOUND" },
      { accountId: "b", status: "DECLINED", effectiveDate: "2026-02-01" },
      { accountId: "c", status: "DRAFT", effectiveDate: "2026-02-01" },
      { accountId: "d", status: "BOUND", effectiveDate: "2026-02-01" },
    ] });
    expect(result.people[0]).toMatchObject({ bound: 1, decided: 3, winRate: 1 / 3 });
    expect(result.people[1]).toMatchObject({ bound: 0, decided: 1, winRate: 0 });
    expect(result.people[2]).toMatchObject({ bound: 0, decided: 0, winRate: null });
    expect(result.people[3]).toMatchObject({ bound: 1, decided: 1, winRate: 1 });
  });

  it("keeps older production and fills zero months across years without truncating the selected total", () => {
    const result = performanceBySalesperson({ ...base, policies: [
      { accountId: "a", effectiveDate: "2023-12-01", premium: 1000 },
      { accountId: "b", effectiveDate: "2026-02-01", premium: 2000 },
    ] });
    expect(result.months).toHaveLength(27);
    expect(result.months[0]).toMatchObject({ key: "2023-12", total: 1000 });
    expect(result.months[1]).toMatchObject({ key: "2024-01", total: 0 });
    expect(result.months.at(-1)).toMatchObject({ key: "2026-02", total: 2000 });
    expect(result.months.reduce((sum, row) => sum + row.total, 0)).toBe(3000);
  });
});

describe("effectiveInWindow", () => {
  it("keeps undated records only when no date bounds were requested", () => {
    expect(effectiveInWindow(undefined, "", "")).toBe(true);
    expect(effectiveInWindow(undefined, "2026-01-01", "")).toBe(false);
    expect(effectiveInWindow(null, "", "2026-12-31")).toBe(false);
    expect(effectiveInWindow("2026-09-30T14:00:00Z", "2026-09-30", "2026-09-30")).toBe(true);
    expect(effectiveInWindow("2026-09-30", "2026-10-01", "2026-09-01")).toBe(false);
  });
});
