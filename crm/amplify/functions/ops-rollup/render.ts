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
 * ── The shape, and why this order ──
 *
 * Worst-first, and "worst" is ranked by what cannot be undone later: coverage
 * that has lapsed, then deadlines still catchable, then money, then what was
 * done, then who did it. A reader who stops after four lines has read the
 * things that were still fixable this morning.
 *
 * ── Why it sends on a quiet weekday ──
 *
 * The last block always renders, and states positively what was checked and
 * found clear. Without it a short email is ambiguous — nothing wrong, or the
 * query broke? — and no scheduled function in this codebase has a delivery
 * alarm, so a silent failure would look exactly like a good day. Once the mail
 * always arrives, a *missing* one is itself the alert.
 */

import { AGENCY } from "../../../../shared/agency";
import { STANDING_LABELS, THRESHOLDS, type Finding } from "./detect";
import type { DoneResult } from "./done";
import type { Progress } from "./progress";
import type { Edition } from "./window";

/** Rows per block before the rest becomes a count. */
const CAP = { exposed: 8, closing: 8, money: 5 } as const;

const NAVY = "#142a4c";
const RED = "#b3392e";
const AMBER = "#92600a";
const SLATE = "#64748b";
const MUTED = "#94a3b8";

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

/** "Tuesday, 25 August 2026" — noon UTC so the day cannot slip a boundary. */
const longDate = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** "Tue 25 Aug" — the subject line's compact form. */
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
  /** Row counts per model, for the closing line. */
  reads: Readonly<Record<string, number>>;
  /** True when a read hit its page cap — stated, never swallowed. */
  truncated: boolean;
  baseUrl?: string;
}

export interface Rollup {
  subject: string;
  text: string;
  html: string;
}

interface Block {
  key: "exposed" | "closing" | "money";
  heading: string;
  note: string;
  color: string;
  tint: string;
  rows: Finding[];
  /** Rows past the cap, and their names, for the overflow line. */
  overflow: number;
  /** Small overdue invoices folded into one line. */
  folded: { count: number; total: number } | null;
}

/**
 * Rows for one block, ordered, capped and folded.
 *
 * Age descending inside each severity band. In a service-failure list the
 * length of the silence is the aggravating fact, so the oldest exposure reads
 * first — the opposite of a deadline list, where the nearest date wins. Money
 * is the exception and sorts by dollars, because that is what decides which
 * phone call to make.
 */
function blockRows(findings: readonly Finding[], key: Block["key"]): Block {
  const all = findings.filter((f) => f.band === key && f.visibility === "row");

  let folded: Block["folded"] = null;
  let rows = all;
  if (key === "money") {
    // A pile of small overdue bills is one errand, not five rows.
    const small = all.filter(
      (f) =>
        f.kind === "invoice-past-due" &&
        f.amount != null &&
        f.amount < THRESHOLDS.INVOICE_NAME_THRESHOLD
    );
    if (small.length > 1) {
      rows = all.filter((f) => !small.includes(f));
      folded = {
        count: small.length,
        total: small.reduce((n, f) => n + (f.amount ?? 0), 0),
      };
    }
    rows = [...rows].sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1) ||
        (b.amount ?? 0) - (a.amount ?? 0) ||
        b.ageDays - a.ageDays
    );
  } else {
    rows = [...all].sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1) ||
        b.ageDays - a.ageDays
    );
  }

  const cap = CAP[key];
  const overflow = Math.max(0, rows.length - cap);

  const meta = {
    exposed: {
      heading: "Exposed",
      note: "Coverage, money or a client is at risk right now.",
      color: RED,
      tint: "#fde8e6",
    },
    closing: {
      heading: "Closing windows",
      note: "Still catchable. Nothing has moved on these.",
      color: AMBER,
      tint: "#fdf1da",
    },
    money: {
      heading: "Money at risk",
      note: "Billed and unpaid, or earned and unbilled.",
      color: AMBER,
      tint: "#fdf1da",
    },
  }[key];

  return { key, ...meta, rows: rows.slice(0, cap), overflow, folded };
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
  return clear.length ? `Clear: ${clear.join(" · ")}.` : "";
}

