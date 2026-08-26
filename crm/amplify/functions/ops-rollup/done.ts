/**
 * What actually happened in the window, and who moved it.
 *
 * Pure. `handler.ts` does the reading; everything here is arithmetic over rows
 * that have already arrived.
 *
 * ── What "who" can and cannot mean in this schema ──
 *
 * No model in this CRM carries an owning-producer id. The schema says so in
 * its own comments, twice, and explains that this is why owner-scoped auth was
 * never built. So there is no book of business, there are no assigned leads,
 * and there is no such thing as "Sarah's renewals" to report on.
 *
 * What exists is per-EVENT attribution: `Activity.actor` holds the Cognito sub
 * of whoever made a change, stamped by the actor proxy in `src/lib/client.ts`.
 * That is a last-writer stamp on a change, not ownership of a record, and the
 * difference is the whole reason this module counts effort and never outcomes.
 *
 * Three consequences worth stating because they shape every function below:
 *
 * 1. **Group on `actor`, never on `actorName`.** The name is denormalised at
 *    write time and never backfilled, so a row written while the UserProfile
 *    lookup was failing says "Unknown user" forever. Grouping on the name
 *    silently merges every such failure into one phantom teammate.
 * 2. **Deletes are unattributed.** The proxy wraps only create and update — a
 *    delete takes `{ id }` and has nowhere to put an actor — so every deletion
 *    in the system is "system". Nothing here counts them.
 * 3. **Whole areas of work leave no Activity at all.** Only 15 models are
 *    streamed. Closing a marketing task, posting a loan payment, editing
 *    invoice lines and all licensing work produce no rows, which is why the
 *    counts below are read from those models' own timestamps instead.
 */

import { inWindow, businessDaysBetween, dayOf, type Edition } from "./window";

/**
 * Writers that are not people.
 *
 * A superset of `ROBOT_NAMES` in `activity-log/handler.ts`, which knows only
 * three of these — so `process-document`, `upload-portal`, `lead-upload`,
 * `pf-agreement`, `send-invoice`, `void-invoice` and `stripe-payment`
 * currently resolve to "Unknown user" in the CRM's own Activity tab. That is a
 * real defect in that screen, and it is worth fixing there; until it is, this
 * set is what stops seven Lambdas being counted as a mysterious teammate here.
 *
 * `opsRollupDone.test.ts` asserts this stays a superset of that map, so the
 * two cannot drift apart unnoticed.
 */
export const ROBOT_ACTORS: ReadonlySet<string> = new Set([
  "system",
  "lead-intake",
  "extract-lead",
  "backfill",
  "process-document",
  "upload-portal",
  "lead-upload",
  "pf-agreement",
  "send-invoice",
  "void-invoice",
  "stripe-payment",
]);

/** What `MarketingTask.completedBy` holds when the sweep closed it itself. */
const AUTO_CLOSER = "system (quote created)";

export interface ActivityLike {
  entityId?: string | null;
  subjectType?: string | null;
  action?: string | null;
  actor?: string | null;
  occurredAt?: string | null;
  changes?: unknown;
}

