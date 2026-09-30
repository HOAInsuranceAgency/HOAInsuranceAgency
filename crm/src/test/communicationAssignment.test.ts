import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadWorkflow, TeamEligibility } from "../../../shared/leadWorkflow";

const h = vi.hoisted(() => ({
  records: new Map<string, any>(), front: vi.fn(), text: vi.fn(), enabledUser: vi.fn(), ensureWorkflow: vi.fn(),
  beforeLease: undefined as (() => void) | undefined,
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...(await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>()),
  DynamoDBDocumentClient: { from: () => ({ send: async (command: any) => {
    const input = command.input;
    if (command.constructor.name === "GetCommand") return { Item: structuredClone(h.records.get(input.Key.id)) };
    if (command.constructor.name !== "TransactWriteCommand") throw new Error(`Unexpected command ${command.constructor.name}`);
    if (input.TransactItems.some((write: any) => write.Put?.Item.data.state === "LEASED") && h.beforeLease) {
      const mutate = h.beforeLease; h.beforeLease = undefined; mutate();
    }
    for (const write of input.TransactItems) {
      const change = write.Put ?? write.ConditionCheck;
      const current = h.records.get(change.Item?.id ?? change.Key.id);
      if (change.ConditionExpression === "attribute_not_exists(id)" ? !!current : current?.version !== change.ExpressionAttributeValues[":v"]) {
        throw Object.assign(new Error("Concurrent assignment changed"), { name: "ConditionalCheckFailedException" });
      }
    }
    for (const write of input.TransactItems) if (write.Put) h.records.set(write.Put.Item.id, structuredClone(write.Put.Item));
    return {};
  } }) },
}));
vi.mock("../../amplify/functions/communications/cleanup", () => ({ archiveAllowed: async () => true }));
vi.mock("../../amplify/functions/communications/config", () => ({ config: async () => ({ paused: false, activatedAt: "2026-09-01", environment: "main", frontInboxId: "inb_sales", frontChannelId: "cha_sales", frontSender: "sales@example.com" }) }));
vi.mock("../../amplify/functions/communications/workflow", () => ({ ensureWorkflow: h.ensureWorkflow, enabledUser: h.enabledUser, recordOutbound: vi.fn() }));
vi.mock("../../amplify/functions/communications/data", () => ({ dataClient: async () => ({ models: {} }) }));
vi.mock("../../amplify/functions/lead-intake/alerts", () => ({ textLeadAlerts: h.text }));
vi.mock("../../amplify/functions/communications/providers", async importOriginal => ({
  ...(await importOriginal<typeof import("../../amplify/functions/communications/providers")>()),
  front: h.front, assertRecipient: vi.fn(), permittedConversation: async (id: string) => ({ id }), verifyEmailChannel: vi.fn(),
}));

import { get, row, save } from "../../amplify/functions/communications/store";
import { enqueueOperation, runOperation, type Operation } from "../../amplify/functions/communications/operations";

const lead = { id: "a1", name: "Willow HOA" };
const record = (id: string) => h.records.get(id)!;
async function member(userId: string, overrides: Partial<TeamEligibility> = {}) {
  const id = `eligibility:${userId}`, old = await get<TeamEligibility>(id);
  return save(row("ELIGIBILITY", id, { userId, name: userId, enabled: true, salesperson: true, frontId: `tea_${userId}`, ...overrides }, { previous: old }), old);
}
async function workflow(overrides: Partial<LeadWorkflow> = {}) {
  const old = await get<LeadWorkflow>("workflow:a1");
  return save(row<LeadWorkflow>("WORKFLOW", "workflow:a1", { accountId: "a1", name: lead.name, salespersonId: "alice", ownershipModel: "SALESPERSON", disposition: "ACTIVE", version: 1, updatedAt: new Date().toISOString(), ...overrides }, { accountId: "a1", previous: old }), old);
}
beforeEach(async () => {
  vi.clearAllMocks(); h.records.clear(); h.beforeLease = undefined;
  process.env.COMMUNICATION_TABLE = "comms";
  h.enabledUser.mockReset().mockResolvedValue({ Enabled: true });
  h.ensureWorkflow.mockReset().mockImplementation(async () => get("workflow:a1"));
  h.text.mockReset().mockResolvedValue({ attempted: 1, sent: 1, failed: 0 });
  h.front.mockReset().mockResolvedValue({});
  await member("alice"); await member("bob"); await workflow();
});

