import { AGENCY } from "../../../../shared/agency";
import { LICENSE_CLASS_LABELS } from "../../../src/lib/enums";

/**
 * Which licences are due a reminder today, and what the email says.
 *
 * Pure — no data client, no SES — so the rule that decides who gets emailed
 * is testable without mocking either. `handler.ts` does the reading, the
 * sending and the ledger writes.
 *
 * ## Day arithmetic
 *
 * Day strings only, compared lexicographically, never a days-until number.
 * That is the rule `src/lib/client.ts` argues for at length: `expirationDate`
 * is a bare `a.date()` with no zone attached, so the only honest comparison
 * is against another day string, and ISO days sort correctly as text. The UI
 * computes a number because it renders one to a person ("30d left") from the
 * *reader's* midnight; nothing here is rendered live, so there is nothing to
 * take a local calendar from and no counterpart rule to mirror.
 *
 * "Today" is the UTC day, as in `renewal-tasks`. The job runs at 06:00
 * Eastern — 10:00 or 11:00 UTC — so the UTC day and the Eastern day are the
 * same day at the moment it runs, whichever side of DST it lands on.
 */

/**
 * The reminder ladder, tightest last.
 *
 * 60 and 30 are the amber and red rungs of `LICENSE_EXPIRY_SCALE`, so an
 * email and the badge on the Licensing screen change on the same day. 3 has
 * no badge behind it: it is the "this is now today's problem" nudge, and a
 * fourth colour on the screen would say less than a fourth email does.
 */
export const REMINDER_DAYS = [60, 30, 3] as const;

/** Statuses that fall through to the date ladder, per `licenseHealth`. */
const LIVE_STATUSES = new Set(["ACTIVE", "PENDING"]);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar day of an instant. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** `addDays("2026-08-06", 30)` → `"2026-09-05"`. */
export const addDays = (day: string, n: number): string => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

/** The fields the rule reads. Structural, so a `Schema` row satisfies it. */
export interface LicenseLike {
  id: string;
  holderType?: string | null;
  holderName?: string | null;
  state?: string | null;
  licenseNumber?: string | null;
  licenseClass?: string | null;
  status?: string | null;
  expirationDate?: string | null;
}

export interface Reminder {
  licenseId: string;
  /** Which rung of {@link REMINDER_DAYS} this is. */
  threshold: number;
  expirationDate: string;
  /** The date is already behind us — the notice is a miss, not a warning. */
  expired: boolean;
  dedupeKey: string;
  line: string;
}

/**
 * `"<licenseId>:<expirationDate>:<threshold>"`.
 *
 * The expiration date is in the key on purpose: renewing a licence moves the
 * date, which mints three fresh keys and re-arms the whole ladder for the new
 * term. Keying on the licence alone would silence it forever after one cycle.
 */
export const dedupeKeyFor = (
  licenseId: string,
  expirationDate: string,
  threshold: number
) => `${licenseId}:${expirationDate}:${threshold}`;

/**
 * The tightest rung this licence has reached, or `null` for nothing due.
 *
 * Tightest rather than every rung reached, because a licence entered with
 * five days left has "reached" 60 and 30 without either ever having been a
 * useful thing to say. It gets one email, filed under 30 — true, and the
 * exact date is on the line — and the 3-day notice still fires two days
 * later, because that rung is separately keyed and still unsent.
 */
export function reminderThreshold(
  license: LicenseLike,
  today: string
): number | null {
  const { status, expirationDate } = license;
  // A LAPSED or INACTIVE licence is already red on the Licensing screen and
  // already known-bad. Counting down to the expiry of something that stopped
  // being usable months ago is noise in a shared inbox.
  if (status && !LIVE_STATUSES.has(status)) return null;
  if (!expirationDate || !ISO_DAY.test(expirationDate)) return null;

  let tightest: number | null = null;
  for (const days of REMINDER_DAYS) {
    if (expirationDate <= addDays(today, days)) tightest = days;
  }
  return tightest;
}

/** `"MA · Producer · Jane Doe · #1234567 · expires 2026-09-05"` */
function lineFor(l: LicenseLike): string {
  const holder =
    l.holderName?.trim() ||
    (l.holderType === "FIRM" ? AGENCY.name : "unassigned producer");
  const cls = l.licenseClass ? LICENSE_CLASS_LABELS[l.licenseClass] : null;
  return [
    l.state ?? "??",
    cls,
    holder,
    l.licenseNumber ? `#${l.licenseNumber}` : null,
    `expires ${l.expirationDate}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Every reminder owed today, tightest rung first. Callers drop the ones
 * already in the ledger.
 */
export function dueReminders(
  licenses: LicenseLike[],
  today: string
): Reminder[] {
  const out: Reminder[] = [];
  for (const l of licenses) {
    const threshold = reminderThreshold(l, today);
    if (threshold == null) continue;
    // Non-null by construction: a threshold is only returned for a licence
    // whose expirationDate parsed as a day string.
    const expirationDate = l.expirationDate as string;
    out.push({
      licenseId: l.id,
      threshold,
      expirationDate,
      expired: expirationDate < today,
      dedupeKey: dedupeKeyFor(l.id, expirationDate, threshold),
      line: lineFor(l),
    });
  }
  // Worst first, so the subject line and the top of the email agree.
  return out.sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
}

/** The email's sections, worst first. Empty ones are dropped by the caller. */
const SECTIONS: { heading: string; match: (r: Reminder) => boolean }[] = [
  { heading: "Already expired", match: (r) => r.expired },
  { heading: "Expiring within 3 days", match: (r) => !r.expired && r.threshold === 3 },
  { heading: "Expiring within 30 days", match: (r) => r.threshold === 30 },
  { heading: "Expiring within 60 days", match: (r) => r.threshold === 60 },
];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/**
 * Subject, text body and HTML body for one run's worth of reminders.
 *
 * One digest rather than an email per licence: the recipient is a shared
 * inbox, and a renewal cycle that lands four licences in the same week should
 * be four lines someone reads once, not four threads someone triages.
 */
export function renderDigest(reminders: Reminder[]): {
  subject: string;
  text: string;
  html: string;
} {
  const groups = SECTIONS.map((s) => ({
    heading: s.heading,
    rows: reminders.filter(s.match),
  })).filter((g) => g.rows.length > 0);

  const subject = `License expirations — ${groups
    .map((g) => `${g.rows.length} ${g.heading.toLowerCase()}`)
    .join(", ")}`;

  const text = groups
    .map((g) => `${g.heading}\n${g.rows.map((r) => `  • ${r.line}`).join("\n")}`)
    .join("\n\n");

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px">
  <h2 style="color:#142a4c;margin:0 0 4px">License renewals</h2>
  <p style="color:#64748b;font-size:13px;margin:0 0 20px">Each licence below is reported once per deadline. Renew it in the CRM under Settings → Licensing and this stops.</p>
${groups
  .map(
    (g) => `  <h3 style="color:#142a4c;font-size:15px;margin:20px 0 6px">${escapeHtml(g.heading)}</h3>
  <ul style="margin:0;padding-left:20px;color:#334155;font-size:14px;line-height:1.7">
${g.rows.map((r) => `    <li>${escapeHtml(r.line)}</li>`).join("\n")}
  </ul>`
  )
  .join("\n")}
</div>`;

  return { subject, text, html };
}
