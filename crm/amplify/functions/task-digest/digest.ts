import { AGENCY } from "../../../../shared/agency";

/**
 * The weekday task digest: which open marketing tasks are outstanding, and
 * what the email says about them.
 *
 * Pure — no data client, no SES — so the grouping rule is testable without
 * mocking either. `handler.ts` does the reading and the sending.
 *
 * ## Scope
 *
 * Open `MarketingTask` rows only: the work on the Tasks screen. Licence
 * renewals are deliberately absent even though they are also outstanding
 * work — `license-alerts` already emails the same inbox about those on its
 * own ladder, and a second daily mail repeating them would train the reader
 * to skim both.
 *
 * ## Day arithmetic
 *
 * Day strings compared lexicographically, never a days-until number — the
 * same rule `license-alerts/digest.ts` sets out. `submitBy` is a bare
 * `a.date()` with no zone attached, so the only honest comparison is against
 * another day string, and ISO days sort correctly as text. The screen renders
 * a number ("11d past submit-by") because it is counting from the reader's
 * own midnight; nothing here is rendered live.
 *
 * "Today" is the UTC day. The job runs at 07:00 Eastern — 11:00 or 12:00 UTC
 * — so the UTC day and the Eastern day are the same day at the moment it
 * runs, on either side of DST.
 */

/**
 * The rungs, in days to the submit-by date.
 *
 * These are `MARKETING_SUBMIT_SCALE`'s `urgent` and `soon` thresholds, so the
 * email and the badge on the Tasks screen change on the same day. They are
 * restated rather than imported: the scale lives in `badges.tsx`, and pulling
 * a TSX module into a Lambda bundle would drag React in behind it.
 * `taskDigest.test.ts` asserts the two stay equal.
 */
export const URGENT_DAYS = 7;
export const SOON_DAYS = 21;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar day of an instant. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** `addDays("2026-08-06", 7)` → `"2026-08-13"`. */
export const addDays = (day: string, n: number): string => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

