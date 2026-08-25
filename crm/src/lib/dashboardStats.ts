/**
 * The dashboard's money aggregations, pure and dependency-free — the same
 * discipline as `invoiceTotals.ts`, so the figures the agency steers by can
 * be asserted without a data client.
 *
 * Commission everywhere in this codebase is `premium × commissionPct / 100`,
 * baked into the premium and informational, never additive (the schema's own
 * words on Quote.commissionPct). These helpers restate that formula rather
 * than invent one.
 */

// Types only — erased at compile time, so the module stays import-safe for
// tests while its status tables stay pinned to the schema enum: a status
// added to QuoteStatus fails compilation here until it is ranked, the same
// guarantee quoteStatus.ts and badges.tsx already make.
import type {
  ClosedQuoteStatus,
  OpenQuoteStatus,
  QuoteStatus,
} from "./quoteStatus";

/** One bar of a grouped money chart. */
export interface MoneyRow {
  key: string;
  name: string;
  total: number;
  count: number;
}

interface PolicyLike {
  accountId: string;
  premium?: number | null;
  commissionPct?: number | null;
}

interface AccountLike {
  id: string;
  source?: string | null;
}

/** The one commission formula, null-safe: no pct or no premium is $0. */
export function policyCommission(p: {
  premium?: number | null;
  commissionPct?: number | null;
}): number {
  return p.premium != null && p.commissionPct != null
    ? (p.premium * p.commissionPct) / 100
    : 0;
}

/**
 * Commission grouped by where the account came from.
 *
 * `Account.source` is free text ("website", "referral", "cold"), so grouping
 * normalises case and whitespace — "Website" and "website " are one bucket —
 * while the display name keeps the first spelling seen. Accounts with no
 * source land in one honest bucket rather than vanishing: an unattributed
 * dollar is a data gap someone should see, not a rounding error. Zero-total
 * groups are dropped and rows sort largest first, matching the carrier
 * charts' contract.
 */
export function commissionBySource(
  policies: readonly PolicyLike[],
  accounts: readonly AccountLike[]
): MoneyRow[] {
  const sourceByAccount = new Map(accounts.map((a) => [a.id, a.source]));
  const groups = new Map<string, { name: string; total: number; count: number }>();
  for (const p of policies) {
    const raw = (sourceByAccount.get(p.accountId) ?? "").trim();
    const key = raw ? raw.toLowerCase() : "(none)";
    const cur = groups.get(key) ?? {
      name: raw || "No source recorded",
      total: 0,
      count: 0,
    };
    cur.total += policyCommission(p);
    cur.count += 1;
    groups.set(key, cur);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...g }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
}

/** What the world owes the agency right now, in two honest buckets. */
export interface Receivables {
  /** Billed and uncollected: SENT + PROCESSING invoices, in dollars. */
  invoiceTotal: number;
  invoiceCount: number;
  /** Invoices that are live but carry no stored amount (never sent through
   * Stripe, e.g. legacy rows) — counted so the total says what it misses. */
  invoiceUnpriced: number;
  /** Outstanding financed principal on loans money has touched. */
  loanTotal: number;
  loanCount: number;
}

interface InvoiceLike {
  status?: string | null;
  stripeLinkAmountCents?: number | null;
}

interface LoanLike {
  status?: string | null;
  balance?: number | null;
  amountFinanced?: number | null;
}

/**
 * Accounts receivable.
 *
 * Invoices: SENT and PROCESSING are claims on the association — DRAFT is not
 * yet asked for, PAID and VOID are settled history. The amount is the stored
 * `stripeLinkAmountCents` (what the payment link was actually minted for at
 * last send) rather than a recomputation from lines, because the link's
 * figure is the one the customer was asked to pay.
 *
 * Loans: money has moved on ACCEPTED onward, so ACCEPTED, ACTIVE and
 * DEFAULTED balances are principal the agency is owed. `balance` is seeded
 * at origination and advanced by every posting; `amountFinanced` is the
 * fallback for a row from before balances existed. QUOTED is an offer, not
 * a receivable; PAID and CANCELLED are closed.
 */
