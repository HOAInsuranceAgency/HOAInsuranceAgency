/**
 * The email: subject, plain text, and HTML.
 *
 * Pure — no data client, no SES — so every ordering, cap and suppression rule
 * is assertable without either.
 *
 * The markup follows `task-digest/digest.ts`: a fixed 640px table with inline
 * styles and no web fonts, because that is what survives Outlook and Gmail's
 * stripping, and a charset declared on every part because the copy carries "·"
 * and "—" and a client left to guess windows-1252 renders them as mojibake.
 *
 * ── Four blocks, and why not nine ──
 *
 * The first version of this email had a heading for every kind of thing it
 * knew about: exposures, closing windows, money at risk, outcomes, activity,
 * people, standing, all-clear. On a typical morning most of those carried one
 * or two rows, so the reader spent more attention on scaffolding than on
 * content — and "Won: Maple Ridge $41,200" printed directly above "Bound:
 * Maple Ridge $41,200" was the same fact twice, because two modules computed
 * it and both got a line.
 *
 * What survives is the smallest set of questions an owner actually asks:
 *
 *   1. **Where does the business stand** — three figures, no prose.
 *   2. **What needs me** — one ranked list, worst first.
 *   3. **What happened** — outcomes and counts, three lines at most.
 *   4. **Who moved things** — names and effort.
 *
 * The row counts the footer used to carry ("Read 1,240 activity rows, 318
 * invoices…") went with them. They answered "did this actually run?", which
 * the checked-and-clear line answers better by naming what it checked, and
 * they are still in the handler's log where that question gets asked.
 *
 * The three risk lists became one because their headings were carrying
 * information the rows already carry: "34 days past due" and "2 carriers past
 * submit-by" say what kind of problem each is far better than a section title
 * does. What the merge must NOT lose is the ranking, so severity survives as
 * the sort and as a coloured edge, and `actionList` is written so a red row
 * can never be pushed under the cap by a pile of ambers.
 */

import { AGENCY } from "../../../../shared/agency";
import { STANDING_LABELS, THRESHOLDS, type Finding } from "./detect";
import type { DoneResult } from "./done";
import type { Progress } from "./progress";
import type { Edition } from "./window";

/**
 * Rows in the action list before the rest becomes a count.
 *
 * Eight, where the three separate lists allowed twenty-one between them. The
 * list is sorted worst-first, so the cap can only ever hide the least
 * important rows — and what it hides is counted on the line beneath rather
 * than dropped in silence.
 */
const MAX_ROWS = 8;

const NAVY = "#142a4c";
const RED = "#b3392e";
const AMBER = "#92600a";
const GREEN = "#187a4b";
const SLATE = "#64748b";
const MUTED = "#94a3b8";
const HAIRLINE = "#e2e8f0";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/**
 * Whole dollars with a thousands separator.
 *
 * Restated rather than imported from `src/lib/client.ts`, which calls
 * `generateClient()` at module scope and would drag the browser data client
 * into this bundle. Matches `fmtMoney`'s options exactly so the email and the
 * dashboard round the same way; `opsRollupRender.test.ts` pins that.
 */
const money = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

/** "Tuesday, August 25, 2026" — noon UTC so the day cannot slip a boundary. */
const longDate = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** "Tue, Aug 25" — the subject line's compact form. */
const shortDate = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export interface RollupInput {
  edition: Edition;
  findings: readonly Finding[];
  done: DoneResult;
  progress: Progress;
  /** The model's opening paragraph, or null when there isn't one. */
  read: string | null;
  /** True when a read hit its page cap — stated, never swallowed. */
  truncated: boolean;
  baseUrl?: string;
}

export interface Rollup {
  subject: string;
  text: string;
  html: string;
}

/**
 * Which risk band a row belongs to, as a rank.
 *
 * Coverage and client loss first, then money already earned or billed, then
 * the pipeline. This is the only place the old section order survives, and it
 * has to: an overdue invoice and an uninsured association are not equally
 * urgent just because they now arrive in the same list.
 */
const BAND_RANK: Record<Finding["band"], number> = { exposed: 0, money: 1, closing: 2 };

interface ActionList {
  rows: Finding[];
  /** Rows past the cap. Counted, never silently dropped. */
  overflow: number;
  /** Small overdue invoices folded into one line. */
  folded: { count: number; total: number } | null;
  /** Everything the reader could act on, before the cap. */
  total: number;
  urgent: number;
}

