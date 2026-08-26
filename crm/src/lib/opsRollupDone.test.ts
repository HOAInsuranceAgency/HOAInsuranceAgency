import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROBOT_ACTORS,
  buildDone,
  type DoneInputs,
} from "../../amplify/functions/ops-rollup/done";
import { editionFor, etMidnight } from "../../amplify/functions/ops-rollup/window";

/**
 * What was done, and who moved it.
 *
 * The counting is the easy half. The half worth testing is the attribution,
 * because every mistake here lands on a named person in an email their
 * employer reads: a Lambda counted as a teammate, one person's closed task
 * credited to another, or a zero printed beside somebody who spent the day on
 * the phone.
 */

const TUESDAY = editionFor(new Date("2026-08-25T11:20:00Z"));
const TRAILING = etMidnight("2026-08-11").getTime();

const EMPTY: DoneInputs = {
  activity: [],
  profiles: [],
  policies: [],
  accounts: [],
  certificates: [],
  invoices: [],
  tasks: [],
  loanPayments: [],
  loans: [],
  carriers: [],
  premiumFinanceEnabled: true,
};

const inputs = (over: Partial<DoneInputs> = {}): DoneInputs => ({ ...EMPTY, ...over });

/** Monday, inside Tuesday's window. */
const YESTERDAY = "2026-08-24T18:00:00Z";

const PROFILES: DoneInputs["profiles"] = [
  { userId: "sub-chen", firstName: "Sarah", lastName: "Chen", role: "PRODUCER" },
  { userId: "sub-greasley", firstName: "Jake", lastName: "Greasley", role: "ADMIN" },
  { userId: "sub-whitfield", firstName: "Dana", lastName: "Whitfield", role: "PRODUCER" },
];

describe("robot writers", () => {
  /**
   * `ROBOT_NAMES` in the activity-log handler knows only three of the Lambdas
   * that stamp `lastWriteBy`, so seven of them resolve to "Unknown user" in
   * the CRM's own Activity tab. That is a defect in that screen; this set is
   * what stops it becoming a phantom teammate in the email as well. If the
   * screen is ever fixed, this assertion is what keeps the two in step.
   */
  it("covers every actor the activity log knows about", () => {
    const src = readFileSync(
      resolve(process.cwd(), "amplify/functions/activity-log/handler.ts"),
      "utf8"
    );
    const block = /const ROBOT_NAMES[\s\S]*?\};/.exec(src)?.[0] ?? "";
    expect(block).not.toBe("");
    const slugs = [...block.matchAll(/^\s*"?([a-z-]+)"?:\s*"/gm)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(ROBOT_ACTORS.has(slug)).toBe(true);
  });

  it("collapses every automated writer into one line and no person", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          { actor: "send-invoice", entityId: "a1", occurredAt: YESTERDAY },
          { actor: "stripe-payment", entityId: "a1", occurredAt: YESTERDAY },
          { actor: "lead-intake", entityId: "a2", occurredAt: YESTERDAY },
          { actor: "system", entityId: "a2", occurredAt: YESTERDAY },
          { actor: null, entityId: "a3", occurredAt: YESTERDAY },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.automatedChanges).toBe(5);
    expect(done.people).toHaveLength(0);
  });
});