export interface ProfileLike {
  userId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface DoneInputs {
  activity: readonly ActivityLike[];
  profiles: readonly ProfileLike[];
  policies: readonly {
    accountId: string;
    premium?: number | null;
    commissionPct?: number | null;
    datePolicyBound?: string | null;
    carrierId?: string | null;
  }[];
  accounts: readonly { id: string; name: string; convertedAt?: string | null }[];
  certificates: readonly { issuedAt?: string | null }[];
  invoices: readonly {
    sentAt?: string | null;
    paidAt?: string | null;
    stripeLinkAmountCents?: number | null;
    remittanceCommissionCents?: number | null;
  }[];
  tasks: readonly {
    status?: string | null;
    completedAt?: string | null;
    completedBy?: string | null;
    resolution?: string | null;
  }[];
  loanPayments: readonly {
    postedAt?: string | null;
    amount?: number | null;
    interest?: number | null;
  }[];
  loans: readonly { downPaidAt?: string | null; downPayment?: number | null }[];
  carriers: readonly { id: string; name?: string | null }[];
  premiumFinanceEnabled: boolean;
}

/** One association that became a client, or one policy that bound. */
export interface BoundPolicy {
  account: string;
  premium: number | null;
  carrier: string | null;
}

export interface DoneSummary {
  bound: BoundPolicy[];
  boundPremium: number;
  /** Bound policies with premium but no commission % — a silent undercount. */
  boundWithoutCommission: number;
  commission: number;
  newClients: string[];
  certificates: number;
  quotesAdvanced: number;
  invoicesSent: number;
  invoicesSentTotal: number | null;
  invoicesSentUnpriced: number;
  invoicesPaid: number;
  invoicesPaidTotal: number | null;
  tasksClosed: number;
  tasksQuoted: number;
  downPayments: number;
  downPaymentTotal: number;
  installments: number;
  installmentTotal: number;
  installmentInterest: number;
  /** True when literally nothing was recorded — itself a finding. */
  empty: boolean;
}

export interface PersonRow {
  actor: string;
  name: string;
  role: string | null;
  accountsTouched: number;
  quotesAdvanced: number;
  policiesBound: number;
  tasksClosed: number;
  /** Distinct accounts touched over the trailing window. */
  trailingAccounts: number;
}

export interface QuietProducer {
  name: string;
  /** Business days since their last write, within the scan. */
  businessDays: number;
  /** True when they have no writes anywhere in the scanned period. */
  beyondScan: boolean;
}

export interface DoneResult {
  summary: DoneSummary;
  people: PersonRow[];
  /** Automated changes in-window, collapsed to one figure. */
  automatedChanges: number;
  /** Task closers whose display name matched no profile. Never guessed. */
  unmatchedClosers: number;
  quiet: QuietProducer[];
}

const displayName = (p: ProfileLike): string =>
  [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || p.email || "Unknown user";

const surname = (p: ProfileLike): string =>
  (p.lastName || p.firstName || p.email || "").toLowerCase();

const cents = (v: number | null | undefined): number | null =>
  typeof v === "number" ? v / 100 : null;

/**
 * `Activity.changes` as an array, whatever shape it arrived in.
 *
 * The column is `a.json()`, which AppSync serialises as `AWSJSON` — a JSON
 * *string* — but a client that has already parsed it hands back an array.
 * Accepting both is cheaper than depending on which.
 */
function changedFields(changes: unknown): string[] {
  let value = changes;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((c) => (c && typeof c === "object" ? String((c as { field?: unknown }).field ?? "") : ""))
    .filter(Boolean);
}

/**
 * Everything the DONE and WHO blocks need, for one edition.
 *
 * `trailingStartMs` opens the wider window the per-person trailing figure is
 * measured over. It exists because a single day is a misleading unit on a
 * 30-to-90-day association sales cycle: a producer with a quiet Tuesday and a
 * heavy fortnight should not read the same as one who has stopped.
 */
export function buildDone(
  input: DoneInputs,
  edition: Edition,
  trailingStartMs: number
): DoneResult {
  const { todayDay } = edition;

  const accountName = new Map(input.accounts.map((a) => [a.id, a.name]));
  const carrierName = new Map(input.carriers.map((c) => [c.id, c.name ?? null]));

  // ── What happened, regardless of who ─────────────────────────────

  const bound: BoundPolicy[] = [];
  let boundPremium = 0;
  let boundWithoutCommission = 0;
  let commission = 0;
  for (const p of input.policies) {
    if (!inWindow(p.datePolicyBound, edition)) continue;
    bound.push({
      account: accountName.get(p.accountId) ?? "Unknown account",
      premium: p.premium ?? null,
      carrier: p.carrierId ? carrierName.get(p.carrierId) ?? null : null,
    });
    if (typeof p.premium === "number") {
      boundPremium += p.premium;
      if (typeof p.commissionPct === "number") {
        commission += p.premium * (p.commissionPct / 100);
      } else if (p.premium > 0) {
        // Counted rather than quietly treated as zero: commission is baked
        // into premium and a missing percentage makes the total an undercount,
        // not a fact.
        boundWithoutCommission += 1;
      }
    }
  }

  const newClients = input.accounts
    .filter((a) => inWindow(a.convertedAt, edition))
    .map((a) => a.name);

  const certificates = input.certificates.filter((c) =>
    inWindow(c.issuedAt, edition)
  ).length;

  let invoicesSent = 0;
  let invoicesSentTotal = 0;
  let invoicesSentUnpriced = 0;
  let invoicesPaid = 0;
  let invoicesPaidTotal = 0;
  for (const inv of input.invoices) {
    if (inWindow(inv.sentAt, edition)) {
      invoicesSent += 1;
      const amount = cents(inv.stripeLinkAmountCents);
      // Never valued at $0 — the house rule `dashboardStats` already follows.
      // A bill with no stored amount makes the total a floor, and the email
      // says so rather than printing a number that looks complete.
      if (amount == null) invoicesSentUnpriced += 1;
      else invoicesSentTotal += amount;
    }
    // `paidAt` is `a.date()`, not a datetime — day granularity is all there
    // is, so this compares day strings rather than instants.
    const paidDay = dayOf(inv.paidAt);
    if (
      paidDay &&
      edition.windowStartDay &&
      paidDay >= edition.windowStartDay &&
      paidDay < todayDay
    ) {
      invoicesPaid += 1;
      invoicesPaidTotal += cents(inv.stripeLinkAmountCents) ?? 0;
    }
  }

  const closed = input.tasks.filter((t) => inWindow(t.completedAt, edition));
  const tasksQuoted = closed.filter((t) => t.resolution === "QUOTED").length;

  let downPayments = 0;
  let downPaymentTotal = 0;
  let installments = 0;
  let installmentTotal = 0;
  let installmentInterest = 0;
  if (input.premiumFinanceEnabled) {
    for (const l of input.loans) {
      if (!inWindow(l.downPaidAt, edition)) continue;
      downPayments += 1;
      downPaymentTotal += l.downPayment ?? 0;
    }
    for (const p of input.loanPayments) {
      if (!inWindow(p.postedAt, edition)) continue;
      installments += 1;
      installmentTotal += p.amount ?? 0;
      installmentInterest += p.interest ?? 0;
    }
  }

  // ── Who moved things ─────────────────────────────────────────────

  const profileByUserId = new Map(input.profiles.map((p) => [p.userId, p]));

  interface Tally {
    accounts: Set<string>;
    quotes: number;
    bound: number;
    trailing: Set<string>;
    lastWriteMs: number;
  }
  const tallies = new Map<string, Tally>();
  const tally = (actor: string): Tally => {
    let t = tallies.get(actor);
    if (!t) {
      t = { accounts: new Set(), quotes: 0, bound: 0, trailing: new Set(), lastWriteMs: 0 };
      tallies.set(actor, t);
    }
    return t;
  };

  let automatedChanges = 0;
  let quotesAdvanced = 0;

  for (const row of input.activity) {
    const actor = row.actor ?? "system";
    const at = row.occurredAt ? Date.parse(row.occurredAt) : NaN;
    if (!Number.isFinite(at)) continue;
    const isRobot = ROBOT_ACTORS.has(actor);
    const inEdition = at >= edition.windowStartMs && at < edition.windowEndMs;

    if (isRobot) {
      if (inEdition) automatedChanges += 1;
      continue;
    }

    const t = tally(actor);
    if (at > t.lastWriteMs) t.lastWriteMs = at;
    if (at >= trailingStartMs && row.entityId) t.trailing.add(row.entityId);
    if (!inEdition) continue;

    if (row.entityId) t.accounts.add(row.entityId);
    // A status change is the only Quote edit that means the deal moved; the
    // rest is data entry on a quote that was already where it was.
    if (row.subjectType === "Quote" && changedFields(row.changes).includes("status")) {
      t.quotes += 1;
      quotesAdvanced += 1;
    }
    if (row.subjectType === "Policy" && row.action === "CREATE") t.bound += 1;
  }

  // Tasks closed join on a display name, not an id: `MarketingTask.completedBy`
  // is written as "First Last" from the browser. Matched exactly and
  // case-insensitively — never fuzzy, never on a first name — because the cost
  // of a wrong match is crediting one person's work to another. A name that
  // matches nobody is counted and shown, never quietly attached to the closest
  // profile.
  const byDisplayName = new Map<string, ProfileLike>();
  for (const p of input.profiles) {
    byDisplayName.set(displayName(p).toLowerCase(), p);
  }
  const tasksClosedBy = new Map<string, number>();
  let unmatchedClosers = 0;
  for (const t of closed) {
    const who = (t.completedBy ?? "").trim();
    if (!who || who === AUTO_CLOSER) continue;
    const profile = byDisplayName.get(who.toLowerCase());
    if (!profile) {
      unmatchedClosers += 1;
      continue;
    }
    tasksClosedBy.set(profile.userId, (tasksClosedBy.get(profile.userId) ?? 0) + 1);
    tally(profile.userId);
  }

  const people: PersonRow[] = [];
  for (const [actor, t] of tallies) {
    const tasksClosed = tasksClosedBy.get(actor) ?? 0;
    const touched = t.accounts.size;
    // Presence only, never absence: a zero row beside a name reads as an
    // accusation, and it is usually a day on the phone or a day off — neither
    // of which this system can see.
    if (touched === 0 && t.quotes === 0 && t.bound === 0 && tasksClosed === 0) continue;
    const profile = profileByUserId.get(actor);
    people.push({
      actor,
      name: profile ? displayName(profile) : "Unknown user",
      role: profile?.role ?? null,
      accountsTouched: touched,
      quotesAdvanced: t.quotes,
      policiesBound: t.bound,
      tasksClosed,
      trailingAccounts: t.trailing.size,
    });
  }
  // Alphabetical by surname, never by volume. Sort order is what turns a list
  // into a leaderboard, and `Activity.actor` is a per-change stamp: a producer
  // who tidies a colleague's account inherits the credit for it.
  people.sort((a, b) => {
    const pa = profileByUserId.get(a.actor);
    const pb = profileByUserId.get(b.actor);
    return (pa ? surname(pa) : a.name.toLowerCase()).localeCompare(
      pb ? surname(pb) : b.name.toLowerCase()
    );
  });

  // Producers with no writes at all in the scanned period. Monday only, and
  // rendered as a question — see render.ts. Five business days, because
  // association work routinely takes someone out of the CRM for days at a
  // time: a property inspection, an annual meeting, a carrier day.
  const quiet: QuietProducer[] = [];
  for (const p of input.profiles) {
    if (p.role !== "PRODUCER" && p.role !== "ADMIN") continue;
    const t = tallies.get(p.userId);
    const lastDay = t?.lastWriteMs
      ? new Date(t.lastWriteMs).toISOString().slice(0, 10)
      : null;
    const businessDays = lastDay
      ? businessDaysBetween(lastDay, todayDay)
      : businessDaysBetween(
          new Date(trailingStartMs).toISOString().slice(0, 10),
          todayDay
        );
    if (businessDays < 5) continue;
    quiet.push({ name: displayName(p), businessDays, beyondScan: !lastDay });
  }
  quiet.sort((a, b) => b.businessDays - a.businessDays);

  const summary: DoneSummary = {
    bound,
    boundPremium,
    boundWithoutCommission,
    commission,
    newClients,
    certificates,
    quotesAdvanced,
    invoicesSent,
    invoicesSentTotal: invoicesSent > 0 ? invoicesSentTotal : null,
    invoicesSentUnpriced,
    invoicesPaid,
    invoicesPaidTotal: invoicesPaid > 0 ? invoicesPaidTotal : null,
    tasksClosed: closed.length,
    tasksQuoted,
    downPayments,
    downPaymentTotal,
    installments,
    installmentTotal,
    installmentInterest,
    empty: false,
  };
  summary.empty =
    bound.length === 0 &&
    newClients.length === 0 &&
    certificates === 0 &&
    quotesAdvanced === 0 &&
    invoicesSent === 0 &&
    invoicesPaid === 0 &&
    closed.length === 0 &&
    downPayments === 0 &&
    installments === 0;

  return { summary, people, automatedChanges, unmatchedClosers, quiet };
}