describe("single-producer website text alerts", () => {
  it("sends only to the persisted owner and does not repeat a confirmed alert", async () => {
    const op = await enqueueOperation("op:sms:s1", { type: "SMS_ALERT", accountId: "a1", assigneeId: "tea_bob", lead });
    await runOperation(op); await runOperation(op);
    expect(h.text).toHaveBeenCalledExactlyOnceWith(expect.anything(), lead, "alice");
    expect(h.enabledUser).toHaveBeenCalledExactlyOnceWith("alice");
    expect(record(op.id).data.state).toBe("CONFIRMED");
    expect(h.ensureWorkflow).not.toHaveBeenCalled();
  });

  it.each(["missing workflow", "missing owner", "ineligible owner", "disabled eligibility", "disabled user"])("holds %s visibly without broadcasting or choosing a default", async state => {
    if (state === "missing workflow") h.records.delete("workflow:a1");
    if (state === "missing owner") await workflow({ salespersonId: undefined });
    if (state === "ineligible owner") await member("alice", { salesperson: false });
    if (state === "disabled eligibility") await member("alice", { enabled: false });
    if (state === "disabled user") h.enabledUser.mockRejectedValue(new Error("Disabled user"));
    const op = await enqueueOperation("op:sms:s1", { type: "SMS_ALERT", accountId: "a1", lead });
    await runOperation(op);
    expect(record(op.id).data).toMatchObject({ state: "RETRY_WAIT", attempts: 0 });
    expect(record(`issue:${op.id}`).data.resolved).toBe(false);
    expect(h.text).not.toHaveBeenCalled(); expect(h.ensureWorkflow).not.toHaveBeenCalled();
  });

  it("uses a repaired assignment and resolves its issue on successful delivery", async () => {
    await workflow({ salespersonId: undefined });
    const op = await enqueueOperation("op:sms:s1", { type: "SMS_ALERT", accountId: "a1", lead });
    await runOperation(op); await workflow({ salespersonId: "bob" }); await runOperation(op);
    expect(h.text).toHaveBeenCalledExactlyOnceWith(expect.anything(), lead, "bob");
    expect(record(`issue:${op.id}`).data.resolved).toBe(true);
  });

  it("rechecks ownership when reassignment wins before delivery is leased", async () => {
    const op = await enqueueOperation("op:sms:s1", { type: "SMS_ALERT", accountId: "a1", lead });
    h.beforeLease = () => {
      const old = record("workflow:a1");
      h.records.set(old.id, row("WORKFLOW", old.id, { ...old.data, salespersonId: "bob" }, { accountId: "a1", previous: old }));
    };
    await runOperation(op);
    expect(h.text).not.toHaveBeenCalled(); expect(record(op.id).data.state).toBe("READY");
    await runOperation(op);
    expect(h.text).toHaveBeenCalledExactlyOnceWith(expect.anything(), lead, "bob");
  });

  it("does not send if the producer loses eligibility before delivery is leased", async () => {
    const op = await enqueueOperation("op:sms:s1", { type: "SMS_ALERT", accountId: "a1", lead });
    h.beforeLease = () => {
      const old = record("eligibility:alice");
      h.records.set(old.id, row("ELIGIBILITY", old.id, { ...old.data, enabled: false }, { previous: old }));
    };
    await runOperation(op); await runOperation(op);
    expect(h.text).not.toHaveBeenCalled(); expect(record(op.id).data.state).toBe("RETRY_WAIT");
  });

  it("requires review instead of automatically repeating a failed or uncertain send", async () => {
    const failed = await enqueueOperation("op:sms:failed", { type: "SMS_ALERT", accountId: "a1", lead });
    h.text.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1 });
    await runOperation(failed); await runOperation(failed);
    expect(record(failed.id).data.state).toBe("FAILED");
    const uncertain = await enqueueOperation("op:sms:uncertain", { type: "SMS_ALERT", accountId: "a1", lead });
    h.text.mockRejectedValueOnce(new Error("Lost response"));
    await runOperation(uncertain); await runOperation(uncertain);
    expect(record(uncertain.id).data.state).toBe("UNKNOWN");
    expect(h.text).toHaveBeenCalledTimes(2);
  });
});

