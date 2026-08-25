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

/**
 * The lead funnel, judged the same way the standing column is: by each
 * lead's most advanced quote. A lead whose quotes are all closed (declined
 * everywhere, lost) sits in NO stage — it was worked and it ended, and
 * filing it under "unworked" would send someone to call an account every
 * carrier already answered for. The stages therefore need not sum to the
 * lead count.
 */
export interface LeadFunnel {
  unworked: number;
  marketing: number;
  presented: number;
  bound30d: number;
}

export function leadFunnel(
  leads: readonly { id: string }[],
  quotesByLead: ReadonlyMap<string, readonly { status?: string | null }[]>,
  clients: readonly { convertedAt?: string | null }[],
  now: Date
): LeadFunnel {
  let unworked = 0;
  let marketing = 0;
  let presented = 0;
  for (const l of leads) {
    const standing = leadQuoteStanding(quotesByLead.get(l.id) ?? []);
    if (!standing) unworked += 1;
    else if (standing.status === "DRAFT" || standing.status === "SUBMITTED")
      marketing += 1;
    else if (standing.status === "QUOTED" || standing.status === "PRESENTED")
      presented += 1;
  }
  const cutoff = now.getTime() - 30 * 86_400_000;
  const bound30d = clients.filter(
    (c) => c.convertedAt && Date.parse(c.convertedAt) >= cutoff
  ).length;
  return { unworked, marketing, presented, bound30d };
}

// ── Renewal rows ─────────────────────────────────────────────────────

/** One row of the renewal workspace: a client policy expiring, or a lead's
 * incumbent policy expiring. Lead rows carry no premium/carrier/lines —
 * the incumbent's terms live in PriorCarrier rows when captured at all,
 * and "—" is honest where $0 would be a claim. */
export interface RenewalRowBase {
  accountId: string;
  name: string;
  kind: "CLIENT" | "LEAD";
  date: string; // YYYY-MM-DD
  days: number;
  premium: number | null;
  carrierId: string | null;
  lines: string[] | null;
  policyNumber: string | null;
}

/**
 * The full renewal set — ACTIVE client policies with an expiration, plus
 * leads with a known incumbent expiration. No horizon filtering here: the
 * chips count the whole set, so the whole set is what gets built. A date
 * `daysUntil` can't read is dropped rather than carried as a row with no
 * number in it.
 */
export function buildRenewalRows(
  leads: readonly {
    id: string;
    name: string;
    currentPolicyExpiration?: string | null;
  }[],
  clients: readonly { id: string; name: string }[],
  policies: readonly {
    accountId: string;
    status?: string | null;
    expirationDate?: string | null;
    premium?: number | null;
    carrierId?: string | null;
    lines?: (string | null)[] | null;
    policyNumber?: string | null;
  }[],
  daysUntil: (d: string) => number | null
): RenewalRowBase[] {
  const out: RenewalRowBase[] = [];
  const clientById = new Map(clients.map((c) => [c.id, c]));

  for (const p of policies) {
    if (p.status !== "ACTIVE" || !p.expirationDate) continue;
    const acct = clientById.get(p.accountId);
    if (!acct) continue;
    const days = daysUntil(p.expirationDate);
    if (days == null) continue;
    out.push({
      accountId: acct.id,
      name: acct.name,
      kind: "CLIENT",
      date: p.expirationDate,
      days,
      premium: p.premium ?? null,
      carrierId: p.carrierId ?? null,
      lines: (p.lines ?? []).filter((l): l is string => Boolean(l)),
      policyNumber: p.policyNumber ?? null,
    });
  }
  for (const l of leads) {
    if (!l.currentPolicyExpiration) continue;
    const days = daysUntil(l.currentPolicyExpiration);
    if (days == null) continue;
    out.push({
      accountId: l.id,
      name: l.name,
      kind: "LEAD",
      date: l.currentPolicyExpiration,
      days,
      premium: null,
      carrierId: null,
      lines: null,
      policyNumber: null,
    });
  }
  return out;
}

/**
 * The widest plausible marketing window before an expiration: the longest
 * carrier lead time in use (~30d) plus the sweep's 14-day head start, with
 * room. A quote for the account created inside this window is renewal
 * marketing for that expiration; one from months earlier belongs to the
 * prior term.
 */
const MARKETING_WINDOW_DAYS = 90;

/**
 * Whether the account was quoted inside the expiration's marketing window.
 *
 * This exists because "no MarketingTask row" does not mean "nobody
 * started": the nightly sweep deliberately never CREATES a task for a
 * carrier that is already quoted (it counts the skip and moves on), so a
 * quote landing before the first sweep leaves no task trail at all. Any
 * surface inferring "not started" from missing tasks must ask the quotes
 * too, or it renders the best-case renewal as the worst.
 */
