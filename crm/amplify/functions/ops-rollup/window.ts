/**
 * Which slice of time one rollup covers, and how a stored date is compared
 * against it.
 *
 * Pure and clock-free: every function takes the instant or the day it works
 * from. `handler.ts` passes `new Date()` once, at the top, and nothing below
 * reads a clock — the same rule `attention.ts` follows, and the reason a
 * Monday edition or a spring-forward morning can be asserted in a test rather
 * than waited for.
 *
 * ── Two clocks, deliberately ──
 *
 * The schema stores two different kinds of "when", and conflating them is the
 * bug this module exists to prevent.
 *
 * `a.date()` fields — `Invoice.dueAt`, `MarketingTask.submitBy`,
 * `Policy.expirationDate`, `License.expirationDate` — are bare days with no
 * zone attached. The only honest comparison is against another day string, so
 * they are compared lexicographically, exactly as `task-digest/digest.ts` sets
 * out. Nothing here parses them into an instant.
 *
 * `a.datetime()` fields — `Activity.occurredAt`, `Policy.datePolicyBound`,
 * `Invoice.sentAt`, every `PfLoan` stamp — are real instants, and those need a
 * real window with real boundaries.
 *
 * ── Why Eastern, and why that is new here ──
 *
 * The existing scheduled jobs take the UTC day as "today" and say why they can:
 * they run at 06:00–07:00 Eastern, which is 10:00–12:00 UTC, so the two agree
 * at the moment they run. That shortcut is sound for a *snapshot* of open work
 * and unsound for a *window* over timestamps. A rollup covering "yesterday" on
 * UTC boundaries reports work done between roughly 20:00 Eastern and midnight
 * as belonging to the following day — so a producer's Monday evening lands in
 * Tuesday's email, and Friday evening's bind is reported after the weekend.
 *
 * The agency is in Marlborough, Massachusetts and everyone reading this works
 * Eastern hours, so Eastern civil days are the ones the reader means.
 */

/** The agency's operating timezone. Every civil day below is one of these. */
const ET = "America/New_York";

/** `en-CA` because its short date format is already `YYYY-MM-DD`. */
const ET_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: ET });
const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hour: "2-digit",
  hour12: false,
});

/** The Eastern civil day an instant falls on, as `YYYY-MM-DD`. */
export const etDay = (t: Date): string => ET_DAY.format(t);

/** The Eastern local hour of an instant, 0–23. */
const etHour = (t: Date): number => Number(ET_HOUR.format(t));

/**
 * The instant midnight begins on Eastern civil day `day`.
 *
 * Eastern is UTC-5 or UTC-4 depending on the season, so exactly one of two
 * candidates is right — and which one is *checked* rather than assumed, by
 * formatting the candidate back and requiring it to land on `day` at hour
 * zero. That check is what makes the two transition days safe: the spring
 * gap is at 02:00, so 00:00 exists normally, and on the fall-back day the
 * UTC-4 candidate is the one whose Eastern hour reads 0.
 *
 * Throws rather than guessing. A wrong midnight silently mis-buckets a whole
 * day of work, which is worse than a run that fails loudly and retries.
 */
