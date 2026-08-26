/**
 * The business, not the day's paperwork.
 *
 * `done.ts` counts what was typed into the CRM. That is activity, and activity
 * is not progress: "9 quotes advanced" tells the owner nothing about whether
 * the agency is growing, because it has no denominator and no comparison. This
 * module supplies the three things that turn a count into a report a principal
 * can act on —
 *
 *   • **outcome** — what was actually won and lost, in premium
 *   • **pace** — where the month stands against the same point in the last one
 *   • **forward view** — what is in flight, and what has to be decided soon
 *
 * Pure, and every figure is either read from a stored field or summed from
 * one. Nothing here estimates.
 *
 * ── What this deliberately does not claim ──
 *
 * There is no `renewalOfPolicyId` in the schema, so new business and renewal
 * business cannot be told apart on a policy. The nearest honest proxy is
 * whether the account converted from LEAD in the same window, which is what
 * `newClients` in `done.ts` already reports — so this module reports total
 * production and does not split it. Inventing the split would be the most
 * quietly wrong number in the whole email.
 *
 * Commission is likewise always an estimate: `commissionPct` is nullable and
 * baked into the premium, and there are no carrier commission statements in
 * this system, so a direct-bill commission is never an actual. The count of
 * policies missing a percentage rides alongside every total for that reason.
 */

import {
  policyCommission,
  quoteWinRate,
  sumInWindow,
} from "../../../src/lib/dashboardStats";
import { addDays, dayOf, daysBetweenDays } from "./window";

/** Open quote statuses, most advanced last — the order the pipeline reads. */
const PIPELINE_STAGES = ["SUBMITTED", "QUOTED", "PRESENTED"] as const;

/** How far ahead an open quote's effective date makes it a live decision. */
const DECISION_HORIZON_DAYS = 30;

export interface Outcome {
  account: string;
  premium: number | null;
  detail: string | null;
}

export interface PipelineStage {
  stage: string;
  count: number;
  premium: number;
}

export interface Progress {
  /** Policies bound inside the edition's window. */
  won: Outcome[];
  /** Quotes marked DECLINED or LOST inside it. */
  lost: Outcome[];

  monthLabel: string;
  mtdPremium: number;
  mtdCommission: number;
  mtdPolicies: number;
  /** Bound policies with premium but no commission % — the totals are floors. */
  mtdWithoutCommission: number;

  /** The same span of the previous month, to the same day number. */
  priorPremium: number;
  priorPolicies: number;
  /** mtd ÷ prior − 1, or null when there is nothing to compare against. */
  pacePct: number | null;

  pipeline: PipelineStage[];
  pipelineTotal: number;
  pipelineCount: number;
  /** Open quotes whose effective date lands inside the horizon. */
  decisionsDue: { count: number; premium: number; days: number };

  /** Lifetime, because Quote stores no decision date to window on. */
  winRate: { bound: number; decided: number; rate: number | null };

  activePolicies: number;
  clients: number;
  leads: number;
}

export interface ProgressInputs {
  policies: readonly {
    accountId: string;
    status?: string | null;
    premium?: number | null;
    commissionPct?: number | null;
    carrierId?: string | null;
    datePolicyBound?: string | null;
  }[];
  quotes: readonly {
    accountId: string;
    status?: string | null;
    premium?: number | null;
    effectiveDate?: string | null;
    updatedAt?: string | null;
  }[];
  accounts: readonly { id: string; name: string; stage?: string | null }[];
  carriers: readonly { id: string; name?: string | null }[];
}

/** `"2026-08-25"` → `"2026-08-01"`. */
const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;