export function quotedWithinWindow(
  quotes: readonly { createdAt?: string | null }[],
  expiration: string,
  daysUntil: (d: string) => number | null
): boolean {
  const expDays = daysUntil(expiration);
  if (expDays == null) return false;
  return quotes.some((q) => {
    const d = q.createdAt ? daysUntil(q.createdAt.slice(0, 10)) : null;
    return d != null && d >= expDays - MARKETING_WINDOW_DAYS && d <= expDays;
  });
}

/**
 * Where a renewal's marketing stands, from its MarketingTask rows.
 *
 * Priority is outcome-first: a quote anywhere settles it ("quoted") —
 * whether recorded as a task resolution or found on the account directly
 * (`hasQuote`, see quotedWithinWindow); an open task past its submit-by is
 * a problem no other open task excuses ("missed"); open tasks are work in
 * flight ("open"); tasks that all closed without a quote were deliberate
 * passes ("passed"), which is not the same claim as "none" — nothing was
 * ever raised — even though both render grey.
 */
export type RenewalMarketing =
  | { kind: "quoted" }
  | { kind: "missed"; submitBy: string }
  | { kind: "open"; count: number; submitBy: string | null }
  | { kind: "passed" }
  | { kind: "none" };

export function renewalMarketing(
  tasks: readonly {
    status?: string | null;
    resolution?: string | null;
    submitBy?: string | null;
  }[],
  today: string,
  hasQuote = false
): RenewalMarketing {
  if (hasQuote || tasks.some((t) => t.resolution === "QUOTED")) {
    return { kind: "quoted" };
  }
  const open = tasks.filter((t) => t.status === "OPEN");
  const missed = open
    .filter((t) => t.submitBy && t.submitBy < today)
    .map((t) => t.submitBy as string)
    .sort();
  if (missed.length > 0) return { kind: "missed", submitBy: missed[0] };
  if (open.length > 0) {
    const submitBys = open
      .filter((t) => t.submitBy)
      .map((t) => t.submitBy as string)
      .sort();
    return { kind: "open", count: open.length, submitBy: submitBys[0] ?? null };
  }
  return tasks.length > 0 ? { kind: "passed" } : { kind: "none" };
}

/** Sort rank for the Marketing column — trouble first. */
export function renewalMarketingRank(m: RenewalMarketing): number {
  switch (m.kind) {
    case "missed":
      return 0;
    case "none":
      return 1;
    case "open":
      return 2;
    case "passed":
      return 3;
    case "quoted":
      return 4;
  }
}

// ── Invoice aging ────────────────────────────────────────────────────

export interface AgingBucket {
  total: number;
  count: number;
}

export interface InvoiceAging {
  current: AgingBucket;
  d1to30: AgingBucket;
  d31to60: AgingBucket;
  d60plus: AgingBucket;
  overdueTotal: number;
  overdueCount: number;
  /** Live invoices with no stored amount — in the counts, not the totals. */
  unpriced: number;
}

/**
 * Open invoices bucketed by how far past due they are. Same money rules as
 * `receivables`: SENT + PROCESSING only, the link's amount is the amount,
 * and a row without one is counted and called out rather than priced at $0.
 * No due date files as current — a bill that never stated a deadline has
 * not blown one.
 */
export function invoiceAging(
  invoices: readonly {
    status?: string | null;
    dueAt?: string | null;
    stripeLinkAmountCents?: number | null;
  }[],
  daysUntil: (d: string) => number | null
): InvoiceAging {
  const empty = () => ({ total: 0, count: 0 });
  const aging: InvoiceAging = {
    current: empty(),
    d1to30: empty(),
    d31to60: empty(),
    d60plus: empty(),
    overdueTotal: 0,
    overdueCount: 0,
    unpriced: 0,
  };
  for (const inv of invoices) {
    if (inv.status !== "SENT" && inv.status !== "PROCESSING") continue;
    const days = inv.dueAt ? daysUntil(inv.dueAt) : null;
    const bucket =
      days == null || days >= 0
        ? aging.current
        : days >= -30
          ? aging.d1to30
          : days >= -60
            ? aging.d31to60
            : aging.d60plus;
    bucket.count += 1;
    const amount =
      typeof inv.stripeLinkAmountCents === "number"
        ? inv.stripeLinkAmountCents / 100
        : null;
    if (amount == null) aging.unpriced += 1;
    else bucket.total += amount;
    if (days != null && days < 0) {
      aging.overdueCount += 1;
      aging.overdueTotal += amount ?? 0;
    }
  }
  return aging;
}

// ── Windowed sums ────────────────────────────────────────────────────

/**
 * Sum rows whose date lands in [from, to], both optional. Dates compare as
 * YYYY-MM-DD strings — the same lexicographic rule the task digest uses for
 * `a.date()` fields — so datetimes are cut to their first ten characters.
 */
