/** Shared calculations used by the dashboard's salesperson charts and A/R aging. */

// Type-only imports keep these helpers independent of the data client and pin
// quote status rankings to the schema's complete status set.
import type {
  ClosedQuoteStatus,
  OpenQuoteStatus,
  QuoteStatus,
} from "./quoteStatus";

/** The one commission formula, null-safe: no pct or no premium is $0. */
export function policyCommission(p: {
  premium?: number | null;
  commissionPct?: number | null;
}): number {
  return p.premium != null && p.commissionPct != null
    ? (p.premium * p.commissionPct) / 100
    : 0;
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
 * Open invoices bucketed by how far past due they are: SENT + PROCESSING only,
 * using the stored payment-link amount,
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
