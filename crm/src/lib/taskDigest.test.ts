import { describe, expect, it } from "vitest";
import {
  SOON_DAYS,
  URGENT_DAYS,
  addDays,
  bucketFor,
  daysBetween,
  digestRows,
  renderDigest,
  type TaskLike,
} from "../../amplify/functions/task-digest/digest";
import { MARKETING_SUBMIT_SCALE } from "./badges";

/**
 * The weekday task digest.
 *
 * The rule is which bucket a task lands in, because that is what the reader
 * acts on: "past submit-by" is a window that has closed and "later" is not
 * yet work. Getting it wrong either cries wolf every morning or stays quiet
 * about a submission that is already late — and the email would look
 * perfectly reasonable either way.
 */

const TODAY = "2026-08-13"; // a Thursday

const task = (over: Partial<TaskLike> = {}): TaskLike => ({
  id: "t1",
  accountId: "a1",
  accountName: "Robin Hollow Condominium",
  carrierName: "Community Association Underwriters",
  lines: ["Property"],
  expirationDate: "2026-09-15",
  submitBy: "2026-09-01",
  status: "OPEN",
  ...over,
});

describe("day arithmetic", () => {
  it("counts forward and back across a month boundary", () => {
    expect(addDays("2026-08-30", 7)).toBe("2026-09-06");
    expect(daysBetween(TODAY, "2026-08-20")).toBe(7);
    expect(daysBetween(TODAY, "2026-08-06")).toBe(-7);
    expect(daysBetween(TODAY, TODAY)).toBe(0);
  });

  /**
   * The job runs at 07:00 America/New_York, which is 11:00 or 12:00 UTC, so
   * the UTC day and the Eastern day agree at the moment it runs. This holds
   * that the arithmetic doesn't drift across the DST boundary in between.
   */
  it("is stable across a DST change", () => {
    expect(addDays("2026-03-07", 7)).toBe("2026-03-14"); // spring forward
    expect(addDays("2026-10-31", 7)).toBe("2026-11-07"); // fall back
    expect(daysBetween("2026-03-07", "2026-03-14")).toBe(7);
    expect(daysBetween("2026-10-31", "2026-11-07")).toBe(7);
  });
});

describe("the rungs match the badge on the Tasks screen", () => {
  /**
   * The email and the screen have to change colour on the same day. The
   * thresholds are restated in digest.ts rather than imported, because that
   * module is bundled into a Lambda and badges.tsx would drag React in — so
   * this is the thing keeping the two copies equal.
   */
  it("uses MARKETING_SUBMIT_SCALE's thresholds", () => {
    expect(URGENT_DAYS).toBe(MARKETING_SUBMIT_SCALE.urgent);
    expect(SOON_DAYS).toBe(MARKETING_SUBMIT_SCALE.soon);
  });
});

