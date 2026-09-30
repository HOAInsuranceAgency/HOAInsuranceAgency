import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn(), list: vi.fn() }));
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class { send = h.send; },
  PublishCommand: class { constructor(public input: Record<string, unknown>) {} },
}));
import { textLeadAlerts } from "../../amplify/functions/lead-intake/alerts";

const salespersonId = "producer-1";
const person = (more = {}) => ({
  id: "p1",
  userId: salespersonId,
  firstName: "Brian",
  lastName: "Cole",
  mobilePhone: "5082332261",
  leadTextAlerts: true,
  ...more,
});
const client = {
  models: { UserProfile: { listUserProfileByUserId: h.list } },
} as unknown as Parameters<typeof textLeadAlerts>[0];
const lead = { id: "a1", name: "Willow HOA", contactName: "Mary", source: "website" };
const noAlerts = { attempted: 0, sent: 0, failed: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRM_BASE_URL = "https://app.protectmyhoa.com";
  h.send.mockResolvedValue({ MessageId: "1" });
  h.list.mockResolvedValue({ data: [person()], nextToken: null });
});

describe("durable worker lead alerts", () => {
  it("texts only the assigned producer and preserves the lead link", async () => {
    h.list.mockResolvedValue({ data: [
      person({ id: "other", userId: "producer-2", mobilePhone: "6175550123" }),
      person(),
    ] });

    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual({ attempted: 1, sent: 1, failed: 0 });
    expect(h.list).toHaveBeenCalledWith({ userId: salespersonId }, { nextToken: undefined, limit: 200 });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].input).toMatchObject({
      PhoneNumber: "+15082332261",
      Message: expect.stringContaining("/accounts/a1"),
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
      },
    });
  });

  it("does not query or send without an assigned producer", async () => {
    expect(await textLeadAlerts(client, lead, "")).toEqual(noAlerts);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not fall back to another producer when the assigned profile is missing", async () => {
    h.list.mockResolvedValue({ data: [person({ userId: "producer-2" })] });
    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual(noAlerts);
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each([
    { leadTextAlerts: false },
    { leadTextAlerts: null },
    { mobilePhone: "invalid" },
  ])("respects the assigned producer's preferences: %j", async (preferences) => {
    h.list.mockResolvedValue({ data: [
      person(preferences),
      person({ id: "other", userId: "producer-2", mobilePhone: "6175550123" }),
    ] });
    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual(noAlerts);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reads all assigned profile pages and sends once for matching duplicate preferences", async () => {
    h.list
      .mockResolvedValueOnce({ data: [person()], nextToken: "more" })
      .mockResolvedValueOnce({ data: [person({ id: "p2", mobilePhone: "(508) 233-2261" })], nextToken: null });
    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual({ attempted: 1, sent: 1, failed: 0 });
    expect(h.list).toHaveBeenNthCalledWith(2, { userId: salespersonId }, { nextToken: "more", limit: 200 });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mobilePhone: "6175550123" },
    { leadTextAlerts: false },
    { mobilePhone: null },
  ])("skips conflicting duplicate profiles instead of guessing: %j", async (conflict) => {
    h.list
      .mockResolvedValueOnce({ data: [person()], nextToken: "more" })
      .mockResolvedValueOnce({ data: [person({ id: "p2", ...conflict })], nextToken: null });
    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual({ attempted: 0, sent: 0, failed: 1 });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reports the assigned producer's send failure", async () => {
    h.send.mockRejectedValueOnce(new Error("SNS unavailable"));
    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("reports profile lookup errors without sending from partial data", async () => {
    h.list.mockResolvedValue({ data: [person()], errors: [{ message: "Profile lookup failed" }] });
    expect(await textLeadAlerts(client, lead, salespersonId)).toEqual({ attempted: 0, sent: 0, failed: 1 });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("reports configuration failures without sending a broken link", async () => {
    delete process.env.CRM_BASE_URL;
    expect((await textLeadAlerts(client, lead, salespersonId)).failed).toBe(1);
    expect(h.send).not.toHaveBeenCalled();
  });
});
