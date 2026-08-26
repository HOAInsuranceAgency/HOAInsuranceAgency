/**
 * What should have been addressed and wasn't — the half of the rollup nothing
 * else in the system reports.
 *
 * Pure and clock-free, like `attention.ts`: the edition and every derived day
 * arrive as parameters, so each rule below is assertable without a data client
 * or a real calendar.
 *
 * ── How this differs from the dashboard's "Needs attention" queue ──
 *
 * `src/lib/attention.ts` answers a related question and answers it correctly
 * for a screen. A screen is a pull surface: it is read when someone chooses to
 * look, so listing every overdue invoice from day one and every blown carrier
 * task individually costs nothing. This is a push surface arriving every
 * morning, where the same completeness is what teaches a reader to archive it
 * unread.
 *
 * So the thresholds here are later, the rollups are coarser, and the ladder in
 * `visibility()` demotes an ageing finding to a counter. What is deliberately
 * NOT re-implemented is the underlying arithmetic: `buildRenewalRows`,
 * `quotedWithinWindow`, `renewalMarketing` and `leadQuoteStanding` are imported
 * from `dashboardStats.ts`, so the email and the screen cannot come to
 * different conclusions about what a renewal or a lead actually is. Where the
 * two surfaces disagree it is only ever about *whether it is worth saying this
 * morning*, never about the facts.
 *
 * ── Every threshold here is policy, not fact ──
 *
 * Nothing in the schema justifies any number below. They are judgements about
 * a commercial habitational book — long sales cycles, manual carrier
 * submissions, volunteer boards that meet monthly — and they are wrong for a
 * personal-lines call centre. Each is a named constant with a test pinning it
 * so tuning one is a deliberate edit rather than a number changed in passing.
 */

import {
  buildRenewalRows,
  leadQuoteStanding,
  quotedWithinWindow,
  renewalMarketing,
} from "../../../src/lib/dashboardStats";
import { propertyNameProblem } from "../../../../shared/propertyName";
import {
  businessDaysSince,
  dayOf,
  daysBetweenDays,
  daysUntilFrom,
  type Edition,
} from "./window";

// ── Thresholds ───────────────────────────────────────────────────────

/**
 * How far past an expiration a coverage gap is still live work.
 *
 * Borrowed verbatim from `attention.ts`'s `UNMARKETED_HORIZON_DAYS`, and for
 * its reason: policies never auto-expire in this schema, so an unbounded past
 * fills the list with archaeology. Older than this is a data-hygiene job.
 */
const COVERAGE_GAP_HORIZON_DAYS = 30;

/**
 * When a renewal with nothing started becomes worth naming.
 *
 * This is the sweep's own opinion. `renewal-tasks` raises a task at
 * `expiration − (carrier lead time + 14-day head start)`, which is 44 days on
 * the default 30-day lead time — so by 45 days out, work should have begun.
 */
const RENEWAL_HORIZON_DAYS = 45;

/**
 * The rung where an unstarted renewal turns red.
 *
 * `MARKETING_SUBMIT_SCALE.soon` in `badges.tsx`, restated rather than imported
 * because pulling a `.tsx` module into a Lambda bundle drags React in behind
 * it — the same trade `task-digest/digest.ts` makes for `URGENT_DAYS`, and
 * `opsRollupDetect.test.ts` asserts the two stay equal.
 */
const SOON_DAYS = 21;

/**
 * Working days between binding an agency-bill policy and billing it.
 *
 * A full week of paperwork grace. Agency-bill premium sits in the trust and is
 * remitted to the carrier on a monthly statement whether or not the
 * association has paid, so every day between bind and bill is the agency
 * floating a carrier's money.
 */
const BOUND_NOT_BILLED_DAYS = 5;

/**
 * Days past due before an invoice is worth a line, and before it is red.
 *
 * Net-14 is the house term (`DEFAULT_TERM_DAYS`), so a bill two days late is
 * ordinary and reporting it is the fastest way to train someone to stop
 * opening this email. Ten days is the first point at which nobody has chased
 * it. Thirty means a board cycle was missed — an association is a committee
 * and boards meet monthly — so it is a phone call, not a reminder.
 */