export function receivables(
  invoices: readonly InvoiceLike[],
  loans: readonly LoanLike[]
): Receivables {
  let invoiceCents = 0;
  let invoiceCount = 0;
  let invoiceUnpriced = 0;
  for (const i of invoices) {
    if (i.status !== "SENT" && i.status !== "PROCESSING") continue;
    invoiceCount += 1;
    if (typeof i.stripeLinkAmountCents === "number") {
      invoiceCents += i.stripeLinkAmountCents;
    } else {
      invoiceUnpriced += 1;
    }
  }
  let loanTotal = 0;
  let loanCount = 0;
  for (const l of loans) {
    if (!["ACCEPTED", "ACTIVE", "DEFAULTED"].includes(l.status ?? "")) continue;
    const owed = l.balance ?? l.amountFinanced ?? 0;
    if (owed <= 0) continue;
    loanCount += 1;
    loanTotal += owed;
  }
  return {
    invoiceTotal: invoiceCents / 100,
    invoiceCount,
    invoiceUnpriced,
    loanTotal,
    loanCount,
  };
}

// ── Renewal horizon chips ────────────────────────────────────────────

export interface RenewalChipCounts {
  overdue: number;
  d30: number;
  d60: number;
  d90: number;
}

/**
 * Chip counts for the renewal horizon picker, each computed over the FULL
 * row set. The card this replaces counted inside rows already filtered to
 * the *selected* horizon, so with 30d active the 60d and 90d chips repeated
 * the 30-day figure — and a renewal past its date appeared in the table
 * while counting toward no chip at all. Overdue is its own number because
 * blown and upcoming are different work, not two distances on one scale.
 */
export function renewalChipCounts(
  rows: readonly { days: number }[]
): RenewalChipCounts {
  let overdue = 0;
  let d30 = 0;
  let d60 = 0;
  let d90 = 0;
  for (const r of rows) {
    if (r.days < 0) {
      overdue += 1;
      continue;
    }
    if (r.days <= 30) d30 += 1;
    if (r.days <= 60) d60 += 1;
    if (r.days <= 90) d90 += 1;
  }
  return { overdue, d30, d60, d90 };
}

// ── Lead pipeline figures ────────────────────────────────────────────

export interface LeadStats {
  /** Leads whose createdAt is within the last 7 days of `now`. */
  newThisWeek: number;
  /** Clients whose convertedAt falls in `now`'s UTC calendar quarter. */
  convertedThisQuarter: number;
  /** Whole days, median over every client carrying both dates. Null with
   * no converted clients — "no data yet" is not the same claim as "0 days". */
  medianDaysToConvert: number | null;
}

interface StampedAccount {
  createdAt?: string | null;
  convertedAt?: string | null;
}

/**
 * The lead tab's lifecycle tiles. `now` is a parameter, not a clock read,
 * for the same reason `badges.tsx` takes days instead of dates: every test
 * stays deterministic. Quarter arithmetic is UTC because the stamps are —
 * a conversion at 11pm Eastern on Mar 31 is an April conversion here, and
 * consistently so on every machine that renders it.
 */
export function leadStats(
  leads: readonly StampedAccount[],
  clients: readonly StampedAccount[],
  now: Date
): LeadStats {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  let newThisWeek = 0;
  for (const l of leads) {
    const t = l.createdAt ? Date.parse(l.createdAt) : NaN;
    if (!Number.isNaN(t) && t >= weekAgo) newThisWeek += 1;
  }

  const qYear = now.getUTCFullYear();
  const qIndex = Math.floor(now.getUTCMonth() / 3);
  let convertedThisQuarter = 0;
  const spans: number[] = [];
  for (const c of clients) {
    if (!c.convertedAt) continue;
    const conv = new Date(c.convertedAt);
    if (Number.isNaN(conv.getTime())) continue;
    if (
      conv.getUTCFullYear() === qYear &&
      Math.floor(conv.getUTCMonth() / 3) === qIndex
    ) {
      convertedThisQuarter += 1;
    }
    const created = c.createdAt ? Date.parse(c.createdAt) : NaN;
    // A conversion stamped before its own creation is corrupt, not a fast
    // sale — it would drag the median negative, so it stays out.
    if (!Number.isNaN(created) && conv.getTime() >= created) {
      spans.push((conv.getTime() - created) / 86_400_000);
    }
  }
  spans.sort((a, b) => a - b);
  const medianDaysToConvert =
    spans.length === 0
      ? null
      : Math.round(
          spans.length % 2
            ? spans[(spans.length - 1) / 2]
            : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2
        );

  return { newThisWeek, convertedThisQuarter, medianDaysToConvert };
}

