import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addDays,
  businessDaysBetween,
  dayOf,
  daysBetweenDays,
  daysUntilFrom,
  editionFor,
  etDay,
  etMidnight,
  inWindow,
  isIsoDay,
} from "../../amplify/functions/ops-rollup/window";

/**
 * The rollup's clock.
 *
 * Everything the email says about "yesterday" rests on these boundaries. Get
 * them wrong and the report is still perfectly readable — it just credits
 * Monday evening's work to Tuesday, or loses the weekend entirely, and nobody
 * would notice from the email itself.
 */

describe("Eastern civil days", () => {
  it("reads the Eastern day, not the UTC day, late in the evening", () => {
    // 01:30 UTC on the 26th is 21:30 Eastern on the 25th. The existing jobs
    // get away with the UTC day because they run mid-morning; a window over
    // timestamps does not.
    expect(etDay(new Date("2026-08-26T01:30:00Z"))).toBe("2026-08-25");
    expect(etDay(new Date("2026-08-25T16:00:00Z"))).toBe("2026-08-25");
  });

  it("resolves midnight on both sides of the DST changes", () => {
    // Summer: Eastern is UTC-4, so midnight is 04:00Z.
    expect(etMidnight("2026-08-25").toISOString()).toBe("2026-08-25T04:00:00.000Z");
    // Winter: UTC-5, so 05:00Z.
    expect(etMidnight("2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  /**
   * The two days a naive offset gets wrong. The spring gap is at 02:00, so
   * 00:00 exists normally; on the fall-back day both candidates land on the
   * right date and only one reads as hour zero.
   */
  it("resolves midnight on the transition days themselves", () => {
    expect(etMidnight("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(etMidnight("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    for (const day of ["2026-03-08", "2026-11-01"]) {
      expect(etDay(etMidnight(day))).toBe(day);
    }
  });
});

describe("day parsing", () => {
  it("rejects a day that does not exist", () => {
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("2026-13-01")).toBe(false);
    expect(isIsoDay("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isIsoDay("2024-02-29")).toBe(true);
  });

  it("takes the leading day of a datetime literally", () => {
    expect(dayOf("2026-08-25T23:59:00.000Z")).toBe("2026-08-25");
    expect(dayOf("2026-08-25")).toBe("2026-08-25");
    expect(dayOf("")).toBe(null);
    expect(dayOf(null)).toBe(null);
    expect(dayOf("not a date")).toBe(null);
  });

  it("counts civil days without a clock", () => {
    expect(daysBetweenDays("2026-08-25", "2026-09-01")).toBe(7);
    expect(daysBetweenDays("2026-08-25", "2026-08-18")).toBe(-7);
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("is stable across a DST change", () => {
    expect(addDays("2026-03-07", 7)).toBe("2026-03-14");
    expect(daysBetweenDays("2026-10-31", "2026-11-07")).toBe(7);
  });
});

describe("daysUntil anchored on an explicit today", () => {
  const daysUntil = daysUntilFrom("2026-08-25");

  it("matches the app's sign convention: future positive, past negative", () => {
    expect(daysUntil("2026-08-28")).toBe(3);
    expect(daysUntil("2026-08-22")).toBe(-3);
    expect(daysUntil("2026-08-25")).toBe(0);
  });

  it("returns null rather than NaN for anything unparseable", () => {
    // The app's own daysUntil made this change deliberately: NaN slipped
    // through a `days == null` guard and rendered as "NaNd left".
    expect(daysUntil("garbage")).toBe(null);
    expect(daysUntil(null)).toBe(null);
    expect(daysUntil(undefined)).toBe(null);
  });
});

describe("business days", () => {
  it("skips the weekend", () => {
    // Friday 21st → Monday 24th is one business day (the Friday).
    expect(businessDaysBetween("2026-08-21", "2026-08-24")).toBe(1);
    // Monday → Tuesday is one.
    expect(businessDaysBetween("2026-08-24", "2026-08-25")).toBe(1);
    // A full week is five.
    expect(businessDaysBetween("2026-08-17", "2026-08-24")).toBe(5);
  });

  it("is zero for a range that has not opened", () => {
    expect(businessDaysBetween("2026-08-25", "2026-08-25")).toBe(0);
    expect(businessDaysBetween("2026-08-26", "2026-08-25")).toBe(0);
  });
});

describe("editions", () => {
  /** 2026-08-25 is a Tuesday; 08-24 Monday; 08-22 Saturday. */
  const at = (iso: string) => editionFor(new Date(iso));

  it("covers the previous day on an ordinary weekday", () => {
    const e = at("2026-08-25T11:20:00Z"); // 07:20 Eastern, Tuesday
    expect(e.kind).toBe("weekday");
    expect(e.todayDay).toBe("2026-08-25");
    expect(e.windowStartDay).toBe("2026-08-24");
    expect(e.covering).toBe("Monday");
    expect(e.sendsWhenClear).toBe(true);
    expect(e.isMonday).toBe(false);
  });

  it("reaches back to Friday midnight on a Monday, so the weekend is reported", () => {
    const e = at("2026-08-24T11:20:00Z");
    expect(e.kind).toBe("monday");
    expect(e.windowStartDay).toBe("2026-08-21");
    expect(e.covering).toBe("Friday–Sunday");
    expect(e.isMonday).toBe(true);
    // 72 hours, and the boundaries are Eastern midnights.
    expect(e.windowEndMs - e.windowStartMs).toBe(72 * 3_600_000);
    expect(e.windowStartMs).toBe(etMidnight("2026-08-21").getTime());
  });

  it("carries no reporting window on a weekend, and does not send when clear", () => {
    const sat = at("2026-08-22T11:20:00Z");
    expect(sat.kind).toBe("weekend");
    expect(sat.windowStartDay).toBe(null);
    expect(sat.sendsWhenClear).toBe(false);
    expect(sat.windowStartMs).toBe(sat.windowEndMs);
    expect(at("2026-08-23T11:20:00Z").kind).toBe("weekend");
  });

  /**
   * The bug this module exists to prevent: on UTC boundaries a bind at 21:00
   * Eastern on Monday falls into Tuesday, so it is reported a day late and
   * counted in the wrong person's day.
   */
  it("puts Monday evening's work in Monday's window", () => {
    const tuesday = at("2026-08-25T11:20:00Z");
    expect(inWindow("2026-08-25T01:30:00Z", tuesday)).toBe(true); // 21:30 ET Mon
    expect(inWindow("2026-08-24T05:00:00Z", tuesday)).toBe(true); // 01:00 ET Mon
    expect(inWindow("2026-08-24T03:00:00Z", tuesday)).toBe(false); // 23:00 ET Sun
    expect(inWindow("2026-08-25T12:00:00Z", tuesday)).toBe(false); // this morning
  });

  it("treats a missing timestamp as outside the window", () => {
    const e = at("2026-08-25T11:20:00Z");
    expect(inWindow(null, e)).toBe(false);
    expect(inWindow("", e)).toBe(false);
    expect(inWindow("nonsense", e)).toBe(false);
  });
});

/**
 * The cron expression.
 *
 * `npm run synth:check` is the real gate — it runs Amplify's own parser — but
 * it is slow, nothing in CI runs it, and a bad expression does not fail
 * cleanly: synth dies partway through asset staging with an unrelated-looking
 * ENOENT about copying `schema.graphql`. `tsc` cannot see the problem at all.
 *
 * So the two traps that actually catch people here are restated as cheap
 * assertions that run on every `vitest`. They do not replace the synth; they
 * mean a typo is caught in a second rather than in a deploy log.
 */
describe("the schedule", () => {
  const cron = (() => {
    const src = readFileSync(
      resolve(process.cwd(), "amplify/functions/ops-rollup/resource.ts"),
      "utf8"
    );
    return /cron:\s*"([^"]+)"/.exec(src)?.[1] ?? "";
  })();

  it("runs at 07:20 Eastern, every day", () => {
    expect(cron).toBe("20 7 * * ? *");
  });

  it("has all six fields EventBridge requires", () => {
    // minute hour day-of-month month day-of-week year — six, not five.
    expect(cron.split(" ")).toHaveLength(6);
  });

  /**
   * Exactly one of day-of-month and day-of-week must be "?". Both wildcards is
   * the single most common way to write this and EventBridge rejects it.
   */
  it("marks exactly one of the two day fields as unused", () => {
    const [, , dayOfMonth, , dayOfWeek] = cron.split(" ");
    expect([dayOfMonth, dayOfWeek].filter((f) => f === "?")).toHaveLength(1);
  });

  /**
   * Amplify runs `Number()` over the day-of-week field before EventBridge ever
   * sees it, so the three-letter names EventBridge documents are rejected —
   * `Number("MON")` is NaN. In that field 1 is Sunday, which is why
   * `task-digest` spells Monday-to-Friday as `2-6`.
   */
  it("keeps the day-of-week field numeric", () => {
    const dayOfWeek = cron.split(" ")[4];
    expect(dayOfWeek).not.toMatch(/[A-Za-z]/);
    expect(dayOfWeek === "?" || /^[1-7](-[1-7])?$/.test(dayOfWeek)).toBe(true);
  });
});