const INVOICE_LATE_DAYS = 10;
const INVOICE_RED_DAYS = 30;

/** Below this, an overdue bill is counted rather than named. */
const INVOICE_NAME_THRESHOLD = 2500;

/**
 * How long an ACH payment may sit in PROCESSING before it counts as late.
 *
 * `PROCESSING` exists in the schema only because ACH authorises at checkout
 * and settles days later. Chasing money already in flight is the exact false
 * positive that would cost this section its credibility.
 */
const ACH_SETTLING_DAYS = 7;

/** A pending debit past this is stuck: `pf-default-sweep`'s own constant. */
const STALE_PENDING_DAYS = 10;

/** How long a cured default keeps haunting the list. Loans bounce back. */
const DEFAULT_LOOKBACK_DAYS = 45;

/**
 * Business days of silence on a quote before it is worth asking about.
 *
 * Two numbers because the ball is in two different courts. SUBMITTED means a
 * human underwriter is hand-rating a habitational risk from an ACORD packet —
 * there is no rating API in this agency by design — and one to two weeks is
 * normal. QUOTED or PRESENTED means we hold a number and the delay is ours or
 * the board's, and seven business days is roughly the gap between meetings.
 */
const QUOTE_SUBMITTED_DAYS = 10;
const QUOTE_HELD_DAYS = 7;

/** Days a finance offer may sit with a board before it is worth chasing. */
const ELECTION_STALE_DAYS = 21;

/**
 * Business days before an untouched lead is a service failure.
 *
 * Three, not three hours. This is commercial lines: a first conversation with
 * a board president is a scheduled call, and this CRM has no phone log, so a
 * shorter threshold flags exactly the producers who are working the account by
 * phone rather than typing into a screen.
 */
const LEAD_UNTOUCHED_DAYS = 3;

/** Past this a lead is dead, not a same-week miss. */
const LEAD_UNTOUCHED_CAP_DAYS = 21;

/** A quote whose effective date passed this long ago is backlog, not news. */
const PASSED_EFFECTIVE_CAP_DAYS = 30;

/** Minutes past its due window before a lead's auto-reply is broken. */
const REPLY_OVERDUE_MINUTES = 60;
/** Minutes stuck mid-send before it is broken. Six times the fn's timeout. */
const REPLY_SENDING_MINUTES = 30;

// ── The finding ──────────────────────────────────────────────────────

export type FindingKind =
  | "coverage-gap-unmarketed"
  | "submission-window-blown"
  | "finance-cancellation-clock"
  | "loan-stuck"
  | "web-lead-heard-nothing"
  | "bound-not-billed"
  | "invoice-past-due"
  | "effective-date-passed"
  | "renewal-not-started"
  | "quote-stalled"
  | "finance-election-stalled"
  | "new-lead-untouched"
  | "producer-licence-lapsed";

/** Which block of the email a finding belongs in. */
export type Band = "exposed" | "closing" | "money";

export type Visibility = "row" | "standing" | "hidden";

export interface Finding {
  kind: FindingKind;
  band: Band;
  severity: "red" | "amber";
  /** Null for findings that are not about an association (a licence). */
  accountId: string | null;
  /** What the row names — an association, or a person for a licence. */
  subject: string;
  /** The one fact, already composed: "expired 4d ago, no marketing". */
  clause: string;
  /** How long this has been true. Orders rows and drives the ladder. */
  ageDays: number;
  /** Dollars at risk, or null when genuinely unknown — never 0. */
  amount: number | null;
  /** CRM path, no origin. Null when there is nowhere useful to land. */
  href: string | null;
  visibility: Visibility;
}

/**
 * What the standing line calls each kind when a row demotes to a counter.
 *
 * Both numbers, because "1 stalled quotes" in the one line the owner reads
 * every morning is the kind of thing that makes a report look automated in the
 * bad sense.
 */