/**
 * The one list, ordered and capped.
 *
 * Severity outranks everything, so a red row cannot be pushed off the bottom
 * by a pile of ambers. Inside a severity, band decides; inside a band, money
 * sorts by dollars — that is what picks which call to make — and everything
 * else by age, because in a service failure the length of the silence is the
 * aggravating fact.
 */
export function actionList(findings: readonly Finding[]): ActionList {
  const all = findings.filter((f) => f.visibility === "row");

  // A pile of small overdue bills is one errand, not five rows.
  const small = all.filter(
    (f) =>
      f.kind === "invoice-past-due" &&
      f.amount != null &&
      f.amount < THRESHOLDS.INVOICE_NAME_THRESHOLD
  );
  const folded =
    small.length > 1
      ? { count: small.length, total: small.reduce((n, f) => n + (f.amount ?? 0), 0) }
      : null;
  const kept = folded ? all.filter((f) => !small.includes(f)) : all;

  const sorted = [...kept].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "red" ? -1 : 1;
    if (a.band !== b.band) return BAND_RANK[a.band] - BAND_RANK[b.band];
    if (a.band === "money") return (b.amount ?? 0) - (a.amount ?? 0);
    return b.ageDays - a.ageDays;
  });

  return {
    rows: sorted.slice(0, MAX_ROWS),
    overflow: Math.max(0, sorted.length - MAX_ROWS),
    folded,
    total: all.length,
    urgent: all.filter((f) => f.severity === "red").length,
  };
}