/** Where a lead stands: its most advanced quote's status, and how many
 * quotes sit at that rung. */
export interface QuoteStanding {
  status: string;
  count: number;
}

const OPEN_STANDING_RANK: Record<string, number> = {
  PRESENTED: 4,
  QUOTED: 3,
  SUBMITTED: 2,
  DRAFT: 1,
} satisfies Record<OpenQuoteStatus, number>;
const CLOSED_STANDING_RANK: Record<string, number> = {
  BOUND: 3,
  DECLINED: 2,
  LOST: 1,
} satisfies Record<ClosedQuoteStatus, number>;

/**
 * A lead's stage is binary (LEAD → CLIENT), so its quotes are the only
 * truthful pipeline signal. The most advanced OPEN quote wins; a lead whose
 * quotes are all closed shows that outcome rather than nothing — a lead
 * every carrier declined has been worked, and the list must not render it
 * like one nobody touched. Null means genuinely untouched.
 */
export function leadQuoteStanding(
  quotes: readonly { status?: string | null }[]
): QuoteStanding | null {
  const top = (rank: Record<string, number>) => {
    let best: string | null = null;
    for (const q of quotes) {
      const s = q.status ?? "";
      if (rank[s] && (best === null || rank[s] > rank[best])) best = s;
    }
    return best;
  };
  const status = top(OPEN_STANDING_RANK) ?? top(CLOSED_STANDING_RANK);
  if (!status) return null;
  return { status, count: quotes.filter((q) => q.status === status).length };
}

/**
 * One total order over every status, for sorting a standing column. Live
 * rungs climb 1–4, BOUND caps them, and the dead outcomes sit below zero:
 * a sort by "pipeline" should read as a progression, and the alternative —
 * alphabetizing the raw strings — files DECLINED between BOUND and DRAFT.
 */
const STANDING_SORT_RANK: Record<string, number> = {
  BOUND: 5,
  PRESENTED: 4,
  QUOTED: 3,
  SUBMITTED: 2,
  DRAFT: 1,
  DECLINED: -1,
  LOST: -2,
} satisfies Record<QuoteStatus, number>;

/** Sort key for a standing: rank, or null for no quotes (sorts last). */
export function quoteStandingRank(standing: QuoteStanding | null): number | null {
  return standing ? STANDING_SORT_RANK[standing.status] ?? 0 : null;
}

// ── Carrier grouping ─────────────────────────────────────────────────

interface CarrierLike {
  id: string;
  name?: string | null;
}

/**
 * Money grouped by writing carrier — the shape behind "premium written by
 * carrier" and "commission by carrier". Moved out of the Dashboard component,
 * where it lived as a render-scoped closure behind an exhaustive-deps
 * disable, so the grouping can be asserted without React. Same contract as
 * `commissionBySource`: honest buckets for unassigned and unknown carriers,
 * zero-total groups dropped, largest first.
 */
export function moneyByCarrier<P extends { carrierId?: string | null }>(
  policies: readonly P[],
  carriers: readonly CarrierLike[],
  value: (p: P) => number
): MoneyRow[] {
  const byCarrier = new Map<string, { total: number; count: number }>();
  for (const p of policies) {
    const key = p.carrierId ?? "unassigned";
    const cur = byCarrier.get(key) ?? { total: 0, count: 0 };
    cur.total += value(p);
    cur.count += 1;
    byCarrier.set(key, cur);
  }
  return [...byCarrier.entries()]
    .map(([key, agg]) => ({
      key,
      name:
        key === "unassigned"
          ? "Unassigned"
          : carriers.find((c) => c.id === key)?.name ?? "Unknown carrier",
      ...agg,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
}
