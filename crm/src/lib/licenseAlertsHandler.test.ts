import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The licence-expiry sweep, as it actually runs.
 *
 * `digest.ts` is unit-tested next door; what is worth pinning here is
 * everything around it, because each of these is a way for the job to be
 * worse than useless:
 *
 *  - a daily cron that re-sends the same reminder every morning is one the
 *    agency filters to a folder, and then the 3-day notice goes there too,
 *  - a run with nothing due must not send an empty email for the same reason,
 *  - and a failed send must not leave a ledger row claiming it succeeded.
 */

const sesSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = sesSend;
  },
  SendEmailCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const models = vi.hoisted(() => ({
  License: { list: vi.fn() },
  LicenseReminder: { list: vi.fn(), create: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({
    resourceConfig: {},
    libraryOptions: {},
  }),
}));

import { handler } from "../../amplify/functions/license-alerts/handler";
import { addDays, dedupeKeyFor, isoDay } from "../../amplify/functions/license-alerts/digest";

const TODAY = isoDay(new Date());

const license = (over: Record<string, unknown> = {}) => ({
  id: "lic-1",
  holderType: "PRODUCER",
  holderName: "Jane Doe",
  state: "MA",
  licenseNumber: "1234567",
  licenseClass: "PRODUCER",
  status: "ACTIVE",
  expirationDate: addDays(TODAY, 20),
  ...over,
});

/** `{ data, nextToken }` — the one-page shape `listAllPages` expects. */
const page = (rows: unknown[]) => async () => ({ data: rows, nextToken: null });

function given(licenses: unknown[], reminders: unknown[] = []) {
  models.License.list.mockImplementation(page(licenses));
  models.LicenseReminder.list.mockImplementation(page(reminders));
}

/** The single SendEmailCommand's input, or undefined if nothing was sent. */
const sentEmail = () => sesSend.mock.calls[0]?.[0]?.input;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.LICENSE_ALERT_FROM = "HOA Insurance Agency <noreply@protectmyhoa.com>";
  process.env.LICENSE_ALERT_TO = "HOA Insurance Agency LLC <insurance@protectmyhoa.com>";
  sesSend.mockResolvedValue({});
  models.LicenseReminder.create.mockResolvedValue({ errors: undefined });
});

describe("license-alerts sweep", () => {
  it("emails the agency inbox one digest for everything due", async () => {
    given([
      license({ id: "a", expirationDate: addDays(TODAY, 2) }),
      license({ id: "b", expirationDate: addDays(TODAY, 20) }),
    ]);

    const summary = await handler();

    expect(sesSend).toHaveBeenCalledTimes(1);
    expect(sentEmail().Destination.ToAddresses).toEqual([
      "HOA Insurance Agency LLC <insurance@protectmyhoa.com>",
    ]);
    expect(sentEmail().FromEmailAddress).toContain("noreply@protectmyhoa.com");
    expect(sentEmail().Content.Simple.Subject.Data).toContain("License expirations");
    expect(summary.remindersSent).toBe(2);
  });

  it("records what it sent, keyed so a renewal re-arms the ladder", async () => {
    given([license({ id: "a", expirationDate: addDays(TODAY, 2) })]);

    await handler();

    expect(models.LicenseReminder.create).toHaveBeenCalledTimes(1);
    expect(models.LicenseReminder.create.mock.calls[0][0]).toMatchObject({
      licenseId: "a",
      threshold: 3,
      expirationDate: addDays(TODAY, 2),
      dedupeKey: dedupeKeyFor("a", addDays(TODAY, 2), 3),
    });
  });

  it("says nothing on the second run", async () => {
    // The whole point of the ledger: this job runs every morning, and the
    // same licence is inside its window for weeks.
    const expirationDate = addDays(TODAY, 20);
    given(
      [license({ id: "a", expirationDate })],
      [{ dedupeKey: dedupeKeyFor("a", expirationDate, 30) }]
    );

    const summary = await handler();

    expect(sesSend).not.toHaveBeenCalled();
    expect(models.LicenseReminder.create).not.toHaveBeenCalled();
    expect(summary.remindersSent).toBe(0);
  });

  it("still fires the tighter rung after the looser one was sent", async () => {
    const expirationDate = addDays(TODAY, 2);
    given(
      [license({ id: "a", expirationDate })],
      [
        { dedupeKey: dedupeKeyFor("a", expirationDate, 60) },
        { dedupeKey: dedupeKeyFor("a", expirationDate, 30) },
      ]
    );

    await handler();

    expect(sesSend).toHaveBeenCalledTimes(1);
    expect(models.LicenseReminder.create.mock.calls[0][0].threshold).toBe(3);
  });

  it("sends nothing when nothing is due", async () => {
    given([license({ expirationDate: addDays(TODAY, 200) })]);

    const summary = await handler();

    expect(sesSend).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ licensesReviewed: 1, remindersSent: 0 });
  });

  it("sends nothing when there are no licences at all", async () => {
    given([]);

    await handler();

    expect(sesSend).not.toHaveBeenCalled();
  });

  it("writes no ledger row when the email fails", async () => {
    given([license({ id: "a", expirationDate: addDays(TODAY, 2) })]);
    sesSend.mockRejectedValue(new Error("SES throttled"));

    // The throw is deliberate: an unhandled failure marks the EventBridge
    // invocation failed and shows up in alarms, where a swallowed one would
    // leave a licence silently un-notified.
    await expect(handler()).rejects.toThrow("SES throttled");

    // Recorded first, this would burn the reminder — the row would claim the
    // agency had been told and the licence would never be raised again.
    expect(models.LicenseReminder.create).not.toHaveBeenCalled();
  });

  it("reads past the first page of both tables", async () => {
    // `.list()` caps at 100. A sweep that stopped there would go quiet for
    // the newest licences as the table grows — silently, and only in prod.
    const due = license({ id: "page-2", expirationDate: addDays(TODAY, 2) });
    models.License.list.mockImplementation(async ({ nextToken }: { nextToken?: string }) =>
      nextToken
        ? { data: [due], nextToken: null }
        : { data: [license({ id: "page-1", expirationDate: addDays(TODAY, 900) })], nextToken: "t" }
    );
    models.LicenseReminder.list.mockImplementation(page([]));

    const summary = await handler();

    expect(summary.licensesReviewed).toBe(2);
    expect(models.LicenseReminder.create.mock.calls[0][0].licenseId).toBe("page-2");
  });
});