/** The month before `day`'s, as `YYYY-MM`. */
function priorMonthKey(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/**
 * The window's production and the shape of the pipeline behind it.
 *
 * `windowStartDay` is null on a weekend edition, where nothing is reported as
 * having happened — the outcome lists come back empty and only the standing
 * figures are filled in.
 */
export function buildProgress(
  input: ProgressInputs,
  todayDay: string,
  windowStartDay: string | null
): Progress {
  const accountName = new Map(input.accounts.map((a) => [a.id, a.name]));
  const carrierName = new Map(input.carriers.map((c) => [c.id, c.name ?? null]));
  const nameOf = (id: string) => accountName.get(id) ?? "Unknown account";

  // ── Won and lost in the window ───────────────────────────────────

  const won: Outcome[] = [];
  const lost: Outcome[] = [];
  if (windowStartDay) {
    for (const p of input.policies) {
      const bound = dayOf(p.datePolicyBound);
      if (!bound || bound < windowStartDay || bound >= todayDay) continue;
      won.push({
        account: nameOf(p.accountId),
        premium: p.premium ?? null,
        detail: p.carrierId ? carrierName.get(p.carrierId) ?? null : null,
      });
    }
    for (const q of input.quotes) {
      if (q.status !== "DECLINED" && q.status !== "LOST") continue;
      // Quote stores no decision date, so this is the day the row was last
      // written. It is the only signal there is, and the email says "marked"
      // rather than "declined on" because of it.
      const marked = dayOf(q.updatedAt);
      if (!marked || marked < windowStartDay || marked >= todayDay) continue;
      lost.push({
        account: nameOf(q.accountId),
        premium: q.premium ?? null,
        detail: q.status === "DECLINED" ? "carrier declined" : "lost",
      });
    }
  }

  // ── Pace ─────────────────────────────────────────────────────────

  const monthStart = firstOfMonth(todayDay);
  // Yesterday: a month-to-date figure that included today would move under
  // the reader as the day went on, and the window never covers today anyway.
  const throughDay = addDays(todayDay, -1);
  const dayNumber = Number(todayDay.slice(8, 10));

  const boundDay = (p: ProgressInputs["policies"][number]) => dayOf(p.datePolicyBound);
  const mtd = sumInWindow(
    input.policies,
    boundDay,
    (p) => p.premium ?? 0,
    monthStart,
    throughDay
  );
  const mtdCommission = sumInWindow(
    input.policies,
    boundDay,
    policyCommission,
    monthStart,
    throughDay
  );
  const mtdWithoutCommission = input.policies.filter((p) => {
    const d = boundDay(p);
    return (
      d != null &&
      d >= monthStart &&
      d <= throughDay &&
      (p.premium ?? 0) > 0 &&
      p.commissionPct == null
    );
  }).length;

  // The same number of days into the previous month. Comparing a partial
  // month against a whole one is the classic way to invent a collapse.
  const priorKey = priorMonthKey(todayDay);
  const prior = sumInWindow(
    input.policies,
    boundDay,
    (p) => p.premium ?? 0,
    `${priorKey}-01`,
    `${priorKey}-${String(dayNumber - 1).padStart(2, "0")}`
  );

  // ── Pipeline ─────────────────────────────────────────────────────

  const pipeline: PipelineStage[] = PIPELINE_STAGES.map((stage) => {
    const rows = input.quotes.filter((q) => q.status === stage);
    return {
      stage,
      count: rows.length,
      premium: rows.reduce((n, q) => n + (q.premium ?? 0), 0),
    };
  }).filter((s) => s.count > 0);

  const open = input.quotes.filter(
    (q) => q.status && (PIPELINE_STAGES as readonly string[]).includes(q.status)
  );
  const dueSoon = open.filter((q) => {
    const eff = dayOf(q.effectiveDate);
    if (!eff) return false;
    const days = daysBetweenDays(todayDay, eff);
    return days >= 0 && days <= DECISION_HORIZON_DAYS;
  });

  return {
    won,
    lost,
    monthLabel: new Date(`${todayDay}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      timeZone: "UTC",
    }),
    mtdPremium: mtd.total,
    mtdCommission: mtdCommission.total,
    mtdPolicies: mtd.count,
    mtdWithoutCommission,
    priorPremium: prior.total,
    priorPolicies: prior.count,
    pacePct: prior.total > 0 ? mtd.total / prior.total - 1 : null,
    pipeline,
    pipelineTotal: open.reduce((n, q) => n + (q.premium ?? 0), 0),
    pipelineCount: open.length,
    decisionsDue: {
      count: dueSoon.length,
      premium: dueSoon.reduce((n, q) => n + (q.premium ?? 0), 0),
      days: DECISION_HORIZON_DAYS,
    },
    winRate: quoteWinRate(input.quotes),
    activePolicies: input.policies.filter((p) => p.status === "ACTIVE").length,
    clients: input.accounts.filter((a) => a.stage === "CLIENT").length,
    leads: input.accounts.filter((a) => a.stage === "LEAD").length,
  };
}
