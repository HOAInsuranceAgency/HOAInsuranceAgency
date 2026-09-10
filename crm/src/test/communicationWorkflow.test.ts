import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Communication, IntegrationConfig, LeadTask } from "../../../shared/leadWorkflow";
const h = vi.hoisted(() => ({ records: new Map<string, Record<string, any>>(), transactions: [] as any[][], inFlight: 0, maxInFlight: 0, fail: false, writeError: undefined as Error | undefined, accountError: false, userEnabled: true,
  front: vi.fn(), dialpad: vi.fn(), update: vi.fn(), c: {} as IntegrationConfig }));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: async (command: any) => {
    const p = command.input;
    if (command.constructor.name === "GetCommand") return { Item: h.records.get(`${p.TableName}:${p.Key.id}`) };
    if (command.constructor.name === "QueryCommand") {
      const v = p.ExpressionAttributeValues;
      let items = [...h.records.entries()].filter(([k,r]) => k.startsWith(`${p.TableName}:`) && r[p.ExpressionAttributeNames["#k"]] === v[":k"] && (!v[":prefix"] || r.accountSort?.startsWith(v[":prefix"])) && (!v[":now"] || r.dueAt <= v[":now"])).map(([,r]) => r);
      const sort = p.IndexName === "account" ? "accountSort" : p.IndexName === "due" ? "dueAt" : p.IndexName === "work" ? "workAt" : "id";
      items.sort((a,b) => String(a[sort]).localeCompare(String(b[sort])) * (p.ScanIndexForward === false ? -1 : 1));
      if (p.ExclusiveStartKey) items = items.slice(items.findIndex(r => r.id === p.ExclusiveStartKey.id) + 1);
      const selected = items.slice(0, p.Limit ?? 100);
      return { Items: selected, LastEvaluatedKey: items.length > selected.length ? { id: selected.at(-1)!.id } : undefined };
    }
    if (command.constructor.name === "TransactWriteCommand") {
      h.inFlight++; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      await Promise.resolve(); h.inFlight--;
      if (h.fail) throw new Error("Simulated storage outage");
      if (h.writeError) { const error = h.writeError; h.writeError = undefined; throw error; }
      const writes = p.TransactItems;
      for (const entry of writes) {
        const w = entry.Put ?? entry.ConditionCheck;
        const old = h.records.get(`${w.TableName}:${w.Item?.id ?? w.Key?.id}`);
        if (w.ConditionExpression === "attribute_not_exists(id)" ? !!old : old?.version !== w.ExpressionAttributeValues[":v"]) throw Object.assign(new Error("Conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      }
      h.transactions.push(writes);
      for (const { Put: w } of writes.filter((w: any) => w.Put)) h.records.set(`${w.TableName}:${w.Item.id}`, structuredClone(w.Item));
      return {};
    }
    throw new Error(`Unexpected storage command ${command.constructor.name}`);
  } }) } };
});
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = async () => ({ Users: [{ Enabled: h.userEnabled }] }); }, ListUsersCommand: class { constructor(public input: unknown) {} } }));
vi.mock("../../amplify/functions/communications/config", async importOriginal => ({ ...(await importOriginal<typeof import("../../amplify/functions/communications/config")>()), saveCredentials: vi.fn(), config: async () => h.c, credentials: async () => ({ frontSigningKey: "test-signing-key", dialpadSigningKey: "test-dialpad-signing-key" }) }));
vi.mock("../../amplify/functions/communications/data", () => ({ dataClient: async () => ({ models: {
  Account: { get: async ({ id }: { id: string }) => (h.accountError ? { data: null, errors: [{ message: "Simulated account read failure" }] } : { data: h.records.get(`Account:${id}`) ?? { id, name: "Willow HOA", stage: "LEAD" } }) },
  LeadReply: { update: h.update },
  UserProfile: { list: async () => ({ data: [...h.records.entries()].filter(([key]) => key.startsWith("UserProfile:")).map(([,profile]) => profile) }) },
} }) }));
vi.mock("../../amplify/functions/communications/providers", async importOriginal => {
  const actual = await importOriginal<typeof import("../../amplify/functions/communications/providers")>();
  return { ...actual, front: h.front, dialpad: h.dialpad, permittedConversation: vi.fn(async (id: string) => ({ id, status: "open" })), verifyEmailChannel: vi.fn() };
});
import { businessDeadline, followUpDeadline } from "../../../shared/leadWorkflow";
import { get, row, save } from "../../amplify/functions/communications/store";
import { handler as capture } from "../../amplify/functions/lead-intake/handler";
import { defaultWorkflow, makeTask, saveTask, recordInbound, recordOutbound, completeTask, setResponsibilities, mergeTasks } from "../../amplify/functions/communications/workflow";
import { archiveAllowed } from "../../amplify/functions/communications/cleanup";
import { remainingDelay, rememberBudget } from "../../amplify/functions/communications/budget";
import { enqueueOperation, runOperation, type Operation } from "../../amplify/functions/communications/operations";
import { permittedConversation, FrontScopeError } from "../../amplify/functions/communications/providers";
import { dialpadEvent, processEvent, ingestFrontMessage } from "../../amplify/functions/communications/events";
import { renderIntakeBrief } from "../../amplify/functions/lead-intake/brief";
const NOW = "2026-09-08T14:00:00.000Z";
const record = (id: string) => h.records.get(`comms:${id}`)!;
const entries = (kind: string) => [...h.records.values()].filter(r => r.kind === kind);
async function lead() { const wf = await defaultWorkflow("a1", "Willow HOA"); return save(row("WORKFLOW", "workflow:a1", { ...wf, conversationId: "cnv_a" }, { accountId: "a1" })); }
async function inbound(id = "m1", at = NOW, extra: Partial<Communication> = {}) { const c: Communication = { id: `comm:${id}`, providerId: id, provider: "front", channel: "EMAIL", direction: "INBOUND", accountId: "a1", conversationId: "cnv_a", at, status: "RECEIVED", version: 1, ...extra }; await save(row("COMMUNICATION", c.id, c, { accountId: c.accountId })); return c; }
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); h.records.clear(); h.transactions.length = 0; h.inFlight = 0; h.maxInFlight = 0; h.fail = false; h.accountError = false; h.userEnabled = true; h.writeError = undefined; vi.clearAllMocks();
  Object.assign(process.env, { COMMUNICATION_TABLE: "comms", ACTIVITY_TABLE: "Activity", ACCOUNT_TABLE: "Account", CONTACT_TABLE: "Contact", PRIOR_CARRIER_TABLE: "PriorCarrier", LEAD_REPLY_TABLE: "LeadReply", USER_POOL_ID: "pool" });
  h.c = { frontCompanyId: "cmp_a", environment: "main", defaultUserId: "brian", frontSender: "sales@protectmyhoa.com", frontInboxId: "inb_a", frontChannelId: "cha_a", holidays: [], paused: false, activatedAt: "2026-09-01T00:00:00Z", allowedInboxIds: [], testRecipients: [], dialpadNumbers: ["+15082332261", "+16175550123"], sharedSmsNumber: "+15082332261", version: 1 };
  await save(row("ELIGIBILITY", "eligibility:brian", { userId: "brian", name: "Brian Cole", email: "brian@example.com", salesperson: true, champion: true, enabled: true }));
  h.update.mockResolvedValue({ data: {} });
  h.front.mockImplementation(async (path: string) => path.includes("/messages") && path.includes("/conversations") ? { _results: [] } : {});
});
afterEach(() => vi.useRealTimers());
describe("agency commitments", () => {
  it.each([
    ["2026-09-08T14:00:30Z", [], "2026-09-09T14:00:30.000Z"],
    ["2026-09-11T20:00:00Z", [], "2026-09-14T20:00:00.000Z"],
    ["2026-09-12T15:00:30Z", [], "2026-09-14T21:00:00.000Z"],
    ["2026-03-06T21:00:00Z", [], "2026-03-09T20:00:00.000Z"],
    ["2026-10-30T20:00:00Z", [], "2026-11-02T21:00:00.000Z"],
    ["2026-09-04T20:00:00Z", ["2026-09-07"], "2026-09-08T20:00:00.000Z"],
  ])("calculates one staffed day from %s", (at, holidays, wanted) => expect(businessDeadline(at, 1, holidays)).toBe(wanted));
  it("uses the second business date for no-reply follow-up", () => expect(followUpDeadline("2026-09-04T20:00Z", 2, ["2026-09-07"])).toBe("2026-09-09T13:00:00.000Z"));
  it("keeps one unanswered episode and its oldest deadline through duplicate/out-of-order messages", async () => {
    await lead(); const a = await inbound("a", "2026-09-08T15:00:00Z"), b = await inbound("b", "2026-09-08T14:00:00Z");
    await recordInbound(a); await recordInbound(b); await recordInbound(a);
    const tasks = entries("TASK"); expect(tasks).toHaveLength(1); expect(tasks[0].data.dueAt).toBe("2026-09-09T14:00:00.000Z"); expect(tasks[0].data.sourceIds).toEqual([a.id, b.id]);
  });
  it("preserves explicit promised dates and source links when a later message arrives", async () => {
    await lead(); const a = await inbound(); await recordInbound(a); const t = entries("TASK")[0];
    await saveTask({ ...t.data, version: t.version, dueAt: "2026-09-15T15:00:00Z", reason: "Prospect requested Tuesday" }, "brian");
    await recordInbound(await inbound("m2")); expect(entries("TASK")[0].data.dueAt).toBe("2026-09-15T15:00:00.000Z"); expect(entries("TASK")[0].data.sourceIds).toHaveLength(2);
  });
  it("rejects stale role edits and never moves a deadline on reassignment", async () => {
    const wf = await lead(); await recordInbound(await inbound()); const before = entries("TASK")[0].data.dueAt;
    await setResponsibilities("a1", "brian", "brian", wf.version, "brian"); expect(entries("TASK")[0].data.dueAt).toBe(before);
    await expect(setResponsibilities("a1", "brian", "brian", wf.version, "brian")).rejects.toThrow("Refresh");
  });
  it("surfaces overdue work to a replacement without restarting its clock", async () => {
    const wf = await lead(); await recordInbound(await inbound()); const original = (await get<LeadTask>(entries("TASK")[0].id))!;
    await save(row("TASK", original.id, { ...original.data, notifiedAt: NOW }, { accountId: "a1", previous: original }), original);
    await save(row("ELIGIBILITY", "eligibility:sally", { userId: "sally", enabled: true, salesperson: true, champion: false }));
    vi.setSystemTime("2026-09-10T14:00:00Z");
    await setResponsibilities("a1", "sally", "brian", wf.version, "brian");
    const changed = record(original.id); expect(changed.data.notifiedAt).toBeUndefined(); expect(changed.data.dueAt).toBe(original.data.dueAt); expect(changed.dueAt).toBe(original.data.dueAt);
  });
  it("requires a successor and atomically resolves only selected source requests", async () => {
    await lead(); await recordInbound(await inbound()); const t = entries("TASK")[0];
    await expect(completeTask({ id: t.id, version: t.version, reason: "Called" }, "brian")).rejects.toThrow("next action");
    await completeTask({ id: t.id, version: t.version, reason: "Answered", successor: { title: "Check documents", dueAt: "2026-09-10T14:00:00Z", role: "SALESPERSON", kind: "DOCUMENTS" } }, "brian");
    expect(record("comm:m1").data.resolved).toBe(true); expect(entries("TASK").filter(t => t.data.status === "OPEN")).toHaveLength(1);
    await recordInbound(record("comm:m1").data); expect(entries("TASK").filter(t => t.data.kind === "RESPONSE" && t.data.status === "OPEN")).toHaveLength(0);
  });
  it("retires a stale reminder after an explicit promise changes without hiding current work", async () => {
    await lead(); await recordInbound(await inbound()); const task = (await get<LeadTask>(entries("TASK")[0].id))!;
    await save(row("TASK", task.id, { ...task.data, notifiedAt: NOW }, { accountId: "a1", previous: task }), task);
    await save(row("NOTIFICATION", "notice:test", { recipient: "brian", taskId: task.id, at: NOW, urgency: "DUE" }, { accountId: "a1" }));
    const { handler } = await import("../../amplify/functions/communications/handler");
    const read = () => handler({ arguments: { readOperation: "work", input: { kind: "NOTIFICATION" } }, identity: { sub: "brian", groups: [] } as never });
    expect(await read()).toMatchObject({ ok: true, items: [{ id: "notice:test" }] });
    const current = (await get<LeadTask>(task.id))!;
    await saveTask({ ...current.data, version: current.version, dueAt: "2026-09-15T14:00:00Z", reason: "Prospect requested next Tuesday" }, "brian");
    expect(await read()).toMatchObject({ ok: true, items: [] });
    expect(record("notice:test").data.resolved).toBe(true); expect(record("notice:test").workKind).toBeUndefined();
    expect(record(task.id).data.status).toBe("OPEN");
  });
  it("Front snooze and archive events do not rewrite commitments", async () => {
    await lead(); await recordInbound(await inbound()); const before = structuredClone(entries("TASK"));
    for (const type of ["snooze", "archive", "reopen"]) { const event = row("EVENT", `e:${type}`, { provider: "front" as const, payload: { type, payload: { conversation: { id: "cnv_a" } } }, attempts: 0 }); await save(event); await processEvent(event); }
    expect(entries("TASK")).toEqual(before);
  });
});
describe("cleanup and combined requests", () => {
  it("only archives after a durable future action and blocks uncertain sends", async () => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(false);
    const comm = await inbound("out", NOW, { direction: "OUTBOUND" }); await recordOutbound(comm);
    expect(await archiveAllowed("a1", "cnv_a")).toBe(true);
    await save(row("OPERATION", "unknown", { type: "EMAIL", state: "UNKNOWN" }, { accountId: "a1" }));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(false);
  });
  it("archives automatically and through manual Tidy despite an old disabled setting, preserving commitments", async () => {
    Object.assign(h.c, { cleanupEnabled: false });
    const wf = await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    await recordOutbound(await inbound("out", NOW, { direction: "OUTBOUND" }));
    const commitments = structuredClone(entries("TASK"));
    await runOperation((await get<Operation>(entries("OPERATION").find(op => op.data.type === "ARCHIVE")!.id))!);
    expect(h.front).toHaveBeenCalledWith("/conversations/cnv_a", "PATCH", { status: "archived" });
    const { handler } = await import("../../amplify/functions/communications/handler");
    expect(await handler({ arguments: { operation: "archive", input: { accountId: "a1", version: wf.version } }, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: true });
    const manual = (await get<Operation>(entries("OPERATION").find(op => op.id.startsWith("op:manual-cleanup:"))!.id))!;
    await runOperation(manual);
    expect(record(manual.id).data.state).toBe("CONFIRMED");
    expect(entries("TASK")).toEqual(commitments);
  });
  it.each(["paused", "not activated", "unanswered request", "overdue", "sync gap", "missing owner"])("still holds cleanup for %s", async condition => {
    const wf = await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    await recordOutbound(await inbound("out", NOW, { direction: "OUTBOUND" }));
    if (condition === "paused") h.c.paused = true;
    if (condition === "not activated") h.c.activatedAt = undefined;
    if (condition === "unanswered request") await recordInbound(await inbound("reply"));
    if (condition === "overdue") {
      const task = (await get<LeadTask>(entries("TASK")[0].id))!;
      await save(row("TASK", task.id, { ...task.data, dueAt: NOW }, { accountId: "a1", previous: task }), task);
    }
    if (condition === "sync gap") await save(row("ISSUE", "issue:sync-gap", { resolved: false }));
    if (condition === "missing owner") await save(row("WORKFLOW", wf.id, { ...wf.data, championId: undefined }, { accountId: "a1", previous: wf }), wf);
    const commitments = structuredClone(entries("TASK"));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(false);
    await runOperation((await get<Operation>(entries("OPERATION").find(op => op.data.type === "ARCHIVE")!.id))!);
    expect(h.front).not.toHaveBeenCalledWith("/conversations/cnv_a", "PATCH", { status: "archived" });
    expect(entries("TASK")).toEqual(commitments);
  });
  it("retires the old setting on reads and saves without changing delivery or requiring activation again", async () => {
    vi.stubEnv("COMMUNICATION_ENV", "main");
    try {
      const actual = await vi.importActual<typeof import("../../amplify/functions/communications/config")>("../../amplify/functions/communications/config");
      await save(row("CONFIG", "config", { ...h.c, cleanupEnabled: false }));
      const loaded = await actual.config();
      expect(loaded).not.toHaveProperty("cleanupEnabled");
      expect(loaded).toMatchObject({ paused: false, activatedAt: h.c.activatedAt });
      const staleClient = { ...loaded, cleanupEnabled: false };
      const saved = await actual.saveConfig(staleClient);
      expect(saved).not.toHaveProperty("cleanupEnabled");
      expect(record("config").data).not.toHaveProperty("cleanupEnabled");
      expect(saved).toMatchObject({ paused: false, activatedAt: h.c.activatedAt });
    } finally { vi.unstubAllEnvs(); }
  });
  it("combines explicitly selected phone/email requests and retains the earliest commitment", async () => {
    await lead(); await recordInbound(await inbound("email", "2026-09-08T14:00:00Z"));
    await recordInbound(await inbound("call", "2026-09-08T16:00:00Z", { channel: "CALL", provider: "dialpad", conversationId: undefined }), "CALLBACK");
    const selected = entries("TASK"); await mergeTasks({ accountId: "a1", tasks: selected.map(t => ({ id: t.id, version: t.version })), reason: "Same insurance enquiry" }, "brian");
    const open = entries("TASK").filter(t => t.data.status === "OPEN"); expect(open).toHaveLength(1); expect(open[0].data.dueAt).toBe("2026-09-09T14:00:00.000Z"); expect(open[0].data.sourceIds).toHaveLength(2);
  });
  it("escalates a default 9am follow-up at 9am on the next business date", async () => {
    const t = await makeTask({ accountId: "a1", title: "Follow up", kind: "FOLLOW_UP", sourceAt: "2026-09-10T14:00:00Z" });
    expect(t.dueAt).toBe("2026-09-14T13:00:00.000Z"); expect(t.escalationAt).toBe("2026-09-15T13:00:00.000Z");
  });
  it("reserves API capacity for sends and honors the longest retry window", async () => {
    await rememberBudget("front", new Response("", { status: 200, headers: { "x-ratelimit-remaining": "4", "x-ratelimit-reset": String(Date.now() / 1000 + 30) } }));
    expect(await remainingDelay("front", true)).toBe(30); expect(await remainingDelay("front", false)).toBe(0);
    await rememberBudget("front", new Response("", { status: 429, headers: { "retry-after": "90" } }));
    await rememberBudget("front", new Response("", { status: 429, headers: { "retry-after": "10" } }));
    expect(await remainingDelay("front", false)).toBe(90);
  });
});

