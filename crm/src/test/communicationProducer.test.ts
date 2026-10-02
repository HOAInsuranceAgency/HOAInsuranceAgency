import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ state: "WAITING", operation: undefined as any, submission: undefined as any,
  accountName: "Willow Condominium Association", contacts: [] as any[], workflow: undefined as any, producer: vi.fn(),
  resolveIssue: vi.fn(), waitProjectionError: false, projectError: false, workerWins: false, model: vi.fn(), update: vi.fn(), issue: vi.fn(), queue: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  LeadReply: { leadRepliesByStatusAndDueAt: async ({ status }: any) => ({ data: status === "WAITING" ? [{ id: "r1", accountId: "a1", submissionId: "submission-1", contactEmail: "test@example.com", status: "WAITING", dueAt: "2026-01-01T14:00:00Z", uploadCount: 0 }] : [] }), update: h.update },
  Account: { get: async () => ({ data: { id: "a1", name: h.accountName, state: "MA" } }) },
  Document: { list: async () => ({ data: [] }) }, Contact: { list: async () => ({ data: h.contacts }) },
  UploadPortal: { list: async () => ({ data: [{ token: "preview-token", expiresAt: "2099-01-01T00:00:00Z" }] }) },
} }) }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: h.model }; } }));
vi.mock("../../amplify/functions/communications/store", () => ({
  get: async (id: string) => id.startsWith("workflow:") ? h.workflow : id.startsWith("submission:") ? h.submission : h.operation, issue: h.issue,
  db: { send: async ({ input }: any) => {
    if (input.ExpressionAttributeValues[":queued"]) {
      const expected = input.ConditionExpression?.match(/^#s = (:\w+)$/)?.[1];
      if (expected && h.state !== input.ExpressionAttributeValues[expected]) throw Object.assign(new Error("Already confirmed"), { name: "ConditionalCheckFailedException" });
      if (h.projectError) throw new Error("Status projection failed after durable queue");
      h.state = "QUEUED";
    } else if (input.ExpressionAttributeValues[":retry"]) {
      if (h.waitProjectionError) throw new Error("Temporary storage failure");
      if (h.state !== "WAITING") throw Object.assign(new Error("Already claimed"), { name: "ConditionalCheckFailedException" });
    } else h.state = "SENDING";
  } },
}));
vi.mock("../../amplify/functions/communications/routing", () => ({ resolveIssue: h.resolveIssue }));
vi.mock("../../amplify/functions/communications/operations", () => ({ enqueueOperation: h.queue, assignedEmailProducer: h.producer }));
import { handler } from "../../amplify/functions/lead-reply/handler";
beforeEach(() => {
  vi.clearAllMocks(); h.waitProjectionError = false; h.state = "WAITING"; h.operation = undefined; h.projectError = false; h.workerWins = false; delete process.env.SITE_BASE_URL;
  h.workflow = { data: { disposition: "ACTIVE", humanTakeover: false, salespersonId: "jake" } };
  h.producer.mockReset().mockResolvedValue({ producerId: "jake", producerName: "Jake Greasley" });
  h.submission = undefined; h.accountName = "Willow Condominium Association"; h.contacts = [];
  h.update.mockResolvedValue({ data: {} }); h.issue.mockResolvedValue(undefined);
  h.model.mockResolvedValue({ content: [{ type: "tool_use", input: { subject: "Your HOA insurance enquiry", body: "I'll review what you shared about your association's insurance." } }] });
  h.queue.mockImplementation(async () => { h.operation = { data: { state: "READY" } }; if (h.workerWins) h.state = "SENT"; return h.operation; });
});

describe("personal, concise first-contact emails", () => {
  const draft = (body: string) => ({ content: [{ type: "tool_use", input: { subject: "Your association's insurance review", body } }] });

  it("uses the submitted first name when the contact-form lead has the same name", async () => {
    h.accountName = "Tom Eperthener";
    h.contacts = [{ name: "Tom Eperthener", email: "test@example.com", isPrimary: true }];
    h.submission = { data: { accountId: "a1", snapshot: { contactFirstName: "Tom", contactLastName: "Eperthener" } } };
    await handler();
    const email = h.queue.mock.calls[0][1];
    expect(email.text).toMatch(/^Hi Tom,\n\nThank you for contacting HOA Insurance Agency\./);
    expect(email.html).toContain("Hi Tom,");
    expect(h.model.mock.calls[0][0].messages[0].content).toContain("Contact: Tom Eperthener");
  });

  it("does not mistake an association fallback for a person's name", async () => {
    h.contacts = [{ name: h.accountName, email: "test@example.com" }];
    h.submission = { data: { accountId: "a1", snapshot: {} } };
    await handler();
    expect(h.queue.mock.calls[0][1].text).toMatch(/^Hello,/);
  });

  it("addresses the email recipient instead of an unrelated primary contact", async () => {
    h.contacts = [{ name: "Alex Smith", email: "someoneelse@example.com", isPrimary: true }, { name: "Phil Brown", email: "test@example.com" }];
    await handler();
    expect(h.queue.mock.calls[0][1].text).toMatch(/^Hi Phil,/);
  });

  it("regenerates the observed duplicate document-list paragraph before queueing", async () => {
    process.env.SITE_BASE_URL = "https://preview.example.test";
    h.model.mockResolvedValueOnce(draft("Your eight buildings and 42 townhomes give us a useful starting point.\n\nI've put a short list of what helps below. Whatever you have on hand is fine."))
      .mockResolvedValueOnce(draft("I'll review how your association's documents divide responsibility for the eight buildings and 42 townhomes. If it's easier to talk, tell me a good time to call."));
    await handler();
    expect(h.model).toHaveBeenCalledTimes(2);
    expect(h.queue).toHaveBeenCalledTimes(1);
    const email = h.queue.mock.calls[0][1];
    expect(email.text).toContain("42 townhomes");
    expect(email.text).not.toContain("short list");
    expect(email.text.match(/You can upload/g)).toHaveLength(1);
    expect(email.html.match(/>Upload your documents</g)).toHaveLength(1);
  });

  it.each(["repeated copy", "retry unavailable"])("still queues a clean first contact when %s", async (failure) => {
    process.env.SITE_BASE_URL = "https://preview.example.test";
    h.model.mockResolvedValueOnce(draft("I've put a short list of what helps below."));
    if (failure === "retry unavailable") h.model.mockRejectedValueOnce(new Error("Model unavailable"));
    else h.model.mockResolvedValueOnce(draft("Please send your documents using the upload link."));
    const result = await handler();
    expect(result.queued).toBe(1);
    const email = h.queue.mock.calls[0][1];
    expect(email.text).not.toMatch(/short list|Please send/);
    expect(email.text).toContain("I'll review what you shared");
    expect(email.text.match(/Thank you for contacting/g)).toHaveLength(1);
    expect(email.html.match(/>Upload your documents</g)).toHaveLength(1);
  });
});
describe("producer and delivery ownership", () => {
  it("uses the assigned salesperson in the prompt, both signatures, and queued identity", async () => {
    await handler();
    expect(h.producer).toHaveBeenCalledWith("jake");
    expect(h.model.mock.calls[0][0].system).toContain("writing as Jake Greasley");
    const email = h.queue.mock.calls[0][1];
    expect(email).toMatchObject({ producerId: "jake", producerName: "Jake Greasley" });
    expect(email.text).toContain("Thanks,\nJake Greasley");
    expect(email.html).toContain("Thanks,<br>Jake Greasley");
    expect(JSON.stringify(email)).not.toContain("Brian Cole");
  });
  it("retains the assigned identity during copy regeneration", async () => {
    process.env.SITE_BASE_URL = "https://preview.example.test";
    h.model.mockResolvedValueOnce({ content: [{ type: "tool_use", input: { subject: "Welcome", body: "I've put a short list of what helps below." } }] });
    await handler();
    expect(h.model).toHaveBeenCalledTimes(2);
    for (const [request] of h.model.mock.calls) expect(request.system).toContain("writing as Jake Greasley");
  });
  it.each(["missing workflow", "pending assignment", "disabled producer", "temporarily unavailable producer"])("waits and retries for %s without generating or permanently failing", async reason => {
    if (reason === "missing workflow") h.workflow = undefined;
    else if (reason === "pending assignment") { h.workflow.data.salespersonId = undefined; h.producer.mockRejectedValue(new Error("Assign an active salesperson")); }
    else h.producer.mockRejectedValue(new Error(reason));
    const result = await handler();
    expect(result.failed).toBe(0);
    expect(h.state).toBe("WAITING");
    expect(h.model).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect(h.issue).toHaveBeenCalledWith("generation-assignment:r1", expect.stringContaining("Initial email is waiting:"), "a1");
    h.workflow = { data: { disposition: "ACTIVE", humanTakeover: false, salespersonId: "jake" } };
    h.producer.mockResolvedValue({ producerId: "jake", producerName: "Jake Greasley" });
    await handler();
    expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.resolveIssue).toHaveBeenCalledWith("generation-assignment:r1");
    expect(h.resolveIssue).not.toHaveBeenCalledWith("generation:r1");
  });
  it.each(["projection", "issue"])("keeps pending assignment retryable when %s persistence fails", async failure => {
    h.workflow = undefined;
    if (failure === "projection") h.waitProjectionError = true;
    else h.issue.mockRejectedValueOnce(new Error("Temporary storage failure"));
    const result = await handler();
    expect(result.failed).toBe(0); expect(h.state).toBe("WAITING");
    expect(h.update).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled();
  });
  it("does not generate or change an email whose operation already exists", async () => {
    h.operation = { data: { state: "ACCEPTED" } };
    await handler();
    expect(h.producer).not.toHaveBeenCalled(); expect(h.model).not.toHaveBeenCalled(); expect(h.queue).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith({ id: "r1", status: "QUEUED" });
  });
  it("does not claim non-delivery when status projection fails after queueing", async () => {
    h.projectError = true; const result = await handler();
    expect(result.queued).toBe(1); expect(result.failed).toBe(0); expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls.some(([r]) => r.status === "FAILED")).toBe(false); expect(h.issue).toHaveBeenCalledWith("generation:r1", expect.stringContaining("Do not send another"), "a1");
  });
  it("does not overwrite SENT when the worker wins before the producer writes QUEUED", async () => {
    h.workerWins = true; await handler(); expect(h.state).toBe("SENT"); expect(h.update).not.toHaveBeenCalled();
  });
});
