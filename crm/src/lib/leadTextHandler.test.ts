import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lead texts, as the intake mutation actually runs them.
 *
 * `sms.ts` is unit-tested next door. What is worth pinning here is that the
 * texting cannot cost a lead. This mutation is what the marketing site awaits
 * before telling a visitor their enquiry went through, so an SNS outage —
 * or a phone number nobody can parse — has to end in a captured lead and a
 * log line, never in a failed form submission.
 */

const snsSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send = snsSend;
  },
  PublishCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const models = vi.hoisted(() => ({
  Account: { create: vi.fn() },
  Contact: { create: vi.fn() },
  UserProfile: { list: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({
    resourceConfig: {},
    libraryOptions: {},
  }),
}));

import { handler } from "../../amplify/functions/lead-intake/handler";

const ARGS = {
  name: "Willow Creek Condominium Trust",
  city: "Concord",
  state: "MA",
  contactFirstName: "Marion",
  contactLastName: "Delacroix",
  contactPhone: "978-555-0117",
  contactEmail: "marion@willowcreek.example",
};

const run = (args: Record<string, unknown> = {}) =>
  (handler as unknown as (e: unknown) => Promise<{ ok: boolean; id?: string }>)({
    arguments: { ...ARGS, ...args },
  });

const profile = (o: Record<string, unknown> = {}) => ({
  id: "p1",
  firstName: "Jake",
  lastName: "Greasley",
  mobilePhone: "508-233-2261",
  leadTextAlerts: true,
  ...o,
});

/** Every number a text was published to. */
const textedNumbers = () =>
  snsSend.mock.calls.map(([cmd]) => cmd.input.PhoneNumber);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.CRM_BASE_URL = "https://app.protectmyhoa.com";
  models.Account.create.mockResolvedValue({
    data: { id: "acct-1", city: "Concord", state: "MA", source: "website" },
    errors: undefined,
  });
  models.Contact.create.mockResolvedValue({ errors: undefined });
  models.UserProfile.list.mockResolvedValue({
    data: [profile()],
    nextToken: null,
  });
  snsSend.mockResolvedValue({ MessageId: "m1" });
});

describe("lead texts", () => {
  it("texts everyone who opted in, once, with a link to the lead", async () => {
    models.UserProfile.list.mockResolvedValue({
      data: [
        profile({ id: "p1", mobilePhone: "508-233-2261" }),
        profile({ id: "p2", firstName: "Dana", mobilePhone: "(617) 555-0143" }),
        profile({ id: "p3", firstName: "Sam", leadTextAlerts: false }),
      ],
      nextToken: null,
    });

    const res = await run();

    expect(res).toEqual({ ok: true, id: "acct-1" });
    expect(textedNumbers().sort()).toEqual(["+15082332261", "+16175550143"]);
    const body = snsSend.mock.calls[0][0].input.Message;
    expect(body).toContain("Willow Creek Condominium Trust");
    expect(body).toContain("Marion Delacroix");
    expect(body).toContain("https://app.protectmyhoa.com/accounts/acct-1");
  });

  it("marks the text transactional so it is not dropped for cost", async () => {
    await run();
    expect(
      snsSend.mock.calls[0][0].input.MessageAttributes["AWS.SNS.SMS.SMSType"]
    ).toEqual({ DataType: "String", StringValue: "Transactional" });
  });

  it("stays quiet when nobody opted in", async () => {
    models.UserProfile.list.mockResolvedValue({
      data: [profile({ leadTextAlerts: false })],
      nextToken: null,
    });

    expect(await run()).toEqual({ ok: true, id: "acct-1" });
    expect(snsSend).not.toHaveBeenCalled();
  });

  it("still captures the lead when SNS is down", async () => {
    snsSend.mockRejectedValue(new Error("Throttling"));

    // The whole point of the placement: a texting outage must not turn a
    // captured lead into a failed form submission.
    expect(await run()).toEqual({ ok: true, id: "acct-1" });
    expect(models.Account.create).toHaveBeenCalled();
  });

  it("still captures the lead when the profile read fails", async () => {
    models.UserProfile.list.mockRejectedValue(new Error("AppSync 500"));

    expect(await run()).toEqual({ ok: true, id: "acct-1" });
  });

  it("texts the reachable people even when one number is unusable", async () => {
    models.UserProfile.list.mockResolvedValue({
      data: [
        profile({ id: "p1", mobilePhone: "extension 4" }),
        profile({ id: "p2", firstName: "Dana", mobilePhone: "617-555-0143" }),
      ],
      nextToken: null,
    });

    await run();

    expect(textedNumbers()).toEqual(["+16175550143"]);
  });

  it("sends nothing rather than a broken link when the base URL is unset", async () => {
    delete process.env.CRM_BASE_URL;

    expect(await run()).toEqual({ ok: true, id: "acct-1" });
    // A text whose link 404s is worse than no text: it reads as a bug in the
    // CRM rather than a missing environment variable.
    expect(snsSend).not.toHaveBeenCalled();
  });

  it("does not text when the lead itself failed to save", async () => {
    models.Account.create.mockResolvedValue({
      data: null,
      errors: [{ message: "ConditionalCheckFailed" }],
    });

    const res = await run();

    expect(res.ok).toBe(false);
    expect(snsSend).not.toHaveBeenCalled();
  });
});