export function etMidnight(day: string): Date {
  for (const offset of ["05", "04"]) {
    const candidate = new Date(`${day}T${offset}:00:00Z`);
    if (etDay(candidate) === day && etHour(candidate) === 0) return candidate;
  }
  throw new Error(`ops-rollup: cannot resolve Eastern midnight for ${day}`);
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real calendar day, decided by arithmetic alone.
 *
 * Same rule as `client.ts`'s private copy: no `new Date()`, so no timezone can
 * shift the answer, and `2026-02-30` is rejected rather than rolling into
 * March the way `Date.parse` would.
 */
export function isIsoDay(v: string): boolean {
  const m = ISO_DAY_RE.exec(v);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

/**
 * The leading day of any stored value, or null if there isn't one.
 *
 * Takes `YYYY-MM-DD` literally and ignores everything after position 10, so a
 * datetime downcasts to its nominal UTC day. That is the same downcast the
 * `.slice(0, 10)` call sites throughout the app already perform, and it is
 * deliberately NOT an Eastern conversion: a stored `a.date()` has no zone to
 * convert from, and re-zoning it would move dates the user typed.
 */
export const dayOf = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const day = String(v).trim().slice(0, 10);
  return isIsoDay(day) ? day : null;
};

const DAY_MS = 86_400_000;

/** Midnight UTC of a day string, for day-to-day arithmetic only. */
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** `addDays("2026-08-25", -3)` → `"2026-08-22"`. */
export function addDays(day: string, n: number): string {
  return new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole civil days from `from` to `to`; negative once `to` is behind. */
export const daysBetweenDays = (from: string, to: string): number =>
  Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

/**
 * The `daysUntil` that `dashboardStats` and `attention` take as a parameter,
 * anchored on an explicit Eastern today instead of the machine clock.
 *
 * The app's own `daysUntil` lives in `src/lib/client.ts`, which calls
 * `generateClient()` at module scope — importing it would pull the browser
 * data client into this bundle. Restating it is the same trade `task-digest`
 * makes for `URGENT_DAYS`, and it buys the more important property: in a
 * Lambda "local midnight" is UTC midnight, so the app's version would answer
 * a different question here than it does in the browser.
 */
export const daysUntilFrom =
  (today: string) =>
  (d: string | null | undefined): number | null => {
    const day = dayOf(d);
    return day === null ? null : daysBetweenDays(today, day);
  };

/** 0 = Sunday … 6 = Saturday, for a day string. */
export const weekdayOf = (day: string): number => new Date(dayMs(day)).getUTCDay();

const isWeekend = (day: string): boolean => {
  const w = weekdayOf(day);
  return w === 0 || w === 6;
};

/**
 * Business days elapsed over the half-open range `[from, to)`.
 *
 * Monday to Tuesday is 1. Friday to Monday is 1 — the weekend contributes
 * nothing, which is the point: every threshold in `detect.ts` that counts
 * "days nobody acted" should not accuse anyone of ignoring a Saturday.
 *
 * Observes no holidays. A holiday table is configuration, and configuration
 * has to live somewhere staff can read it — which is the one thing this
 * feature cannot have (see `resource.ts`). The cost is that these thresholds
 * read a day or two "fast" across Thanksgiving and Christmas weeks.
 */
export function businessDaysBetween(from: string, to: string): number {
  if (daysBetweenDays(from, to) <= 0) return 0;
  let count = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    if (!isWeekend(d)) count += 1;
  }
  return count;
}

/** Business days from a stored day to today; 0 for anything unparseable. */
export const businessDaysSince = (
  v: string | null | undefined,
  today: string
): number => {
  const day = dayOf(v);
  return day === null ? 0 : businessDaysBetween(day, today);
};

/**
 * How much of the past one edition speaks for, and what it is allowed to say.
 *
 * `kind` drives the whole email:
 *
 * - `weekday` — Tuesday to Friday. Covers the previous civil day, prints every
 *   section, and sends even when nothing is wrong.
 * - `monday` — covers Friday, Saturday and Sunday as one 72-hour block, so
 *   the weekend is reported rather than skipped, and expands the sections that
 *   are compressed to a counter the rest of the week.
 * - `weekend` — reports nothing that happened and only the findings that mean
 *   coverage or money is actually at risk right now, and stays silent when
 *   there are none. A Saturday email that says "all clear" every week is how a
 *   reader learns to archive the one that doesn't.
 */
export interface Edition {
  kind: "weekday" | "monday" | "weekend";
  /** The Eastern civil day the job is running on. */
  todayDay: string;
  /** First day the reporting window covers; null on a weekend edition. */
  windowStartDay: string | null;
  /** Half-open window over real instants: `[startMs, endMs)`. */
  windowStartMs: number;
  windowEndMs: number;
  /** "Monday" / "Friday–Sunday" — what the header says it covers. */
  covering: string;
  /** Monday expands rows the other weekdays fold into the standing line. */
  isMonday: boolean;
  /** Whether an edition with no findings is still worth sending. */
  sendsWhenClear: boolean;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * The edition for the instant the job woke up.
 *
 * The window is derived from the calendar rather than from a record of the
 * last send, which is what lets this feature keep no state at all (see
 * `resource.ts` on why it must not). The cost is that a missed run leaves a
 * hole no later run backfills — mitigated by the grace bands in `detect.ts`,
 * which keep a finding visible for three days rather than exactly one.
 */
export function editionFor(now: Date): Edition {
  const todayDay = etDay(now);
  const weekday = weekdayOf(todayDay);
  const endMs = etMidnight(todayDay).getTime();

  if (weekday === 0 || weekday === 6) {
    return {
      kind: "weekend",
      todayDay,
      windowStartDay: null,
      windowStartMs: endMs,
      windowEndMs: endMs,
      covering: WEEKDAY_NAMES[weekday],
      isMonday: false,
      sendsWhenClear: false,
    };
  }

  // Monday reaches back over the weekend to Friday's midnight, so nothing
  // that happened between Friday morning and Monday morning goes unreported.
  const back = weekday === 1 ? 3 : 1;
  const windowStartDay = addDays(todayDay, -back);

  return {
    kind: weekday === 1 ? "monday" : "weekday",
    todayDay,
    windowStartDay,
    windowStartMs: etMidnight(windowStartDay).getTime(),
    windowEndMs: endMs,
    covering:
      back === 1
        ? WEEKDAY_NAMES[weekdayOf(windowStartDay)]
        : `${WEEKDAY_NAMES[weekdayOf(windowStartDay)]}–${WEEKDAY_NAMES[weekdayOf(addDays(todayDay, -1))]}`,
    isMonday: weekday === 1,
    sendsWhenClear: true,
  };
}

/** Whether a stored timestamp falls inside the edition's window. */
export const inWindow = (
  v: string | null | undefined,
  edition: Edition
): boolean => {
  if (!v) return false;
  const t = Date.parse(v);
  return (
    Number.isFinite(t) && t >= edition.windowStartMs && t < edition.windowEndMs
  );
};
