import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ send: vi.fn(), list: vi.fn() }));
vi.mock("@aws-sdk/client-sns", () => ({ SNSClient: class { send = h.send; }, PublishCommand: class { constructor(public input: Record<string, unknown>) {} } }));
import { textLeadAlerts } from "../../amplify/functions/lead-intake/alerts";
const person = (more = {}) => ({ id: "p1", firstName: "Brian", lastName: "Cole", mobilePhone: "5082332261", leadTextAlerts: true, ...more });
const client = { models: { UserProfile: { list: h.list } } } as unknown as Parameters<typeof textLeadAlerts>[0];
const lead = { id: "a1", name: "Willow HOA", contactName: "Mary", source: "website" };
beforeEach(() => { vi.clearAllMocks(); process.env.CRM_BASE_URL = "https://app.protectmyhoa.com"; h.send.mockResolvedValue({ MessageId: "1" }); h.list.mockResolvedValue({ data: [person()], nextToken: null }); });
describe("durable worker lead alerts", () => {
  it("texts opted-in teammates once per normalized phone and preserves the lead link", async () => {
    h.list.mockResolvedValue({ data: [person(), person({ id: "p2", mobilePhone: "(508) 233-2261" }), person({ id: "p3", leadTextAlerts: false })] });
    expect(await textLeadAlerts(client, lead)).toEqual({ attempted: 1, sent: 1, failed: 0 }); expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].input).toMatchObject({ PhoneNumber: "+15082332261", Message: expect.stringContaining("/accounts/a1"), MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } } });
  });
  it("is quiet when nobody opted in", async () => { h.list.mockResolvedValue({ data: [person({ leadTextAlerts: false })] }); expect(await textLeadAlerts(client, lead)).toEqual({ attempted: 0, sent: 0, failed: 0 }); expect(h.send).not.toHaveBeenCalled(); });
  it("reports partial send failure so the outbox does not blindly duplicate successful alerts", async () => {
    h.list.mockResolvedValue({ data: [person(), person({ id: "p2", mobilePhone: "6175550123" })] }); h.send.mockRejectedValueOnce(new Error("SNS unavailable"));
    expect(await textLeadAlerts(client, lead)).toEqual({ attempted: 2, sent: 1, failed: 1 });
  });
  it("reports profile and configuration failures without sending a broken link", async () => { delete process.env.CRM_BASE_URL; expect((await textLeadAlerts(client, lead)).failed).toBe(1); expect(h.send).not.toHaveBeenCalled(); });
});