/** Whole days from `today` to `day`; negative once the day is behind us. */
export const daysBetween = (today: string, day: string): number =>
  Math.round(
    (Date.parse(day + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000
  );

/** The fields the rule reads. Structural, so a `Schema` row satisfies it. */
export interface TaskLike {
  id: string;
  accountId?: string | null;
  accountName?: string | null;
  carrierName?: string | null;
  lines?: (string | null)[] | null;
  expirationDate?: string | null;
  submitBy?: string | null;
  status?: string | null;
}

export type Bucket = "overdue" | "urgent" | "soon" | "later" | "undated";

export interface DigestRow {
  task: TaskLike;
  bucket: Bucket;
  /** Days to submit-by; negative when past. Null when there is no date. */
  days: number | null;
  account: string;
  carrier: string;
  lines: string;
  expires: string;
  submitBy: string;
  /** "11 days past" / "in 4 days" / "no submit-by date". */
  timing: string;
}

const day = (v: unknown): string | null =>
  typeof v === "string" && ISO_DAY.test(v) ? v : null;

/**
 * Which rung a task sits on.
 *
 * A task with no `submitBy` gets its own bucket rather than being dropped or
 * sorted to the bottom of "later". The sweep sets that date from the carrier's
 * lead time, so a missing one means the carrier has no lead time recorded —
 * the task is real, its deadline is simply unknown, and quietly filing it
 * under "later" would be the digest asserting something it does not know.
 */
export function bucketFor(submitBy: string | null, today: string): Bucket {
  if (!submitBy) return "undated";
  if (submitBy < today) return "overdue";
  if (submitBy <= addDays(today, URGENT_DAYS)) return "urgent";
  if (submitBy <= addDays(today, SOON_DAYS)) return "soon";
  return "later";
}

function timingFor(bucket: Bucket, days: number | null): string {
  if (days === null) return "no submit-by date";
  if (bucket === "overdue") {
    const n = Math.abs(days);
    return `${n} day${n === 1 ? "" : "s"} past`;
  }
  if (days === 0) return "due today";
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Every open task, bucketed and sorted — soonest deadline first inside each
 * bucket, undated last. Completed tasks are dropped here rather than in the
 * handler so the rule is visible next to the rest of the grouping.
 */
export function digestRows(tasks: TaskLike[], today: string): DigestRow[] {
  const rows: DigestRow[] = [];
  for (const t of tasks) {
    if (t.status !== "OPEN") continue;
    const submitBy = day(t.submitBy);
    const bucket = bucketFor(submitBy, today);
    const days = submitBy ? daysBetween(today, submitBy) : null;
    rows.push({
      task: t,
      bucket,
      days,
      account: t.accountName?.trim() || "(unnamed account)",
      carrier: t.carrierName?.trim() || "—",
      lines: (t.lines ?? []).filter(Boolean).join(", ") || "—",
      expires: day(t.expirationDate) ?? "—",
      submitBy: submitBy ?? "—",
      timing: timingFor(bucket, days),
    });
  }
  return rows.sort((a, b) => {
    if (a.submitBy === "—") return b.submitBy === "—" ? 0 : 1;
    if (b.submitBy === "—") return -1;
    return a.submitBy.localeCompare(b.submitBy);
  });
}

/** Section order is worst-first, which is also reading order. */
const SECTIONS: {
  bucket: Bucket;
  heading: string;
  /** Body colour and the tint behind the section's header row. */
  color: string;
  tint: string;
  note: string;
}[] = [
  {
    bucket: "overdue",
    heading: "Past submit-by",
    color: "#b3392e",
    tint: "#fde8e6",
    note: "The submission window has closed. Submit or close these with a reason.",
  },
  {
    bucket: "urgent",
    heading: `Due within ${URGENT_DAYS} days`,
    color: "#b3392e",
    tint: "#fde8e6",
    note: "This week's submissions.",
  },
  {
    bucket: "soon",
    heading: `Due within ${SOON_DAYS} days`,
    color: "#92600a",
    tint: "#fdf1da",
    note: "Coming up — worth starting on the paperwork.",
  },
  {
    bucket: "later",
    heading: "Later",
    color: "#187a4b",
    tint: "#e3f5ec",
    note: "Open, but not yet inside the submission window.",
  },
  {
    bucket: "undated",
    heading: "No submit-by date",
    color: "#475569",
    tint: "#f1f5f9",
    note: "The carrier has no lead time recorded, so no deadline could be worked out.",
  },
];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/** "Thursday, 13 August 2026" — spelled out, since the subject carries no date. */
function longDate(today: string): string {
  return new Date(today + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface Digest {
  subject: string;
  text: string;
  html: string;
}

/**
 * Subject, plain-text body and HTML body for one day's outstanding tasks.
 *
 * The HTML is table-based with inline styles and no web fonts, because that
 * is what survives Outlook and Gmail's stripping. Nothing here is responsive
 * beyond a max-width — a fixed 640px column is the one layout every client
 * renders the same way.
 *
 * `baseUrl` is the CRM's origin, used for the deep links. Rows link straight
 * to the account's quotes tab, which is where the submission is recorded, so
 * the email is a worklist rather than a notification.
 */
export function renderDigest(
  rows: DigestRow[],
  today: string,
  baseUrl?: string
): Digest {
  const groups = SECTIONS.map((s) => ({
    ...s,
    rows: rows.filter((r) => r.bucket === s.bucket),
  })).filter((g) => g.rows.length > 0);

  const overdue = rows.filter((r) => r.bucket === "overdue").length;
  const urgent = rows.filter((r) => r.bucket === "urgent").length;

  // Named worst-first, and only the parts that are non-zero — a subject that
  // always reads "0 past submit-by" stops being read.
  const headline = [
    overdue > 0 ? `${overdue} past submit-by` : null,
    urgent > 0 ? `${urgent} due within ${URGENT_DAYS} days` : null,
  ].filter(Boolean);
  const subject =
    `Marketing tasks — ` +
    (headline.length ? headline.join(", ") : `${rows.length} open`);

  const text = [
    `Outstanding marketing tasks — ${longDate(today)}`,
    `${rows.length} open in total.`,
    "",
    ...groups.map((g) =>
      [
        `${g.heading.toUpperCase()} (${g.rows.length})`,
        ...g.rows.map(
          (r) =>
            `  • ${r.account} · ${r.carrier} · submit by ${r.submitBy} (${r.timing})`
        ),
      ].join("\n")
    ),
    "",
    baseUrl ? `Work through them: ${baseUrl}/tasks` : "",
  ]
    .join("\n")
    .trimEnd();

  const tasksUrl = baseUrl ? `${baseUrl}/tasks` : null;

  const section = (g: (typeof groups)[number]) => `
      <tr>
        <td style="padding:26px 0 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            <tr>
              <td style="background:${g.tint};border-left:3px solid ${g.color};padding:10px 14px">
                <div style="font:600 14px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${g.color}">
                  ${escapeHtml(g.heading)} · ${g.rows.length}
                </div>
                <div style="font:400 12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#64748b;padding-top:2px">
                  ${escapeHtml(g.note)}
                </div>
              </td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:2px">
            <tr>
              <th align="left" style="font:600 11px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px 6px 14px;border-bottom:1px solid #e2e8f0">Account</th>
              <th align="left" style="font:600 11px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px 6px;border-bottom:1px solid #e2e8f0">Carrier</th>
              <th align="left" style="font:600 11px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px 6px;border-bottom:1px solid #e2e8f0;white-space:nowrap">Submit by</th>
            </tr>
${g.rows
  .map((r) => {
    const name = escapeHtml(r.account);
    const label =
      tasksUrl && r.task.accountId
        ? `<a href="${baseUrl}/accounts/${encodeURIComponent(r.task.accountId)}?tab=quotes" style="color:#142a4c;text-decoration:none;border-bottom:1px solid #cbd5e1">${name}</a>`
        : name;
    return `            <tr>
              <td style="font:600 13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#142a4c;padding:9px 10px 9px 14px;border-bottom:1px solid #f1f5f9">${label}
                <div style="font:400 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8;padding-top:1px">${escapeHtml(r.lines)}</div>
              </td>
              <td style="font:400 13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#334155;padding:9px 10px;border-bottom:1px solid #f1f5f9">${escapeHtml(r.carrier)}</td>
              <td style="font:400 13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#334155;padding:9px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap">${escapeHtml(r.submitBy)}
                <div style="font:600 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${g.color};padding-top:1px">${escapeHtml(r.timing)}</div>
              </td>
            </tr>`;
  })
  .join("\n")}
          </table>
        </td>
      </tr>`;

  // The charset declaration is load-bearing, not boilerplate: the copy below
  // uses "·" and "—", and a client that defaults to windows-1252 renders them
  // as "Â·" and "â€”". Belt and braces with the Charset on the SES envelope —
  // some clients read the meta, some the MIME header, and neither is reliably
  // the one that wins.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08)">
        <tr>
          <td style="background:#142a4c;padding:22px 28px">
            <div style="font:700 17px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff">Outstanding marketing tasks</div>
            <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#a9bcd8;padding-top:3px">${escapeHtml(longDate(today))}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 28px 4px">
            <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              <tr>
                <td style="padding-right:26px">
                  <div style="font:700 26px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#142a4c">${rows.length}</div>
                  <div style="font:400 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#64748b;padding-top:3px">open</div>
                </td>
                <td style="padding-right:26px">
                  <div style="font:700 26px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${overdue ? "#b3392e" : "#142a4c"}">${overdue}</div>
                  <div style="font:400 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#64748b;padding-top:3px">past submit-by</div>
                </td>
                <td>
                  <div style="font:700 26px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${urgent ? "#92600a" : "#142a4c"}">${urgent}</div>
                  <div style="font:400 12px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#64748b;padding-top:3px">due within ${URGENT_DAYS} days</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="padding:0 28px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${groups.map(section).join("\n")}
          </table>
        </td></tr>
${
  tasksUrl
    ? `        <tr><td style="padding:26px 28px 4px">
          <a href="${tasksUrl}" style="display:inline-block;background:#142a4c;color:#ffffff;font:600 14px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;text-decoration:none;padding:13px 22px;border-radius:6px">Open the task list</a>
        </td></tr>`
    : ""
}
        <tr>
          <td style="padding:22px 28px 26px">
            <div style="border-top:1px solid #e2e8f0;padding-top:14px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#94a3b8">
              Sent each weekday morning by ${escapeHtml(AGENCY.name)}'s CRM. A task closes on its own once a quote is recorded for that carrier — otherwise close it on the Tasks screen and say why. License renewals are reported separately.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
