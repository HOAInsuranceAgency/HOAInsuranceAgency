import { acquisitionLabel } from "../../../shared/leadSource";
import type { ChartRow, ChartSeries } from "../components/StackedBars";
import { salespersonKey } from "./dashboardPeople";
import { policyCommission } from "./dashboardStats";

type Assignments = Readonly<Record<string, { salespersonId?: string | null }>>;
interface PerformancePolicy {
  accountId: string;
  carrierId?: string | null;
  effectiveDate?: string | null;
  premium?: number | null;
  commissionPct?: number | null;
  status?: string | null;
}
interface PerformanceQuote {
  accountId: string;
  effectiveDate?: string | null;
  status?: string | null;
}
interface PerformanceAccount { id: string; leadSource?: string | null; source?: string | null }
interface PerformanceCarrier { id: string; name?: string | null }
export interface PerformanceMoneyRow extends ChartRow {
  total: number;
  count: number;
}
export interface PerformancePerson {
  key: string;
  label: string;
  commission: number;
  policies: number;
  missingCommissionPct: number;
  bound: number;
  decided: number;
  /** No decisions is unknown, not a measured 0% win rate. */
  winRate: number | null;
}

/** The controls refer to civil policy/quote effective dates, inclusively. */
export function effectiveInWindow(date: string | null | undefined, from: string, to: string): boolean {
  if (from && to && from > to) return false;
  const day = date?.slice(0, 10);
  if (from && (!day || day < from)) return false;
  if (to && (!day || day > to)) return false;
  return true;
}

const monthLabel = (key: string) => new Intl.DateTimeFormat("en-US", {
  month: "short", year: "numeric", timeZone: "UTC",
}).format(new Date(`${key}-01T12:00:00Z`));
const validMonth = (value: string | null | undefined): string | undefined => {
  const month = value?.slice(0, 7);
  return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined;
};
const nextMonth = (key: string) => key.endsWith("-12")
  ? `${String(Number(key.slice(0, 4)) + 1).padStart(4, "0")}-01`
  : `${key.slice(0, 4)}-${String(Number(key.slice(5)) + 1).padStart(2, "0")}`;

/**
 * Every chart uses the same filtered policies and current account assignment.
 * Unknown carriers, sources, owners and dates retain their own buckets so the
 * totals reconcile. Monthly output keeps all production, including older years.
 */
export function performanceBySalesperson({
  policies, quotes, accounts, carriers, entries, series, from = "", to = "", excludeCancelled = true,
}: {
  policies: readonly PerformancePolicy[];
  quotes: readonly PerformanceQuote[];
  accounts: readonly PerformanceAccount[];
  carriers: readonly PerformanceCarrier[];
  entries: Assignments;
  series: readonly ChartSeries[];
  from?: string;
  to?: string;
  excludeCancelled?: boolean;
}) {
  const selected = policies.filter(p => (!excludeCancelled || p.status !== "CANCELLED") && effectiveInWindow(p.effectiveDate, from, to));
  const people = new Map<string, PerformancePerson>(series.map(s => [s.key, {
    key: s.key, label: s.label, commission: 0, policies: 0, missingCommissionPct: 0,
    bound: 0, decided: 0, winRate: null,
  }]));
  const carrierNames = new Map(carriers.map(c => [c.id, c.name?.trim() || "Unknown carrier"]));
  const sources = new Map(accounts.map(a => [a.id, acquisitionLabel(a.leadSource, a.source)]));
  const months = new Map<string, PerformanceMoneyRow>();
  const premiumCarriers = new Map<string, PerformanceMoneyRow>();
  const commissionCarriers = new Map<string, PerformanceMoneyRow>();
  const commissionSources = new Map<string, PerformanceMoneyRow>();
  const personFor = (accountId: string) => {
    const key = salespersonKey(accountId, entries);
    let person = people.get(key);
    if (!person) {
      person = { key, label: "Unassigned", commission: 0, policies: 0, missingCommissionPct: 0, bound: 0, decided: 0, winRate: null };
      people.set(key, person);
    }
    return person;
  };
  const add = (groups: Map<string, PerformanceMoneyRow>, key: string, label: string, person: string, value: number) => {
    const row = groups.get(key) ?? { key, label, values: {}, total: 0, count: 0 };
    row.values[person] = (row.values[person] ?? 0) + value;
    row.total += value;
    row.count++;
    groups.set(key, row);
  };
  for (const policy of selected) {
    const person = personFor(policy.accountId);
    const premium = policy.premium ?? 0;
    const commission = policyCommission(policy);
    person.commission += commission;
    person.policies++;
    if (premium > 0 && policy.commissionPct == null) person.missingCommissionPct++;
    const month = validMonth(policy.effectiveDate);
    add(months, month ?? "undated", month ? monthLabel(month) : "No effective date", person.key, premium);
    const carrierKey = policy.carrierId || "unassigned";
    const carrierLabel = policy.carrierId ? carrierNames.get(policy.carrierId) ?? "Unknown carrier" : "No carrier recorded";
    add(premiumCarriers, carrierKey, carrierLabel, person.key, premium);
    add(commissionCarriers, carrierKey, carrierLabel, person.key, commission);
    const sourceLabel = sources.get(policy.accountId) ?? "Not recorded";
    add(commissionSources, sourceLabel.toLowerCase(), sourceLabel, person.key, commission);
  }
  for (const quote of quotes) {
    if (!effectiveInWindow(quote.effectiveDate, from, to)) continue;
    const person = personFor(quote.accountId);
    if (quote.status === "BOUND") {
      person.bound++;
      person.decided++;
    } else if (quote.status === "LOST" || quote.status === "DECLINED") person.decided++;
  }
  for (const person of people.values()) person.winRate = person.decided ? person.bound / person.decided : null;

  // Fill empty months between real dates (or explicit bounds). No 24-month
  // truncation: a chart marked All time must not silently lose old premium.
  const observedMonths = [...months.keys()].filter(k => k !== "undated").sort();
  const start = validMonth(from) ?? observedMonths[0];
  const end = validMonth(to) ?? observedMonths.at(-1);
  if (start && end && start <= end) {
    for (let month = start; month <= end; month = nextMonth(month)) {
      if (!months.has(month)) months.set(month, { key: month, label: monthLabel(month), values: {}, total: 0, count: 0 });
      if (month === end) break;
    }
  }
  const descending = (groups: Map<string, PerformanceMoneyRow>) => [...groups.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return {
    people: [...people.values()],
    months: [...months.values()].sort((a, b) => a.key.localeCompare(b.key)),
    premiumCarriers: descending(premiumCarriers),
    commissionCarriers: descending(commissionCarriers),
    commissionSources: descending(commissionSources),
    missingCommissionPct: [...people.values()].reduce((sum, person) => sum + person.missingCommissionPct, 0),
  };
}