describe("durable public capture", () => {
  const args = { submissionId: "submission-12345678901234567890", retryProof: "p".repeat(64), name: "Willow HOA", contactEmail: "prospect@example.com", contactFirstName: "Mary", contactPhone: "6175550100", answerSnapshot: '{"coverages":["D&O"]}' };
  const submit = (overrides = {}) => capture({ arguments: { ...args, ...overrides } } as never, {} as never, () => {});
  it("captures one lead, intake and AI reply across concurrent browser retries", async () => {
    const [a,b] = await Promise.all([submit(), submit()]); expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true }); expect((a as any).id).toBe((b as any).id);
    expect([...h.records.keys()].filter(k => k.startsWith("Account:"))).toHaveLength(1); expect(entries("OPERATION").filter(o => o.data.type === "IMPORT")).toHaveLength(1); expect(entries("WORKFLOW")[0].data).toMatchObject({ salespersonId: "brian", championId: "brian" });
    expect(h.front).not.toHaveBeenCalled();
  });
  it("does not return a bearer upload token to a guessed identity or changed payload", async () => {
    await submit(); expect(await submit({ retryProof: "q".repeat(64) })).toMatchObject({ ok: false }); expect(await submit({ name: "Different HOA" })).toMatchObject({ ok: false });
  });
  it("does not claim success or leave partial lead records when storage fails", async () => {
    h.fail = true; expect(await submit()).toMatchObject({ ok: false }); expect(entries("SUBMISSION")).toHaveLength(0); expect([...h.records.keys()].filter(k => k.startsWith("Account:"))).toHaveLength(0);
  });
});
describe("Front durable delivery", () => {
  it.each(["<pre>Website submission\nReference: hoa:main:s1\nDetails</pre>", "Website submission\n\nChanged formatting"])("does not turn an imported form into a prospect reply: %s", async text => {
    await lead();
    await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
    await save(row("OPERATION", "op:intake:s1", { type: "IMPORT", uid: "uid_intake" }, { accountId: "a1" }));
    await save(row("UID", "front-uid:uid_intake", { operationId: "op:intake:s1", accountId: "a1" }));
    await ingestFrontMessage({ id: "msg_intake", message_uid: "uid_intake", is_inbound: true, created_at: Date.parse(NOW) / 1000, text }, "cnv_a");
    expect(entries("TASK")).toHaveLength(0); expect(entries("COMMUNICATION")).toHaveLength(0);
    await recordOutbound(await inbound("ai", NOW, { direction: "OUTBOUND", actorId: "crm:initial-ai", status: "SENT" }));
    expect(entries("TASK")).toHaveLength(1); expect(entries("TASK")[0].data.kind).toBe("FOLLOW_UP");
  });
  it("recognizes a verified import when its UID index write was interrupted", async () => {
    await lead();
    await save(row("OPERATION", "op:intake:s1", { type: "IMPORT", uid: "uid_intake" }, { accountId: "a1" }));
    await ingestFrontMessage({ id: "msg_intake", message_uid: "uid_intake", is_inbound: true, created_at: Date.parse(NOW) / 1000, text: "<pre>Website submission\nReference: hoa:main:s1\nDetails</pre>" }, "cnv_a");
    expect(entries("COMMUNICATION")).toHaveLength(0);
  });
  it("still creates response work for a real reply quoting the intake reference", async () => {
    await lead();
    await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
    await save(row("OPERATION", "op:intake:s1", { type: "IMPORT", uid: "uid_intake" }, { accountId: "a1" }));
    await ingestFrontMessage({ id: "msg_reply", message_uid: "uid_reply", is_inbound: true, created_at: Date.parse(NOW) / 1000, text: "Website submission\nReference: hoa:main:s1\nPlease call me." }, "cnv_a");
    expect(entries("TASK")[0].data.kind).toBe("RESPONSE");
  });
  it.each([true, false])("recognizes the new brief only when its import UID matches: %s", async matches => {
    await lead();
    vi.stubEnv("CRM_BASE_URL", "https://staging.example.com");
    try {
      await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
      await save(row("OPERATION", "op:intake:s1", { type: "IMPORT", uid: "uid_intake" }, { accountId: "a1" }));
      const { html } = renderIntakeBrief({ snapshot: {}, accountId: "a1", accountName: "Willow HOA", submissionId: "s1", receivedAt: NOW, environment: "main", crmBaseUrl: process.env.CRM_BASE_URL });
      await ingestFrontMessage({ id: "msg_brief", message_uid: matches ? "uid_intake" : "uid_reply", is_inbound: true, created_at: Date.parse(NOW) / 1000, body: html, text: "Please call me. New website lead Willow HOA" }, "cnv_a");
      expect(entries("COMMUNICATION")).toHaveLength(matches ? 0 : 1);
      if (!matches) expect(entries("TASK")[0].data.kind).toBe("RESPONSE");
    } finally { vi.unstubAllEnvs(); }
  });
  it("clears only the recovered delivery warning when Front confirms an accepted email", async () => {
    await lead();
    const op = await save(row<Operation>("OPERATION", "op:recovered", { type: "EMAIL", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_recovered", recipient: "prospect@example.com", error: "Waiting for the Front intake conversation", failures: 3 }, { accountId: "a1" }));
    await save(row("ISSUE", `issue:${op.id}`, { resolved: false, message: op.data.error }, { accountId: "a1" }));
    await save(row("ISSUE", "issue:sync-gap", { resolved: false, message: "Review missed SMS" }));
    h.front.mockResolvedValueOnce({ id: "msg_recovered", is_inbound: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_a" } });
    await runOperation(op);
    expect(record(op.id).data).toMatchObject({ state: "CONFIRMED", failures: 0 });
    expect(record(op.id).data.error).toBeUndefined();
    expect(record(`issue:${op.id}`).data.resolved).toBe(true);
    expect(record(`issue:${op.id}`).workKind).toBeUndefined();
    expect(record("issue:sync-gap").data.resolved).toBe(false);
    expect(h.transactions.some(writes => writes.some(w => w.Put?.Item.id === op.id && w.Put.Item.data.state === "CONFIRMED") && writes.some(w => w.Put?.Item.id === `issue:${op.id}` && w.Put.Item.data.resolved))).toBe(true);
    expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
  it("keeps a delivery warning open while its UID is still pending", async () => {
    await lead();
    const op = await save(row<Operation>("OPERATION", "op:pending", { type: "EMAIL", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_pending" }, { accountId: "a1" }));
    await save(row("ISSUE", `issue:${op.id}`, { resolved: false }, { accountId: "a1" }));
    h.front.mockResolvedValue({ is_draft: true });
    await runOperation(op);
    expect(record(op.id).data.state).toBe("ACCEPTED");
    expect(record(`issue:${op.id}`).data.resolved).toBe(false);
  });
  it("imports escaped HTML using Front's explicit HTML body format", async () => {
    await lead();
    await save(row("SUBMISSION", "submission:html", { snapshot: { contactEmail: "prospect@example.com", notes: "<script>alert('test')</script>" }, receivedAt: NOW }));
    const op = await enqueueOperation("op:html", { type: "IMPORT", accountId: "a1", submissionId: "html" });
    h.front.mockResolvedValue({ message_uid: "uid_html" });
    await runOperation(op);
    const body = h.front.mock.calls.find(c => c[1] === "POST")![2];
    expect(body.body_format).toBe("html"); expect(body.body).toContain("&lt;script&gt;"); expect(body.body).not.toContain("<script>");
    expect(body.body).not.toContain("<pre>"); expect(body.external_id).toBe("hoa:main:html");
    expect(body.metadata.thread_ref).toBe(body.external_id);
  });
  it("treats accepted UID as pending until the outbound message resolves", async () => {
    await lead(); const op = await enqueueOperation("op:test", { type: "EMAIL", accountId: "a1", replyId: "r1", recipient: "prospect@example.com", text: "Hello", html: "<p>Hello</p>" });
    h.front.mockImplementation(async (path: string, method?: string) => method === "POST" ? { message_uid: "uid_1" } : path.startsWith("/messages/alt") ? { id: "msg_1", message_uid: "uid_1", is_inbound: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_a" } } : { _results: [] });
    await runOperation(op); expect(record(op.id).data.state).toBe("ACCEPTED"); expect(h.update).not.toHaveBeenCalled(); expect(entries("TASK")).toHaveLength(0);
    await runOperation((await get<Operation>(op.id))!); expect(record(op.id).data.state).toBe("CONFIRMED"); expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ status: "SENT" })); expect(entries("TASK")[0].data.kind).toBe("FOLLOW_UP");
    const body = h.front.mock.calls.find(c => c[1] === "POST")![2]; expect(body).toMatchObject({ sender_name: "Brian Cole", to: ["prospect@example.com"], cc: [], bcc: [], quote_body: "", signature_id: null, options: { archive: false } });
  });
  it("never automatically resends after a lost delivery response", async () => {
    await lead(); const op = await enqueueOperation("op:test", { type: "EMAIL", accountId: "a1", recipient: "prospect@example.com" });
    h.front.mockImplementation(async (_p: string, method?: string) => { if (method === "POST") throw new Error("Connection closed after send"); return { _results: [] }; });
    await runOperation(op); expect(record(op.id).data.state).toBe("UNKNOWN"); await runOperation((await get<Operation>(op.id))!); expect(h.front.mock.calls.filter(c => c[1] === "POST")).toHaveLength(1);
  });
  it("confirms an accepted email after a verified Front merge without resending it", async () => {
    await lead();
    const op = await save(row<Operation>("OPERATION", "op:merged", { type: "EMAIL", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_merged", replyId: "r1", recipient: "prospect@example.com", text: "Hello" }, { accountId: "a1" }));
    h.front.mockResolvedValue({ id: "msg_merged", is_inbound: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_b" } });
    vi.mocked(permittedConversation).mockResolvedValueOnce({ id: "cnv_b", status: "open" }).mockResolvedValueOnce({ id: "cnv_b", status: "open" });
    await runOperation(op);
    expect(record(op.id).data.state).toBe("CONFIRMED"); expect(record("workflow:a1").data.conversationId).toBe("cnv_b");
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ status: "SENT" })); expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
  it("does not reconcile an accepted email into an unrelated conversation", async () => {
    await lead();
    const op = await save(row<Operation>("OPERATION", "op:unrelated", { type: "EMAIL", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_wrong", recipient: "prospect@example.com" }, { accountId: "a1" }));
    h.front.mockResolvedValue({ id: "msg_wrong", is_inbound: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_b" } });
    await runOperation(op); expect(record(op.id).data.state).not.toBe("CONFIRMED"); expect(h.update).not.toHaveBeenCalled(); expect(entries("TASK")).toHaveLength(0);
  });
  it("rate-limits a requested Seen refresh, checks an older email once, and preserves its commitment", async () => {
    await lead(); await recordInbound(await inbound()); const deadline = entries("TASK")[0].data.dueAt;
    const comm = await inbound("old", "2026-08-01T14:00:00Z", { direction: "OUTBOUND", status: "SENT" });
    const { handler } = await import("../../amplify/functions/communications/handler");
    const refresh = () => handler({ arguments: { operation: "refreshSeen", input: { id: comm.id } }, identity: { sub: "brian", groups: [] } as never });
    expect(await refresh()).toMatchObject({ ok: true }); const version = record(comm.id).version;
    expect(await refresh()).toMatchObject({ ok: true }); expect(record(comm.id).version).toBe(version);
    h.front.mockResolvedValue({ _results: [{ first_seen_at: String(Date.parse(NOW)) }] });
    const { refreshCommunication } = await import("../../amplify/functions/communications/worker");
    await refreshCommunication((await get<Communication>(comm.id))!);
    expect(record(comm.id).data.seenAt).toBe(NOW); expect(record(comm.id).data.seenRequestedAt).toBeUndefined(); expect(record(comm.id).dueAt).toBeUndefined();
    expect(entries("TASK")[0].data.dueAt).toBe(deadline); expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
  it("suppresses a queued AI send when a human already replied", async () => {
    await lead(); const op = await enqueueOperation("op:test", { type: "EMAIL", accountId: "a1", recipient: "prospect@example.com" }); h.front.mockResolvedValue({ _results: [{ is_inbound: false, author: { id: "tea_b" } }] });
    await runOperation(op); expect(record(op.id).data.state).toBe("SUPPRESSED"); expect(h.front.mock.calls.filter(c => c[1] === "POST")).toHaveLength(0);
  });
});
describe("Dialpad event ordering", () => {
  const call = { call_id: 1001, entry_point_call_id: 1000, internal_number: "+15082332261", external_number: "+16175550111", target: { id: 5, type: "user" }, direction: "inbound", date_started: Date.parse(NOW) };
  it("records one answered customer call when one agent misses and another answers", async () => {
    await dialpadEvent({ ...call, state: "hangup" }); await dialpadEvent({ ...call, call_id: 1002, state: "connected", date_connected: Date.parse(NOW) + 10000 }); await dialpadEvent({ ...call, state: "hangup" });
    expect(entries("COMMUNICATION")).toHaveLength(1); expect(entries("COMMUNICATION")[0].data.status).toBe("CONNECTED"); expect(entries("TASK")).toHaveLength(0); expect(entries("TRIAGE")).toHaveLength(1);
  });
  it("keeps SMS delivery monotonic through duplicate and reordered receipts", async () => {
    const sms = { id: 222, direction: "outbound", created_date: Date.parse(NOW), target: { phone_number: "+15082332261" }, contact: { phone_number: "+16175550111" }, text: "Hello" };
    for (const message_status of ["delivered", "pending", "sent", "delivered"]) await dialpadEvent({ ...sms, message_status });
    expect(entries("COMMUNICATION")).toHaveLength(1); expect(entries("COMMUNICATION")[0].data.status).toBe("DELIVERED");
  });
});

describe("review regressions: deadline delivery and recovery", () => {
  async function dueTask(kind: LeadTask["kind"] = "RESPONSE") {
    await lead(); const task = await makeTask({ accountId: "a1", kind, title: "Follow up", conversationId: "cnv_a" });
    await save(row("TASK", task.id, task, { accountId: "a1", dueAt: task.dueAt }));
    vi.setSystemTime(new Date(Date.parse(task.dueAt) + 1)); return (await get<LeadTask>(task.id))!;
  }
  it("preserves a live task when the account read returns GraphQL errors", async () => {
    const task = await dueTask(); h.accountError = true;
    const { dispatchTask } = await import("../../amplify/functions/communications/worker");
    await expect(dispatchTask(task)).rejects.toThrow("commitment remains open");
    expect(record(task.id).data.status).toBe("OPEN"); expect(record(task.id).dueAt).toBe(task.dueAt);
  });
  it("delivers the due notice, then escalates on the original business deadline", async () => {
    const task = await dueTask();
    await save(row("ELIGIBILITY", "eligibility:champ", { enabled: true }));
    const wf = (await get<any>("workflow:a1"))!; await save(row("WORKFLOW", wf.id, { ...wf.data, championId: "champ" }, { accountId: "a1", previous: wf }), wf);
    const { handler } = await import("../../amplify/functions/communications/worker"); h.c.paused = true;
    await handler(); expect(entries("NOTIFICATION")).toHaveLength(1); expect(entries("NOTIFICATION")[0].data.recipient).toBe("brian");
    expect(record(task.id).dueAt).toBe(task.data.escalationAt);
    vi.setSystemTime(new Date(Date.parse(task.data.escalationAt) + 1)); await handler();
    expect(entries("NOTIFICATION")).toHaveLength(2); expect(entries("NOTIFICATION").find(r => r.data.recipient === "champ")?.data.urgency).toBe("ESCALATED");
    expect(record(task.id).data.dueAt).toBe(task.data.dueAt); expect(record(task.id).data.escalatedAt).toBeTruthy();
  });
  it("coalesces already overdue work for the same salesperson/champion into one escalated notice", async () => {
    const task = await dueTask(); vi.setSystemTime(new Date(Date.parse(task.data.escalationAt) + 1));
    const { dispatchTask } = await import("../../amplify/functions/communications/worker"); await dispatchTask(task);
    expect(entries("NOTIFICATION")).toHaveLength(1); expect(entries("NOTIFICATION")[0].data.urgency).toBe("ESCALATED"); expect(record(task.id).dueAt).toBeUndefined();
  });
  it("keeps a deadline scheduled after more than twelve processing failures and resets failures on success", async () => {
    const task = await dueTask(); h.accountError = true; h.c.paused = true;
    const { handler } = await import("../../amplify/functions/communications/worker");
    for (let n = 0; n < 14; n++) { await handler(); expect(record(task.id).dueAt).toBeTruthy(); vi.setSystemTime(new Date(Date.parse(record(task.id).dueAt) + 1)); }
    expect(record(task.id).data.status).toBe("OPEN"); expect(record(task.id).data.attempts).toBe(14);
    h.accountError = false; await handler(); expect(record(task.id).data.attempts).toBe(0); expect(entries("NOTIFICATION").length).toBeGreaterThan(0);
  });
  it("does not spend a task's failure budget on Front rate limits", async () => {
    const task = await dueTask("FOLLOW_UP"); h.c.paused = true;
    const { ProviderError } = await import("../../amplify/functions/communications/providers");
    h.front.mockRejectedValue(new ProviderError("Rate limited", 429, false, 60));
    const { handler } = await import("../../amplify/functions/communications/worker");
    for (let n = 0; n < 14; n++) { await handler(); vi.setSystemTime(new Date(Date.parse(record(task.id).dueAt) + 1)); }
    expect(record(task.id).data.attempts).toBe(0); expect(record(task.id).workKind).toBe("TASK"); expect(record(task.id).dueAt).toBeTruthy();
    expect(entries("ISSUE").some(r => r.accountId === "a1")).toBe(true);
    h.front.mockResolvedValue({ _results: [] }); await handler(); expect(record(task.id).data.notifiedAt).toBeTruthy();
  });
  it("rejects a new promise in the past but preserves a historical inbound deadline", async () => {
    await expect(makeTask({ accountId: "a1", title: "Promise", kind: "FOLLOW_UP", custom: true, dueAt: "2026-09-01T14:00:00Z" })).rejects.toThrow("future");
    const task = await makeTask({ accountId: "a1", title: "Late linked callback", kind: "CALLBACK", sourceAt: "2026-09-01T14:00:00Z" }); expect(task.dueAt).toBe("2026-09-02T14:00:00.000Z");
  });
});

describe("review regressions: provider capture and delivery", () => {
  it("discards signed outside-inbox traffic and persists only identifiers for eligible Front events", async () => {
    const { handler } = await import("../../amplify/functions/communications/webhook");
    const { createHmac } = await import("node:crypto");
    const send = async (inbox: string) => {
      const body = JSON.stringify({ authorization: { id: "cmp_a" }, type: "inbound_received", payload: { id: "evt_1", conversation: { id: "cnv_a", subject: "Private subject" }, target: { data: { id: "msg_a", text: "Private body" } }, source: { _meta: { type: "inboxes" }, data: [{ id: inbox }] } } }), stamp = String(Date.now());
      return handler({ rawPath: "/front", requestContext: { http: { method: "POST" } }, body, headers: { "x-front-request-timestamp": stamp, "x-front-signature": createHmac("sha256", "test-signing-key").update(`${stamp}:${body}`).digest("base64") } } as never);
    };
    expect(await send("inb_other")).toMatchObject({ statusCode: 202 }); expect(entries("EVENT")).toHaveLength(0);
    expect(await send("inb_a")).toMatchObject({ statusCode: 202 }); expect(entries("EVENT")).toHaveLength(1);
    expect(JSON.stringify(entries("EVENT"))).not.toContain("Private");
  });
  it("finishes an excluded Front event without fetching its message or blocking other work", async () => {
    vi.mocked(permittedConversation).mockRejectedValueOnce(new FrontScopeError("Conversation is outside the configured inboxes"));
    const event = await save(row("EVENT", "event:front-other", { provider: "front" as const, payload: { type: "inbound_received", payload: { conversation: { id: "cnv_other" }, target: { data: { id: "msg_other" } } } }, attempts: 0 }, { dueAt: NOW }));
    await processEvent(event);
    expect(h.front).not.toHaveBeenCalled(); expect(record(event.id).data.outcome.ignored).toContain("outside"); expect(record(event.id).dueAt).toBeUndefined(); expect(entries("COMMUNICATION")).toHaveLength(0);
  });
  it("acknowledges only a durable webhook receipt, never a throttled transaction", async () => {
    const { handler } = await import("../../amplify/functions/communications/webhook");
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ authorization: { id: "cmp_a" }, type: "inbound_received", payload: { id: "evt_1" } }), stamp = String(Date.now());
    const input = { rawPath: "/front", requestContext: { http: { method: "POST" } }, body, headers: { "x-front-request-timestamp": stamp, "x-front-signature": createHmac("sha256", "test-signing-key").update(`${stamp}:${body}`).digest("base64") } } as never;
    for (const Code of ["ThrottlingError", "TransactionConflict", "ProvisionedThroughputExceeded"]) {
      h.writeError = Object.assign(new Error(Code), { name: "TransactionCanceledException", CancellationReasons: [{ Code }] });
      expect(await handler(input)).toMatchObject({ statusCode: 503 }); expect(entries("EVENT")).toHaveLength(0);
    }
    expect(await handler(input)).toMatchObject({ statusCode: 202 }); expect(await handler(input)).toMatchObject({ statusCode: 202 }); expect(entries("EVENT")).toHaveLength(1);
  });
  it("deduplicates overlapping call windows but captures changed call details", async () => {
    h.c.frontInboxId = undefined; h.c.dialpadCompanyId = "1";
    const call = { call_id: 301, internal_number: "+15082332261", external_number: "+16175550111", date_started: Date.parse(NOW), direction: "inbound", date_ended: Date.parse(NOW) + 1000 };
    h.dialpad.mockResolvedValue({ items: [call] });
    const { reconcile } = await import("../../amplify/functions/communications/reconcile");
    for (let n = 0; n < 5; n++) { h.dialpad.mockResolvedValue({ items: [{ ...call, recording_url: `https://media.example/call?temporary=${n}` }] }); await reconcile(); vi.setSystemTime(new Date(Date.now() + 60_000)); }
    expect(entries("EVENT")).toHaveLength(1);
    h.dialpad.mockResolvedValue({ items: [{ ...call, transcription_text: "Please call me" }] }); await reconcile(); expect(entries("EVENT")).toHaveLength(2);
  });
  it("advances an empty Dialpad call window without a sync-gap issue", async () => {
    h.c.frontInboxId = undefined; h.c.dialpadCompanyId = "1"; h.dialpad.mockResolvedValue({});
    const { reconcile } = await import("../../amplify/functions/communications/reconcile");
    expect(await reconcile()).toEqual({ lagging: false });
    expect(record("cursor:dialpad").data.checkedAt).toBeTruthy(); expect(entries("EVENT")).toHaveLength(0); expect(entries("ISSUE")).toHaveLength(0);
  });
  it("excludes other business lines before storing call history and redacts unidentified records", async () => {
    h.c.frontInboxId = undefined; h.c.dialpadCompanyId = "1";
    h.dialpad.mockResolvedValue({ items: [
      { call_id: 800, direction: "inbound", internal_number: "+12125550000", transcription_text: "Unrelated private transcript" },
      { call_id: 801, direction: "inbound", transcription_text: "Unidentified private transcript", external_number: "+12125550001" },
      { call_id: 802, direction: "inbound", internal_number: "+15082332261", transcription_text: "Authorized HOA transcript" },
    ] });
    const { reconcile } = await import("../../amplify/functions/communications/reconcile"); await reconcile();
    expect(entries("EVENT")).toHaveLength(2);
    expect(JSON.stringify(entries("EVENT"))).not.toMatch(/private transcript|12125550001/);
    expect(entries("EVENT").filter(e => e.dueAt)).toHaveLength(1);
    expect(entries("EVENT").find(e => !e.dueAt)?.data.payload.call_id).toBe(801);
    expect(entries("ISSUE").some(e => e.data.message.includes("business line"))).toBe(true);
  });
  it("applies business-line scope before persisting signed Dialpad content", async () => {
    h.c.dialpadCompanyId = "1";
    const { handler } = await import("../../amplify/functions/communications/webhook");
    const { createHmac } = await import("node:crypto");
    const send = async (line?: string) => {
      const a = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
      const b = Buffer.from(JSON.stringify({ id: "100", company_id: "1", direction: "inbound", internal_number: line, text: "Private SMS content" })).toString("base64url");
      const body = `${a}.${b}.${createHmac("sha256", "test-dialpad-signing-key").update(`${a}.${b}`).digest("base64url")}`;
      return handler({ rawPath: "/dialpad", requestContext: { http: { method: "POST" } }, body, headers: {} } as never);
    };
    expect(await send("+12125550000")).toMatchObject({ statusCode: 202 }); expect(entries("EVENT")).toHaveLength(0);
    expect(await send()).toMatchObject({ statusCode: 202 }); expect(JSON.stringify(entries("EVENT"))).not.toContain("Private SMS content");
    expect(await send("+15082332261")).toMatchObject({ statusCode: 202 }); expect(entries("EVENT").some(e => e.data.payload.text === "Private SMS content")).toBe(true);
  });
  it("does not rearm an already checked missed call when history enriches it", async () => {
    const p = { call_id: 401, internal_number: "+15082332261", external_number: "+16175550111", date_started: Date.parse(NOW), direction: "inbound", state: "hangup" };
    await dialpadEvent(p); const comm = (await get<Communication>("comm:dialpad:call:401"))!;
    await save(row("COMMUNICATION", comm.id, comm.data, { previous: comm }), comm);
    await dialpadEvent({ ...p, transcription_text: "Late transcript" }); expect(record(comm.id).dueAt).toBeUndefined(); expect(record(comm.id).data.text).toBe("Late transcript");
  });
  it("uses the original master through a transfer and direction-aware fallback numbers", async () => {
    await dialpadEvent({ call_id: 100, from_number: "+16175550111", to_number: "+15082332261", direction: "inbound", date_started: Date.parse(NOW), state: "hangup" });
    await dialpadEvent({ call_id: 301, entry_point_call_id: 300, master_call_id: 100, internal_number: "+15082332261", external_number: "+16175550111", direction: "inbound", date_started: Date.parse(NOW), state: "connected" });
    await dialpadEvent({ call_id: 301, entry_point_call_id: 300, internal_number: "+15082332261", external_number: "+16175550111", direction: "inbound", date_started: Date.parse(NOW), state: "hangup" });
    expect(entries("COMMUNICATION")).toHaveLength(1); expect(entries("COMMUNICATION")[0].data.status).toBe("CONNECTED"); expect(entries("TRIAGE")).toHaveLength(1);
  });
  it("records why a signed event was excluded from the configured business lines", async () => {
    const event = await save(row<any>("EVENT", "event:other-line", { provider: "dialpad", payload: { call_id: 2, internal_number: "+12125550000", direction: "inbound" }, attempts: 0 }));
    await processEvent(event); expect(record(event.id).data.outcome.ignored).toContain("outside"); expect(entries("COMMUNICATION")).toHaveLength(0);
  });
  it("fences cancellation during Front preflight before claiming the outbound send", async () => {
    await lead(); const op = await enqueueOperation("op:cancel-race", { type: "EMAIL", accountId: "a1", recipient: "prospect@example.com" });
    h.front.mockImplementation(async (_path: string, method?: string) => {
      if (!method) { const wf = (await get<any>("workflow:a1"))!; await save(row("WORKFLOW", wf.id, { ...wf.data, humanTakeover: true }, { accountId: "a1", previous: wf }), wf); }
      return { _results: [] };
    });
    await runOperation(op); expect(h.front.mock.calls.filter(c => c[1] === "POST")).toHaveLength(0);
    await runOperation((await get<Operation>(op.id))!); expect(record(op.id).data.state).toBe("SUPPRESSED");
  });
  it.each([401, 403])("holds a %s rejection for credential repair instead of failing queued delivery", async status => {
    await lead(); const op = await enqueueOperation("op:credential-rotation", { type: "EMAIL", accountId: "a1", recipient: "prospect@example.com" });
    const { ProviderError } = await import("../../amplify/functions/communications/providers"); h.front.mockRejectedValue(new ProviderError("Credential rotation", status, false));
    await runOperation(op); expect(record(op.id).data.state).toBe("RETRY_WAIT"); expect(record(op.id).dueAt).toBeTruthy(); expect(record("issue:provider-auth").data.message).toContain("authorization");
  });
});

describe("review regressions: association and accountability", () => {
  it("associates previously captured Front mail and projects its original inbound deadline", async () => {
    await lead(); const { ingestFrontMessage, backfillConversation } = await import("../../amplify/functions/communications/events");
    const message = { id: "msg_before_link", is_inbound: true, type: "email", created_at: Date.parse(NOW) / 1000, text: "Please send a quote", conversation: { id: "cnv_a" } };
    await ingestFrontMessage(message); expect(record("comm:front:msg_before_link").accountId).toBeUndefined();
    await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
    const job = await save(row("CONVERSATION_BACKFILL", "backfill:test", { conversationId: "cnv_a" }, { accountId: "a1", dueAt: NOW }));
    vi.setSystemTime("2026-09-12T14:00:00Z"); h.front.mockResolvedValue({ _results: [message] });
    await backfillConversation(job); await ingestFrontMessage(message);
    expect(record("comm:front:msg_before_link").accountId).toBe("a1"); expect(record("comm:front:msg_before_link").accountSort).toMatch(/^COMMUNICATION#/);
    expect(entries("TASK")).toHaveLength(1); expect(entries("TASK")[0].data.dueAt).toBe("2026-09-09T14:00:00.000Z"); expect(record("issue:comm:front:msg_before_link").data.resolved).toBe(true);
  });
  it("does not make an auto-reply into response work", async () => {
    await lead(); await save(row("LINK", "front-link:cnv_a", { accountId: "a1", purpose: "PROSPECT" }, { accountId: "a1" }));
    const { ingestFrontMessage, classifyEmail } = await import("../../amplify/functions/communications/events");
    expect(classifyEmail({ text: "Away", metadata: { auto_submitted: "auto-replied" } })).toBe("AUTOMATIC");
    await ingestFrontMessage({ id: "msg_auto", is_inbound: true, created_at: Date.parse(NOW) / 1000, subject: "Out of office", text: "Away" }, "cnv_a"); expect(entries("TASK")).toHaveLength(0);
  });
  it("saves an actual call outcome and resolves only the selected request", async () => {
    await lead(); const comm = await inbound("callback", NOW, { provider: "dialpad", providerId: "10", channel: "CALL", status: "MISSED" }); await recordInbound(comm, "CALLBACK");
    const task = entries("TASK")[0]; const { recordCallOutcome } = await import("../../amplify/functions/communications/review");
    await recordCallOutcome({ id: comm.id, version: record(comm.id).version, outcome: "NO_ANSWER", note: "Left voicemail" }, "brian");
    expect(record(task.id).data.status).toBe("OPEN"); expect(record(comm.id).data.resolved).toBe(false);
    await recordCallOutcome({ id: comm.id, version: record(comm.id).version, outcome: "HANDLED", note: "Spoke with the manager", taskId: task.id, taskVersion: task.version, nextAction: { title: "Request documents", dueAt: "2026-09-10T14:00:00Z" } }, "brian");
    expect(record(task.id).data.status).toBe("COMPLETE"); expect(record(comm.id).data.resolved).toBe(true); expect(entries("TASK").filter(t => t.data.status === "OPEN")).toHaveLength(1);
    expect([...h.records.keys()].some(k => k.startsWith("Activity:"))).toBe(true);
  });
  it("requires an explicit absence check before retrying an ambiguous send", async () => {
    await lead(); const op = await save(row<Operation>("OPERATION", "op:review", { type: "EMAIL", accountId: "a1", state: "UNKNOWN", attempts: 1 }));
    const { reviewOperation } = await import("../../amplify/functions/communications/review");
    await expect(reviewOperation({ id: op.id, version: op.version, action: "retry", reason: "Retry" }, "admin")).rejects.toThrow("confirm");
    expect(record(op.id).data.state).toBe("UNKNOWN");
    await reviewOperation({ id: op.id, version: op.version, action: "retry", reason: "Verified in Front", verifiedNotSent: true }, "admin"); expect(record(op.id).data.state).toBe("READY");
  });
  it("paginates matching work past unrelated tasks and never exposes global communication bodies", async () => {
    await lead(); for (let n = 0; n < 120; n++) await save(row("TASK", `t:${n}`, { status: "OPEN", kind: "FOLLOW_UP", role: "SALESPERSON", dueAt: NOW }, { accountId: "a1" }));
    await save(row("TASK", "target", { status: "OPEN", kind: "CALLBACK", role: "SALESPERSON", dueAt: "2026-09-09T14:00:00Z" }, { accountId: "a1" }));
    const { handler } = await import("../../amplify/functions/communications/handler");
    expect(await handler({ arguments: { readOperation: "work", input: { kind: "TASK", view: "Needs response", mine: true } }, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: true, items: [{ id: "target" }] });
    expect(await handler({ arguments: { readOperation: "work", input: { kind: "COMMUNICATION" } }, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: false });
  });
  it("reassigns over one hundred open tasks through bounded durable pages", async () => {
    const wf = await lead();
    await save(row("ELIGIBILITY", "eligibility:sally", { enabled: true, salesperson: true, champion: true }));
    for (let n = 0; n < 120; n++) await save(row("TASK", `t:${n}`, { status: "OPEN", role: "SALESPERSON", dueAt: NOW, escalationAt: "2026-09-10T14:00:00Z", notifiedAt: NOW, notifiedRecipientId: "brian" }, { accountId: "a1" }));
    await setResponsibilities("a1", "sally", "brian", wf.version, "brian");
    const { syncResponsibilities } = await import("../../amplify/functions/communications/workflow");
    for (let n = 0; n < 8; n++) { const job = entries("ROLE_SYNC").find(r => r.dueAt); if (job) await syncResponsibilities((await get<any>(job.id))!); }
    expect(entries("TASK").every(t => !t.data.notifiedAt && t.data.dueAt === NOW)).toBe(true);
    expect(h.transactions.every(t => t.length <= 100)).toBe(true); expect(entries("ROLE_SYNC").some(r => r.dueAt)).toBe(false);
  });
  it("completes work despite more than a hundred former assignee reminders", async () => {
    await lead(); await recordInbound(await inbound()); const task = entries("TASK")[0];
    for (let n = 0; n < 120; n++) await save(row("NOTIFICATION", `notice:old:${n}`, { taskId: task.id, recipient: `former:${n}` }, { accountId: "a1" }));
    await completeTask({ id: task.id, version: task.version, reason: "Answered", successor: { title: "Check documents", dueAt: "2026-09-10T14:00:00Z", role: "SALESPERSON", kind: "DOCUMENTS" } }, "brian");
    expect(record(task.id).data.status).toBe("COMPLETE"); expect(h.transactions.every(t => t.length <= 100)).toBe(true);
  });
  it("retains a document-arrival comment while paused or waiting for its Front conversation", async () => {
    const wf = await lead(); await save(row("WORKFLOW", wf.id, { ...wf.data, conversationId: undefined }, { accountId: "a1", previous: wf }), wf);
    const op = await enqueueOperation("op:documents:portal:batch", { type: "COMMENT", accountId: "a1", text: "Documents arrived" });
    h.c.paused = true; await runOperation(op); expect(record(op.id).data.state).toBe("RETRY_WAIT");
    h.c.paused = false; await runOperation((await get<Operation>(op.id))!); expect(record(op.id).data.state).toBe("RETRY_WAIT"); expect(record(op.id).data.text).toBe("Documents arrived"); expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
});

it("creates one callback for a verified missed call and retracts it when another routed leg answers", async () => {
  await lead(); await save(row("LINK", "activity-link:comm:dialpad:call:501", { accountId: "a1" }, { accountId: "a1" }));
  const base = { internal_number: "+15082332261", external_number: "+16175550111", direction: "inbound", date_started: Date.parse(NOW) };
  await dialpadEvent({ ...base, call_id: 502, entry_point_call_id: 501, state: "hangup" });
  expect(entries("TASK")).toHaveLength(0);
  vi.setSystemTime(new Date(Date.parse(NOW) + 180001)); h.c.paused = true; h.dialpad.mockResolvedValue({ ...base, call_id: 501, state: "hangup" });
  const { handler } = await import("../../amplify/functions/communications/worker"); await handler();
  expect(entries("TASK").filter(t => t.data.status === "OPEN" && t.data.kind === "CALLBACK")).toHaveLength(1);
  await dialpadEvent({ ...base, call_id: 503, entry_point_call_id: 501, date_connected: Date.parse(NOW) + 10000, state: "connected" });
  expect(entries("COMMUNICATION")).toHaveLength(1); expect(entries("TASK").filter(t => t.data.status === "OPEN")).toHaveLength(0);
});

it("classifies only explicit failed conditions as optimistic-write conflicts", async () => {
  const { conflict } = await import("../../amplify/functions/communications/store");
  const error = (codes?: string[]) => Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes?.map(Code => ({ Code })) });
  expect(conflict(error(["None", "ConditionalCheckFailed"]))).toBe(true);
  for (const value of [error(), error(["TransactionConflict"]), error(["ThrottlingError"]), error(["ConditionalCheckFailed", "ThrottlingError"])]) expect(conflict(value)).toBe(false);
});

it("continues accepting cached website forms during the additive schema rollout", async () => {
  const result = await capture({ arguments: { name: "Legacy page enquiry", contactEmail: "test@example.com" } } as never, {} as never, () => {});
  expect(result).toMatchObject({ ok: true }); expect(entries("SUBMISSION")).toHaveLength(1); expect(entries("OPERATION").filter(r => r.data.type === "IMPORT")).toHaveLength(1);
});

it("readiness checks storage without creating a lead or dispatching communication", async () => {
  const before = h.transactions.length;
  expect(await capture({ arguments: { readinessContract: 2 }, identity: null, source: null, request: {}, prev: null } as never, {} as never, () => {})).toMatchObject({ ready: true, contractVersion: 2 });
  expect(h.transactions).toHaveLength(before); expect(entries("SUBMISSION")).toHaveLength(0); expect(h.front).not.toHaveBeenCalled();
});

describe("second review: adverse ordering and recovery", () => {
  const call = (call_id: number, patch: Record<string, unknown> = {}) => ({ call_id, internal_number: "+15082332261", external_number: "+16175550111", direction: "inbound", date_started: Date.parse(NOW), state: "hangup", ...patch });
  async function missed(id: number, at = NOW) {
    await save(row("LINK", `activity-link:comm:dialpad:call:${id}`, { accountId: "a1" }, { accountId: "a1" }));
    await dialpadEvent(call(id, { date_started: Date.parse(at) }));
    await recordInbound(record(`comm:dialpad:call:${id}`).data, "CALLBACK");
  }
  it.each([true, false])("unites separately captured transfer legs and retracts duplicate callbacks (reverse=%s)", async reverse => {
    await lead();
    for (const id of reverse ? [602, 601] : [601, 602]) await missed(id);
    expect(entries("TASK").filter(t => t.data.status === "OPEN")).toHaveLength(2);
    await dialpadEvent(call(602, { master_call_id: 601, date_connected: Date.parse(NOW) + 1000 }));
    expect(entries("COMMUNICATION")).toHaveLength(1); expect(record("comm:dialpad:call:601").data.status).toBe("CONNECTED");
    expect(entries("TASK").filter(t => t.data.status === "OPEN")).toHaveLength(0);
    await dialpadEvent(call(602)); expect(entries("COMMUNICATION")).toHaveLength(1); expect(record("comm:dialpad:call:601").data.status).toBe("CONNECTED");
  });
  it("combines missed-call callbacks without postponing the earliest commitment", async () => {
    await lead(); await missed(601, "2026-09-08T13:00:00Z"); await missed(602);
    const due = entries("TASK").map(t => t.data.dueAt).sort()[0];
    await dialpadEvent(call(602, { entry_point_call_id: 601 }));
    const tasks = entries("TASK").filter(t => t.data.status === "OPEN");
    expect(tasks).toHaveLength(1); expect(tasks[0].data.dueAt).toBe(due); expect(entries("COMMUNICATION")).toHaveLength(1);
  });
  it("keeps a custom promise when a late leg shows the original call was answered", async () => {
    await lead(); await missed(601); const task = entries("TASK")[0];
    await saveTask({ ...task.data, version: task.version, dueAt: "2026-09-15T14:00:00Z", reason: "Promised Tuesday" }, "brian");
    await dialpadEvent(call(602, { master_call_id: 601, date_connected: Date.parse(NOW) }));
    expect(record(task.id).data.status).toBe("OPEN"); expect(record(task.id).data.dueAt).toBe("2026-09-15T14:00:00.000Z");
  });
  it("projects the callback even when call verification fails", async () => {
    await lead(); await save(row("LINK", "activity-link:comm:dialpad:call:601", { accountId: "a1" }, { accountId: "a1" }));
    await dialpadEvent(call(601)); h.dialpad.mockRejectedValue(new Error("Call history temporarily unavailable"));
    const { refreshCommunication } = await import("../../amplify/functions/communications/worker");
    await refreshCommunication((await get<Communication>("comm:dialpad:call:601"))!);
    expect(entries("TASK").filter(t => t.data.status === "OPEN")).toHaveLength(1);
    expect(record("comm:dialpad:call:601").dueAt).toBeTruthy(); expect(entries("ISSUE").some(i => i.data.message.includes("callback deadline"))).toBe(true);
  });
  it("captures Dialpad independently of Front rate limiting and parks malformed call items", async () => {
    h.c.dialpadCompanyId = "1";
    const { ProviderError } = await import("../../amplify/functions/communications/providers");
    h.front.mockRejectedValue(new ProviderError("Front rate limit", 429, false));
    h.dialpad.mockResolvedValue({ items: [call(701), { broken: "provider record" }, call(702)], cursor: "next" });
    const { reconcile } = await import("../../amplify/functions/communications/reconcile");
    expect(await reconcile()).toMatchObject({ lagging: true });
    expect(entries("EVENT")).toHaveLength(3); expect(entries("EVENT").filter(e => e.dueAt)).toHaveLength(2);
    expect(record("cursor:dialpad").data.cursor).toBe("next"); expect(record("cursor:front")).toBeUndefined();
    expect(entries("ISSUE").some(i => i.data.message.includes("invalid call ID"))).toBe(true);
  });
  it("does not advance a history checkpoint past a failed durable write", async () => {
    h.c.frontInboxId = undefined; h.c.dialpadCompanyId = "1";
    h.dialpad.mockResolvedValue({ items: [call(701)], cursor: "next" });
    h.writeError = new Error("Capture failed");
    const { reconcile } = await import("../../amplify/functions/communications/reconcile"); await reconcile();
    expect(record("cursor:dialpad")).toBeUndefined(); expect(entries("EVENT")).toHaveLength(0);
    await reconcile(); expect(record("cursor:dialpad").data.cursor).toBe("next"); expect(entries("EVENT")).toHaveLength(1);
  });
  it("durably isolates a failing Front conversation from the next conversation", async () => {
    h.front.mockResolvedValue({ _results: [{ id: "cnv_bad" }, { id: "cnv_good" }] });
    const { reconcile } = await import("../../amplify/functions/communications/reconcile"); await reconcile();
    expect(entries("CONVERSATION_BACKFILL")).toHaveLength(2); expect(record("cursor:front")).toBeTruthy();
    expect(h.front.mock.calls.every(([path]) => path.includes("/search/"))).toBe(true);
  });
  it.each(["TransactionConflict", "ThrottlingError"])("retries %s before send without marking the reply failed", async Code => {
    await lead(); const op = await enqueueOperation("op:storage", { type: "EMAIL", accountId: "a1", recipient: "test@example.com", replyId: "r1" });
    h.writeError = Object.assign(new Error(Code), { name: "TransactionCanceledException", CancellationReasons: [{ Code }] });
    await runOperation(op); expect(record(op.id).data.state).toBe("RETRY_WAIT"); expect(record(op.id).dueAt).toBeTruthy(); expect(h.update).not.toHaveBeenCalled();
    expect(h.front.mock.calls.some(([, method]) => method === "POST")).toBe(false);
  });
  it("does not turn a storage failure after an external send into a resend", async () => {
    await lead(); const op = await enqueueOperation("op:post-storage", { type: "COMMENT", accountId: "a1", text: "Documents arrived" });
    h.front.mockImplementation(async (_path, method) => {
      if (method === "POST") h.writeError = Object.assign(new Error("TransactionConflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] });
      return { id: "com_1" };
    });
    await runOperation(op); expect(record(op.id).data.state).toBe("UNKNOWN"); expect(record(op.id).dueAt).toBeUndefined();
    await runOperation((await get<Operation>(op.id))!); expect(h.front.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
  });
  it("backs off preflight auth errors independently of send attempts", async () => {
    await lead(); const op = await enqueueOperation("op:auth-backoff", { type: "EMAIL", accountId: "a1", recipient: "test@example.com" });
    const { ProviderError } = await import("../../amplify/functions/communications/providers"); h.front.mockRejectedValue(new ProviderError("Repair authorization", 401, false));
    const delays = [];
    for (let n = 0; n < 4; n++) { await runOperation((await get<Operation>(op.id))!); delays.push(Date.parse(record(op.id).dueAt) - Date.now()); vi.setSystemTime(record(op.id).dueAt); }
    expect(delays).toEqual([60000, 120000, 240000, 480000]); expect(record(op.id).data.attempts).toBe(0);
  });
  it("shares an authorization cooldown and releases it when credentials change", async () => {
    const { authorizationDelay, authorizationFailed, authorizationRestored } = await import("../../amplify/functions/communications/budget");
    expect(await authorizationFailed("front", "old-fingerprint")).toBe(60);
    expect(await authorizationDelay("front", "old-fingerprint")).toBe(60);
    expect(await authorizationDelay("front", "new-fingerprint")).toBe(0);
    vi.setSystemTime(new Date(Date.now() + 60000)); expect(await authorizationFailed("front", "old-fingerprint")).toBe(120);
    await authorizationRestored("front", "new-fingerprint"); expect(await authorizationDelay("front", "new-fingerprint")).toBe(0);
  });
  it("finalizes worker health and gives reconciliation a turn under a time-limited backlog", async () => {
    await lead(); for (let n = 0; n < 3; n++) await enqueueOperation(`op:slow:${n}`, { type: "EMAIL", accountId: "a1", recipient: "test@example.com" });
    h.front.mockImplementation(async (path, method) => {
      if (path.includes("/search/")) return { _results: [] };
      if (!method) { vi.setSystemTime(new Date(Date.now() + 40000)); return { _results: [] }; }
      return { message_uid: `uid_${Date.now()}` };
    });
    const { handler } = await import("../../amplify/functions/communications/worker"); await handler();
    expect(record("health:worker").data.at).toBe(new Date().toISOString()); expect(record("issue:sync-gap")).toBeUndefined();
    expect(h.front.mock.calls.some(([path]) => path.includes("/search/"))).toBe(true);
    expect(entries("OPERATION").some(o => o.data.state === "READY")).toBe(true);
  });
  it("does not restart a completed history walk when the same conversation link is saved again", async () => {
    await lead(); const { handler } = await import("../../amplify/functions/communications/handler");
    const input = { arguments: { operation: "linkConversation", input: { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" } }, identity: { sub: "brian", groups: [] } as never };
    expect(await handler(input)).toMatchObject({ ok: true });
    const job = (await get<any>("conversation-backfill:cnv_a"))!; await save(row("CONVERSATION_BACKFILL", job.id, job.data, { previous: job }), job);
    const before = h.transactions.length; expect(await handler(input)).toMatchObject({ ok: true }); expect(h.transactions.length).toBe(before); expect(record(job.id).dueAt).toBeUndefined();
  });
});

it("keeps valid Front messages moving when a malformed history item needs review", async () => {
  await lead(); await save(row("LINK", "front-link:cnv_a", { accountId: "a1", purpose: "PROSPECT" }, { accountId: "a1" }));
  const { backfillConversation } = await import("../../amplify/functions/communications/events");
  const job = await save(row("CONVERSATION_BACKFILL", "backfill:malformed", { conversationId: "cnv_a" }, { accountId: "a1", dueAt: NOW }));
  h.front.mockResolvedValue({ _results: [null, { id: "msg_malformed", created_at: Date.parse(NOW) / 1000, text: 123 }, { id: "msg_good", created_at: Date.parse(NOW) / 1000, is_inbound: true, type: "email", text: "Please call me" }], _pagination: { next: "https://api2.frontapp.com/next" } });
  await backfillConversation(job);
  expect(record("comm:front:msg_good").accountId).toBe("a1"); expect(record(job.id).data.next).toContain("/next");
  expect(entries("ISSUE").some(i => i.data.message.includes("malformed message"))).toBe(true);
});

it("retains both association links for explicit review when related calls disagree", async () => {
  await lead();
  const base = { internal_number: "+15082332261", external_number: "+16175550111", direction: "inbound", date_started: Date.parse(NOW), state: "hangup" };
  for (const [id, accountId] of [[801, "a1"], [802, "a2"]] as const) {
    await save(row("LINK", `activity-link:comm:dialpad:call:${id}`, { accountId }, { accountId }));
    await dialpadEvent({ ...base, call_id: id });
  }
  await expect(dialpadEvent({ ...base, call_id: 802, master_call_id: 801 })).rejects.toThrow("conflicting association links");
  expect(record("comm:dialpad:call:801").accountId).toBe("a1"); expect(record("comm:dialpad:call:802").accountId).toBe("a2");
  expect(entries("ISSUE").some(i => i.data.message.includes("different associations"))).toBe(true);
});

it("retires reminders serially instead of contending on the same workflow", async () => {
  await lead();
  for (let n = 0; n < 50; n++) await save(row("NOTIFICATION", `notice:stale:${n}`, { recipient: "brian", taskId: "task:completed", urgency: "DUE", at: NOW }, { accountId: "a1" }));
  h.maxInFlight = 0;
  const { handler } = await import("../../amplify/functions/communications/handler");
  expect(await handler({ arguments: { readOperation: "work", input: { kind: "NOTIFICATION" } }, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: true, items: [] });
  expect(h.maxInFlight).toBe(1); expect(entries("NOTIFICATION").every(r => r.data.resolved)).toBe(true);
});

it("saves settings and audit together and never copies credential values into activity", async () => {
  vi.stubEnv("COMMUNICATION_ENV", "main");
  try {
    await save(row("CONFIG", "config", h.c));
    const { handler } = await import("../../amplify/functions/communications/handler");
    const result = await handler({ arguments: { operation: "saveSettings", input: { config: { ...h.c, defaultUserId: undefined }, credentials: { frontToken: "private-test-token" } } }, identity: { sub: "admin", groups: ["ADMIN"] } as never });
    expect(result).toMatchObject({ ok: true }); expect(record("config").data.paused).toBe(true);
    const transaction = h.transactions.find(writes => writes.some(w => w.Put?.Item?.id === "config") && writes.some(w => w.Put?.TableName === "Activity"));
    expect(transaction).toBeTruthy(); expect(entries("AUDIT")).toHaveLength(0);
    expect(JSON.stringify([...h.records.values()])).not.toContain("private-test-token");
  } finally { vi.unstubAllEnvs(); }
});

describe("round three: recoverable history capture", () => {
  async function request(operation: string, input: Record<string, unknown>, admin = true) {
    const { handler } = await import("../../amplify/functions/communications/handler");
    return handler({ arguments: { operation, input }, identity: { sub: "brian", groups: admin ? ["ADMIN"] : [] } as never });
  }
  it("repairs an unchanged link created elsewhere without changing its manual routing", async () => {
    const wf = await lead(); await save(row("WORKFLOW", wf.id, { ...wf.data, conversationId: undefined }, { accountId: "a1", previous: wf }), wf);
    await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT", routing: "MANUAL" }, { accountId: "a1" }));
    expect(await request("linkConversation", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, false)).toMatchObject({ ok: true });
    expect(record("workflow:a1").data.conversationId).toBe("cnv_a"); expect(record("front-link:cnv_a").data.routing).toBe("MANUAL");
    expect(record("conversation-backfill:cnv_a").dueAt).toBeTruthy(); expect(entries("OPERATION")).toHaveLength(0);
  });
  it("re-arms a capped link-history job in place and completes it after provider recovery", async () => {
    await lead(); await request("linkConversation", { accountId: "a1", conversationId: "cnv_a" }, false); h.c.paused = true;
    h.front.mockRejectedValue(new Error("Mailbox unavailable"));
    const { handler: tick } = await import("../../amplify/functions/communications/worker");
    for (let n = 0; n < 12; n++) { const job = record("conversation-backfill:cnv_a"); vi.setSystemTime(job.dueAt); await tick(); }
    const stopped = record("conversation-backfill:cnv_a"); expect(stopped.dueAt).toBeUndefined(); expect(stopped.data.attempts).toBe(12);
    expect(await request("linkConversation", { accountId: "a1", conversationId: "cnv_a" }, false)).toMatchObject({ ok: true });
    const restarted = record(stopped.id); expect(restarted.dueAt).toBeTruthy(); expect(restarted.data.error).toBeUndefined(); expect(restarted.data.attempts).toBe(0);
    h.front.mockResolvedValue({ _results: [] }); await tick();
    expect(record(stopped.id).data.completedAt).toBeTruthy(); expect(record(stopped.id).dueAt).toBeUndefined(); expect(entries("CONVERSATION_BACKFILL")).toHaveLength(1);
  });
  it("offers a deliberate admin restart for failed pagination in either history job", async () => {
    await lead();
    for (const id of ["conversation-backfill:cnv_a", "front-reconcile:cnv_a"]) await save(row("CONVERSATION_BACKFILL", id, { conversationId: "cnv_a", next: "expired-page", attempts: 12, error: "Expired cursor" }, { accountId: "a1" }));
    expect(await request("restartConversationHistory", { conversationId: "cnv_a", reason: "Mailbox repaired" }, false)).toMatchObject({ ok: false });
    expect(await request("restartConversationHistory", { conversationId: "cnv_a", reason: "Mailbox repaired" })).toMatchObject({ ok: true });
    for (const job of entries("CONVERSATION_BACKFILL")) { expect(job.dueAt).toBeTruthy(); expect(job.data.next).toBeUndefined(); expect(job.data.error).toBeUndefined(); expect(job.data.attempts).toBe(0); }
    const before = h.transactions.length;
    await request("restartConversationHistory", { conversationId: "cnv_a", reason: "Already running" }); expect(h.transactions.length).toBe(before);
  });
  it.each(["front", "dialpad"])("restarts %s pagination without advancing the unfinished capture window", async provider => {
    const after = Date.parse(NOW) - 86400_000, through = Date.parse(NOW), key = `cursor:${provider}`;
    const old = await save(row("CURSOR", key, { after, through, inbox: 1, cursor: "expired", next: "expired", pending: ["cnv_a"], messageNext: "expired-message-page" }));
    expect(await request("restartReconciliation", { provider, version: old.version, reason: "Provider rejected pagination" }, false)).toMatchObject({ ok: false });
    expect(await request("restartReconciliation", { provider, version: old.version + 1, reason: "Stale view" })).toMatchObject({ ok: false });
    expect(await request("restartReconciliation", { provider, version: old.version, reason: "Provider rejected pagination" })).toMatchObject({ ok: true });
    expect(record(key).data).toMatchObject({ after, through });
    for (const field of ["cursor", "next", "pending", "messageNext"]) expect(record(key).data[field]).toBeUndefined();
    if (provider === "front") expect(record(key).data.inbox).toBe(1);
  });
  it("recovers an actually rejected Dialpad cursor and captures the next valid page", async () => {
    h.c.frontInboxId = undefined; h.c.dialpadCompanyId = "1";
    const { reconcile } = await import("../../amplify/functions/communications/reconcile"), { ProviderError } = await import("../../amplify/functions/communications/providers");
    const old = await save(row("CURSOR", "cursor:dialpad", { after: Date.parse(NOW) - 1000, through: Date.parse(NOW), cursor: "expired" }));
    h.dialpad.mockImplementation(async path => { if (path.includes("cursor=expired")) throw new ProviderError("Invalid cursor", 400, false); return { items: [{ call_id: 900, direction: "inbound", internal_number: "+15082332261", date_started: Date.parse(NOW) }] }; });
    expect(await reconcile()).toMatchObject({ lagging: true }); expect(entries("EVENT")).toHaveLength(0);
    await request("restartReconciliation", { provider: "dialpad", version: old.version, reason: "Expired provider pagination" });
    expect(await reconcile()).toMatchObject({ lagging: false }); expect(entries("EVENT")).toHaveLength(1);
    expect(record("issue:reconcile:dialpad").data.resolved).toBe(true);
  });
  it("caps unchanged Front history walks across completed reconciliation cycles", async () => {
    const { reconcile } = await import("../../amplify/functions/communications/reconcile"), { backfillConversation } = await import("../../amplify/functions/communications/events");
    h.front.mockImplementation(async path => ({ _results: path.includes("/search/") ? [{ id: "cnv_a" }] : [] }));
    for (let n = 0; n < 30; n++) {
      vi.setSystemTime(new Date(Date.parse(NOW) + n * 60000)); await reconcile();
      const job = await get<any>("front-reconcile:cnv_a"); if (job?.dueAt) await backfillConversation(job);
    }
    expect(h.front.mock.calls.filter(([path]) => path.includes("/conversations/cnv_a/messages"))).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse(NOW) + 30 * 60000)); await reconcile(); expect(record("front-reconcile:cnv_a").dueAt).toBeTruthy();
  });
  it("keeps failed history visible for deliberate repair instead of repeatedly resetting its attempts", async () => {
    const { reconcile } = await import("../../amplify/functions/communications/reconcile");
    const job = await save(row("CONVERSATION_BACKFILL", "front-reconcile:cnv_a", { conversationId: "cnv_a", attempts: 12, error: "Mailbox needs repair" }));
    h.front.mockResolvedValue({ _results: [{ id: "cnv_a" }] }); vi.setSystemTime(new Date(Date.parse(NOW) + 86400_000));
    await reconcile(); expect(record(job.id).version).toBe(job.version); expect(record(job.id).data.attempts).toBe(12);
  });
});


describe("configured default lead owner", () => {
  async function prepareJake(flags = { enabled: true, salesperson: true, champion: true }) {
    h.records.set("UserProfile:jake", { userId: "jake", firstName: "Jake", lastName: "Greasley", email: "jake@example.com" });
    await save(row("ELIGIBILITY", "eligibility:jake", { userId: "jake", name: "Jake Greasley", email: "jake@example.com", ...flags }));
    await save(row("CONFIG", "config", h.c));
  }
  async function chooseJake() {
    const { handler } = await import("../../amplify/functions/communications/handler");
    return handler({ arguments: { operation: "saveSettings", input: { config: { ...h.c, defaultUserId: "jake" } } }, identity: { sub: "admin", groups: ["ADMIN"] } as never });
  }
  it.each(["staging", "main"])("accepts an eligible non-Brian default in %s and keeps existing assignments", async environment => {
    vi.stubEnv("COMMUNICATION_ENV", environment);
    try {
      h.c = { ...h.c, environment, frontSender: environment === "main" ? "sales@protectmyhoa.com" : "test@example.com" };
      await lead(); await prepareJake();
      expect(await chooseJake()).toMatchObject({ ok: true, config: { defaultUserId: "jake" } });
      h.c = record("config").data;
      expect(await defaultWorkflow("new-lead", "New HOA")).toMatchObject({ salespersonId: "jake", championId: "jake", assignmentIssue: undefined });
      expect(record("workflow:a1").data).toMatchObject({ salespersonId: "brian", championId: "brian" });
      const { connectionChecks } = await import("../../amplify/functions/communications/setup");
      expect((await connectionChecks()).find(check => check.name === "Default responsibilities")).toMatchObject({ ok: true });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    { enabled: true, salesperson: true, champion: false },
    { enabled: true, salesperson: false, champion: true },
    { enabled: false, salesperson: true, champion: true },
  ])("rejects an ineligible default before saving: %j", async flags => {
    await prepareJake(flags);
    expect(await chooseJake()).toMatchObject({ ok: false, error: expect.stringContaining("eligible") });
    expect(record("config").data.defaultUserId).toBe("brian");
  });
  it("rejects a disabled sign-in account even when both eligibility flags remain enabled", async () => {
    await prepareJake(); h.userEnabled = false;
    expect(await chooseJake()).toMatchObject({ ok: false, error: expect.stringContaining("disabled") });
    expect(record("config").data.defaultUserId).toBe("brian");
  });
  it("rejects a stale eligibility record without a current CRM teammate", async () => {
    await prepareJake(); h.records.delete("UserProfile:jake");
    expect(await chooseJake()).toMatchObject({ ok: false, error: expect.stringContaining("current CRM teammate") });
    expect(record("config").data.defaultUserId).toBe("brian");
  });
});

it("returns the committed teammate version so the next edit does not depend on an index refresh", async () => {
  const profile = { userId: "jake", firstName: "Jake", lastName: "Greasley", email: "jake@example.com" };
  h.records.set("UserProfile:jake", profile);
  const initial = { userId: "jake", name: "Jake Greasley", email: profile.email, enabled: true, salesperson: true, champion: true };
  await save(row("ELIGIBILITY", "eligibility:jake", initial));
  const { handler } = await import("../../amplify/functions/communications/handler");
  const write = (input: Record<string, unknown>) => handler({ arguments: { operation: "saveEligibility", input }, identity: { sub: "admin", groups: ["ADMIN"] } as never });
  const first = await write({ ...initial, version: 1, frontId: "tea_jake", dialpadId: "5655281245659136" });
  expect(first).toMatchObject({ ok: true, member: { ...initial, frontId: "tea_jake", dialpadId: "5655281245659136", version: 2 } });
  const committed = (first as { member: Record<string, unknown> }).member;
  expect(await write({ ...committed, salesperson: false })).toMatchObject({ ok: true, member: { version: 3, salesperson: false, champion: true, frontId: "tea_jake", dialpadId: "5655281245659136" } });
});


describe("creation-only lead acquisition", () => {
  it("requires one of the six choices and ignores a free-text source", async () => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    const create = (fields: Record<string, unknown>, requestId = "manual-source-test-123456789") => handler({ arguments: { operation: "createLead", input: { requestId, fields: { name: "Source test HOA", ...fields } } }, identity: { sub: "brian", groups: ["ADMIN"] } as never });
    expect(await create({ source: "anything" })).toMatchObject({ ok: false });
    expect(await create({ leadSource: "REFERRAL" })).toMatchObject({ ok: false });
    expect([...h.records.keys()].filter(k => k.startsWith("Account:"))).toHaveLength(0);
    const result = await create({ leadSource: "PHONE", source: "pretend-google" }) as { id: string };
    expect(h.records.get(`Account:${result.id}`)).toMatchObject({ leadSource: "PHONE" });
    expect(h.records.get(`Account:${result.id}`)?.source).toBeUndefined();
    // An idempotent retry never changes the already-created acquisition.
    expect(await create({ leadSource: "EMAIL" })).toMatchObject({ id: result.id });
    expect(h.records.get(`Account:${result.id}`)?.leadSource).toBe("PHONE");
  });
  it.each([["gclid", "GOOGLE_AD_WEBSITE"], ["wbraid", "GOOGLE_AD_WEBSITE"], ["", "ORGANIC_WEBSITE"]])("classifies website creation from %s", async (key, expected) => {
    const { handler: capture } = await import("../../amplify/functions/lead-intake/handler");
    const result = await capture({ arguments: { name: "Campaign test", attribution: JSON.stringify(key ? { [key]: "test-click" } : {}), source: "website-quote" } } as never, {} as never, () => {}) as { id: string };
    expect(h.records.get(`Account:${result.id}`)).toMatchObject({ leadSource: expected, source: "website-quote" });
  });
});

describe("last prospect contact", () => {
  const stamp = "2026-09-08T14:00:00.000Z";
  async function link(purpose = "PROSPECT") { await save(row("LINK", "front-link:cnv_a", { accountId: "a1", purpose })); }
  it("includes either direction and keeps task updates, notes and Seen out of the clock", async () => {
    const { lastContactPage } = await import("../../amplify/functions/communications/lastContact");
    await link(); await inbound("reply", stamp);
    await inbound("sent", "2026-09-08T15:00:00.000Z", { direction: "OUTBOUND", seenAt: "2026-09-09T16:00:00.000Z" });
    await inbound("note", "2026-09-09T16:00:00.000Z", { channel: "NOTE", direction: "INTERNAL" });
    expect(await lastContactPage("a1")).toMatchObject({ complete: true, contact: { at: "2026-09-08T15:00:00.000Z", direction: "OUTBOUND" } });
  });
  it("excludes carrier conversations, automatic replies and unrelated or failed activity", async () => {
    const { lastContactPage } = await import("../../amplify/functions/communications/lastContact");
    await link("CARRIER"); await inbound("carrier", stamp);
    await inbound("auto", stamp, { classification: "AUTOMATIC" });
    await inbound("wrong", stamp, { channel: "CALL", outcome: "UNRELATED", conversationId: undefined });
    await inbound("failed", stamp, { channel: "SMS", status: "FAILED", conversationId: undefined });
    expect(await lastContactPage("a1")).toMatchObject({ complete: true, contact: null });
  });
  it("paginates past recent notes to find the historical call instead of reporting no contact", async () => {
    const { lastContactPage } = await import("../../amplify/functions/communications/lastContact");
    await inbound("call", stamp, { channel: "CALL", direction: "OUTBOUND", status: "CONNECTED", conversationId: undefined });
    for (let i = 0; i < 30; i++) await inbound(`note-${i}`, "2026-09-09T16:00:00.000Z", { channel: "NOTE", direction: "INTERNAL" });
    const first = await lastContactPage("a1"); expect(first).toMatchObject({ complete: false, contact: null });
    expect(first.nextToken).toBeTruthy();
    expect(await lastContactPage("a1", first.nextToken)).toMatchObject({ complete: true, contact: { at: stamp, channel: "CALL" } });
  });
  it("does not count another account's stale link", async () => {
    const { lastContactPage } = await import("../../amplify/functions/communications/lastContact");
    await save(row("LINK", "front-link:cnv_a", { accountId: "a2", purpose: "PROSPECT" })); await inbound("email", stamp);
    expect((await lastContactPage("a1")).contact).toBeNull();
  });
});

describe("simplified staff work views", () => {
  async function readWork(input: Record<string, unknown>, groups: string[] = []) {
    const { handler } = await import("../../amplify/functions/communications/handler");
    return handler({ arguments: { readOperation: "work", input }, identity: { sub: "brian", groups } as never });
  }
  it("partitions open work into attention and upcoming without changing deadlines", async () => {
    await lead();
    const fixtures = [
      ["overdue", "FOLLOW_UP", "2026-09-07T13:00:00Z"],
      ["today", "DOCUMENTS", "2026-09-08T20:00:00Z"],
      ["reply", "RESPONSE", "2026-09-09T20:00:00Z"],
      ["callback", "CALLBACK", "2026-09-09T20:00:00Z"],
      ["carrier", "CARRIER", "2026-09-09T20:00:00Z"],
      ["delivery", "CORRECTION", "2026-09-09T20:00:00Z"],
      ["future", "FOLLOW_UP", "2026-09-11T13:00:00Z"],
      ["documents", "DOCUMENTS", "2026-09-12T13:00:00Z"],
    ];
    for (const [id, kind, dueAt] of fixtures) await save(row("TASK", id, { kind, dueAt, role: "SALESPERSON", status: "OPEN" }, { accountId: "a1" }));
    await save(row("TASK", "closed", { kind: "RESPONSE", dueAt: NOW, status: "COMPLETE" }, { accountId: "a1" }));
    const before = structuredClone(entries("TASK")), writes = h.transactions.length;
    const attention = await readWork({ kind: "TASK", view: "Needs attention" });
    const upcoming = await readWork({ kind: "TASK", view: "Upcoming" });
    const all = await readWork({ kind: "TASK", view: "All open" });
    expect((attention as any).items.map((r: any) => r.id).sort()).toEqual(["callback", "carrier", "delivery", "overdue", "reply", "today"]);
    expect((upcoming as any).items.map((r: any) => r.id).sort()).toEqual(["documents", "future"]);
    expect((all as any).items).toHaveLength(8);
    expect(entries("TASK")).toEqual(before); expect(h.transactions).toHaveLength(writes);
  });
  it("uses the agency date near midnight and honors the selected responsibility with My leads", async () => {
    const wf = await lead();
    await save(row("WORKFLOW", wf.id, { ...wf.data, championId: "another" }, { accountId: "a1", previous: wf }), wf);
    await save(row("TASK", "sales", { kind: "DOCUMENTS", dueAt: "2026-09-09T02:00:00Z", role: "SALESPERSON", status: "OPEN" }, { accountId: "a1" }));
    await save(row("TASK", "champ", { kind: "CARRIER", dueAt: "2026-09-10T14:00:00Z", role: "CHAMPION", status: "OPEN" }, { accountId: "a1" }));
    expect(await readWork({ kind: "TASK", view: "Needs attention", responsibility: "SALESPERSON", mine: true })).toMatchObject({ ok: true, items: [{ id: "sales" }] });
    expect(await readWork({ kind: "TASK", view: "Needs attention", responsibility: "CHAMPION", mine: true })).toMatchObject({ ok: true, items: [] });
    expect(await readWork({ kind: "TASK", view: "Needs attention", responsibility: "CHAMPION" })).toMatchObject({ ok: true, items: [{ id: "champ" }] });
    expect(await readWork({ kind: "TASK", responsibility: "ADMIN" })).toMatchObject({ ok: false });
  });
  it("keeps a cursor when matching work lies beyond the bounded search", async () => {
    await lead();
    for (let n = 0; n < 450; n++) await save(row("TASK", `later:${n}`, { kind: "FOLLOW_UP", dueAt: "2026-09-10T13:00:00Z", status: "OPEN", role: "SALESPERSON" }, { accountId: "a1" }));
    await save(row("TASK", "answer-this", { kind: "CALLBACK", dueAt: "2026-09-11T13:00:00Z", status: "OPEN", role: "SALESPERSON" }, { accountId: "a1" }));
    const first = await readWork({ kind: "TASK", view: "Needs attention" });
    expect(first).toMatchObject({ ok: true, items: [], nextToken: expect.any(String) });
    expect(await readWork({ kind: "TASK", view: "Needs attention", nextToken: (first as any).nextToken })).toMatchObject({ ok: true, items: [{ id: "answer-this" }], nextToken: undefined });
  });
  it("reserves technical queues and issue resolution for admins but keeps shared intake accessible", async () => {
    await save(row("ISSUE", "issue:connection", { message: "Reconnect Front", resolved: false }));
    await save(row("TRIAGE", "triage:shared", { phone: "+16175550123", resolved: false }));
    for (const kind of ["ISSUE", "OPERATION", "EVENT"]) {
      expect(await readWork({ kind })).toMatchObject({ ok: false });
      expect(await readWork({ kind }, ["ADMIN"])).toMatchObject({ ok: true });
    }
    expect(await readWork({ kind: "TRIAGE" })).toMatchObject({ ok: true, items: [{ id: "triage:shared" }] });
    const { handler } = await import("../../amplify/functions/communications/handler");
    const args = { arguments: { operation: "reviewIssue", input: { id: "issue:connection", version: 1, reason: "Reconnected" } } };
    expect(await handler({ ...args, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: false });
    expect(record("issue:connection").data.resolved).toBe(false);
    expect(await handler({ ...args, identity: { sub: "admin", groups: ["ADMIN"] } as never })).toMatchObject({ ok: true });
  });
});