/** The DONE block's two or three sentences, already composed. */
function doneLines(done: DoneResult): string[] {
  const s = done.summary;
  if (s.empty) return ["Nothing was recorded in the CRM."];
  const lines: string[] = [];

  const headline: string[] = [];
  for (const b of s.bound) {
    headline.push(
      `Bound: ${b.account} ${money(b.premium)}${b.carrier ? ` (${b.carrier})` : ""}`
    );
  }
  if (s.newClients.length) {
    headline.push(`New ${s.newClients.length === 1 ? "client" : "clients"}: ${s.newClients.join(", ")}`);
  }
  if (s.certificates) headline.push(`COIs: ${s.certificates}`);
  if (headline.length) lines.push(headline.join(" · "));

  const counts: string[] = [];
  if (s.quotesAdvanced) counts.push(plural(s.quotesAdvanced, "quote") + " advanced");
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
  if (counts.length) lines.push(counts.join(" · "));

  const pf: string[] = [];
  if (s.downPayments) {
    pf.push(`${plural(s.downPayments, "down payment")} ${money(s.downPaymentTotal)}`);
  }
  if (s.installments) {
    pf.push(
      `${plural(s.installments, "installment")} posted ${money(s.installmentTotal)} (${money(s.installmentInterest)} interest)`
    );
  }
  if (pf.length) lines.push(`Financing: ${pf.join(" · ")}`);

  return lines;
}

/**
 * The scoreboard: where the business stands, in two lines.
 *
 * This is the half a list cannot give an owner. A count of quotes advanced is
 * activity; premium bound against the same point last month is progress, and
 * the pipeline behind it is whether that continues.
 */
function scoreboardLines(p: Progress): string[] {
  const lines: string[] = [];

  const pace =
    p.pacePct == null
      ? p.priorPremium === 0 && p.mtdPremium > 0
        ? "no production at this point last month"
        : null
      : `${Math.abs(Math.round(p.pacePct * 100))}% ${p.pacePct >= 0 ? "ahead of" : "behind"} the same point last month`;

  lines.push(
    `${p.monthLabel} to date: ${money(p.mtdPremium)} bound across ${plural(p.mtdPolicies, "policy", "policies")}` +
      (pace ? ` — ${pace}` : "") +
      (p.mtdCommission > 0 ? ` · est. commission ${money(p.mtdCommission)}` : "") +
      (p.mtdWithoutCommission
        ? ` (${p.mtdWithoutCommission} with no commission % on file)`
        : "")
  );

  if (p.pipelineCount > 0) {
    lines.push(
      `In flight: ${money(p.pipelineTotal)} across ${plural(p.pipelineCount, "open quote")} — ` +
        p.pipeline.map((s) => `${s.count} ${s.stage.toLowerCase()} ${money(s.premium)}`).join(" · ") +
        (p.decisionsDue.count
          ? ` · ${plural(p.decisionsDue.count, "decision")} due within ${p.decisionsDue.days}d (${money(p.decisionsDue.premium)})`
          : "")
    );
  }

  return lines;
}

/** What was actually won and lost — the outcome the activity counts imply. */
function outcomeLines(p: Progress): string[] {
  const lines: string[] = [];
  for (const w of p.won) {
    lines.push(`Won: ${w.account} ${money(w.premium)}${w.detail ? ` (${w.detail})` : ""}`);
  }
  for (const l of p.lost) {
    lines.push(`Lost: ${l.account} ${money(l.premium)}${l.detail ? ` — ${l.detail}` : ""}`);
  }
  return lines;
}