export const STANDING_LABELS: Record<FindingKind, readonly [string, string]> = {
  "coverage-gap-unmarketed": ["coverage gap", "coverage gaps"],
  "submission-window-blown": ["blown submission window", "blown submission windows"],
  "finance-cancellation-clock": ["cancellation clock", "cancellation clocks"],
  "loan-stuck": ["stuck loan", "stuck loans"],
  "web-lead-heard-nothing": ["web lead with no reply", "web leads with no reply"],
  "bound-not-billed": ["policy bound and unbilled", "policies bound and unbilled"],
  "invoice-past-due": ["overdue invoice", "overdue invoices"],
  "effective-date-passed": [
    "quote past its effective date",
    "quotes past their effective date",
  ],
  "renewal-not-started": ["renewal not started", "renewals not started"],
  "quote-stalled": ["stalled quote", "stalled quotes"],
  "finance-election-stalled": ["finance offer unanswered", "finance offers unanswered"],
  "new-lead-untouched": ["untouched lead", "untouched leads"],
  "producer-licence-lapsed": ["lapsed licence", "lapsed licences"],
};

/**
 * Whether a finding gets its own row today, a place in the standing counter,
 * or nothing at all — decided from its own age and the edition alone.
 *
 * This is the whole de-escalation mechanism, and it is stateless because it
 * has to be. Remembering what was already reported would mean a table, and a
 * new model is exactly the artifact that would publish this feature to every
 * signed-in user (see `resource.ts`). So "have I mentioned this before?" is
 * answered by "how old is it?", which needs no memory.
 *
 * ── The three-day grace band ──
 *
 * A finding gets a full row on the day it crosses its rung and for two days
 * after, rather than on that day exactly. With no ledger, an exact-day rung is
 * lost forever if one morning's send fails — and no scheduled function in this
 * codebase has a delivery alarm, so nobody would know. Three days costs a
 * couple of lines and makes a missed morning survivable.
 *
 * `persistent` kinds never demote. They are the ones where the outcome is a
 * coverage lapse or a lost client, and a coverage gap quietly becoming a
 * number in a summary line is the failure mode this whole email exists to
 * prevent.
 */
export function visibility(
  ageDays: number,
  rung: number,
  persistent: boolean,
  isMonday: boolean
): Visibility {
  if (ageDays < rung) return "hidden";
  if (persistent) return "row";
  if (ageDays <= rung + 2) return "row";
  return isMonday ? "row" : "standing";
}

// ── Inputs ───────────────────────────────────────────────────────────

/** Structural, so a `Schema` row satisfies it without casting. */
export interface DetectInputs {
  leads: readonly {
    id: string;
    name: string;
    createdAt?: string | null;
    currentPolicyExpiration?: string | null;
    extractionStatus?: string | null;
  }[];
  clients: readonly { id: string; name: string; extractionStatus?: string | null }[];
  policies: readonly {
    id: string;
    accountId: string;
    status?: string | null;
    expirationDate?: string | null;
    premium?: number | null;
    carrierId?: string | null;
    lines?: (string | null)[] | null;
    policyNumber?: string | null;
    billType?: string | null;
    datePolicyBound?: string | null;
    quoteId?: string | null;
  }[];
  quotes: readonly {
    id: string;
    accountId: string;
    status?: string | null;
    premium?: number | null;
    effectiveDate?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  }[];
  invoices: readonly {
    id: string;
    accountId: string;
    number?: string | null;
    status?: string | null;
    dueAt?: string | null;
    policyId?: string | null;
    quoteId?: string | null;
    stripeLinkAmountCents?: number | null;
    stripeEventAt?: string | null;
  }[];
  tasks: readonly {
    accountId: string;
    accountName?: string | null;
    carrierName?: string | null;
    status?: string | null;
    submitBy?: string | null;
    resolution?: string | null;
    expirationDate?: string | null;
  }[];
  loans: readonly {
    id: string;
    accountId: string;
    status?: string | null;
    balance?: number | null;
    amountFinanced?: number | null;
    quotedAt?: string | null;
    electionToken?: string | null;
    electedAt?: string | null;
    electionTokenExpiresAt?: string | null;
    downPaymentIntentId?: string | null;
    defaultedAt?: string | null;
    autopayFailedInstallment?: number | null;
    autopayPendingIntentId?: string | null;
    autopayAttemptedAt?: string | null;
  }[];
  notices: readonly {
    loanId: string;
    type?: string | null;
    occurredAt?: string | null;
    clockExpiresAt?: string | null;
  }[];
  leadReplies: readonly {
    accountId: string;
    status?: string | null;
    submittedAt?: string | null;
    dueAt?: string | null;
  }[];
  licenses: readonly {
    holderType?: string | null;
    holderName?: string | null;
    state?: string | null;
    status?: string | null;
    expirationDate?: string | null;
  }[];
  /** False suppresses every premium-finance rule. The module ships dark. */
  premiumFinanceEnabled: boolean;
}