describe("who moved things", () => {
  /**
   * `actorName` is denormalised at write time and never backfilled, so a row
   * written while the profile lookup was failing says "Unknown user" forever.
   * Grouping on the name merges every such failure into one phantom person.
   */
  it("groups on the Cognito sub, not on the denormalised name", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          { actor: "sub-chen", entityId: "a1", occurredAt: YESTERDAY },
          // Same person, a row whose name lookup failed at write time.
          { actor: "sub-chen", entityId: "a2", occurredAt: YESTERDAY },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people).toHaveLength(1);
    expect(done.people[0].name).toBe("Sarah Chen");
    expect(done.people[0].accountsTouched).toBe(2);
  });

  it("counts distinct accounts, not writes", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: Array.from({ length: 9 }, () => ({
          actor: "sub-chen",
          entityId: "a1",
          occurredAt: YESTERDAY,
        })),
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people[0].accountsTouched).toBe(1);
  });

  it("counts a quote as advanced only when its status changed", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          {
            actor: "sub-chen",
            entityId: "a1",
            subjectType: "Quote",
            occurredAt: YESTERDAY,
            changes: JSON.stringify([{ field: "status", from: "DRAFT", to: "SUBMITTED" }]),
          },
          {
            actor: "sub-chen",
            entityId: "a1",
            subjectType: "Quote",
            occurredAt: YESTERDAY,
            changes: JSON.stringify([{ field: "premium", from: 1, to: 2 }]),
          },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people[0].quotesAdvanced).toBe(1);
    expect(done.summary.quotesAdvanced).toBe(1);
  });

  it("reads changes whether they arrive parsed or as a JSON string", () => {
    const row = (changes: unknown) => ({
      actor: "sub-chen",
      entityId: "a1",
      subjectType: "Quote",
      occurredAt: YESTERDAY,
      changes,
    });
    const asArray = buildDone(
      inputs({ profiles: PROFILES, activity: [row([{ field: "status" }])] }),
      TUESDAY,
      TRAILING
    );
    const asString = buildDone(
      inputs({ profiles: PROFILES, activity: [row(JSON.stringify([{ field: "status" }]))] }),
      TUESDAY,
      TRAILING
    );
    expect(asArray.people[0].quotesAdvanced).toBe(1);
    expect(asString.people[0].quotesAdvanced).toBe(1);
  });

  it("survives changes that are not JSON at all", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          {
            actor: "sub-chen",
            entityId: "a1",
            subjectType: "Quote",
            occurredAt: YESTERDAY,
            changes: "{not json",
          },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people[0].quotesAdvanced).toBe(0);
    expect(done.people[0].accountsTouched).toBe(1);
  });

  /**
   * A zero beside a name reads as an accusation, and it is usually a day on
   * the phone or a day off — neither of which this system can see. The block
   * prints presence, never absence.
   */
  it("omits a person with nothing in the window rather than printing a zero", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          { actor: "sub-chen", entityId: "a1", occurredAt: YESTERDAY },
          // Dana wrote a fortnight ago: inside the trailing scan, outside the
          // edition. She has a tally, but no row.
          { actor: "sub-whitfield", entityId: "a9", occurredAt: "2026-08-12T10:00:00Z" },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people.map((p) => p.name)).toEqual(["Sarah Chen"]);
  });

  /**
   * Sort order is what turns a list into a leaderboard. `Activity.actor` is a
   * per-change stamp, so a producer who tidies a colleague's account inherits
   * the credit for it — ranking on that would be ranking on an artifact.
   */
  it("sorts alphabetically by surname, never by volume", () => {
    const busy = Array.from({ length: 20 }, (_, i) => ({
      actor: "sub-whitfield",
      entityId: `a${i}`,
      occurredAt: YESTERDAY,
    }));
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          ...busy,
          { actor: "sub-chen", entityId: "z1", occurredAt: YESTERDAY },
          { actor: "sub-greasley", entityId: "z2", occurredAt: YESTERDAY },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people.map((p) => p.name)).toEqual([
      "Sarah Chen",
      "Jake Greasley",
      "Dana Whitfield",
    ]);
  });

  it("carries a trailing figure wider than the day", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        activity: [
          { actor: "sub-chen", entityId: "a1", occurredAt: YESTERDAY },
          { actor: "sub-chen", entityId: "a2", occurredAt: "2026-08-14T10:00:00Z" },
          { actor: "sub-chen", entityId: "a3", occurredAt: "2026-08-18T10:00:00Z" },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people[0].accountsTouched).toBe(1);
    expect(done.people[0].trailingAccounts).toBe(3);
  });
});