describe("website Front assignment", () => {
  async function intake() {
    await save(row("SUBMISSION", "submission:s1", { snapshot: { contactEmail: "jane@example.com", contactFirstName: "Jane", contactLastName: "Doe" }, receivedAt: "2026-09-01T12:00:00.000Z" }, { accountId: "a1" }));
    return enqueueOperation("op:intake:s1", { type: "IMPORT", accountId: "a1", submissionId: "s1" });
  }

  it.each(["missing workflow", "missing owner", "ineligible owner", "disabled eligibility", "disabled user"])("holds a Front import with %s until an active producer is assigned", async state => {
    if (state === "missing workflow") h.records.delete("workflow:a1");
    if (state === "missing owner") await workflow({ salespersonId: undefined });
    if (state === "ineligible owner") await member("alice", { salesperson: false });
    if (state === "disabled eligibility") await member("alice", { enabled: false });
    if (state === "disabled user") h.enabledUser.mockRejectedValue(new Error("Disabled user"));
    const op = await intake();
    await runOperation(op);
    expect(record(op.id).data).toMatchObject({ state: "RETRY_WAIT", attempts: 0 });
    expect(record(`issue:${op.id}`).data.resolved).toBe(false);
    expect(h.front).not.toHaveBeenCalled(); expect(h.ensureWorkflow).not.toHaveBeenCalled();
    if (state === "missing workflow") expect(h.records.has("workflow:a1")).toBe(false);
    if (state === "missing owner") expect(record("workflow:a1").data.salespersonId).toBeUndefined();
  });

  it("imports after the persisted producer is verified even when their Front mapping needs repair", async () => {
    await member("bob", { frontId: undefined });
    await workflow({ salespersonId: "bob" });
    const op = await intake();
    h.front.mockResolvedValueOnce({ message_uid: "uid_s1" });
    await runOperation(op);
    expect(h.enabledUser).toHaveBeenCalledExactlyOnceWith("bob");
    expect(h.front).toHaveBeenCalledExactlyOnceWith("/inboxes/inb_sales/imported_messages", "POST", expect.objectContaining({ external_id: "hoa:main:s1" }));
    expect(record(op.id).data).toMatchObject({ state: "ACCEPTED", attempts: 1, uid: "uid_s1" });
    expect(h.ensureWorkflow).not.toHaveBeenCalled();
  });

  it("holds the import when ownership changes before its delivery lease", async () => {
    const op = await intake();
    h.beforeLease = () => {
      const old = record("workflow:a1");
      h.records.set(old.id, row("WORKFLOW", old.id, { ...old.data, salespersonId: "bob" }, { accountId: "a1", previous: old }));
    };
    await runOperation(op);
    expect(h.front).not.toHaveBeenCalled(); expect(record(op.id).data.state).toBe("READY");
    h.front.mockResolvedValueOnce({ message_uid: "uid_s1" });
    await runOperation(op);
    expect(h.enabledUser).toHaveBeenLastCalledWith("bob");
    expect(h.front).toHaveBeenCalledTimes(1);
    expect(record(op.id).data.state).toBe("ACCEPTED");
  });

  it("holds the import when producer eligibility changes before its delivery lease", async () => {
    const op = await intake();
    h.beforeLease = () => {
      const old = record("eligibility:alice");
      h.records.set(old.id, row("ELIGIBILITY", old.id, { ...old.data, enabled: false }, { previous: old }));
    };
    await runOperation(op); await runOperation(op);
    expect(h.front).not.toHaveBeenCalled();
    expect(record(op.id).data).toMatchObject({ state: "RETRY_WAIT", attempts: 0 });
    expect(record(`issue:${op.id}`).data.resolved).toBe(false);
  });

  it("keeps assignment queued when the selected producer has no Front mapping and recovers after repair", async () => {
    await member("alice", { frontId: undefined });
    const imported = await save(row<Operation>("OPERATION", "op:intake:s1", { type: "IMPORT", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_s1" }, { accountId: "a1" }));
    h.front.mockResolvedValueOnce({ id: "msg_s1", is_inbound: true, is_draft: false, created_at: Date.now() / 1000, conversation: { id: "cnv_a" } });
    await runOperation(imported); await runOperation(imported);
    expect(record(imported.id).data.state).toBe("CONFIRMED");
    const assigned = (await get<Operation>("op:assign:cnv_a"))!;
    expect(assigned.data).toMatchObject({ type: "ASSIGN", state: "READY" });
    await runOperation(assigned);
    expect(record(assigned.id).data).toMatchObject({ state: "RETRY_WAIT", attempts: 0 });
    expect(record(`issue:${assigned.id}`).data.message).toContain("Front identity in Team settings");
    expect(h.front.mock.calls.filter(([, method]) => method === "PATCH")).toHaveLength(0);
    await member("alice", { frontId: "tea_repaired" });
    await runOperation(assigned); await runOperation(assigned);
    expect(h.front).toHaveBeenCalledWith("/conversations/cnv_a", "PATCH", { assignee_id: "tea_repaired" });
    expect(h.front.mock.calls.filter(([, method]) => method === "PATCH")).toHaveLength(1);
    expect(record(`issue:${assigned.id}`).data.resolved).toBe(true);
  });

  it("assigns Front to the current owner instead of a stale queued recipient", async () => {
    const op = await enqueueOperation("op:assign:cnv_a", { type: "ASSIGN", accountId: "a1", conversationId: "cnv_a", assigneeId: "tea_bob" });
    h.front.mockImplementation(async () => {
      // A webhook can arrive before the PATCH response. Its event handler must
      // recognize our own assignment using the recipient saved in the lease.
      expect(record(op.id).data).toMatchObject({ state: "LEASED", assigneeId: "tea_alice" });
      return {};
    });
    await runOperation(op);
    expect(h.front).toHaveBeenCalledExactlyOnceWith("/conversations/cnv_a", "PATCH", { assignee_id: "tea_alice" });
    expect(h.enabledUser).toHaveBeenCalledExactlyOnceWith("alice");
    expect(record(op.id).data).toMatchObject({ state: "CONFIRMED", assigneeId: "tea_alice" });
  });

  it("holds Front assignment for a disabled user even if their Front mapping remains", async () => {
    h.enabledUser.mockRejectedValue(new Error("Disabled user"));
    const op = await enqueueOperation("op:assign:cnv_a", { type: "ASSIGN", accountId: "a1", conversationId: "cnv_a" });
    await runOperation(op);
    expect(record(op.id).data.state).toBe("RETRY_WAIT");
    expect(record(`issue:${op.id}`).data.message).toContain("active");
    expect(h.front).not.toHaveBeenCalled();
  });

  it("preserves a teammate's manual Front assignment", async () => {
    await save(row("LINK", "front-link:cnv_a", { routing: "MANUAL" }, { accountId: "a1" }));
    const op = await enqueueOperation("op:assign:cnv_a", { type: "ASSIGN", accountId: "a1", conversationId: "cnv_a" });
    await runOperation(op);
    expect(record(op.id).data.state).toBe("SUPPRESSED");
    expect(h.enabledUser).not.toHaveBeenCalled(); expect(h.front).not.toHaveBeenCalled();
  });
});