const dollars = (cents: number | null | undefined): number | null =>
  typeof cents === "number" ? cents / 100 : null;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** An open quote is one that could still become a policy. */
const OPEN_QUOTE_STATUSES = new Set(["DRAFT", "SUBMITTED", "QUOTED", "PRESENTED"]);

/**
 * Every finding for one morning, unordered.
 *
 * Ordering and capping belong to `render.ts`, because they are presentation
 * decisions — how many rows fit before the reader stops — and this module's
 * job is only to decide what is true.
 */
export function buildFindings(input: DetectInputs, edition: Edition): Finding[] {
  const { todayDay, isMonday } = edition;
  const daysUntil = daysUntilFrom(todayDay);
  const now = Date.parse(`${todayDay}T00:00:00Z`);
  const out: Finding[] = [];

  const accountName = new Map<string, string>();
  for (const a of [...input.leads, ...input.clients]) accountName.set(a.id, a.name);
  const nameOf = (id: string) => accountName.get(id) ?? "Unknown account";

  const quotesByAccount = new Map<string, DetectInputs["quotes"][number][]>();
  for (const q of input.quotes) {
    const list = quotesByAccount.get(q.accountId);
    if (list) list.push(q);
    else quotesByAccount.set(q.accountId, [q]);
  }

  const push = (
    f: Omit<Finding, "visibility">,
    rung: number,
    persistent: boolean
  ) => {
    const vis = visibility(f.ageDays, rung, persistent, isMonday);
    if (vis !== "hidden") out.push({ ...f, visibility: vis });
  };

  // ── Renewals: the coverage half ────────────────────────────────────
  //
  // One pass over the renewal set answers two rules. Past its date with
  // nothing started is a live coverage gap; inside the horizon with nothing
  // started is a deadline still catchable. Both must clear on tasks OR
  // quotes: the nightly sweep deliberately creates no task for a carrier it
  // has already quoted, so a missing task alone proves nothing.
  const renewals = buildRenewalRows(
    input.leads,
    input.clients,
    input.policies,
    daysUntil
  );
  const tasksByKey = new Map<string, DetectInputs["tasks"][number][]>();
  for (const t of input.tasks) {
    const key = `${t.accountId}:${t.expirationDate ?? ""}`;
    const list = tasksByKey.get(key);
    if (list) list.push(t);
    else tasksByKey.set(key, [t]);
  }

  for (const r of renewals) {
    const accountQuotes = quotesByAccount.get(r.accountId) ?? [];
    const hasQuote = quotedWithinWindow(accountQuotes, r.date, daysUntil);
    const keyTasks = tasksByKey.get(`${r.accountId}:${r.date}`) ?? [];
    const marketing = renewalMarketing(keyTasks, todayDay, hasQuote);

    if (r.days < 0) {
      // Expired. As far as this system knows the association is uninsured.
      if (r.days < -COVERAGE_GAP_HORIZON_DAYS) continue;
      if (marketing.kind === "quoted" || keyTasks.length > 0) {
        // A blown window is its own, less severe finding: somebody tried.
        if (marketing.kind === "missed") {
          push(
            {
              kind: "submission-window-blown",
              band: "exposed",
              severity: "red",
              accountId: r.accountId,
              subject: r.name,
              clause: `${plural(keyTasks.filter((t) => t.status === "OPEN").length, "carrier")} past submit-by, nothing quoted`,
              ageDays: Math.max(0, daysBetweenDays(marketing.submitBy, todayDay)),
              amount: r.premium,
              href: `/accounts/${r.accountId}?tab=quotes`,
            },
            0,
            true
          );
        }
        continue;
      }
      push(
        {
          kind: "coverage-gap-unmarketed",
          band: "exposed",
          severity: "red",
          accountId: r.accountId,
          subject: r.name,
          clause: `expired ${-r.days}d ago, no marketing, no quote`,
          ageDays: -r.days,
          amount: r.premium,
          href: `/accounts/${r.accountId}?tab=quotes`,
        },
        0,
        true
      );
      continue;
    }

    // Still ahead of us, and a manual submission is still possible.
    if (r.days > RENEWAL_HORIZON_DAYS) continue;
    if (marketing.kind !== "none" && marketing.kind !== "missed") continue;
    if (marketing.kind === "missed") {
      push(
        {
          kind: "submission-window-blown",
          band: "exposed",
          severity: "red",
          accountId: r.accountId,
          subject: r.name,
          clause: `submit-by passed on ${plural(keyTasks.filter((t) => t.status === "OPEN").length, "carrier")}, renews in ${r.days}d`,
          ageDays: Math.max(0, daysBetweenDays(marketing.submitBy, todayDay)),
          amount: r.premium,
          href: `/accounts/${r.accountId}?tab=quotes`,
        },
        0,
        true
      );
      continue;
    }
    push(
      {
        kind: "renewal-not-started",
        band: "closing",
        severity: r.days <= SOON_DAYS ? "red" : "amber",
        accountId: r.accountId,
        subject: r.name,
        clause: `renews in ${r.days}d, no submission started`,
        ageDays: RENEWAL_HORIZON_DAYS - r.days,
        amount: r.premium,
        href: `/accounts/${r.accountId}?tab=quotes`,
      },
      0,
      false
    );
  }

  // ── Premium finance ────────────────────────────────────────────────
  //
  // Every rule here is suppressed wholesale when the module is off, because
  // it ships dark in production and a section about loans that cannot exist
  // is worse than no section.
  if (input.premiumFinanceEnabled) {
    const loanById = new Map(input.loans.map((l) => [l.id, l]));
    const cancelRequested = new Set(
      input.notices
        .filter((n) => n.type === "CANCELLATION_REQUEST")
        .map((n) => n.loanId)
    );

    for (const n of input.notices) {
      if (n.type !== "INTENT_TO_CANCEL" || !n.clockExpiresAt) continue;
      if (cancelRequested.has(n.loanId)) continue;
      const loan = loanById.get(n.loanId);
      // Episode-scoped, and the scoping is not decoration: curing a default
      // sets the loan back to ACTIVE, but the notice row is immutable and its
      // clock keeps running on paper. Without these tests a cancellation
      // somebody already resolved would be reported as live every morning,
      // forever.
      if (!loan || loan.status !== "DEFAULTED" || !loan.defaultedAt) continue;
      if (!n.occurredAt || Date.parse(n.occurredAt) < Date.parse(loan.defaultedAt)) {
        continue;
      }
      // Counted in civil days, not in hours remaining. The clock is a legal
      // deadline that lands on a date, the reader acts on dates, and an
      // hours-based count would drift with the hour the job happened to run.
      const expiresDay = dayOf(n.clockExpiresAt);
      if (!expiresDay) continue;
      const daysLeft = daysBetweenDays(todayDay, expiresDay);
      if (daysLeft < 0) continue;
      push(
        {
          kind: "finance-cancellation-clock",
          band: "exposed",
          severity: "red",
          accountId: loan.accountId,
          subject: nameOf(loan.accountId),
          clause:
            daysLeft === 0
              ? "cancellation clock expires today"
              : `cancellation clock running, ${plural(daysLeft, "day")} left`,
          ageDays: Math.max(
            0,
            Math.floor((now - Date.parse(n.occurredAt)) / 86_400_000)
          ),
          amount: loan.balance ?? loan.amountFinanced ?? null,
          href: `/accounts/${loan.accountId}?tab=financing`,
        },
        0,
        true
      );
    }

    for (const loan of input.loans) {
      // A default emails nobody today: pf-default-sweep's only outbound mail
      // is in its stale-marker loop. This is the loudest uncovered failure in
      // the system, which is why it reports from day one.
      const defaultedDays = loan.defaultedAt
        ? Math.floor((now - Date.parse(loan.defaultedAt)) / 86_400_000)
        : null;
      const stuckDebit =
        loan.autopayPendingIntentId && loan.autopayAttemptedAt
          ? Math.floor((now - Date.parse(loan.autopayAttemptedAt)) / 86_400_000)
          : null;

      const isDefaulted =
        loan.status === "DEFAULTED" &&
        defaultedDays != null &&
        defaultedDays <= DEFAULT_LOOKBACK_DAYS;
      const isStuck = stuckDebit != null && stuckDebit > STALE_PENDING_DAYS;

      if (isDefaulted || isStuck) {
        push(
          {
            kind: "loan-stuck",
            band: "money",
            severity: "red",
            accountId: loan.accountId,
            subject: nameOf(loan.accountId),
            clause: isDefaulted
              ? `loan DEFAULTED${loan.autopayFailedInstallment ? `, installment ${loan.autopayFailedInstallment} failed` : ""}`
              : `debit stuck ${plural(stuckDebit as number, "day")} — can't retry, post or default`,
            ageDays: (isDefaulted ? defaultedDays : stuckDebit) ?? 0,
            amount: loan.balance ?? loan.amountFinanced ?? null,
            href: `/accounts/${loan.accountId}?tab=financing`,
          },
          0,
          true
        );
        continue;
      }

      // An offer out with a board that hasn't voted. A down-payment intent
      // means the election is committed and clearing, which legitimately
      // takes days — that is not a stall.
      if (
        loan.status === "QUOTED" &&
        loan.electionToken &&
        !loan.electedAt &&
        !loan.downPaymentIntentId &&
        loan.quotedAt
      ) {
        const expires = loan.electionTokenExpiresAt
          ? Date.parse(loan.electionTokenExpiresAt)
          : null;
        if (expires != null && expires <= now) continue;
        const age = Math.floor((now - Date.parse(loan.quotedAt)) / 86_400_000);
        push(
          {
            kind: "finance-election-stalled",
            band: "closing",
            severity: "amber",
            accountId: loan.accountId,
            subject: nameOf(loan.accountId),
            clause: `finance offer out ${plural(age, "day")}, board has not elected`,
            ageDays: age,
            amount: loan.amountFinanced ?? null,
            href: `/accounts/${loan.accountId}?tab=financing`,
          },
          ELECTION_STALE_DAYS,
          false
        );
      }
    }
  }

  // ── Web leads that heard nothing back ──────────────────────────────
  //
  // `LeadReply` is ADMIN-read-only and no screen reads it, so a failed
  // auto-reply is currently invisible to every human in the agency. The
  // numbers are set by the mechanism, not by taste: the reply window is 8
  // minutes and the sweep runs every minute, so an hour past due is
  // unambiguously a broken sweep or a dead SES call.
  //
  // A lead with no email address has no window at all and is not a failure.
  for (const reply of input.leadReplies) {
    const broken =
      reply.status === "FAILED" ||
      (reply.status === "WAITING" &&
        reply.dueAt &&
        now - Date.parse(reply.dueAt) > REPLY_OVERDUE_MINUTES * 60_000) ||
      (reply.status === "SENDING" &&
        reply.submittedAt &&
        now - Date.parse(reply.submittedAt) > REPLY_SENDING_MINUTES * 60_000);
    if (!broken) continue;
    const submitted = dayOf(reply.submittedAt);
    push(
      {
        kind: "web-lead-heard-nothing",
        band: "exposed",
        severity: "red",
        accountId: reply.accountId,
        subject: nameOf(reply.accountId),
        clause: `web lead${submitted ? ` ${submitted}` : ""} got no auto-reply (${reply.status})`,
        ageDays: submitted ? Math.max(0, daysBetweenDays(submitted, todayDay)) : 0,
        amount: null,
        href: `/accounts/${reply.accountId}`,
      },
      0,
      true
    );
  }

  // ── Money ──────────────────────────────────────────────────────────

  // Bound, agency-billed, and never invoiced. Restricted to an explicit
  // AGENCY billType because the field is nullable and a null must not be
  // guessed at: one false accusation on a direct-bill policy is how this
  // section loses its reader.
  const billedPolicyIds = new Set<string>();
  const billedQuoteIds = new Set<string>();
  const draftPolicyIds = new Set<string>();
  for (const inv of input.invoices) {
    const live = inv.status === "SENT" || inv.status === "PROCESSING" || inv.status === "PAID";
    if (live) {
      if (inv.policyId) billedPolicyIds.add(inv.policyId);
      if (inv.quoteId) billedQuoteIds.add(inv.quoteId);
    } else if (inv.status === "DRAFT" && inv.policyId) {
      draftPolicyIds.add(inv.policyId);
    }
  }
  for (const p of input.policies) {
    if (p.status !== "ACTIVE" || p.billType !== "AGENCY") continue;
    // Nullable for policies bound before the field existed — skipped, never
    // treated as infinitely old.
    if (!p.datePolicyBound) continue;
    if (billedPolicyIds.has(p.id)) continue;
    if (p.quoteId && billedQuoteIds.has(p.quoteId)) continue;
    const boundDay = dayOf(p.datePolicyBound);
    if (!boundDay) continue;
    const age = businessDaysSince(boundDay, todayDay);
    push(
      {
        kind: "bound-not-billed",
        band: "money",
        severity: age >= BOUND_NOT_BILLED_DAYS * 2 ? "red" : "amber",
        accountId: p.accountId,
        subject: nameOf(p.accountId),
        clause: draftPolicyIds.has(p.id)
          ? `bound ${plural(age, "business day")} ago, invoice still in draft`
          : `bound ${plural(age, "business day")} ago, agency bill, never invoiced`,
        ageDays: age,
        amount: p.premium ?? null,
        href: `/accounts/${p.accountId}?tab=invoices`,
      },
      BOUND_NOT_BILLED_DAYS,
      false
    );
  }

  for (const inv of input.invoices) {
    if (inv.status !== "SENT" && inv.status !== "PROCESSING") continue;
    // An invoice that never stated a deadline has not blown one.
    const due = dayOf(inv.dueAt);
    if (!due) continue;
    const overdue = daysBetweenDays(due, todayDay);
    if (overdue <= 0) continue;
    // Money already in flight. ACH authorises at checkout and settles days
    // later, and chasing that is the false positive that kills the section.
    if (
      inv.status === "PROCESSING" &&
      inv.stripeEventAt &&
      now - Date.parse(inv.stripeEventAt) < ACH_SETTLING_DAYS * 86_400_000
    ) {
      continue;
    }
    push(
      {
        kind: "invoice-past-due",
        band: "money",
        severity: overdue >= INVOICE_RED_DAYS ? "red" : "amber",
        accountId: inv.accountId,
        subject: nameOf(inv.accountId),
        clause: `${inv.number ?? "invoice"} ${plural(overdue, "day")} past due`,
        ageDays: overdue,
        amount: dollars(inv.stripeLinkAmountCents),
        href: `/accounts/${inv.accountId}?tab=invoices`,
      },
      INVOICE_LATE_DAYS,
      overdue >= INVOICE_RED_DAYS
    );
  }

  // ── Pipeline ───────────────────────────────────────────────────────

  // An effective date that passed with the quote still open is either a bind
  // nobody recorded or a deal that died silently. Both distort the pipeline,
  // and the first is an E&O fact pattern. Nothing else in the product reports
  // this.
  for (const q of input.quotes) {
    if (!q.status || !OPEN_QUOTE_STATUSES.has(q.status)) continue;
    const eff = dayOf(q.effectiveDate);
    if (!eff) continue;
    const past = daysBetweenDays(eff, todayDay);
    if (past <= 0 || past > PASSED_EFFECTIVE_CAP_DAYS) continue;
    push(
      {
        kind: "effective-date-passed",
        band: "exposed",
        severity: "red",
        accountId: q.accountId,
        subject: nameOf(q.accountId),
        clause: `quote still ${q.status}, effective date passed ${plural(past, "day")} ago`,
        ageDays: past,
        amount: q.premium ?? null,
        href: `/accounts/${q.accountId}?tab=quotes`,
      },
      0,
      false
    );
  }

  // Stalled quotes. The wording here is load-bearing: Quote stores none of
  // its status transitions, so this is days since the row was last WRITTEN,
  // not days in status, and the row must never claim otherwise.
  for (const q of input.quotes) {
    if (q.status !== "SUBMITTED" && q.status !== "QUOTED" && q.status !== "PRESENTED") {
      continue;
    }
    const rung = q.status === "SUBMITTED" ? QUOTE_SUBMITTED_DAYS : QUOTE_HELD_DAYS;
    const quiet = businessDaysSince(q.updatedAt, todayDay);
    if (quiet > rung * 4) continue;
    push(
      {
        kind: "quote-stalled",
        band: "closing",
        severity: "amber",
        accountId: q.accountId,
        subject: nameOf(q.accountId),
        clause: `${q.status}, no write in ${plural(quiet, "business day")}`,
        ageDays: quiet,
        amount: q.premium ?? null,
        href: `/accounts/${q.accountId}?tab=quotes`,
      },
      rung,
      false
    );
  }

  // Leads nobody has quoted. `leadQuoteStanding() === null` is the existing
  // tested definition of untouched, and it deliberately does not flag a lead
  // whose quotes were all declined — that lead was worked and lost, which is
  // a different fact and a different conversation.
  for (const lead of input.leads) {
    const created = dayOf(lead.createdAt);
    if (!created) continue;
    const age = businessDaysSince(created, todayDay);
    if (daysBetweenDays(created, todayDay) > LEAD_UNTOUCHED_CAP_DAYS) continue;
    if (leadQuoteStanding(quotesByAccount.get(lead.id) ?? []) !== null) continue;
    // Web forms produce test submissions. A digest that reports "nobody
    // followed up with asdf HOA" as a service failure loses its reader on the
    // first occurrence.
    if (propertyNameProblem(lead.name) != null) continue;
    push(
      {
        kind: "new-lead-untouched",
        band: "closing",
        severity: "amber",
        accountId: lead.id,
        subject: lead.name,
        clause: `new lead ${created}, no quote started`,
        ageDays: age,
        amount: null,
        href: `/accounts/${lead.id}?tab=quotes`,
      },
      LEAD_UNTOUCHED_DAYS,
      false
    );
  }

  // A producer licence that actually lapsed. `license-alerts` fires a 60/30/3
  // ladder and writes a dedupe row per rung, so once the 3-day rung has fired
  // and the date passes, nothing ever mentions it again — and an expired
  // licence is a regulatory fact, not a reminder.
  for (const l of input.licenses) {
    if (l.holderType !== "PRODUCER") continue;
    const exp = dayOf(l.expirationDate);
    const lapsedByStatus = l.status === "LAPSED" || l.status === "EXPIRED";
    const lapsedByDate = exp != null && daysBetweenDays(exp, todayDay) > 0;
    if (!lapsedByStatus && !lapsedByDate) continue;
    push(
      {
        kind: "producer-licence-lapsed",
        band: "exposed",
        severity: "red",
        accountId: null,
        subject: l.holderName || "A producer",
        clause: `${l.state ?? "—"} producer licence LAPSED${exp ? ` since ${exp}` : ""}`,
        ageDays: exp ? Math.max(0, daysBetweenDays(exp, todayDay)) : 0,
        amount: null,
        href: `/licensing`,
      },
      0,
      // A row on the day it lapses and each Monday after: it cannot be fixed
      // this morning, so shouting daily would only train dismissal.
      false
    );
  }

  return out;
}

/** Pinned by the tests so a tuning edit is deliberate. */
export const THRESHOLDS = {
  COVERAGE_GAP_HORIZON_DAYS,
  RENEWAL_HORIZON_DAYS,
  SOON_DAYS,
  BOUND_NOT_BILLED_DAYS,
  INVOICE_LATE_DAYS,
  INVOICE_RED_DAYS,
  INVOICE_NAME_THRESHOLD,
  ACH_SETTLING_DAYS,
  STALE_PENDING_DAYS,
  DEFAULT_LOOKBACK_DAYS,
  QUOTE_SUBMITTED_DAYS,
  QUOTE_HELD_DAYS,
  ELECTION_STALE_DAYS,
  LEAD_UNTOUCHED_DAYS,
  LEAD_UNTOUCHED_CAP_DAYS,
  PASSED_EFFECTIVE_CAP_DAYS,
} as const;