/** "3 renewals not started · 2 overdue invoices" — the one-line memory. */
function standingLine(findings: readonly Finding[]): string | null {
  const counts = new Map<Finding["kind"], number>();
  for (const f of findings) {
    if (f.visibility !== "standing") continue;
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${STANDING_LABELS[kind][n === 1 ? 0 : 1]}`)
    .join(" · ");
}

/**
 * What was checked and found clear.
 *
 * Named positively and per kind, because "nothing to report" and "the renewal
 * query threw" produce identical silence otherwise.
 */
function clearLine(findings: readonly Finding[]): string {
  const present = new Set(findings.map((f) => f.kind));
  const checks: [string, Finding["kind"]][] = [
    ["no coverage gaps", "coverage-gap-unmarketed"],
    ["no blown submission windows", "submission-window-blown"],
    ["no cancellation clocks", "finance-cancellation-clock"],
    ["no stuck debits", "loan-stuck"],
    ["no failed auto-replies", "web-lead-heard-nothing"],
    ["no bound-and-unbilled policies", "bound-not-billed"],
  ];
  const clear = checks.filter(([, kind]) => !present.has(kind)).map(([label]) => label);
  return clear.length ? `Checked and clear: ${clear.join(" · ")}.` : "";
}

interface Stat {
  figure: string;
  label: string;
  note: string | null;
  color: string;
}

/**
 * The three figures, as a strip rather than a sentence.
 *
 * These were two dense lines of prose separated by interpuncts, which is a
 * shape the eye has to read rather than scan. A figure over a label is taken
 * in at a glance, and this is the part of the email that should cost no
 * attention at all on a normal morning.
 */
export function stats(p: Progress, list: ActionList): Stat[] {
  const pace =
    p.pacePct == null
      ? p.priorPremium === 0 && p.mtdPremium > 0
        ? "none at this point last month"
        : null
      : `${p.pacePct >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(p.pacePct * 100))}% vs last month`;

  return [
    {
      figure: money(p.mtdPremium),
      label: `${p.monthLabel} bound`,
      note: pace,
      color: NAVY,
    },
    {
      figure: money(p.pipelineTotal),
      label: "in flight",
      note: p.decisionsDue.count
        ? `${plural(p.decisionsDue.count, "decision")} due in ${p.decisionsDue.days}d`
        : p.pipelineCount
          ? plural(p.pipelineCount, "open quote")
          : null,
      color: NAVY,
    },
    {
      figure: String(list.total),
      label: list.total === 1 ? "needs you" : "need you",
      note: list.urgent ? `${list.urgent} urgent` : list.total ? "none urgent" : null,
      color: list.urgent ? RED : list.total ? AMBER : GREEN,
    },
  ];
}

/**
 * What happened, in at most three lines.
 *
 * Binds are named once. `progress.won` and `done.summary.bound` are the same
 * policies counted by two modules — the old layout printed both, one directly
 * under the other — so the outcome lines own the names and the counts line
 * owns everything with no name worth printing.
 */
export function happenedLines(done: DoneResult, p: Progress): string[] {
  const s = done.summary;
  if (s.empty && p.won.length === 0 && p.lost.length === 0) {
    return ["Nothing was recorded in the CRM."];
  }
  const lines: string[] = [];

  for (const w of p.won) {
    lines.push(`Won   ${w.account} ${money(w.premium)}${w.detail ? ` · ${w.detail}` : ""}`);
  }
  for (const l of p.lost) {
    lines.push(`Lost   ${l.account} ${money(l.premium)}${l.detail ? ` · ${l.detail}` : ""}`);
  }

  const counts: string[] = [];
  if (s.newClients.length) {
    counts.push(`${plural(s.newClients.length, "new client")}: ${s.newClients.join(", ")}`);
  }
  if (s.quotesAdvanced) counts.push(`${plural(s.quotesAdvanced, "quote")} advanced`);
  if (s.certificates) counts.push(`${plural(s.certificates, "COI")} issued`);
  if (s.invoicesSent) {
    counts.push(
      `${plural(s.invoicesSent, "bill")} sent ${money(s.invoicesSentTotal)}` +
        (s.invoicesSentUnpriced ? ` (${s.invoicesSentUnpriced} unpriced)` : "")
    );
  }
  if (s.invoicesPaid) counts.push(`${s.invoicesPaid} paid ${money(s.invoicesPaidTotal)}`);
  if (s.tasksClosed) {
    counts.push(`${plural(s.tasksClosed, "task")} closed (${s.tasksQuoted} quoted)`);
  }
  if (s.downPayments) {
    counts.push(`${plural(s.downPayments, "down payment")} ${money(s.downPaymentTotal)}`);
  }
  if (s.installments) {
    counts.push(`${plural(s.installments, "installment")} ${money(s.installmentTotal)}`);
  }
  if (counts.length) lines.push(counts.join(" · "));

  return lines;
}

/** The fixed sentence under the producer block. Never varies. */
const PRODUCER_CAVEAT =
  "CRM writes only — calls, carrier emails, inspections and board meetings leave no record in this system.";

/** One producer's line: what they moved, without the name. */
const personDetail = (p: DoneResult["people"][number]): string =>
  [
    plural(p.accountsTouched, "account"),
    p.quotesAdvanced ? `${plural(p.quotesAdvanced, "quote")} advanced` : "",
    p.policiesBound ? plural(p.policiesBound, "bind") : "",
    p.tasksClosed ? `${plural(p.tasksClosed, "task")} closed` : "",
  ]
    .filter(Boolean)
    .join(", ");

export function renderRollup(input: RollupInput): Rollup {
  const { edition, findings, done, progress, read, truncated, baseUrl } = input;
  const weekend = edition.kind === "weekend";

  const list = actionList(findings);
  const strip = weekend ? [] : stats(progress, list);
  const happened = weekend ? [] : happenedLines(done, progress);
  const people = weekend ? [] : done.people;
  const standing = weekend ? null : standingLine(findings);
  const clear = clearLine(findings);
  const quiet = weekend || !edition.isMonday ? [] : done.quiet.slice(0, 3);

  // Non-zero parts only, worst first. A subject that always reads "0 urgent"
  // stops being read, and this is what shows in a phone's notification
  // preview — so it names no audience and no purpose.
  const parts = [
    list.urgent ? `${list.urgent} urgent` : null,
    list.total - list.urgent > 0 ? `${list.total - list.urgent} open` : null,
  ].filter(Boolean) as string[];
  const subject = `Ops — ${shortDate(edition.todayDay)} · ${parts.length ? parts.join(", ") : "all clear"}`;

  const link = (path: string | null): string | null =>
    baseUrl && path ? `${baseUrl}${path}` : null;

  // ── Plain text ───────────────────────────────────────────────────

  const text = [
    `Ops rollup — ${longDate(edition.todayDay)}`,
    weekend ? "Weekend check — open exposures only." : `Covering ${edition.covering}.`,
    "",
    ...(read ? [read, ""] : []),
    ...(strip.length
      ? [
          strip
            .map((s) => `${s.figure} ${s.label}${s.note ? ` (${s.note})` : ""}`)
            .join("   ·   "),
          "",
        ]
      : []),
    ...(list.rows.length || list.folded
      ? [
          `NEEDS YOU (${list.total})`,
          ...list.rows.map(
            (f) =>
              `  ${f.severity === "red" ? "!" : "·"} ${f.subject}${f.amount != null ? ` — ${money(f.amount)}` : ""}\n      ${f.clause}`
          ),
          ...(list.folded
            ? [
                `  · and ${plural(list.folded.count, "smaller overdue invoice")}, ${money(list.folded.total)}`,
              ]
            : []),
          ...(list.overflow ? [`  · +${list.overflow} more`] : []),
          "",
        ]
      : []),
    ...(happened.length ? ["YESTERDAY", ...happened.map((l) => `  ${l}`), ""] : []),
    ...(people.length
      ? [
          "WHO MOVED THINGS",
          ...people.map(
            (p) => `  ${p.name} — ${personDetail(p)} · 10-day: ${p.trailingAccounts}`
          ),
          ...(done.automatedChanges
            ? [`  Automated — ${plural(done.automatedChanges, "change")}`]
            : []),
          ...(done.unmatchedClosers
            ? [`  (${done.unmatchedClosers} closed tasks matched no profile)`]
            : []),
          `  ${PRODUCER_CAVEAT}`,
          "",
        ]
      : []),
    ...(quiet.length
      ? [
          "SINCE LAST WEEK",
          ...quiet.map(
            (q) =>
              `  ${q.name} — no CRM writes in ${plural(q.businessDays, "business day")}${q.beyondScan ? "+" : ""} — worth a check-in?`
          ),
          "",
        ]
      : []),
    standing ? `Standing: ${standing}` : "",
    clear,
    truncated ? "A read hit its page cap — counts above may under-report." : "",
    baseUrl ? `\nOpen the CRM: ${baseUrl}/` : "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .trimEnd();

  // ── HTML ─────────────────────────────────────────────────────────

  const font = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";

  /** A block heading. Small, muted, and the only chrome a section gets. */
  const heading = (label: string, count?: number) =>
    `          <div style="font:600 11px/1.4 ${font};color:${MUTED};text-transform:uppercase;letter-spacing:.06em;padding:0 0 10px">${escapeHtml(label)}${count != null ? ` · ${count}` : ""}</div>`;

  /** A hairline-separated section. One rule per block, not a box each. */
  const block = (body: string) => `
        <tr><td style="padding:18px 28px 0">
          <div style="border-top:1px solid ${HAIRLINE};padding-top:16px">
${body}
          </div>
        </td></tr>`;

  const statCell = (s: Stat) => `
                <td width="33%" style="padding:0 10px 0 0;vertical-align:top">
                  <div style="font:700 23px/1.15 ${font};color:${s.color};white-space:nowrap">${escapeHtml(s.figure)}</div>
                  <div style="font:400 12px/1.4 ${font};color:${SLATE};padding-top:4px">${escapeHtml(s.label)}</div>
                  ${s.note ? `<div style="font:600 11px/1.4 ${font};color:${MUTED};padding-top:2px">${escapeHtml(s.note)}</div>` : ""}
                </td>`;

  const actionRow = (f: Finding) => {
    const href = link(f.href);
    const name = escapeHtml(f.subject);
    const label = href
      ? `<a href="${href}" style="color:${NAVY};text-decoration:none">${name}</a>`
      : name;
    const color = f.severity === "red" ? RED : AMBER;
    return `            <tr>
              <td width="3" style="background:${color};padding:0;font-size:0;line-height:0">&nbsp;</td>
              <td style="padding:8px 10px 8px 12px;border-bottom:1px solid #f1f5f9">
                <div style="font:600 14px/1.4 ${font};color:${NAVY}">${label}</div>
                <div style="font:400 13px/1.45 ${font};color:${SLATE};padding-top:2px">${escapeHtml(f.clause)}</div>
              </td>
              <td align="right" style="font:600 14px/1.4 ${font};color:${color};padding:8px 0 8px 8px;border-bottom:1px solid #f1f5f9;white-space:nowrap;vertical-align:top">${f.amount != null ? escapeHtml(money(f.amount)) : ""}</td>
            </tr>`;
  };

  const proseRows = (lines: string[]) =>
    lines
      .map(
        (l) =>
          `          <div style="font:400 13px/1.7 ${font};color:#334155">${escapeHtml(l)}</div>`
      )
      .join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08)">
        <tr>
          <td style="background:${NAVY};padding:20px 28px">
            <div style="font:700 17px/1.3 ${font};color:#ffffff">Ops rollup</div>
            <div style="font:400 13px/1.5 ${font};color:#a9bcd8;padding-top:3px">${escapeHtml(longDate(edition.todayDay))} · ${escapeHtml(weekend ? "weekend check — open exposures only" : `covering ${edition.covering}`)}</div>
          </td>
        </tr>
${
  read
    ? `        <tr><td style="padding:20px 28px 0">
          <div style="font:400 14px/1.65 ${font};color:#1e293b">${escapeHtml(read)}</div>
        </td></tr>`
    : ""
}
${
  strip.length
    ? `        <tr><td style="padding:18px 28px 0">
          <div style="border-top:1px solid ${HAIRLINE};padding-top:16px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              <tr>
${strip.map(statCell).join("\n")}
              </tr>
            </table>
          </div>
        </td></tr>`
    : ""
}
${
  list.rows.length || list.folded
    ? block(`${heading("Needs you", list.total)}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${list.rows.map(actionRow).join("\n")}
${
  list.folded
    ? `            <tr><td width="3" style="background:${AMBER};font-size:0;line-height:0">&nbsp;</td><td colspan="2" style="font:400 13px/1.45 ${font};color:${SLATE};padding:8px 0 8px 12px;border-bottom:1px solid #f1f5f9">and ${plural(list.folded.count, "smaller overdue invoice")}, ${escapeHtml(money(list.folded.total))}</td></tr>`
    : ""
}
          </table>
${
  list.overflow
    ? `          <div style="font:600 12px/1.5 ${font};color:${MUTED};padding-top:8px">+${list.overflow} more</div>`
    : ""
}`)
    : ""
}
${happened.length ? block(`${heading("Yesterday")}\n${proseRows(happened)}`) : ""}
${
  people.length
    ? block(`${heading("Who moved things")}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${people
  .map(
    (p) => `            <tr>
              <td style="font:600 13px/1.6 ${font};color:${NAVY};padding:2px 12px 2px 0;white-space:nowrap;vertical-align:top">${escapeHtml(p.name)}</td>
              <td style="font:400 13px/1.6 ${font};color:#334155;padding:2px 12px 2px 0">${escapeHtml(personDetail(p))}</td>
              <td align="right" style="font:400 12px/1.6 ${font};color:${MUTED};padding:2px 0;white-space:nowrap;vertical-align:top">10-day: ${p.trailingAccounts}</td>
            </tr>`
  )
  .join("\n")}
${
  done.automatedChanges
    ? `            <tr><td colspan="3" style="font:400 13px/1.6 ${font};color:${MUTED};padding:2px 0">Automated — ${plural(done.automatedChanges, "change")}</td></tr>`
    : ""
}
          </table>
${
  done.unmatchedClosers
    ? `          <div style="font:400 12px/1.5 ${font};color:${MUTED};padding-top:6px">${done.unmatchedClosers} closed ${done.unmatchedClosers === 1 ? "task" : "tasks"} matched no profile and are counted for nobody.</div>`
    : ""
}
          <div style="font:400 12px/1.55 ${font};color:${SLATE};padding-top:8px">${escapeHtml(PRODUCER_CAVEAT)}</div>`)
    : ""
}
${
  quiet.length
    ? block(
        `${heading("Since last week")}\n${proseRows(
          quiet.map(
            (q) =>
              `${q.name} — no CRM writes in ${plural(q.businessDays, "business day")}${q.beyondScan ? "+" : ""} — worth a check-in?`
          )
        )}`
      )
    : ""
}
${
  baseUrl
    ? `        <tr><td style="padding:20px 28px 0">
          <a href="${baseUrl}/" style="display:inline-block;background:${NAVY};color:#ffffff;font:600 14px/1 ${font};text-decoration:none;padding:12px 20px;border-radius:6px">Open the CRM</a>
        </td></tr>`
    : ""
}
        <tr>
          <td style="padding:18px 28px 24px">
            <div style="border-top:1px solid ${HAIRLINE};padding-top:14px;font:400 12px/1.6 ${font};color:${MUTED}">
              ${standing ? `<span style="color:${SLATE}">Standing: ${escapeHtml(standing)}</span><br>` : ""}
              ${escapeHtml(clear)}${truncated ? " A read hit its page cap — counts above may under-report." : ""}<br>
              Silence here means no record was written, not that nobody acted: ${escapeHtml(AGENCY.name)}'s CRM has no call or email log. The dashboard's Needs-attention queue is the unfiltered version of the list above.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
