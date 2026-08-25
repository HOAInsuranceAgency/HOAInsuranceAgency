/**
 * The Overview tab's "Needs attention" queue — every signal in the data that
 * means someone should act today, ranked in one list.
 *
 * Each of these already exists somewhere: overdue invoices in the Invoice
 * rows, defaulted loans in PfLoan, missed submission windows in
 * MarketingTask, failed extractions on Document/Account, expiring licenses
 * in License. What none of them had was a shared surface — they reached a
 * human as outbound email (task digest, license ladder) or not at all. This
 * module is selection and ranking only; the words and navigation live in the
 * component, which is also why items carry raw fields rather than composed
 * strings.
 *
 * Pure and clock-free, like the rest of the dashboard's figures: `now` and
 * `daysUntil` are parameters, so every rule below is assertable without a
 * data client or a real calendar.
 */

import { quotedWithinWindow } from "./dashboardStats";

export type AttentionSeverity = "red" | "amber" | "blue";

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  red: 0,
  amber: 1,
  blue: 2,
};

interface BaseItem {
  severity: AttentionSeverity;
  /** Orders items within a severity — smaller first. Each kind computes it
   * from its own urgency measure (days overdue, days to expiry). */
  sortKey: number;
  accountId: string | null;
}

export type AttentionItem =
  | (BaseItem & {
      kind: "invoice-overdue";
      invoiceNumber: string | null;
      accountName: string;
      /** Dollars; null when the live invoice carries no stored amount. */
      amount: number | null;
      dueAt: string;
      overdueDays: number;
    })
  | (BaseItem & {
      kind: "loan-defaulted";
      accountName: string;
      outstanding: number;
      failedInstallment: number | null;
      defaultedAt: string | null;
    })
  | (BaseItem & {
      kind: "renewal-unmarketed";
      accountName: string;
      days: number;
      date: string;
      premium: number | null;
    })
  | (BaseItem & {
      kind: "task-window-missed";
      accountName: string;
      carrierName: string;
      daysPast: number;
    })
  | (BaseItem & {
      kind: "extraction-failed";
      /** Which pipeline failed: a document's Textract OCR, or the
       * account-level AI extraction. Different failures, different words. */
      pipeline: "ocr" | "extraction";
      accountName: string;
      documentName: string | null;
    })
  | (BaseItem & {
      kind: "election-pending";
      accountName: string;
      pendingDays: number | null;
      expiresInDays: number | null;
    })
  | (BaseItem & {
      kind: "license-expiring";
      holder: string;
      state: string;
      days: number;
    });

export interface AttentionInputs {
  accountNames: ReadonlyMap<string, string>;
  /** Every quote, all statuses — the unmarketed rule needs them because the
   * sweep skips task creation for already-quoted carriers (see
   * quotedWithinWindow), so missing tasks alone prove nothing. */
  quotes: readonly { accountId: string; createdAt?: string | null }[];
  invoices: readonly {
    accountId: string;
    number?: string | null;
    status?: string | null;
    dueAt?: string | null;
    stripeLinkAmountCents?: number | null;
  }[];
  loans: readonly {
    accountId: string;
    status?: string | null;
    balance?: number | null;
    amountFinanced?: number | null;
    autopayFailedInstallment?: number | null;
    defaultedAt?: string | null;
    quotedAt?: string | null;
    electionToken?: string | null;
    electionTokenExpiresAt?: string | null;
    electedAt?: string | null;
  }[];
  /** The renewal rows the Renewals tab shows, premium included. */
  renewals: readonly {
    accountId: string;
    name: string;
    date: string;
    days: number;
    premium: number | null;
  }[];
  tasks: readonly {
    accountId: string;
    carrierName?: string | null;
    accountName?: string | null;
    expirationDate?: string | null;
    submitBy?: string | null;
    status?: string | null;
  }[];
  failedDocs: readonly {
    entityType?: string | null;
    entityId: string;
    name?: string | null;
  }[];
  accountsWithFailedExtraction: readonly { id: string; name: string }[];
  licenses: readonly {
    holderType?: string | null;
    holderName?: string | null;
    state?: string | null;
    status?: string | null;
    expirationDate?: string | null;
  }[];
}

const DAY_MS = 86_400_000;

/** How close a renewal can get before "nobody has started" is a problem —
 * and how far past its date it stays in the queue before it is archaeology
 * rather than work (policies never auto-expire, so an unbounded past would
 * flood the list with ancient rows). */
const UNMARKETED_HORIZON_DAYS = 30;
/** The license ladder's outer rung — matches LICENSE_EXPIRY_SCALE's amber. */
const LICENSE_HORIZON_DAYS = 60;