describe("bucketing", () => {
  it.each([
    ["2026-08-12", "overdue", "yesterday"],
    [TODAY, "urgent", "today is not yet past"],
    [addDays(TODAY, URGENT_DAYS), "urgent", "the boundary is inclusive"],
    [addDays(TODAY, URGENT_DAYS + 1), "soon", "one day past the boundary"],
    [addDays(TODAY, SOON_DAYS), "soon", "the outer boundary is inclusive"],
    [addDays(TODAY, SOON_DAYS + 1), "later", "beyond the window"],
  ])("puts %s in %s (%s)", (submitBy, expected) => {
    expect(bucketFor(submitBy, TODAY)).toBe(expected);
  });

  /**
   * A task the sweep could not date is real work with an unknown deadline.
   * Filing it under "later" would be the digest asserting something it does
   * not know; dropping it would hide it entirely.
   */
  it("gives an undated task its own bucket rather than guessing", () => {
    expect(bucketFor(null, TODAY)).toBe("undated");
    const rows = digestRows([task({ submitBy: null })], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe("undated");
    expect(rows[0].timing).toBe("no submit-by date");
  });

  it("ignores a malformed date instead of bucketing on it", () => {
    // Lexicographic comparison against "not a date" would silently succeed.
    expect(digestRows([task({ submitBy: "31/12/2026" })], TODAY)[0].bucket).toBe(
      "undated"
    );
  });
});

describe("rows", () => {
  it("drops completed tasks", () => {
    const rows = digestRows(
      [task({ id: "a" }), task({ id: "b", status: "COMPLETE" })],
      TODAY
    );
    expect(rows.map((r) => r.task.id)).toEqual(["a"]);
  });

  it("sorts soonest deadline first, undated last", () => {
    const rows = digestRows(
      [
        task({ id: "late", submitBy: "2026-09-30" }),
        task({ id: "none", submitBy: null }),
        task({ id: "past", submitBy: "2026-07-01" }),
        task({ id: "soon", submitBy: "2026-08-20" }),
      ],
      TODAY
    );
    expect(rows.map((r) => r.task.id)).toEqual(["past", "soon", "late", "none"]);
  });

  it("names the timing the way a person would say it", () => {
    const rows = digestRows(
      [
        task({ id: "a", submitBy: "2026-08-12" }),
        task({ id: "b", submitBy: TODAY }),
        task({ id: "c", submitBy: "2026-08-14" }),
      ],
      TODAY
    );
    expect(rows.map((r) => r.timing)).toEqual(["1 day past", "due today", "in 1 day"]);
  });

  it("falls back rather than rendering an empty cell", () => {
    const [row] = digestRows(
      [task({ accountName: null, carrierName: "  ", lines: [] })],
      TODAY
    );
    expect(row.account).toBe("(unnamed account)");
    expect(row.carrier).toBe("—");
    expect(row.lines).toBe("—");
  });
});

describe("the email", () => {
  const rows = () =>
    digestRows(
      [
        task({ id: "1", accountName: "Robin Hollow", submitBy: "2026-07-01" }),
        task({ id: "2", accountName: "Maillet Woods", submitBy: "2026-07-07" }),
        task({ id: "3", accountName: "Sargent Estates", submitBy: "2026-08-16" }),
        task({ id: "4", accountName: "High Rock", submitBy: "2026-09-30" }),
      ],
      TODAY
    );

  it("leads the subject with what is already late", () => {
    const { subject } = renderDigest(rows(), TODAY);
    expect(subject).toBe(
      `Marketing tasks — 2 past submit-by, 1 due within ${URGENT_DAYS} days`
    );
  });

  it("omits a count of zero rather than saying '0 past submit-by'", () => {
    const later = digestRows([task({ submitBy: "2026-09-30" })], TODAY);
    expect(renderDigest(later, TODAY).subject).toBe("Marketing tasks — 1 open");
  });

  it("puts every task in the body, in both formats", () => {
    const { text, html } = renderDigest(rows(), TODAY, "https://app.example.com");
    for (const name of ["Robin Hollow", "Maillet Woods", "Sargent Estates", "High Rock"]) {
      expect(text).toContain(name);
      expect(html).toContain(name);
    }
  });

  it("deep-links each row to the account, and the button to the task list", () => {
    const { html } = renderDigest(rows(), TODAY, "https://app.example.com");
    expect(html).toContain('href="https://app.example.com/accounts/a1?tab=quotes"');
    expect(html).toContain('href="https://app.example.com/tasks"');
  });

  it("still renders without a base url, just without links", () => {
    const { html, text } = renderDigest(rows(), TODAY, undefined);
    expect(html).toContain("Robin Hollow");
    expect(html).not.toContain("href=\"undefined");
    expect(text).not.toContain("undefined");
  });

  /** An account name is user input and lands inside an HTML attribute. */
  it("escapes markup in an account name", () => {
    const evil = digestRows(
      [task({ accountName: '<script>alert("x")</script>' })],
      TODAY
    );
    const { html } = renderDigest(evil, TODAY, "https://app.example.com");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows only the sections that have rows", () => {
    const { html } = renderDigest(
      digestRows([task({ submitBy: "2026-07-01" })], TODAY),
      TODAY
    );
    expect(html).toContain("Past submit-by");
    expect(html).not.toContain("No submit-by date");
    expect(html).not.toContain("Later ·");
  });

  it("dates the email so a stale one is obvious", () => {
    const { html, text } = renderDigest(rows(), TODAY);
    expect(html).toContain("Thursday, August 13, 2026");
    expect(text).toContain("Thursday, August 13, 2026");
  });
});