describe("closed marketing tasks", () => {
  /**
   * `completedBy` is a bare display name typed into a browser, not an id. A
   * fuzzy or first-name match would credit one person's work to another, so a
   * name matching nobody is counted and shown rather than attached to whoever
   * is closest.
   */
  it("matches a closer exactly, and counts an unmatched name for nobody", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        tasks: [
          { completedAt: YESTERDAY, completedBy: "Sarah Chen", resolution: "QUOTED" },
          { completedAt: YESTERDAY, completedBy: "  sarah chen ", resolution: "QUOTED" },
          { completedAt: YESTERDAY, completedBy: "S. Chen", resolution: "OUT_OF_APPETITE" },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people).toHaveLength(1);
    expect(done.people[0].tasksClosed).toBe(2);
    expect(done.unmatchedClosers).toBe(1);
    expect(done.summary.tasksClosed).toBe(3);
    expect(done.summary.tasksQuoted).toBe(2);
  });

  it("credits an auto-closed task to nobody", () => {
    const done = buildDone(
      inputs({
        profiles: PROFILES,
        tasks: [
          { completedAt: YESTERDAY, completedBy: "system (quote created)", resolution: "QUOTED" },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.people).toHaveLength(0);
    expect(done.unmatchedClosers).toBe(0);
    expect(done.summary.tasksClosed).toBe(1);
  });
});

describe("what happened", () => {
  it("names what bound and totals the premium", () => {
    const done = buildDone(
      inputs({
        accounts: [{ id: "a1", name: "Maple Ridge Condominium" }],
        carriers: [{ id: "c1", name: "Travelers" }],
        policies: [
          {
            accountId: "a1",
            premium: 41200,
            commissionPct: 12,
            carrierId: "c1",
            datePolicyBound: YESTERDAY,
          },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.summary.bound).toEqual([
      { account: "Maple Ridge Condominium", premium: 41200, carrier: "Travelers" },
    ]);
    expect(done.summary.boundPremium).toBe(41200);
    expect(done.summary.commission).toBeCloseTo(4944);
    expect(done.summary.empty).toBe(false);
  });

  /**
   * Commission is baked into premium and the percentage is nullable, so a
   * missing one makes the total an undercount rather than a fact. Counted and
   * surfaced, never silently treated as zero.
   */
  it("counts a bound policy with no commission percentage on file", () => {
    const done = buildDone(
      inputs({
        accounts: [{ id: "a1", name: "Maple Ridge" }],
        policies: [{ accountId: "a1", premium: 41200, datePolicyBound: YESTERDAY }],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.summary.boundWithoutCommission).toBe(1);
    expect(done.summary.commission).toBe(0);
  });

  it("counts an unpriced bill rather than valuing it at zero", () => {
    const done = buildDone(
      inputs({
        invoices: [
          { sentAt: YESTERDAY, stripeLinkAmountCents: 5_210_000 },
          { sentAt: YESTERDAY, stripeLinkAmountCents: null },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.summary.invoicesSent).toBe(2);
    expect(done.summary.invoicesSentTotal).toBe(52_100);
    expect(done.summary.invoicesSentUnpriced).toBe(1);
  });

  /**
   * `paidAt` is `a.date()`, not a datetime — day granularity is all there is,
   * so it is compared as a day string against the window's days.
   */
  it("counts a payment by its day, since that is all the schema stores", () => {
    const done = buildDone(
      inputs({
        invoices: [
          { paidAt: "2026-08-24", stripeLinkAmountCents: 1_940_000 },
          { paidAt: "2026-08-25", stripeLinkAmountCents: 999 }, // today, not yet
          { paidAt: "2026-08-23", stripeLinkAmountCents: 999 }, // before the window
        ],
      }),
      TUESDAY,
      TRAILING
    );
    expect(done.summary.invoicesPaid).toBe(1);
    expect(done.summary.invoicesPaidTotal).toBe(19_400);
  });

  it("says nothing about financing when the module is dark", () => {
    const dark = inputs({
      premiumFinanceEnabled: false,
      loans: [{ downPaidAt: YESTERDAY, downPayment: 9800 }],
      loanPayments: [{ postedAt: YESTERDAY, amount: 1470, interest: 204 }],
    });
    const done = buildDone(dark, TUESDAY, TRAILING);
    expect(done.summary.downPayments).toBe(0);
    expect(done.summary.installments).toBe(0);
    expect(done.summary.empty).toBe(true);
  });

  it("reports an empty day as empty — itself a finding", () => {
    expect(buildDone(inputs(), TUESDAY, TRAILING).summary.empty).toBe(true);
  });
});

describe("quiet producers", () => {
  it("names only producers, and only past a working week of silence", () => {
    const done = buildDone(
      inputs({
        profiles: [
          ...PROFILES,
          { userId: "sub-staff", firstName: "Pat", lastName: "Ortiz", role: "STAFF" },
        ],
        activity: [
          { actor: "sub-chen", entityId: "a1", occurredAt: YESTERDAY },
          // Dana last wrote on the 17th: six business days back.
          { actor: "sub-whitfield", entityId: "a2", occurredAt: "2026-08-17T10:00:00Z" },
        ],
      }),
      TUESDAY,
      TRAILING
    );
    const names = done.quiet.map((q) => q.name);
    expect(names).toContain("Dana Whitfield");
    expect(names).toContain("Jake Greasley"); // no writes at all in the scan
    expect(names).not.toContain("Sarah Chen"); // wrote yesterday
    expect(names).not.toContain("Pat Ortiz"); // not a producer
  });

  it("marks somebody with no writes anywhere in the scan", () => {
    const done = buildDone(
      inputs({ profiles: [PROFILES[0]], activity: [] }),
      TUESDAY,
      TRAILING
    );
    expect(done.quiet[0].beyondScan).toBe(true);
  });
});