export function buildAttentionQueue(
  inputs: AttentionInputs,
  daysUntil: (d: string) => number | null,
  now: Date
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const name = (id: string) =>
    inputs.accountNames.get(id) ?? "Unknown account";

  // Overdue invoices: billed, unpaid, and past the date on the bill.
  for (const inv of inputs.invoices) {
    if (inv.status !== "SENT" && inv.status !== "PROCESSING") continue;
    if (!inv.dueAt) continue;
    const days = daysUntil(inv.dueAt);
    if (days == null || days >= 0) continue;
    const overdueDays = -days;
    items.push({
      kind: "invoice-overdue",
      severity: "red",
      sortKey: -overdueDays,
      accountId: inv.accountId,
      invoiceNumber: inv.number ?? null,
      accountName: name(inv.accountId),
      amount:
        typeof inv.stripeLinkAmountCents === "number"
          ? inv.stripeLinkAmountCents / 100
          : null,
      dueAt: inv.dueAt,
      overdueDays,
    });
  }

  for (const loan of inputs.loans) {
    // Defaulted loans: an installment went unposted and autopay stood down.
    if (loan.status === "DEFAULTED") {
      const since = loan.defaultedAt
        ? Math.floor((now.getTime() - Date.parse(loan.defaultedAt)) / DAY_MS)
        : 0;
      items.push({
        kind: "loan-defaulted",
        severity: "red",
        sortKey: -since,
        accountId: loan.accountId,
        accountName: name(loan.accountId),
        outstanding: loan.balance ?? loan.amountFinanced ?? 0,
        failedInstallment: loan.autopayFailedInstallment ?? null,
        defaultedAt: loan.defaultedAt ?? null,
      });
    }
    // Pending elections: an offer is out and nobody has taken it.
    if (
      loan.status === "QUOTED" &&
      loan.electionToken &&
      !loan.electedAt &&
      (!loan.electionTokenExpiresAt ||
        Date.parse(loan.electionTokenExpiresAt) > now.getTime())
    ) {
      const pendingDays = loan.quotedAt
        ? Math.floor((now.getTime() - Date.parse(loan.quotedAt)) / DAY_MS)
        : null;
      const expiresInDays = loan.electionTokenExpiresAt
        ? Math.ceil(
            (Date.parse(loan.electionTokenExpiresAt) - now.getTime()) / DAY_MS
          )
        : null;
      items.push({
        kind: "election-pending",
        severity: "blue",
        sortKey: -(pendingDays ?? 0),
        accountId: loan.accountId,
        accountName: name(loan.accountId),
        pendingDays,
        expiresInDays,
      });
    }
  }

  // Renewals inside the horizon with no marketing started. "Started" is
  // tasks OR quotes: the sweep never creates a task for a carrier already
  // quoted, so a missing task row alone proves nothing. Silence on both
  // means no appointed carrier matched or the sweep hasn't caught up —
  // either way a human should look, and one already past its date is red:
  // the client is (as far as this system knows) uninsured.
  const taskKeys = new Set(
    inputs.tasks.map((t) => `${t.accountId}:${t.expirationDate ?? ""}`)
  );
  const quotesByAccount = new Map<string, { createdAt?: string | null }[]>();
  for (const q of inputs.quotes) {
    const list = quotesByAccount.get(q.accountId);
    if (list) list.push(q);
    else quotesByAccount.set(q.accountId, [q]);
  }
  for (const r of inputs.renewals) {
    if (r.days < -UNMARKETED_HORIZON_DAYS || r.days > UNMARKETED_HORIZON_DAYS)
      continue;
    if (taskKeys.has(`${r.accountId}:${r.date}`)) continue;
    if (
      quotedWithinWindow(quotesByAccount.get(r.accountId) ?? [], r.date, daysUntil)
    )
      continue;
    items.push({
      kind: "renewal-unmarketed",
      severity: r.days < 0 ? "red" : "amber",
      sortKey: r.days,
      accountId: r.accountId,
      accountName: r.name,
      days: r.days,
      date: r.date,
      premium: r.premium,
    });
  }

  // Open marketing tasks whose submission window has already closed.
  for (const t of inputs.tasks) {
    if (t.status !== "OPEN" || !t.submitBy) continue;
    const days = daysUntil(t.submitBy);
    if (days == null || days >= 0) continue;
    items.push({
      kind: "task-window-missed",
      severity: "amber",
      sortKey: days,
      accountId: t.accountId,
      accountName: t.accountName ?? name(t.accountId),
      carrierName: t.carrierName ?? "Unknown carrier",
      daysPast: -days,
    });
  }

  // Failed pipelines, one item per account per pipeline: a document whose
  // Textract OCR failed is not the same failure as an account whose AI
  // extraction failed, and one must not hide the other — but ten failed
  // pages on one account are one problem, so docs dedupe per account.
  const ocrSeen = new Set<string>();
  for (const d of inputs.failedDocs) {
    if (d.entityType !== "ACCOUNT" || ocrSeen.has(d.entityId)) continue;
    ocrSeen.add(d.entityId);
    items.push({
      kind: "extraction-failed",
      pipeline: "ocr",
      severity: "amber",
      sortKey: 0,
      accountId: d.entityId,
      accountName: name(d.entityId),
      documentName: d.name ?? null,
    });
  }
  for (const a of inputs.accountsWithFailedExtraction) {
    items.push({
      kind: "extraction-failed",
      pipeline: "extraction",
      severity: "amber",
      sortKey: 0,
      accountId: a.id,
      accountName: a.name,
      documentName: null,
    });
  }

  // Licenses approaching (or past) expiration. Only ones that are supposed
  // to be alive: a LAPSED or INACTIVE row is a record, not a deadline.
  for (const l of inputs.licenses) {
    if (!l.expirationDate) continue;
    if (l.status && l.status !== "ACTIVE" && l.status !== "PENDING") continue;
    const days = daysUntil(l.expirationDate);
    if (days == null || days > LICENSE_HORIZON_DAYS) continue;
    items.push({
      kind: "license-expiring",
      severity: days < 0 ? "red" : days <= 30 ? "amber" : "blue",
      sortKey: days,
      accountId: null,
      holder:
        l.holderType === "FIRM" ? "Firm" : l.holderName || "Producer",
      state: l.state ?? "—",
      days,
    });
  }

  return items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.sortKey - b.sortKey
  );
}
