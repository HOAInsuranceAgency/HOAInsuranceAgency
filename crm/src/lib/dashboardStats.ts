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