/** The fixed sentence under the producer block. Never varies. */
const PRODUCER_CAVEAT =
  "CRM writes only — calls, carrier emails, inspections and board meetings leave no record in this system.";

export function renderRollup(input: RollupInput): Rollup {
  const { edition, findings, done, progress, read, reads, truncated, baseUrl } = input;
  const weekend = edition.kind === "weekend";

  const blocks = (weekend
    ? (["exposed"] as const)
    : (["exposed", "closing", "money"] as const)
  )
    .map((k) => blockRows(findings, k))
    .filter((b) => b.rows.length > 0 || b.folded);

  const exposedCount = findings.filter(
    (f) => f.band === "exposed" && f.visibility === "row"
  ).length;
  const closingCount = weekend
    ? 0
    : findings.filter((f) => f.band === "closing" && f.visibility === "row").length;
  const moneyCount = weekend
    ? 0
    : findings.filter((f) => f.band === "money" && f.visibility === "row").length;

  // Non-zero parts only, worst first. A subject that always reads "0 exposed"
  // stops being read, and this is what shows in a phone's notification
  // preview — so it names no audience and no purpose.
  const parts = [
    exposedCount ? `${exposedCount} exposed` : null,
    closingCount ? `${closingCount} closing` : null,
    moneyCount ? `${moneyCount} at risk` : null,
  ].filter(Boolean) as string[];
  const subject = `Ops — ${shortDate(edition.todayDay)} · ${parts.length ? parts.join(" · ") : "all clear"}`;

  const scoreboard = weekend ? [] : scoreboardLines(progress);
  const outcomes = weekend ? [] : outcomeLines(progress);
  const standing = weekend ? null : standingLine(findings);
  const clear = clearLine(findings);
  const done3 = weekend ? [] : doneLines(done);

  const link = (path: string | null): string | null =>
    baseUrl && path ? `${baseUrl}${path}` : null;

  // ── Plain text ───────────────────────────────────────────────────

  const textRow = (f: Finding): string =>
    `  • ${f.subject} — ${f.clause}${f.amount != null ? ` · ${money(f.amount)}` : ""}`;

  const text = [
    `Ops rollup — ${longDate(edition.todayDay)}`,
    weekend ? "Weekend check — open exposures only." : `Covering ${edition.covering}.`,
    "",
    ...(read ? [read, ""] : []),
    ...(scoreboard.length ? ["THE BUSINESS", ...scoreboard.map((l) => `  ${l}`), ""] : []),
    ...blocks.flatMap((b) => [
      `${b.heading.toUpperCase()} (${b.rows.length + (b.overflow || 0)})`,
      ...b.rows.map(textRow),
      b.folded
        ? `  • and ${plural(b.folded.count, "smaller overdue invoice")}, ${money(b.folded.total)}`
        : "",
      b.overflow ? `  • +${b.overflow} more` : "",
      "",
    ]),
    ...(outcomes.length ? ["WON & LOST", ...outcomes.map((l) => `  ${l}`), ""] : []),
    ...(done3.length ? ["DONE", ...done3.map((l) => `  ${l}`), ""] : []),
    ...(!weekend && done.people.length
      ? [
          "WHO MOVED THINGS",
          ...done.people.map(
            (p) =>
              `  • ${p.name} — ${plural(p.accountsTouched, "account")}` +
              (p.quotesAdvanced ? `, ${plural(p.quotesAdvanced, "quote")} advanced` : "") +
              (p.policiesBound ? `, ${plural(p.policiesBound, "bind")}` : "") +
              (p.tasksClosed ? `, ${plural(p.tasksClosed, "task")} closed` : "") +
              ` · 10-day: ${p.trailingAccounts}`
          ),
          done.automatedChanges
            ? `  • Automated — ${plural(done.automatedChanges, "change")}`
            : "",
          done.unmatchedClosers
            ? `  (${done.unmatchedClosers} closed tasks matched no profile)`
            : "",
          `  ${PRODUCER_CAVEAT}`,
          "",
        ]
      : []),
    ...(edition.isMonday && done.quiet.length
      ? [
          "SINCE LAST WEEK",
          ...done.quiet
            .slice(0, 3)
            .map(
              (q) =>
                `  • ${q.name} — no CRM writes in ${plural(q.businessDays, "business day")}${q.beyondScan ? "+" : ""} — worth a check-in?`
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

  const htmlRow = (f: Finding): string => {
    const href = link(f.href);
    const name = escapeHtml(f.subject);
    const label = href
      ? `<a href="${href}" style="color:${NAVY};text-decoration:none;border-bottom:1px solid #cbd5e1">${name}</a>`
      : name;
    return `            <tr>
              <td style="font:600 13px/1.45 ${font};color:${NAVY};padding:9px 10px 9px 14px;border-bottom:1px solid #f1f5f9">${label}
                <div style="font:400 12px/1.45 ${font};color:${SLATE};padding-top:2px">${escapeHtml(f.clause)}</div>
              </td>
              <td align="right" style="font:600 13px/1.45 ${font};color:${f.severity === "red" ? RED : AMBER};padding:9px 14px 9px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap">${f.amount != null ? escapeHtml(money(f.amount)) : ""}</td>
            </tr>`;
  };

  const htmlBlock = (b: Block): string => `
      <tr>
        <td style="padding:24px 0 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            <tr>
              <td style="background:${b.tint};border-left:3px solid ${b.color};padding:10px 14px">
                <div style="font:600 14px/1.3 ${font};color:${b.color}">${escapeHtml(b.heading)} · ${b.rows.length + b.overflow}</div>
                <div style="font:400 12px/1.5 ${font};color:${SLATE};padding-top:2px">${escapeHtml(b.note)}</div>
              </td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:2px">
${b.rows.map(htmlRow).join("\n")}
${
  b.folded
    ? `            <tr><td colspan="2" style="font:400 12px/1.45 ${font};color:${SLATE};padding:9px 14px;border-bottom:1px solid #f1f5f9">and ${plural(b.folded.count, "smaller overdue invoice")}, ${escapeHtml(money(b.folded.total))}</td></tr>`
    : ""
}
${
  b.overflow
    ? `            <tr><td colspan="2" style="font:600 12px/1.45 ${font};color:${MUTED};padding:9px 14px">+${b.overflow} more</td></tr>`
    : ""
}
          </table>
        </td>
      </tr>`;

  const paragraph = (heading: string, lines: string[]): string => `
      <tr>
        <td style="padding:24px 0 0">
          <div style="font:600 11px/1.4 ${font};color:${MUTED};text-transform:uppercase;letter-spacing:.05em;padding-bottom:6px">${escapeHtml(heading)}</div>
${lines
  .map(
    (l) =>
      `          <div style="font:400 13px/1.6 ${font};color:#334155;padding:2px 0">${escapeHtml(l)}</div>`
  )
  .join("\n")}
        </td>
      </tr>`;

  const peopleRows = done.people.map((p) => {
    const detail = [
      plural(p.accountsTouched, "account"),
      p.quotesAdvanced ? `${plural(p.quotesAdvanced, "quote")} advanced` : "",
      p.policiesBound ? `${plural(p.policiesBound, "bind")}` : "",
      p.tasksClosed ? `${plural(p.tasksClosed, "task")} closed` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `            <tr>
              <td style="font:600 13px/1.5 ${font};color:${NAVY};padding:6px 10px 6px 0;white-space:nowrap">${escapeHtml(p.name)}</td>
              <td style="font:400 13px/1.5 ${font};color:#334155;padding:6px 10px 6px 0">${escapeHtml(detail)}</td>
              <td align="right" style="font:400 12px/1.5 ${font};color:${MUTED};padding:6px 0;white-space:nowrap">10-day: ${p.trailingAccounts}</td>
            </tr>`;
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08)">
        <tr>
          <td style="background:${NAVY};padding:22px 28px">
            <div style="font:700 17px/1.3 ${font};color:#ffffff">Ops rollup</div>
            <div style="font:400 13px/1.5 ${font};color:#a9bcd8;padding-top:3px">${escapeHtml(longDate(edition.todayDay))} · ${escapeHtml(weekend ? "weekend check — open exposures only" : `covering ${edition.covering}`)}</div>
          </td>
        </tr>
${
  read
    ? `        <tr><td style="padding:22px 28px 0">
          <div style="font:400 14px/1.65 ${font};color:#1e293b;border-left:3px solid ${NAVY};padding:2px 0 2px 14px">${escapeHtml(read)}</div>
        </td></tr>`
    : ""
}
        <tr><td style="padding:0 28px 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${scoreboard.length ? paragraph("The business", scoreboard) : ""}
${blocks.map(htmlBlock).join("\n")}
${outcomes.length ? paragraph(`Won & lost · ${edition.covering}`, outcomes) : ""}
${done3.length ? paragraph(`Done · ${edition.covering}`, done3) : ""}
${
  !weekend && peopleRows.length
    ? `      <tr>
        <td style="padding:24px 0 0">
          <div style="font:600 11px/1.4 ${font};color:${MUTED};text-transform:uppercase;letter-spacing:.05em;padding-bottom:6px">Who moved things</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${peopleRows.join("\n")}
${
  done.automatedChanges
    ? `            <tr><td colspan="3" style="font:400 13px/1.5 ${font};color:${MUTED};padding:6px 0">Automated — ${plural(done.automatedChanges, "change")}</td></tr>`
    : ""
}
          </table>
${
  done.unmatchedClosers
    ? `          <div style="font:400 12px/1.5 ${font};color:${MUTED};padding-top:4px">${done.unmatchedClosers} closed ${done.unmatchedClosers === 1 ? "task" : "tasks"} matched no profile and are counted for nobody.</div>`
    : ""
}
          <div style="font:400 12px/1.55 ${font};color:${SLATE};padding-top:8px">${escapeHtml(PRODUCER_CAVEAT)}</div>
        </td>
      </tr>`
    : ""
}
${
  edition.isMonday && done.quiet.length
    ? paragraph(
        "Since last week",
        done.quiet
          .slice(0, 3)
          .map(
            (q) =>
              `${q.name} — no CRM writes in ${plural(q.businessDays, "business day")}${q.beyondScan ? "+" : ""} — worth a check-in?`
          )
      )
    : ""
}
          </table>
        </td></tr>
${
  standing
    ? `        <tr><td style="padding:22px 28px 0">
          <div style="font:400 12px/1.6 ${font};color:${SLATE};background:#f8fafc;border-radius:6px;padding:10px 12px">Standing: ${escapeHtml(standing)}</div>
        </td></tr>`
    : ""
}
${
  baseUrl
    ? `        <tr><td style="padding:22px 28px 0">
          <a href="${baseUrl}/" style="display:inline-block;background:${NAVY};color:#ffffff;font:600 14px/1 ${font};text-decoration:none;padding:13px 22px;border-radius:6px">Open the CRM</a>
        </td></tr>`
    : ""
}
        <tr>
          <td style="padding:22px 28px 26px">
            <div style="border-top:1px solid #e2e8f0;padding-top:14px;font:400 12px/1.6 ${font};color:${MUTED}">
              ${escapeHtml(clear)}<br>
              Read ${Object.entries(reads).map(([k, v]) => `${v.toLocaleString("en-US")} ${k}`).join(", ")}.${truncated ? " A read hit its page cap — counts above may under-report." : ""}<br>
              Silence here means no record was written, not that nobody acted: ${escapeHtml(AGENCY.name)}'s CRM has no call or email log. The dashboard's Needs-attention queue is the unfiltered version of the lists above.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
