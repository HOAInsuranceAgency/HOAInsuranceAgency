import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ state: "WAITING", operation: undefined as any, projectError: false, workerWins: false, model: vi.fn(), update: vi.fn(), issue: vi.fn(), queue: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  LeadReply: { leadRepliesByStatusAndDueAt: async ({ status }: any) => ({ data: status === "WAITING" ? [{ id: "r1", accountId: "a1", submissionId: "submission-1", contactEmail: "test@example.com", status: "WAITING", dueAt: "2026-01-01T14:00:00Z", uploadCount: 0 }] : [] }), update: h.update },
  Account: { get: async () => ({ data: { id: "a1", name: "Willow Condominium Association", state: "MA" } }) },
  Document: { list: async () => ({ data: [] }) }, Contact: { list: async () => ({ data: [] }) },
} }) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: h.model }; } }));
vi.mock("../../amplify/functions/communications/workflow", () => ({ ensureWorkflow: async () => ({ data: { disposition: "ACTIVE", humanTakeover: false } }) }));
vi.mock("../../amplify/functions/communications/store", () => ({
  get: async () => h.operation, issue: h.issue,
  db: { send: async ({ input }: any) => {
    if (input.ExpressionAttributeValues[":queued"]) {
      const expected = input.ConditionExpression?.match(/^#s = (:\w+)$/)?.[1];
      if (expected && h.state !== input.ExpressionAttributeValues[expected]) throw Object.assign(new Error("Already confirmed"), { name: "ConditionalCheckFailedException" });
      if (h.projectError) throw new Error("Status projection failed after durable queue");
      h.state = "QUEUED";
    } else h.state = "SENDING";
  } },
}));
vi.mock("../../amplify/functions/communications/operations", () => ({ enqueueOperation: h.queue }));
import { handler } from "../../amplify/functions/lead-reply/handler";
beforeEach(() => {
  vi.clearAllMocks(); h.state = "WAITING"; h.operation = undefined; h.projectError = false; h.workerWins = false; delete process.env.SITE_BASE_URL;
  h.update.mockResolvedValue({ data: {} }); h.issue.mockResolvedValue(undefined);
  h.model.mockResolvedValue({ content: [{ type: "tool_use", input: { subject: "Your HOA insurance enquiry", body: "Thank you for contacting us. I will help you review the coverage." } }] });
  h.queue.mockImplementation(async () => { h.operation = { data: { state: "READY" } }; if (h.workerWins) h.state = "SENT"; return h.operation; });
});
describe("producer and delivery ownership", () => {
  it("does not claim non-delivery when status projection fails after queueing", async () => {
    h.projectError = true; const result = await handler();
    expect(result.queued).toBe(1); expect(result.failed).toBe(0); expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls.some(([r]) => r.status === "FAILED")).toBe(false); expect(h.issue).toHaveBeenCalledWith("generation:r1", expect.stringContaining("Do not send another"), "a1");
  });
  it("does not overwrite SENT when the worker wins before the producer writes QUEUED", async () => {
    h.workerWins = true; await handler(); expect(h.state).toBe("SENT"); expect(h.update).not.toHaveBeenCalled();
  });
});