export function sumInWindow<T>(
  rows: readonly T[],
  dateOf: (t: T) => string | null | undefined,
  valueOf: (t: T) => number,
  from: string,
  to: string
): { total: number; count: number } {
  let total = 0;
  let count = 0;
  for (const r of rows) {
    const d = dateOf(r)?.slice(0, 10);
    if (!d) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    total += valueOf(r);
    count += 1;
  }
  return { total, count };
}

// ── Monthly production ───────────────────────────────────────────────

export interface MonthColumn {
  /** YYYY-MM */
  key: string;
  label: string;
  /** After the current month — rendered as a placeholder, not a zero. */
  future: boolean;
  total: number;
  count: number;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function addMonths(key: string, n: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

/**
 * Written premium by month over the filter window.
 *
 * The columns are the window's own months — never more. The one padding
 * rule: a window that STARTS at a January 1st and ends in the same year
 * (the YTD shape) pads out to that year's full Jan–Dec, so the year so far
 * reads with the rest of the year visibly still to come. A mid-year custom
 * window must NOT pad: the policies were already filtered to the window,
 * so a padded month would render real production as a measured $0. No
 * window at all means the current calendar year; a half-open window runs
 * to (or from) the current month. Capped at 24 columns, keeping the most
 * recent, because a chart of every month since founding answers no
 * question the carrier charts don't.
 */
export function premiumByMonth(
  policies: readonly { effectiveDate?: string | null; premium?: number | null }[],
  from: string,
  to: string,
  today: string
): MonthColumn[] {
  const thisMonth = today.slice(0, 7);
  const ytdShaped = (f: string, endMonth: string) =>
    f.slice(5) === "01-01" && endMonth.slice(0, 4) === f.slice(0, 4);
  let start: string;
  let end: string;
  if (from && to) {
    start = from.slice(0, 7);
    end = to.slice(0, 7);
    if (ytdShaped(from, end)) end = `${start.slice(0, 4)}-12`;
  } else if (from) {
    start = from.slice(0, 7);
    end = thisMonth > start ? thisMonth : start;
    if (ytdShaped(from, end)) end = `${start.slice(0, 4)}-12`;
  } else if (to) {
    end = to.slice(0, 7);
    start = addMonths(end, -11);
  } else {
    start = `${thisMonth.slice(0, 4)}-01`;
    end = `${thisMonth.slice(0, 4)}-12`;
  }
  if (end < start) return [];

  const keys: string[] = [];
  for (let k = start; k <= end; k = addMonths(k, 1)) keys.push(k);
  const trimmed = keys.slice(-24);

  const byMonth = new Map(
    trimmed.map((k) => [k, { total: 0, count: 0 }])
  );
  for (const p of policies) {
    const key = p.effectiveDate?.slice(0, 7);
    if (!key) continue;
    const cell = byMonth.get(key);
    if (!cell) continue;
    cell.total += p.premium ?? 0;
    cell.count += 1;
  }
  return trimmed.map((key) => ({
    key,
    label: MONTH_LABELS[Number(key.slice(5, 7)) - 1] ?? key,
    future: key > thisMonth,
    ...byMonth.get(key)!,
  }));
}

// ── Quote win rate ───────────────────────────────────────────────────

export interface QuoteWinRateResult {
  bound: number;
  decided: number;
  /** bound ÷ decided; null until anything has been decided at all. */
  rate: number | null;
}

/**
 * Only decided quotes vote — BOUND against DECLINED and LOST — so an open
 * pipeline can't dilute the rate, and a brand-new agency reads "—" rather
 * than a fake 0%.
 */
export function quoteWinRate(
  quotes: readonly { status?: string | null }[]
): QuoteWinRateResult {
  let bound = 0;
  let decided = 0;
  for (const q of quotes) {
    if (q.status === "BOUND") {
      bound += 1;
      decided += 1;
    } else if (q.status === "DECLINED" || q.status === "LOST") {
      decided += 1;
    }
  }
  return { bound, decided, rate: decided ? bound / decided : null };
}

// ── PF installment forecast ──────────────────────────────────────────

/**
 * Cash expected off ACTIVE loans in the next `horizonDays`: one installment
 * per loan, at its `nextDueAt`. Overdue installments are excluded — money
 * past its date is the default sweep's story, not a forecast's.
 */
export function pfInstallmentsDue(
  loans: readonly {
    status?: string | null;
    nextDueAt?: string | null;
    payment?: number | null;
  }[],
  daysUntil: (d: string) => number | null,
  horizonDays = 30
): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const l of loans) {
    if (l.status !== "ACTIVE" || !l.nextDueAt) continue;
    const days = daysUntil(l.nextDueAt);
    if (days == null || days < 0 || days > horizonDays) continue;
    count += 1;
    total += l.payment ?? 0;
  }
  return { count, total };
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
