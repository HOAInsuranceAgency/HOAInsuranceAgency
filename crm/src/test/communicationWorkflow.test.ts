import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Communication, IntegrationConfig, LeadWorkflow } from "../../../shared/leadWorkflow";
const h = vi.hoisted(() => ({ records: new Map<string, Record<string, any>>(), transactions: [] as any[][], inFlight: 0, maxInFlight: 0, fail: false, failAt: undefined as number | undefined, writeError: undefined as Error | undefined, writeErrors: [] as Error[], accountError: false, userEnabled: true, disabledUsers: new Set<string>(),
  reads: [] as string[], readFailureId: undefined as string | undefined, beforeWrite: undefined as (() => void) | undefined, userReads: [] as string[], userError: undefined as Error | undefined, queries: [] as any[], queryError: undefined as Error | undefined, deletionQuery: vi.fn(), batch: vi.fn(), front: vi.fn(), dialpad: vi.fn(), update: vi.fn(), accountList: vi.fn(), c: {} as IntegrationConfig }));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: async (command: any) => {
    const p = command.input;
    if (command.constructor.name === "GetCommand") { h.reads.push(p.Key.id); if (h.readFailureId === p.Key.id) { h.readFailureId = undefined; throw new Error("Temporary read failure"); } return { Item: h.records.get(`${p.TableName}:${p.Key.id}`) }; }
    if (command.constructor.name === "BatchGetCommand") return h.batch(p);
    if (command.constructor.name === "QueryCommand") {
      h.queries.push(p);
      if (p.Select === 'COUNT') {
        const override = await h.deletionQuery(p);
        if (override !== undefined) return override;
        const matches = [...h.records.entries()].filter(([key, value]) => key.startsWith(`${p.TableName}:`) && value.accountId === p.ExpressionAttributeValues[':accountId']);
        return { Count: Math.min(matches.length, p.Limit) };
      }
      if (p.IndexName === "website-producers" && h.queryError) throw h.queryError;
      const v = p.ExpressionAttributeValues;
      let items = [...h.records.entries()].filter(([k,r]) => k.startsWith(`${p.TableName}:`) && r[p.ExpressionAttributeNames["#k"] ?? p.ExpressionAttributeNames["#group"]] === (v[":k"] ?? v[":group"]) && (!v[":after"] || r.id > v[":after"]) && (!v[":through"] || r.id <= v[":through"]) && (!v[":prefix"] || r.accountSort?.startsWith(v[":prefix"])) && (!v[":now"] || r.dueAt <= v[":now"])).map(([,r]) => r);
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
      if (h.failAt === h.transactions.length) { h.failAt = undefined; throw new Error("Interrupted contact progress"); }
      if (h.writeError) { const error = h.writeError; h.writeError = undefined; throw error; }
      if (h.writeErrors.length) throw h.writeErrors.shift();
      const beforeWrite = h.beforeWrite; h.beforeWrite = undefined; beforeWrite?.();
      const writes = p.TransactItems;
      for (const entry of writes) {
        const w = entry.Put ?? entry.ConditionCheck ?? entry.Update;
        const old = h.records.get(`${w.TableName}:${w.Item?.id ?? w.Key?.id}`);
        if (entry.ConditionCheck && w.ConditionExpression === '#stage = :lead') {
          if (old?.stage !== w.ExpressionAttributeValues[':lead']) throw Object.assign(new Error('Lead stage changed'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
          continue;
        }
        if (entry.ConditionCheck && w.ConditionExpression === 'updatedAt = :at') {
          if (old?.updatedAt !== w.ExpressionAttributeValues[':at']) throw Object.assign(new Error('Source record changed'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
          continue;
        }
        if (entry.Update) {
          const v = w.ExpressionAttributeValues;
          const changed = v[":before"] != null ? old?.currentPolicyExpiration !== v[":before"] || old?.updatedAt !== v[":version"] || old?.stage !== v[":lead"] : old?.updatedAt !== v[":old"] || v[":quoted"] && old?.status !== v[":quoted"];
          if (changed) throw Object.assign(new Error("Source record changed"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
          continue;
        }
        if (w.ConditionExpression === "attribute_not_exists(id)" ? !!old : old?.version !== w.ExpressionAttributeValues[":v"]) throw Object.assign(new Error("Conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      }
      h.transactions.push(writes);
      for (const { Put: w } of writes.filter((w: any) => w.Put)) h.records.set(`${w.TableName}:${w.Item.id}`, structuredClone(w.Item));
      for (const { Update: u } of writes.filter((w: any) => w.Update)) {
        const key = `${u.TableName}:${u.Key.id}`, record = { ...h.records.get(key) };
        for (const assignment of u.UpdateExpression.replace(/^SET /, "").split(", ")) {
          const [raw, variable] = assignment.split(" = "); record[u.ExpressionAttributeNames?.[raw] ?? raw] = u.ExpressionAttributeValues[variable];
        }
        h.records.set(key, record);
      }
      return {};
    }
    throw new Error(`Unexpected storage command ${command.constructor.name}`);
  } }) } };
});
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({ CognitoIdentityProviderClient: class { send = async (command: any) => { const id = /"([^"]+)"/.exec(command.input.Filter)?.[1] ?? "brian"; h.userReads.push(id); if (h.userError) throw h.userError; return { Users: [{ Enabled: h.userEnabled && !h.disabledUsers.has(id), Attributes: [{ Name: "email", Value: `${id}@example.com` }, { Name: "email_verified", Value: "true" }] }] }; }; }, ListUsersCommand: class { constructor(public input: unknown) {} } }));
vi.mock("../../amplify/functions/communications/config", async importOriginal => ({ ...(await importOriginal<typeof import("../../amplify/functions/communications/config")>()), saveCredentials: vi.fn(), config: async () => h.c, credentials: async () => ({ frontSigningKey: "test-signing-key", dialpadSigningKey: "test-dialpad-signing-key" }) }));
vi.mock("../../amplify/functions/communications/data", () => ({ dataClient: async () => ({ models: {
  Account: { list: h.accountList, get: async ({ id }: { id: string }) => (h.accountError ? { data: null, errors: [{ message: "Simulated account read failure" }] } : { data: { id, name: "Willow HOA", stage: "LEAD", createdAt: "2026-09-08T14:00:00.000Z", updatedAt: "2026-09-08T14:00:00.000Z", ...Object.fromEntries([["quotes", "Quote"], ["policies", "Policy"], ["priorCarriers", "PriorCarrier"], ["certificates", "Certificate"], ["invoices", "Invoice"]].map(([name, model]) => [name, async () => ({ data: [...h.records.entries()].filter(([key, r]) => key.startsWith(`${model}:`) && r.accountId === id).map(([, r]) => r) })])), contacts: async () => ({ data: [...h.records.entries()].filter(([key, c]) => key.startsWith("Contact:") && c.accountId === id).map(([,c]) => c) }), ...h.records.get(`Account:${id}`) } }) },
  Quote: { get: async ({ id }: { id: string }) => ({ data: h.records.get(`Quote:${id}`) ?? null }), list: async () => ({ data: [...h.records.entries()].filter(([key]) => key.startsWith("Quote:")).map(([,r]) => r) }) },
  Policy: { get: async ({ id }: { id: string }) => ({ data: h.records.get(`Policy:${id}`) ?? null }), list: async () => ({ data: [...h.records.entries()].filter(([key]) => key.startsWith("Policy:")).map(([,r]) => r) }) },
  MarketingTask: { list: async () => ({ data: [] }), listMarketingTaskByAccountId: async () => ({ data: [] }) },
  PriorCarrier: { list: async () => ({ data: [] }) },
  Carrier: { get: async ({ id }: { id: string }) => ({ data: h.records.get(`Carrier:${id}`) ?? null }) },
  Certificate: { list: async () => ({ data: [...h.records.entries()].filter(([key]) => key.startsWith("Certificate:")).map(([,d]) => d) }) },
  Document: { listDocumentByEntityId: async () => ({ data: [...h.records.entries()].filter(([key]) => key.startsWith("Document:")).map(([,d]) => d) }) },
  LeadReply: { update: h.update },
  UserProfile: { list: async () => ({ data: [...h.records.entries()].filter(([key]) => key.startsWith("UserProfile:")).map(([,profile]) => profile) }) },
} }) }));
vi.mock("../../amplify/functions/communications/providers", async importOriginal => {
  const actual = await importOriginal<typeof import("../../amplify/functions/communications/providers")>();
  return { ...actual, front: h.front, dialpad: h.dialpad, permittedConversation: vi.fn(async (id: string) => ({ id, status: "open" })), verifyEmailChannel: vi.fn() };
});
import { get, row, save, type Row } from "../../amplify/functions/communications/store";
import { handler as capture } from "../../amplify/functions/lead-intake/handler";
import { runWebLeadAssignment } from "../../amplify/functions/lead-intake/assignment";
import { defaultWorkflow, makeTask, saveTask as retiredSaveTask, recordInbound, recordOutbound, completeTask, setResponsibilities, mergeTasks } from "../../amplify/functions/communications/workflow";
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
async function inbound(id = "m1", at = NOW, extra: Partial<Communication> = {}) { const c: Communication = { id: `comm:${id}`, providerId: id, provider: "front", frontDraft: false, channel: "EMAIL", direction: "INBOUND", accountId: "a1", conversationId: "cnv_a", at, status: extra.direction === "OUTBOUND" ? "SENT" : "RECEIVED", text: "A message about the policy", version: 1, ...extra }; await save(row("COMMUNICATION", c.id, c, { accountId: c.accountId })); return c; }
/** Import a historical row as it existed before task retirement. */
async function seedLegacyPromise(input: any, actor: string) {
  void actor;
  const data = { id: input.id ?? "historical-task", status: "OPEN", version: 1, ...input };
  const historical = { ...row("TASK", data.id, data, { accountId: data.accountId }), dueAt: data.dueAt, dueGroup: "DUE", workKind: "TASK", workAt: data.dueAt };
  h.records.set(`comms:${data.id}`, historical);
  return data;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); h.records.clear(); h.transactions.length = 0; h.inFlight = 0; h.maxInFlight = 0; h.fail = false; h.failAt = undefined; h.accountError = false; h.userEnabled = true; h.writeError = undefined; vi.clearAllMocks();
  h.disabledUsers.clear();
  h.writeErrors.length = 0;
  h.reads.length = 0; h.readFailureId = undefined; h.beforeWrite = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined;
  h.deletionQuery.mockReset();
  h.batch.mockReset().mockImplementation((p: { RequestItems: Record<string, { Keys: { id: string }[] }> }) => ({
    Responses: Object.fromEntries(Object.entries(p.RequestItems).map(([name, request]) => [name,
      request.Keys.map(key => h.records.get(`${name}:${key.id}`)).filter(Boolean).map(item => structuredClone(item)).reverse(),
    ])),
  }));
  Object.assign(process.env, { COMMUNICATION_TABLE: "comms", ACTIVITY_TABLE: "Activity", ACCOUNT_TABLE: "Account", CONTACT_TABLE: "Contact", PRIOR_CARRIER_TABLE: "PriorCarrier", LEAD_REPLY_TABLE: "LeadReply", USER_POOL_ID: "pool", CRM_BASE_URL: "https://crm.example.test", QUOTE_TABLE: "Quote", CERTIFICATE_TABLE: "Certificate", DOCUMENT_TABLE: "Document", LEAD_DELETION_POLICY_TABLE: 'Policy', LEAD_DELETION_POLICY_INDEX: 'gsi-Account.policies', LEAD_DELETION_INVOICE_TABLE: 'Invoice', LEAD_DELETION_INVOICE_INDEX: 'gsi-Account.invoices' });
  h.c = { frontCompanyId: "cmp_a", environment: "main", defaultUserId: "brian", frontSender: "sales@protectmyhoa.com", frontInboxId: "inb_a", frontChannelId: "cha_a", holidays: [], paused: false, activatedAt: "2026-09-01T00:00:00Z", allowedInboxIds: [], testRecipients: [], dialpadNumbers: ["+15082332261", "+16175550123"], sharedSmsNumber: "+15082332261", version: 1 };
  await save(row("ELIGIBILITY", "eligibility:brian", { userId: "brian", name: "Brian Cole", email: "brian@example.com", salesperson: true, champion: true, enabled: true }));
  await save(row("TEAM_ROUTING", "team-routing", { ownerId: "brian", members: [] }));
  h.records.set("comms:migration:website-producers:v1", row("MIGRATION", "migration:website-producers:v1", { complete: true }));
  h.update.mockResolvedValue({ data: {} });
  h.accountList.mockReset().mockResolvedValue({ data: [] });
  h.front.mockImplementation(async (path: string) => path.includes("/messages") && path.includes("/conversations") ? { _results: [] } : {});
});
afterEach(() => vi.useRealTimers());
describe('producer lead snoozes', () => {
  const input = { accountId: 'a1', version: 0, followUpOn: '2026-09-10', note: '  Call after the board meeting  ' };
  async function setup() {
    await lead();
    h.records.set('Account:a1', { id: 'a1', stage: 'LEAD', name: 'Willow HOA', updatedAt: NOW });
    return (await import('../../amplify/functions/communications/snooze')).saveLeadSnooze;
  }
  it('saves and audits a date without creating tasks, deliveries or queue work', async () => {
    const write = await setup();
    expect(await write(input, 'brian', false)).toEqual({ ...input, version: 1, note: 'Call after the board meeting', updatedAt: NOW, updatedBy: 'brian' });
    expect(record('lead-snooze:a1')).toMatchObject({ kind: 'LEAD_SNOOZE', accountId: 'a1', version: 1, accountSort: expect.stringMatching(/^LEAD_SNOOZE#/) });
    for (const field of ['dueAt', 'dueGroup', 'workKind', 'workAt']) expect(record('lead-snooze:a1')).not.toHaveProperty(field);
    for (const kind of ['TASK', 'NOTIFICATION', 'OPERATION', 'LIFECYCLE']) expect(entries(kind)).toHaveLength(0);
    expect([...h.records.values()].filter(r => r.__typename === 'Activity')).toMatchObject([{ actor: 'brian', summary: 'Lead snoozed until follow-up' }]);
    expect(h.front).not.toHaveBeenCalled(); expect(h.dialpad).not.toHaveBeenCalled();
  });
  it('keeps a cleared row versioned and rejects stale changes without losing the clear', async () => {
    const write = await setup();
    await write(input, 'brian', false);
    expect(await write({ ...input, version: 1, followUpOn: null }, 'brian', false)).toMatchObject({ version: 2, followUpOn: null, note: '' });
    await expect(write(input, 'brian', false)).rejects.toThrow('Refresh before saving');
    await expect(write({ ...input, version: 1 }, 'brian', false)).rejects.toThrow('Refresh before saving');
    expect(record('lead-snooze:a1').data).toMatchObject({ version: 2, followUpOn: null });
  });
  it('allows one competing first save and tells the other editor to refresh', async () => {
    const write = await setup();
    const results = await Promise.allSettled([write(input, 'brian', false), write({ ...input, followUpOn: '2026-09-11' }, 'brian', false)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: expect.objectContaining({ message: expect.stringContaining('Refresh before saving') }) }]);
    expect(record('lead-snooze:a1').version).toBe(1);
    expect([...h.records.values()].filter(r => r.__typename === 'Activity')).toHaveLength(1);
  });
  it.each(['assignment', 'binding', 'deletion', 'account removal'])('fences a concurrent %s before saving or auditing', async change => {
    const write = await setup();
    h.beforeWrite = () => {
      if (change === 'assignment') h.records.set('comms:workflow:a1', { ...record('workflow:a1'), version: 2, data: { ...record('workflow:a1').data, salespersonId: 'other' } });
      if (change === 'binding') h.records.get('Account:a1')!.stage = 'CLIENT';
      if (change === 'deletion') h.records.set('comms:deleted-account:a1', row('DELETED_ACCOUNT', 'deleted-account:a1', {}));
      if (change === 'account removal') h.records.delete('Account:a1');
    };
    await expect(write(input, 'brian', false)).rejects.toThrow('Refresh before saving');
    expect(record('lead-snooze:a1')).toBeUndefined();
    expect([...h.records.values()].filter(r => r.__typename === 'Activity')).toHaveLength(0);
  });
  it('rechecks ownership and permits an administrator to snooze a lead without initializing its workflow', async () => {
    const write = await setup();
    await expect(write(input, 'other', false)).rejects.toThrow('assigned leads');
    h.records.delete('comms:workflow:a1');
    await expect(write(input, 'brian', false)).rejects.toThrow('assigned leads');
    expect(await write(input, 'admin', true)).toMatchObject({ version: 1, updatedBy: 'admin' });
    expect(record('workflow:a1')).toBeUndefined();
  });
  it('requires a real, readable lead and rejects already deleted accounts', async () => {
    const write = await setup();
    h.accountError = true;
    await expect(write(input, 'brian', false)).rejects.toThrow('Could not load this lead');
    h.accountError = false; h.records.get('Account:a1')!.stage = 'CLIENT';
    await expect(write(input, 'brian', false)).rejects.toThrow('only available for leads');
    h.records.get('Account:a1')!.stage = 'LEAD';
    h.records.set('comms:deleted-account:a1', row('DELETED_ACCOUNT', 'deleted-account:a1', {}));
    await expect(write(input, 'admin', true)).rejects.toThrow('being deleted');
    expect(record('lead-snooze:a1')).toBeUndefined();
  });
  it('validates dates against the Eastern calendar rather than the UTC day', async () => {
    const write = await setup();
    vi.setSystemTime('2026-09-09T02:00:00.000Z');
    await expect(write({ ...input, followUpOn: '2026-09-08' }, 'brian', false)).rejects.toThrow('after today');
    expect(await write({ ...input, followUpOn: '2026-09-09' }, 'brian', false)).toMatchObject({ followUpOn: '2026-09-09' });
  });
  it.each([
    { followUpOn: '2026-09-31' }, { followUpOn: 'tomorrow' }, { followUpOn: undefined },
    { note: 'x'.repeat(1001) }, { note: undefined }, { version: -1 }, { version: 0.5 }, { accountId: '../other' },
  ])('rejects malformed input before storing a snooze: %j', async invalid => {
    const write = await setup();
    await expect(write({ ...input, ...invalid }, 'brian', false)).rejects.toThrow();
    expect(record('lead-snooze:a1')).toBeUndefined();
  });
  it('preserves storage failures instead of reporting success or an empty read', async () => {
    const write = await setup();
    h.fail = true;
    await expect(write(input, 'brian', false)).rejects.toThrow('storage outage');
    h.fail = false; h.batch.mockRejectedValueOnce(new Error('Temporary read failure'));
    const { commercialTable } = await import('../../amplify/functions/communications/commercial');
    await expect(commercialTable(['a1'], ['a1'])).rejects.toThrow('Temporary read failure');
  });
  it('exposes source-row versions in table/context reads, including leads without a workflow', async () => {
    const { commercialTable } = await import('../../amplify/functions/communications/commercial');
    const { handler } = await import('../../amplify/functions/communications/handler');
    const identity = { sub: 'brian', groups: ['ADMIN'] } as never;
    const empty = { accountId: 'a1', version: 0, followUpOn: null, note: '' };
    expect(await commercialTable(['a1'], ['a1'])).toMatchObject([{ snooze: empty }]);
    expect(await handler({ arguments: { readOperation: 'context', input: { accountId: 'a1' } }, identity })).toMatchObject({ ok: true, workflow: null, snooze: empty });
    h.records.set('comms:lead-snooze:a1', { ...row('LEAD_SNOOZE', 'lead-snooze:a1', { ...input, version: 1 }), version: 4 });
    expect(await commercialTable(['a1'], ['a1'])).toMatchObject([{ snooze: { ...input, version: 4 } }]);
    expect(await handler({ arguments: { readOperation: 'context', input: { accountId: 'a1' } }, identity })).toMatchObject({ ok: true, snooze: { ...input, version: 4 } });
    h.records.set('Account:a1', { id: 'a1', stage: 'CLIENT' });
    h.reads.length = 0;
    const client = await handler({ arguments: { readOperation: 'context', input: { accountId: 'a1' } }, identity });
    expect(client).toMatchObject({ ok: true }); expect(client).not.toHaveProperty('snooze');
    expect(h.reads).not.toContain('lead-snooze:a1');
  });
  it('routes writes through active-role ownership checks and returns the saved snooze', async () => {
    await setup();
    const { handler } = await import('../../amplify/functions/communications/handler');
    const identity = { sub: 'other', groups: ['ADMIN', 'PRODUCER'] } as never;
    const event = { arguments: { operation: 'saveLeadSnooze', input }, identity };
    expect(await handler({ ...event, request: { headers: { 'x-crm-role': 'PRODUCER' } } })).toMatchObject({ ok: false, error: expect.stringContaining('assigned leads') });
    expect(await handler({ ...event, request: { headers: { 'x-crm-role': 'ADMIN' } } })).toMatchObject({ ok: true, snooze: { version: 1, followUpOn: input.followUpOn, updatedBy: 'other' } });
  });
});
describe('commercial table batched reads', () => {
  it('reads a full 25-account batch including requested follow-ups with one storage request', async () => {
    const accounts = Array.from({ length: 25 }, (_, index) => `a${index}`);
    h.records.set('comms:commercial:a1', { ...row('COMMERCIAL_PLAN', 'commercial:a1', { accountId: 'a1', estimatedCents: 10000 }), version: 7 });
    h.records.set('comms:workflow:a1', row('WORKFLOW', 'workflow:a1', { accountId: 'a1', salespersonId: 'brian', disposition: 'ACTIVE' }));
    h.records.set('comms:lead-snooze:a1', { ...row('LEAD_SNOOZE', 'lead-snooze:a1', { accountId: 'a1', followUpOn: '2026-09-10', note: 'Call back', version: 1 }), version: 3 });
    const { commercialTable } = await import('../../amplify/functions/communications/commercial');
    const results = await commercialTable(accounts, accounts);
    expect(h.batch).toHaveBeenCalledTimes(1);
    const request = h.batch.mock.calls[0][0].RequestItems.comms;
    expect(request.ConsistentRead).toBe(true);
    expect(request.Keys).toHaveLength(75);
    expect(new Set(request.Keys.map((key: { id: string }) => key.id)).size).toBe(75);
    expect(h.reads).toEqual([]);
    expect(results.map(result => result.accountId)).toEqual(accounts);
    expect(results[1]).toMatchObject({ accountId: 'a1', plan: { estimatedCents: 10000, version: 7 }, salespersonId: 'brian', disposition: 'ACTIVE', snooze: { version: 3, followUpOn: '2026-09-10', note: 'Call back' } });
    expect(results[0]).toMatchObject({ snooze: { accountId: 'a0', version: 0, followUpOn: null, note: '' } });
  });
  it.each([undefined, []])('omits follow-up reads unless explicitly requested: %j', async requested => {
    h.records.set('comms:lead-snooze:a1', row('LEAD_SNOOZE', 'lead-snooze:a1', { accountId: 'a1', followUpOn: '2026-09-10' }));
    const { commercialTable } = await import('../../amplify/functions/communications/commercial');
    const result = await commercialTable(['a1'], requested);
    expect(result[0]).not.toHaveProperty('snooze');
    expect(h.batch.mock.calls[0][0].RequestItems.comms.Keys).toEqual([{ id: 'commercial:a1' }, { id: 'workflow:a1' }]);
    expect(h.reads).toEqual([]);
  });
  it('reads follow-ups only for the requested account subset through the API', async () => {
    const { handler } = await import('../../amplify/functions/communications/handler');
    const result = await handler({ arguments: { readOperation: 'commercialTable', input: { accountIds: ['lead', 'client'], snoozeAccountIds: ['lead'] } }, identity: { sub: 'admin', groups: ['ADMIN'] } as never });
    expect(result).toMatchObject({ ok: true, items: [{ accountId: 'lead', snooze: { accountId: 'lead', version: 0 } }, { accountId: 'client' }] });
    expect((result as { items: Record<string, unknown>[] }).items[1]).not.toHaveProperty('snooze');
    const keys = h.batch.mock.calls[0][0].RequestItems.comms.Keys;
    expect(keys).toHaveLength(5);
    expect(keys).toContainEqual({ id: 'lead-snooze:lead' });
    expect(keys).not.toContainEqual({ id: 'lead-snooze:client' });
  });
  it.each([null, 'a1', ['other-account'], ['a1', 'a1'], [1], Array.from({ length: 26 }, (_, index) => `a${index}`)])('rejects an invalid follow-up subset before storage access: %j', async requested => {
    const { commercialTable } = await import('../../amplify/functions/communications/commercial');
    await expect(commercialTable(['a1'], requested)).rejects.toThrow('requested accounts');
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.reads).toEqual([]);
  });
  it('never treats repeatedly unprocessed follow-ups as an empty snooze', async () => {
    h.batch.mockImplementation(input => ({ UnprocessedKeys: input.RequestItems }));
    const { commercialTable } = await import('../../amplify/functions/communications/commercial');
    const result = expect(commercialTable(['a1'], ['a1'])).rejects.toThrow('Communication batch read remains incomplete');
    await vi.runAllTimersAsync();
    await result;
    expect(h.batch).toHaveBeenCalledTimes(4);
  });
});
describe('commercial package persistence', () => {
  async function seedPackages() {
    await lead(); h.records.set('Account:a1', { id: 'a1', stage: 'LEAD', name: 'Willow HOA', createdAt: NOW, updatedAt: NOW });
    for (const [id, lines, premium] of [['bundle', ['Property','D&O'], 15000], ['property', ['Property'], 11000], ['do', ['D&O'], 2500]] as const) h.records.set(`Quote:${id}`, { id, accountId: 'a1', carrierId: id, status: 'QUOTED', lines: [...lines], premium, commissionPct: 10, effectiveDate: '2026-10-01', expirationDate: '2027-10-01', createdAt: NOW, updatedAt: NOW });
    return (await import('../../amplify/functions/communications/commercial')).saveCommercial;
  }
  it('persists and audits estimates with optimistic concurrency, without touching packages', async () => {
    const write = await seedPackages(); const p = await write({ accountId: 'a1', version: 0, action: 'ESTIMATE', amount: '1234.56' }, 'brian');
    expect(p).toMatchObject({ estimatedCents: 123456, options: [], version: 1 });
    await expect(write({ accountId: 'a1', version: 0, action: 'ESTIMATE', amount: '4' }, 'brian')).rejects.toThrow('changed');
    expect([...h.records.keys()].some(k => k.startsWith('Activity:'))).toBe(true);
  });
  it('saves complete reviewed options and records the selected package without sending or binding', async () => {
    const write = await seedPackages(); let p = await write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Combined', requiredLines: ['Property','D&O'], quoteIds: ['property','do'], reviewed: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.options[0].id, clientSelected: true }, 'brian');
    expect(p.selectedOptionId).toBe(p.options[0].id); expect(p.selectedTerms?.property).toBeTruthy();
    expect(entries('LIFECYCLE')).toHaveLength(2); expect(entries('OPERATION')).toHaveLength(0); expect(h.records.get('Quote:property')!.status).toBe('QUOTED');
  });
  it('rejects incomplete reviewed options and quotes from another account', async () => {
    const write = await seedPackages();
    await expect(write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Incomplete', requiredLines: ['Property','D&O'], quoteIds: ['do'], reviewed: true }, 'brian')).rejects.toThrow('Missing Property');
    h.records.get('Quote:do')!.accountId = 'other';
    await expect(write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Wrong account', requiredLines: ['D&O'], quoteIds: ['do'] }, 'brian')).rejects.toThrow('this account');
  });
  it('does not accept changed quote terms without a new package review', async () => {
    const write = await seedPackages(); const p = await write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Bundle', requiredLines: ['Property','D&O'], quoteIds: ['bundle'], reviewed: true }, 'brian');
    h.records.get('Quote:bundle')!.premium = 16000;
    await expect(write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.options[0].id, clientSelected: true }, 'brian')).rejects.toThrow('current terms');
  });
  it('keeps bound policies in a selected package and permits review of remaining terms', async () => {
    const write = await seedPackages(); let p = await write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Combined', requiredLines: ['Property','D&O'], quoteIds: ['property','do'], reviewed: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.options[0].id, clientSelected: true }, 'brian');
    h.records.get('Quote:property')!.status = 'BOUND';
    await expect(write({ accountId: 'a1', version: p.version, action: 'CLEAR_SELECTION' }, 'brian')).rejects.toThrow('already in binding');
    await expect(write({ accountId: 'a1', version: p.version, action: 'SAVE_OPTION', optionId: p.selectedOptionId, name: 'Bad edit', quoteIds: ['do'], requiredLines: ['D&O'], reviewed: true }, 'brian')).rejects.toThrow('Keep bound');
    expect((await write({ accountId: 'a1', version: p.version, action: 'SAVE_OPTION', optionId: p.selectedOptionId, name: 'Updated combined', quoteIds: ['property','do'], requiredLines: ['Property','D&O'], reviewed: true }, 'brian')).options[0].reviewed).toBeTruthy();
  });
  it('requires renewed client selection when a selected package changes scope or membership', async () => {
    const write = await seedPackages(); let p = await write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Combined', requiredLines: ['Property','D&O'], quoteIds: ['property','do'], reviewed: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.options[0].id, clientSelected: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SAVE_OPTION', optionId: p.selectedOptionId, name: 'Property only', requiredLines: ['Property'], quoteIds: ['property'], reviewed: true }, 'brian');
    const { pendingCommission } = await import('../../../shared/quotePackages');
    expect(pendingCommission(p, [h.records.get('Quote:property')!] as never, '2026-09-08')).toMatchObject({ cents: null, label: 'Selected package needs review' });
    p = await write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.selectedOptionId, clientSelected: true }, 'brian');
    expect(pendingCommission(p, [h.records.get('Quote:property')!] as never, '2026-09-08').cents).toBe(110000);
  });
  it('cannot switch away from a package that has started binding', async () => {
    const write = await seedPackages(); let p = await write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Bundle', requiredLines: ['Property','D&O'], quoteIds: ['bundle'], reviewed: true }, 'brian');
    const bundle = p.options[0].id;
    p = await write({ accountId: 'a1', version: p.version, action: 'SAVE_OPTION', name: 'Combined', requiredLines: ['Property','D&O'], quoteIds: ['property','do'], reviewed: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.options[1].id, clientSelected: true }, 'brian');
    h.records.get('Quote:property')!.bindAuthorizedAt = NOW;
    await expect(write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: bundle, clientSelected: true }, 'brian')).rejects.toThrow('already in binding');
  });
  it('retains an unfinished package after first bind and retires alternatives from sales work', async () => {
    const write = await seedPackages(); let p = await write({ accountId: 'a1', version: 0, action: 'SAVE_OPTION', name: 'Bundle', requiredLines: ['Property','D&O'], quoteIds: ['bundle'], reviewed: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SAVE_OPTION', name: 'Combined', requiredLines: ['Property','D&O'], quoteIds: ['property','do'], reviewed: true }, 'brian');
    p = await write({ accountId: 'a1', version: p.version, action: 'SELECT', optionId: p.options[1].id, clientSelected: true }, 'brian');
    h.records.get('Quote:property')!.status = 'BOUND'; h.records.get('Account:a1')!.stage = 'CLIENT'; h.records.set('Policy:property', { id: 'property', accountId: 'a1', quoteId: 'property', status: 'ACTIVE', effectiveDate: '2026-10-01', expirationDate: '2027-10-01', lines: ['Property'], createdAt: NOW });
    await (await import('../../amplify/functions/communications/workflow')).syncAccountLifecycle('a1');
    expect(record('workflow:a1').data.openLeadQuoteIds).toEqual(['do']);
    expect(entries("TASK")).toEqual([]);
    h.records.get('Quote:do')!.status = 'DECLINED';
    await (await import('../../amplify/functions/communications/workflow')).syncAccountLifecycle('a1');
    expect(record('workflow:a1').data.openLeadQuoteIds).toEqual(['do']);
    expect(entries("TASK")).toEqual([]);
    h.records.get('Quote:do')!.status = 'BOUND'; h.records.set('Policy:do', { id: 'do', accountId: 'a1', quoteId: 'do', status: 'ACTIVE', expirationDate: '2027-10-01', lines: ['D&O'], createdAt: NOW });
    await (await import('../../amplify/functions/communications/workflow')).syncAccountLifecycle('a1');
    expect(record('workflow:a1').data.openLeadQuoteIds).toEqual([]);
    expect(entries("TASK")).toEqual([]);
  });
});
describe('deleted lead cleanup', () => {
  it('requires admin permission at the API', async () => {
    const { handler } = await import('../../amplify/functions/communications/handler');
    expect(await handler({ arguments: { operation: 'prepareLeadDeletion', input: { accountId: 'a1', name: 'Willow HOA' } }, identity: { sub: 'staff', groups: ['STAFF'] } as never })).toMatchObject({ ok: false, error: 'Only an admin can change integration or team settings' });
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it('preserves historical tasks while stopping their indexes and stale events or queued sends', async () => {
    await lead();
    for (let i = 0; i < 31; i++) await seedLegacyPromise({ accountId: 'a1', role: 'SALESPERSON', kind: 'FOLLOW_UP', title: 'Test task', dueAt: '2026-09-10T13:00:00.000Z', id: `task:delete:${i}` }, 'brian');
    const queued = await enqueueOperation('op:delete:queued', { type: 'COMMENT', accountId: 'a1', conversationId: 'cnv_a', text: 'No longer needed' });
    const { prepareLeadDeletion, retireAccountPage } = await import('../../amplify/functions/communications/deletion');
    await prepareLeadDeletion('a1', 'Willow HOA', 'admin');
    let passes = 0;
    while (record('account-delete:a1')?.dueAt && passes++ < 20) await retireAccountPage(record('account-delete:a1') as never);
    expect(passes).toBeLessThan(20);
    expect(entries('TASK')).toHaveLength(31);
    expect(entries('TASK').every(t => t.data.status === 'OPEN' && !t.dueAt && !t.workKind)).toBe(true);
    await runOperation(queued);
    expect(h.front).not.toHaveBeenCalled();
    expect(record(queued.id).data.state).toBe('SUPPRESSED');
    await recordInbound(await inbound('late'));
    expect(entries('TASK')).toHaveLength(31);
    expect(record('workflow:a1').data.disposition).toBe('DISQUALIFIED');
  });
  it.each(['LEASED','ACCEPTED','UNKNOWN'] as const)('blocks deletion while a delivery is %s', async state => {
    await lead(); await save(row('OPERATION', 'op:busy', { accountId: 'a1', type: 'EMAIL', state, attempts: 1 }, { accountId: 'a1' }));
    const { prepareLeadDeletion } = await import('../../amplify/functions/communications/deletion');
    await expect(prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow('delivery');
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it.each(['Policy','Invoice'])('preserves accounts with %s records', async model => {
    await lead(); h.records.set(`${model}:real`, { id: 'real', accountId: 'a1' });
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow(/cannot be deleted/);
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it('permits a lead with no policies or invoices despite unrelated table history and empty lazy-relation pages', async () => {
    const policies = vi.fn().mockResolvedValue({ data: [], nextToken: 'unrelated-policy-page' });
    const invoices = vi.fn().mockResolvedValue({ data: [], nextToken: 'unrelated-invoice-page' });
    h.records.set('Account:a1', { id: 'a1', policies, invoices });
    for (let i = 0; i < 25; i++) {
      h.records.set(`Policy:unrelated-${i}`, { id: `unrelated-${i}`, accountId: 'another-account' });
      h.records.set(`Invoice:unrelated-${i}`, { id: `unrelated-${i}`, accountId: 'another-account' });
    }
    await (await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin');
    expect(record('deleted-account:a1')?.data).toMatchObject({ accountId: 'a1', actor: 'admin' });
    expect(policies).not.toHaveBeenCalled();
    expect(invoices).not.toHaveBeenCalled();
    expect(h.queries.filter(query => query.Select === 'COUNT')).toEqual(['Policy', 'Invoice'].map(model => ({
      TableName: model,
      IndexName: `gsi-Account.${model === 'Policy' ? 'policies' : 'invoices'}`,
      KeyConditionExpression: '#accountId = :accountId',
      ExpressionAttributeNames: { '#accountId': 'accountId' },
      ExpressionAttributeValues: { ':accountId': 'a1' },
      Select: 'COUNT',
      Limit: 1,
    })));
  });
  it.each(['ACTIVE', 'CANCELLED', 'EXPIRED'])('preserves a lead with a real %s policy', async status => {
    h.records.set('Policy:real', { id: 'real', accountId: 'a1', status });
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow('An account with policies cannot be deleted as a lead');
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it.each(['Policy', 'Invoice'])('follows empty %s index pages before deciding that no records exist', async model => {
    const cursor = { id: 'continuation', accountId: 'a1' };
    let reads = 0;
    h.deletionQuery.mockImplementation((input: any) => input.TableName === model
      ? reads++ === 0 ? { Count: 0, LastEvaluatedKey: cursor } : { Count: 0, LastEvaluatedKey: {} }
      : undefined);
    await (await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin');
    expect(record('deleted-account:a1')).toBeDefined();
    const queries = h.queries.filter(query => query.TableName === model);
    expect(queries).toHaveLength(2);
    expect(queries[0].ExclusiveStartKey).toBeUndefined();
    expect(queries[1].ExclusiveStartKey).toEqual(cursor);
  });
  it.each(['Policy', 'Invoice'])('preserves a lead when a later %s index page contains a matching record', async model => {
    let reads = 0;
    h.deletionQuery.mockImplementation((input: any) => input.TableName === model
      ? reads++ === 0 ? { Count: 0, LastEvaluatedKey: { id: 'continuation', accountId: 'a1' } } : { Count: 1 }
      : undefined);
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow(/cannot be deleted/);
    expect(h.queries.filter(query => query.TableName === model)).toHaveLength(2);
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it.each(['Policy', 'Invoice'])('blocks deletion when the %s index cannot be read', async model => {
    h.deletionQuery.mockImplementation((input: any) => {
      if (input.TableName === model) throw new Error('Access denied');
    });
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow(new RegExp(`Could not verify this lead.s ${model === 'Policy' ? 'policies' : 'billing records'}`));
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it.each(['LEAD_DELETION_POLICY_TABLE', 'LEAD_DELETION_POLICY_INDEX', 'LEAD_DELETION_INVOICE_TABLE', 'LEAD_DELETION_INVOICE_INDEX'])('blocks deletion if %s is not configured', async setting => {
    delete process.env[setting];
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow(/Could not verify this lead.s/);
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it.each([undefined, null, '0', -1, 0.5, Number.NaN])('blocks deletion for an invalid policy count %s', async Count => {
    h.deletionQuery.mockResolvedValueOnce({ Count });
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow(/Could not verify this lead.s policies/);
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it.each(['Policy', 'Invoice'])('blocks deletion when a %s index continuation repeats', async model => {
    h.deletionQuery.mockImplementation((input: any) => input.TableName === model
      ? { Count: 0, LastEvaluatedKey: { id: 'repeated', accountId: 'a1' } }
      : undefined);
    await expect((await import('../../amplify/functions/communications/deletion')).prepareLeadDeletion('a1', 'Willow HOA', 'admin')).rejects.toThrow(new RegExp(`Could not verify this lead.s ${model === 'Policy' ? 'policies' : 'billing records'}`));
    expect(h.queries.filter(query => query.TableName === model)).toHaveLength(2);
    expect(record('deleted-account:a1')).toBeUndefined();
  });
  it('fences a deletion that occurs during send preparation', async () => {
    await lead();
    const queued = await enqueueOperation('op:delete:race', { type: 'COMMENT', accountId: 'a1', conversationId: 'cnv_a', text: 'Should not send' });
    vi.mocked(permittedConversation).mockImplementationOnce(async id => { await save(row('DELETED_ACCOUNT', 'deleted-account:a1', { accountId: 'a1' })); return { id, status: 'open' } as never; });
    await runOperation(queued); expect(h.front).not.toHaveBeenCalled();
    await runOperation(queued); expect(record(queued.id).data.state).toBe('SUPPRESSED');
  });
  it('preserves delivery uncertainty when an account is deleted outside the normal flow', async () => {
    await lead(); await save(row('OPERATION', 'op:uncertain', { accountId: 'a1', type: 'EMAIL', state: 'UNKNOWN', attempts: 1 }, { accountId: 'a1' }));
    const { retireAccount, retireAccountPage } = await import('../../amplify/functions/communications/deletion');
    await retireAccount('a1', 'system');
    await retireAccountPage(record('account-delete:a1') as never);
    expect(record('op:uncertain').data.state).toBe('UNKNOWN');
  });
});
describe("existing lead assignment migration", () => {
  it("reaches later batches using the complete opaque AppSync continuation token", async () => {
    const token = "opaque-AppSync-cursor/+=_".repeat(80);
    h.accountList.mockImplementation(async ({ nextToken }) => !nextToken
      ? { data: [], nextToken: token }
      : nextToken === token ? { data: [{ id: "a1", name: "Willow HOA" }] }
        : { data: [], errors: [{ message: "Invalid pagination token" }] });
    const { handler } = await import("../../amplify/functions/communications/handler");
    const request = (nextToken?: string) => handler({ arguments: { operation: "backfill", input: { nextToken } }, identity: { sub: "admin", groups: ["ADMIN"] } as never });
    expect(await request()).toMatchObject({ ok: true, nextToken: token });
    expect(await request(token)).toMatchObject({ ok: true, exceptions: 0, nextToken: undefined });
    expect(record("workflow:a1").data).toMatchObject({ salespersonId: "brian" });
    expect(entries("OPERATION")).toHaveLength(0);
  });

  it.each([123, "x".repeat(16_385)])("rejects invalid migration cursors before querying accounts", async nextToken => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    expect(await handler({ arguments: { operation: "backfill", input: { nextToken } }, identity: { sub: "admin", groups: ["ADMIN"] } as never })).toMatchObject({ ok: false, error: "Invalid pagination token. Refresh and try again." });
    expect(h.accountList).not.toHaveBeenCalled();
  });
});
describe("caught-up tracking confirmation", () => {
  it.each(["healthy", "paused", "missing monitor", "monitor failure", "stale worker", "invalid worker time", "stale census", "sync gap"])("reports %s accurately in the account context", async state => {
    await lead();
    await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    await save(row("HEALTH", "health:monitor", { at: NOW, errors: [] }));
    await save(row("HEALTH", "coverage:census", { completedAt: NOW }));
    if (state === "paused") h.c.paused = true;
    if (state === "missing monitor") h.records.delete("comms:health:monitor");
    if (state === "monitor failure") record("health:monitor").data.errors = ["Routing needs attention"];
    if (state === "stale worker") record("health:worker").data.at = "2026-09-08T13:00:00.000Z";
    if (state === "invalid worker time") record("health:worker").data.at = "invalid";
    if (state === "stale census") record("coverage:census").data.completedAt = "2026-09-06T14:00:00.000Z";
    if (state === "sync gap") await save(row("ISSUE", "issue:sync-gap", { resolved: false }));
    const { handler } = await import("../../amplify/functions/communications/handler");
    expect(await handler({ arguments: { readOperation: "context", input: { accountId: "a1" } }, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: true, trackingHealthy: state === "healthy" || state === "stale census" });
  });
});
describe("cleanup and combined requests", () => {
  it("keeps a conversation open while its last Front message is still a draft", async () => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    const sent = await inbound("sent", NOW, { direction: "OUTBOUND" }); await recordOutbound(sent);
    expect(await archiveAllowed("a1", "cnv_a")).toBe(true);
    vi.mocked(permittedConversation).mockResolvedValueOnce({ id: "cnv_a", status: "open", last_message: { id: "msg_draft", is_draft: true, is_inbound: false, created_at: Date.parse(NOW) / 1000 } });
    expect(await archiveAllowed("a1", "cnv_a")).toBe(false);
  });
  it("archives without a task requirement but still blocks uncertain sends", async () => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(true);
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
  it.each(["paused", "not activated", "unanswered request", "sync gap", "missing owner"])("still holds cleanup for %s", async condition => {
    const wf = await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    await recordOutbound(await inbound("out", NOW, { direction: "OUTBOUND" }));
    if (condition === "paused") h.c.paused = true;
    if (condition === "not activated") h.c.activatedAt = undefined;
    if (condition === "unanswered request") await recordInbound(await inbound("reply", "2026-09-08T14:01:00Z"));
    if (condition === "sync gap") await save(row("ISSUE", "issue:sync-gap", { resolved: false }));
    if (condition === "missing owner") await save(row("WORKFLOW", wf.id, { ...wf.data, salespersonId: undefined }, { accountId: "a1", previous: wf }), wf);
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
  it("atomically queues one carrier estimate and replays its receipt across concurrent retries", async () => {
    vi.stubEnv("HONEYCOMB_ENABLED", "true"); vi.stubEnv("HONEYCOMB_ESTIMATE_TABLE", "HoneycombEstimate");
    try {
      const property = { type: "ASSOCIATION", propertyKind: "condominium", address: "1 Main St", city: "Juneau", state: "AK", grossSquareFeet: "10000", replacementValue: "2500000" };
      const [a, b] = await Promise.all([submit(property), submit(property)]) as any[];
      expect(a.ok).toBe(true); expect(a.estimateToken).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(b.estimateToken).toBe(a.estimateToken);
      const estimates = [...h.records.entries()].filter(([key]) => key.startsWith("HoneycombEstimate:"));
      expect(estimates).toHaveLength(1); expect(estimates[0][1]).toMatchObject({ accountId: a.id, status: "PENDING" });
      expect(JSON.parse(estimates[0][1].input).address).toContain("AK");
      const writes = h.transactions.find(items => items.some(w => w.Put?.TableName === "HoneycombEstimate"))!;
      expect(writes.some(w => w.Put?.TableName === "Account")).toBe(true);
      expect(await submit({ ...property, retryProof: "z".repeat(64) })).toMatchObject({ ok: false });
    } finally { vi.unstubAllEnvs(); }
  });
  it("preserves leads without inventing missing carrier inputs, and disables estimates outside staging", async () => {
    vi.stubEnv("HONEYCOMB_ESTIMATE_TABLE", "HoneycombEstimate"); vi.stubEnv("HONEYCOMB_ENABLED", "true");
    try {
      const captured = await submit() as any;
      expect(captured.ok).toBe(true); expect(captured.estimateToken).toBeUndefined();
      expect([...h.records.values()].some(r => r.__typename === "HoneycombEstimate" && r.status === "NEEDS_DETAILS")).toBe(true);
      vi.stubEnv("HONEYCOMB_ENABLED", "false");
      await submit({ submissionId: "another-submission-12345678901234567890" });
      expect([...h.records.values()].filter(r => r.__typename === "HoneycombEstimate")).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it("captures one lead, intake and AI reply across concurrent browser retries", async () => {
    const [a,b] = await Promise.all([submit(), submit()]); expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true }); expect((a as any).id).toBe((b as any).id);
    expect([...h.records.keys()].filter(k => k.startsWith("Account:"))).toHaveLength(1); expect(entries("OPERATION").filter(o => o.data.type === "IMPORT")).toHaveLength(1); expect(entries("WORKFLOW")[0].data).toMatchObject({ assignmentIssue: "Website lead assignment is pending." });
    expect(entries("WEB_LEAD_ASSIGNMENT")).toHaveLength(1);
    await runWebLeadAssignment(entries("WEB_LEAD_ASSIGNMENT")[0] as never);
    expect(entries("WORKFLOW")[0].data).toMatchObject({ salespersonId: "brian" });
    expect(h.front).not.toHaveBeenCalled();
  });
  it("does not return a bearer upload token to a guessed identity or changed payload", async () => {
    await submit(); expect(await submit({ retryProof: "q".repeat(64) })).toMatchObject({ ok: false }); expect(await submit({ name: "Different HOA" })).toMatchObject({ ok: false });
  });
  it("does not claim success or leave partial lead records when storage fails", async () => {
    h.fail = true; expect(await submit()).toMatchObject({ ok: false }); expect(entries("SUBMISSION")).toHaveLength(0); expect([...h.records.keys()].filter(k => k.startsWith("Account:"))).toHaveLength(0);
  });
});
describe("website producer rotation", () => {
  const submissionId = (index: number) => `rotation-submission-${String(index).padStart(20, "0")}`;
  const submit = (index: number, overrides = {}) => capture({ arguments: { submissionId: submissionId(index), retryProof: "r".repeat(64), name: `Association ${index}`, contactEmail: "prospect@example.com", ...overrides } } as never, {} as never, () => {});
  const assignedTo = (result: any) => {
    expect(result).toMatchObject({ ok: true });
    return record(`workflow:${result.id}`).data.salespersonId;
  };
  const jobFor = (result: any) => record(`web-assignment:${result.id}`);
  async function runJob(result: any) {
    const job = jobFor(result);
    if (job.dueAt && Date.parse(job.dueAt) > Date.now()) vi.setSystemTime(job.dueAt);
    await runWebLeadAssignment(job as never);
  }
  async function completeJob(result: any) {
    let attempts = 0;
    while (jobFor(result).dueAt && attempts++ < 10) await runJob(result);
    expect(jobFor(result).data.state).toBe("COMPLETE");
  }
  async function assign(index: number) { const result = await submit(index); await completeJob(result); return result; }
  async function roster(users: { userId: string; enabled?: boolean; salesperson?: boolean }[]) {
    for (const [key, value] of h.records) if (value.kind === "ELIGIBILITY") h.records.delete(key);
    for (const user of users) await save(row("ELIGIBILITY", `eligibility:${user.userId}`, { name: user.userId, email: `${user.userId}@example.com`, salesperson: true, enabled: true, ...user }));
  }
  it("durably captures the unassigned lead and delivery jobs before a separate atomic producer assignment", async () => {
    await roster([{ userId: "charlie" }, { userId: "alice" }, { userId: "bravo" }]);
    h.c.defaultSalespersonId = "charlie";
    const results = [];
    for (let i = 0; i < 4; i++) {
      const result = await submit(i) as any;
      expect(assignedTo(result)).toBeUndefined();
      expect(record(`workflow:${result.id}`).data.assignmentIssue).toBe("Website lead assignment is pending.");
      const captureWrites = h.transactions.find(items => items.some(write => write.Put?.TableName === "Account" && write.Put.Item.id === result.id))!;
      expect(captureWrites.some(write => write.Put?.Item.id === "rotation:web-leads")).toBe(false);
      expect(captureWrites.some(write => write.Put?.Item.id === `workflow:${result.id}`)).toBe(true);
      expect(captureWrites.some(write => write.Put?.Item.id === `web-assignment:${result.id}`)).toBe(true);
      expect(captureWrites.filter(write => write.Put?.Item.kind === "OPERATION").map(write => write.Put.Item.data.type).sort()).toEqual(["IMPORT", "SMS_ALERT"]);
      await completeJob(result); results.push(result);
      const assignmentWrites = h.transactions.find(items => items.some(write => write.Put?.Item.id === `web-assignment:${result.id}` && write.Put.Item.data.state === "COMPLETE"))!;
      expect(assignmentWrites.some(write => write.Put?.Item.id === "rotation:web-leads")).toBe(true);
      expect(assignmentWrites.some(write => write.ConditionCheck?.Key.id === `eligibility:${assignedTo(result)}`)).toBe(true);
      expect(assignmentWrites.some(write => write.Put?.Item.id === `workflow:${result.id}`)).toBe(true);
      expect(record(`workflow:${result.id}`).data.assignmentIssue).toBeUndefined();
      expect(jobFor(result).dueAt).toBeUndefined();
    }
    expect(results.map(assignedTo)).toEqual(["alice", "bravo", "charlie", "alice"]);
    expect(record("rotation:web-leads")).toMatchObject({ version: 4, data: { lastUserId: "alice" } });
    expect(h.front).not.toHaveBeenCalled(); expect(h.dialpad).not.toHaveBeenCalled();
  });
  it("assigns captured leads through the scheduled worker while provider delivery is paused", async () => {
    h.c.paused = true;
    const result = await submit(0) as any;
    const { handler: tick } = await import("../../amplify/functions/communications/worker");
    expect(await tick()).toMatchObject({ failed: 0 });
    expect(assignedTo(result)).toBe("brian"); expect(jobFor(result).data.state).toBe("COMPLETE");
    expect(jobFor(result).dueAt).toBeUndefined(); expect(entries("TASK")).toHaveLength(0);
    expect(h.front).not.toHaveBeenCalled(); expect(h.dialpad).not.toHaveBeenCalled();
  });
  it("keeps the scheduled assignment retryable after twelve failures even if the queue record read fails", async () => {
    h.c.paused = true;
    const result = await submit(0) as any, job = (await get<any>(jobFor(result).id))!;
    await save(row("WEB_LEAD_ASSIGNMENT", job.id, { ...job.data, attempts: 12 }, { accountId: result.id, previous: job, dueAt: NOW }), job);
    h.readFailureId = job.id;
    const { handler: tick } = await import("../../amplify/functions/communications/worker");
    expect(await tick()).toMatchObject({ failed: 1 });
    expect(jobFor(result)).toMatchObject({ data: { state: "READY", attempts: 13 }, dueAt: expect.any(String) });
    expect(assignedTo(result)).toBeUndefined(); expect(record("rotation:web-leads")).toBeUndefined();
    vi.setSystemTime(jobFor(result).dueAt);
    await tick();
    expect(assignedTo(result)).toBe("brian"); expect(jobFor(result).data.state).toBe("COMPLETE");
  });
  it("excludes disabled accounts and teammates who are not eligible producers", async () => {
    await roster([{ userId: "alice", enabled: false }, { userId: "bravo" }, { userId: "charlie", salesperson: false }, { userId: "delta" }, { userId: "echo" }]);
    h.disabledUsers.add("bravo");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await assign(i));
    expect(results.map(assignedTo)).toEqual(["delta", "echo", "delta", "echo"]);
    expect(h.userReads).not.toContain("alice"); expect(h.userReads).not.toContain("charlie");
  });
  it("retries an unavailable roster until a producer recovers without another website submission", async () => {
    await roster([{ userId: "alice" }]);
    expect(assignedTo(await assign(0))).toBe("alice");
    const cursor = structuredClone(record("rotation:web-leads"));
    h.disabledUsers.add("alice");
    const result = await submit(1) as any;
    for (let attempt = 0; attempt < 12; attempt++) await runJob(result);
    expect(assignedTo(result)).toBeUndefined();
    expect(record(`workflow:${result.id}`).data.assignmentIssue).toEqual(expect.any(String));
    expect(entries("ISSUE").some(issue => issue.accountId === result.id && !issue.data.resolved)).toBe(true);
    expect(jobFor(result)).toMatchObject({ data: { state: "READY" }, dueAt: expect.any(String) });
    expect(record("rotation:web-leads")).toEqual(cursor);
    h.disabledUsers.delete("alice");
    for (let attempt = 0; jobFor(result).dueAt && attempt < 4; attempt++) await runJob(result);
    expect(assignedTo(result)).toBe("alice");
    expect(jobFor(result)).toMatchObject({ data: { state: "COMPLETE" } });
    expect(record(`workflow:${result.id}`).data.assignmentIssue).toBeUndefined();
    expect(entries("SUBMISSION")).toHaveLength(2);
  });
  it("accepts 24 simultaneous distinct leads before any roster lookup or cursor update, then assigns fairly", async () => {
    await roster([{ userId: "alice" }, { userId: "bravo" }, { userId: "charlie" }]);
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => submit(index)));
    expect(results.every(result => (result as any).ok)).toBe(true);
    expect(new Set((results as { id: string }[]).map(result => result.id)).size).toBe(24);
    expect(entries("SUBMISSION")).toHaveLength(24); expect(entries("WEB_LEAD_ASSIGNMENT")).toHaveLength(24);
    expect(record("rotation:web-leads")).toBeUndefined(); expect(h.userReads).toEqual([]); expect(h.queries).toEqual([]);
    expect(results.map(assignedTo)).toEqual(Array(24).fill(undefined));
    for (const result of results) await completeJob(result);
    expect(results.map(assignedTo)).toEqual(Array.from({ length: 24 }, (_, index) => ["alice", "bravo", "charlie"][index % 3]));
    expect(record("rotation:web-leads").version).toBe(24);
    expect(h.maxInFlight).toBeGreaterThan(1);
  });
  it("keeps assignment contention in the durable queue and eventually balances concurrent workers", async () => {
    await roster([{ userId: "alice" }, { userId: "bravo" }, { userId: "charlie" }]);
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => submit(index)));
    let passes = 0;
    while (results.some(result => jobFor(result).dueAt) && passes++ < 50) {
      await Promise.all(results.filter(result => jobFor(result).dueAt).map(runJob));
    }
    expect(passes).toBeLessThan(50);
    expect(results.map(assignedTo).sort()).toEqual([...Array(8).fill("alice"), ...Array(8).fill("bravo"), ...Array(8).fill("charlie")]);
    expect(record("rotation:web-leads").version).toBe(24);
    expect(entries("SUBMISSION")).toHaveLength(24);
    expect(entries("WEB_LEAD_ASSIGNMENT").every(job => job.data.state === "COMPLETE" && !job.dueAt)).toBe(true);
  });
  it.each(["directory", "producer index"])("captures successfully through a transient %s failure and assigns after recovery", async failure => {
    await roster([{ userId: "alice" }]);
    const unavailable = Object.assign(new Error("Temporary service outage"), { name: "ServiceUnavailable" });
    if (failure === "directory") h.userError = unavailable; else h.queryError = unavailable;
    const result = await submit(0) as any;
    expect(result.ok).toBe(true); expect(h.userReads).toEqual([]); expect(h.queries).toEqual([]);
    await runJob(result);
    expect(assignedTo(result)).toBeUndefined(); expect(record("rotation:web-leads")).toBeUndefined();
    expect(jobFor(result)).toMatchObject({ data: { state: "READY" }, dueAt: expect.any(String) });
    h.userError = undefined; h.queryError = undefined;
    await runJob(result);
    expect(assignedTo(result)).toBe("alice"); expect(jobFor(result).data.state).toBe("COMPLETE");
    expect(entries("SUBMISSION")).toHaveLength(1);
  });
  it("keeps retrying after more than twelve transient failures without asking the prospect to submit again", async () => {
    const result = await submit(0) as any;
    h.userError = Object.assign(new Error("Directory temporarily unavailable"), { name: "ServiceUnavailable" });
    for (let attempt = 0; attempt < 14; attempt++) await runJob(result);
    expect(jobFor(result)).toMatchObject({ data: { state: "READY", attempts: 14 }, dueAt: expect.any(String) });
    expect(assignedTo(result)).toBeUndefined(); expect(record("rotation:web-leads")).toBeUndefined();
    h.userError = undefined;
    await completeJob(result);
    expect(assignedTo(result)).toBe("brian"); expect(entries("SUBMISSION")).toHaveLength(1);
    expect(record(`issue:web-assignment:${result.id}`).data.resolved).toBe(true);
  });
  it("preserves an unrelated invalid-email issue after assignment recovers", async () => {
    const result = await submit(0, { contactEmail: "not-an-email" }) as any;
    h.userError = new Error("Directory temporarily unavailable");
    await runJob(result);
    h.userError = undefined;
    await completeJob(result);
    expect(assignedTo(result)).toBe("brian");
    expect(record(`issue:intake:${result.id}`).data).toMatchObject({ message: "Correct the prospect email before sending" });
    expect(record(`issue:intake:${result.id}`).data.resolved).not.toBe(true);
    expect(record(`issue:web-assignment:${result.id}`).data.resolved).toBe(true);
  });
  it("waits durably for the producer index migration and resumes the captured lead once ready", async () => {
    h.records.delete("comms:migration:website-producers:v1");
    const result = await submit(0) as any;
    await runJob(result);
    expect(assignedTo(result)).toBeUndefined(); expect(jobFor(result).dueAt).toBeTruthy();
    expect(h.userReads).toEqual([]); expect(h.queries).toEqual([]);
    h.records.set("comms:migration:website-producers:v1", row("MIGRATION", "migration:website-producers:v1", { complete: true }));
    await runJob(result);
    expect(assignedTo(result)).toBe("brian"); expect(entries("SUBMISSION")).toHaveLength(1);
  });
  it.each(["TransactionConflictException", "TransactionCanceledException", "ConditionalCheckFailedException"])("retries queued assignment after %s without a partial assignment or lost producer turn", async name => {
    await roster([{ userId: "alice" }, { userId: "bravo" }]);
    expect(assignedTo(await assign(0))).toBe("alice");
    const cursor = structuredClone(record("rotation:web-leads"));
    const result = await submit(1) as any;
    h.writeError = Object.assign(new Error("Another transaction is in progress"), { name,
      ...(name === "TransactionCanceledException" ? { CancellationReasons: [{ Code: "TransactionConflict" }] } : {}),
    });
    await runJob(result);
    expect(assignedTo(result)).toBeUndefined(); expect(record("rotation:web-leads")).toEqual(cursor);
    expect(jobFor(result)).toMatchObject({ data: { state: "READY" }, dueAt: expect.any(String) });
    expect(entries("SUBMISSION")).toHaveLength(2); expect(entries("OPERATION")).toHaveLength(4);
    await runJob(result);
    expect(assignedTo(result)).toBe("bravo"); expect(record("rotation:web-leads").version).toBe(2);
  });
  it("consumes one turn for concurrent browser retries and none for receipt or completed job replay", async () => {
    await roster([{ userId: "alice" }, { userId: "bravo" }]);
    const results = await Promise.all([submit(0), submit(0), submit(0)]) as any[];
    expect(new Set(results.map(result => result.id)).size).toBe(1); expect(entries("WEB_LEAD_ASSIGNMENT")).toHaveLength(1);
    await Promise.all(results.map(runJob));
    expect(results.map(assignedTo)).toEqual(["alice", "alice", "alice"]);
    expect(record("rotation:web-leads").version).toBe(1);
    expect(await submit(0)).toMatchObject({ ok: true, duplicate: true, id: results[0].id });
    await runJob(results[0]); expect(record("rotation:web-leads").version).toBe(1);
    expect(assignedTo(await assign(1))).toBe("bravo");
  });
  it("does not consume a turn or create an assignment job when durable capture fails", async () => {
    await roster([{ userId: "alice" }, { userId: "bravo" }]);
    expect(assignedTo(await assign(0))).toBe("alice");
    const cursor = structuredClone(record("rotation:web-leads"));
    h.fail = true;
    expect(await submit(1)).toMatchObject({ ok: false });
    expect(record("rotation:web-leads")).toEqual(cursor); expect(entries("SUBMISSION")).toHaveLength(1);
    expect([...h.records.keys()].filter(key => key.startsWith("Account:"))).toHaveLength(1);
    expect(entries("WEB_LEAD_ASSIGNMENT")).toHaveLength(1);
    h.fail = false;
    expect(assignedTo(await assign(1))).toBe("bravo"); expect(record("rotation:web-leads").version).toBe(2);
  });
  it("continues with the next producer when the previously selected producer leaves the roster", async () => {
    await roster([{ userId: "alice" }, { userId: "bravo" }, { userId: "charlie" }]);
    expect(assignedTo(await assign(0))).toBe("alice"); expect(assignedTo(await assign(1))).toBe("bravo");
    h.records.delete("comms:eligibility:bravo");
    expect(assignedTo(await assign(2))).toBe("charlie"); expect(assignedTo(await assign(3))).toBe("alice");
  });
  it("bounds each worker pass while reaching an active producer beyond the first directory page", async () => {
    const unavailable = Array.from({ length: 19 }, (_, index) => ({ userId: `producer-${String(index).padStart(3, "0")}` }));
    await roster([...unavailable, { userId: "zeta" }]);
    for (const user of unavailable) h.disabledUsers.add(user.userId);
    const result = await submit(0) as any;
    let passes = 0;
    while (jobFor(result).dueAt && passes++ < 6) {
      const readsBefore = h.userReads.length, queriesBefore = h.queries.length;
      await runJob(result);
      expect(h.userReads.length - readsBefore).toBeLessThanOrEqual(8);
      expect(h.queries.length - queriesBefore).toBeLessThanOrEqual(1);
    }
    expect(passes).toBe(3); expect(assignedTo(result)).toBe("zeta");
    expect(h.queries.every(query => query.IndexName === "website-producers" && query.Limit === 8)).toBe(true);
    expect(h.batch).toHaveBeenCalledTimes(3);
  });
  it("restarts a partial roster page after another worker advances the rotation", async () => {
    const disabled = Array.from({ length: 9 }, (_, index) => ({ userId: `producer-${index}` }));
    await roster([...disabled, { userId: "yankee" }, { userId: "zeta" }]);
    for (const user of disabled) h.disabledUsers.add(user.userId);
    const result = await submit(0) as any;
    await runJob(result);
    expect(jobFor(result).data.nextToken).toEqual(expect.any(String)); expect(assignedTo(result)).toBeUndefined();
    await save(row("CURSOR", "rotation:web-leads", { lastUserId: "yankee" }));
    await runJob(result);
    expect(assignedTo(result)).toBe("zeta");
    expect(h.queries.at(-1)).toMatchObject({ ExpressionAttributeValues: { ":after": "eligibility:yankee" } });
    expect(h.queries.at(-1).ExclusiveStartKey).toBeUndefined();
  });
  it("keeps a manual assignment and completes its waiting job without advancing the rotation", async () => {
    await roster([{ userId: "alice" }, { userId: "bravo" }]);
    expect(assignedTo(await assign(0))).toBe("alice");
    const cursor = structuredClone(record("rotation:web-leads"));
    const result = await submit(1) as any;
    const old = record(`workflow:${result.id}`) as Row<LeadWorkflow>;
    await save(row("WORKFLOW", old.id, { ...old.data, salespersonId: "alice", assignmentIssue: undefined, version: old.version + 1 }, { accountId: result.id, previous: old }), old);
    await runJob(result);
    expect(assignedTo(result)).toBe("alice"); expect(jobFor(result).data.state).toBe("COMPLETE");
    expect(record("rotation:web-leads")).toEqual(cursor); expect(assignedTo(await assign(2))).toBe("bravo");
  });
  it.each(["manual assignment", "deletion"])("fences %s between producer selection and assignment commit", async change => {
    await roster([{ userId: "alice" }, { userId: "bravo" }]);
    expect(assignedTo(await assign(0))).toBe("alice");
    const cursor = structuredClone(record("rotation:web-leads")), result = await submit(1) as any;
    h.batch.mockImplementationOnce((p: { RequestItems: Record<string, { Keys: { id: string }[] }> }) => {
      if (change === "deletion") h.records.set(`comms:deleted-account:${result.id}`, row("DELETED_ACCOUNT", `deleted-account:${result.id}`, { accountId: result.id }));
      else {
        const old = record(`workflow:${result.id}`) as Row<LeadWorkflow>;
        h.records.set(`comms:${old.id}`, row("WORKFLOW", old.id, { ...old.data, salespersonId: "alice", assignmentIssue: undefined, version: old.version + 1 }, { accountId: result.id, previous: old }));
      }
      return { Responses: Object.fromEntries(Object.entries(p.RequestItems).map(([name, request]) => [name,
        request.Keys.map(key => h.records.get(`${name}:${key.id}`)).filter(Boolean).map(item => structuredClone(item)),
      ])) };
    });
    await runJob(result);
    expect(record("rotation:web-leads")).toEqual(cursor);
    expect(assignedTo(result)).toBe(change === "deletion" ? undefined : "alice");
    await runJob(result);
    expect(jobFor(result).data.state).toBe(change === "deletion" ? "SUPPRESSED" : "COMPLETE");
    expect(record("rotation:web-leads")).toEqual(cursor);
  });
  it("preserves a closed lead's disposition while completing its pending producer assignment", async () => {
    const result = await submit(0) as any, old = record(`workflow:${result.id}`) as Row<LeadWorkflow>;
    await save(row("WORKFLOW", old.id, { ...old.data, disposition: "LOST", version: old.version + 1 }, { accountId: result.id, previous: old }), old);
    await completeJob(result);
    expect(record(`workflow:${result.id}`).data).toMatchObject({ disposition: "LOST", salespersonId: "brian" });
  });
  it("suppresses assignment for a deleted lead without taking a producer's turn", async () => {
    const result = await submit(0) as any;
    await save(row("DELETED_ACCOUNT", `deleted-account:${result.id}`, { accountId: result.id }));
    await runJob(result);
    expect(assignedTo(result)).toBeUndefined(); expect(jobFor(result).data.state).toBe("SUPPRESSED");
    expect(jobFor(result).dueAt).toBeUndefined(); expect(record("rotation:web-leads")).toBeUndefined();
    expect(h.userReads).toEqual([]);
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
    expect(entries("TASK")).toHaveLength(0);
  });
  it("recognizes a verified import when its UID index write was interrupted", async () => {
    await lead();
    await save(row("OPERATION", "op:intake:s1", { type: "IMPORT", uid: "uid_intake" }, { accountId: "a1" }));
    await ingestFrontMessage({ id: "msg_intake", message_uid: "uid_intake", is_inbound: true, created_at: Date.parse(NOW) / 1000, text: "<pre>Website submission\nReference: hoa:main:s1\nDetails</pre>" }, "cnv_a");
    expect(entries("COMMUNICATION")).toHaveLength(0);
  });
  it("still captures a real reply quoting the intake reference", async () => {
    await lead();
    await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
    await save(row("OPERATION", "op:intake:s1", { type: "IMPORT", uid: "uid_intake" }, { accountId: "a1" }));
    await ingestFrontMessage({ id: "msg_reply", message_uid: "uid_reply", is_inbound: true, created_at: Date.parse(NOW) / 1000, text: "Website submission\nReference: hoa:main:s1\nPlease call me." }, "cnv_a");
    expect(entries("COMMUNICATION").some(c => c.data.direction === "INBOUND")).toBe(true); expect(entries("TASK")).toHaveLength(0);
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
      if (!matches) expect(entries("COMMUNICATION").some(c => c.data.direction === "INBOUND")).toBe(true); expect(entries("TASK")).toHaveLength(0);
    } finally { vi.unstubAllEnvs(); }
  });
  it("clears only the recovered delivery warning when Front confirms an accepted email", async () => {
    await lead();
    const op = await save(row<Operation>("OPERATION", "op:recovered", { type: "EMAIL", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_recovered", recipient: "prospect@example.com", error: "Waiting for the Front intake conversation", failures: 3 }, { accountId: "a1" }));
    await save(row("ISSUE", `issue:${op.id}`, { resolved: false, message: op.data.error }, { accountId: "a1" }));
    await save(row("ISSUE", "issue:sync-gap", { resolved: false, message: "Review missed SMS" }));
    h.front.mockResolvedValueOnce({ id: "msg_recovered", is_inbound: false, is_draft: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_a" } });
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
    h.front.mockImplementation(async (path: string, method?: string) => method === "POST" ? { message_uid: "uid_1" } : path.startsWith("/messages/alt") ? { id: "msg_1", message_uid: "uid_1", is_inbound: false, is_draft: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_a" } } : { _results: [] });
    await runOperation(op); expect(record(op.id).data.state).toBe("ACCEPTED"); expect(h.update).not.toHaveBeenCalled(); expect(entries("TASK")).toHaveLength(0);
    await runOperation((await get<Operation>(op.id))!); expect(record(op.id).data.state).toBe("CONFIRMED"); expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ status: "SENT" })); expect(entries("TASK")).toHaveLength(0);
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
    h.front.mockResolvedValue({ id: "msg_merged", is_inbound: false, is_draft: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_b" } });
    vi.mocked(permittedConversation).mockResolvedValueOnce({ id: "cnv_b", status: "open" }).mockResolvedValueOnce({ id: "cnv_b", status: "open" });
    await runOperation(op);
    expect(record(op.id).data.state).toBe("CONFIRMED"); expect(record("workflow:a1").data.conversationId).toBe("cnv_b");
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ status: "SENT" })); expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
  it("does not reconcile an accepted email into an unrelated conversation", async () => {
    await lead();
    const op = await save(row<Operation>("OPERATION", "op:unrelated", { type: "EMAIL", accountId: "a1", state: "ACCEPTED", attempts: 1, uid: "uid_wrong", recipient: "prospect@example.com" }, { accountId: "a1" }));
    h.front.mockResolvedValue({ id: "msg_wrong", is_inbound: false, is_draft: false, created_at: Date.parse(NOW) / 1000, conversation: { id: "cnv_b" } });
    await runOperation(op); expect(record(op.id).data.state).not.toBe("CONFIRMED"); expect(h.update).not.toHaveBeenCalled(); expect(entries("TASK")).toHaveLength(0);
  });
  it("rate-limits a requested Seen refresh, checks an older email once, and preserves its commitment", async () => {
    await lead(); await recordInbound(await inbound());
    const comm = await inbound("old", "2026-08-01T14:00:00Z", { direction: "OUTBOUND", status: "SENT" });
    const { handler } = await import("../../amplify/functions/communications/handler");
    const refresh = () => handler({ arguments: { operation: "refreshSeen", input: { id: comm.id } }, identity: { sub: "brian", groups: [] } as never });
    expect(await refresh()).toMatchObject({ ok: true }); const version = record(comm.id).version;
    expect(await refresh()).toMatchObject({ ok: true }); expect(record(comm.id).version).toBe(version);
    h.front.mockResolvedValue({ _results: [{ first_seen_at: String(Date.parse(NOW)) }] });
    const { refreshCommunication } = await import("../../amplify/functions/communications/worker");
    await refreshCommunication((await get<Communication>(comm.id))!);
    expect(record(comm.id).data.seenAt).toBe(NOW); expect(record(comm.id).data.seenRequestedAt).toBeUndefined(); expect(record(comm.id).dueAt).toBeUndefined();
    expect(entries("TASK")).toHaveLength(0); expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
  it("suppresses a queued AI send when a human already replied", async () => {
    await lead(); const op = await enqueueOperation("op:test", { type: "EMAIL", accountId: "a1", recipient: "prospect@example.com" }); h.front.mockResolvedValue({ _results: [{ is_inbound: false, is_draft: false, author: { id: "tea_b" } }] });
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
  it("associates previously captured Front mail without creating a task", async () => {
    await lead(); const { ingestFrontMessage, backfillConversation } = await import("../../amplify/functions/communications/events");
    const message = { id: "msg_before_link", is_inbound: true, type: "email", created_at: Date.parse(NOW) / 1000, text: "Please send a quote", conversation: { id: "cnv_a" } };
    await ingestFrontMessage(message); expect(record("comm:front:msg_before_link").accountId).toBeUndefined();
    await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
    const job = await save(row("CONVERSATION_BACKFILL", "backfill:test", { conversationId: "cnv_a" }, { accountId: "a1", dueAt: NOW }));
    vi.setSystemTime("2026-09-12T14:00:00Z"); h.front.mockResolvedValue({ _results: [message] });
    await backfillConversation(job); await ingestFrontMessage(message);
    expect(record("comm:front:msg_before_link").accountId).toBe("a1"); expect(record("comm:front:msg_before_link").accountSort).toMatch(/^COMMUNICATION#/);
    expect(entries("TASK")).toHaveLength(0); expect(record("comm:front:msg_before_link").data.at).toBe(NOW); expect(record("issue:comm:front:msg_before_link").data.resolved).toBe(true);
  });
  it("does not make an auto-reply into response work", async () => {
    await lead(); await save(row("LINK", "front-link:cnv_a", { accountId: "a1", purpose: "PROSPECT" }, { accountId: "a1" }));
    const { ingestFrontMessage, classifyEmail } = await import("../../amplify/functions/communications/events");
    expect(classifyEmail({ text: "Away", metadata: { auto_submitted: "auto-replied" } })).toBe("AUTOMATIC");
    await ingestFrontMessage({ id: "msg_auto", is_inbound: true, created_at: Date.parse(NOW) / 1000, subject: "Out of office", text: "Away" }, "cnv_a"); expect(entries("TASK")).toHaveLength(0);
  });
  it("saves actual call outcomes and notes without requiring a task", async () => {
    await lead(); const comm = await inbound("callback", NOW, { provider: "dialpad", providerId: "10", channel: "CALL", status: "MISSED" }); await recordInbound(comm, "CALLBACK");
    const { recordCallOutcome } = await import("../../amplify/functions/communications/review");
    await recordCallOutcome({ id: comm.id, version: record(comm.id).version, outcome: "NO_ANSWER", note: "Left voicemail" }, "brian");
    expect(entries("TASK")).toEqual([]); expect(record(comm.id).data.resolved).toBe(false);
    await recordCallOutcome({ id: comm.id, version: record(comm.id).version, outcome: "HANDLED", note: "Spoke with the manager" }, "brian");
    expect(record(comm.id).data.resolved).toBe(true); expect(entries("TASK")).toEqual([]);
    expect([...h.records.keys()].some(k => k.startsWith("Activity:"))).toBe(true);
  });
  it("requires an explicit absence check before retrying an ambiguous send", async () => {
    await lead(); const op = await save(row<Operation>("OPERATION", "op:review", { type: "EMAIL", accountId: "a1", state: "UNKNOWN", attempts: 1 }));
    const { reviewOperation } = await import("../../amplify/functions/communications/review");
    await expect(reviewOperation({ id: op.id, version: op.version, action: "retry", reason: "Retry" }, "admin")).rejects.toThrow("confirm");
    expect(record(op.id).data.state).toBe("UNKNOWN");
    await reviewOperation({ id: op.id, version: op.version, action: "retry", reason: "Verified in Front", verifiedNotSent: true }, "admin"); expect(record(op.id).data.state).toBe("READY");
  });
  it("retains a document-arrival comment while paused or waiting for its Front conversation", async () => {
    const wf = await lead(); await save(row("WORKFLOW", wf.id, { ...wf.data, conversationId: undefined }, { accountId: "a1", previous: wf }), wf);
    const op = await enqueueOperation("op:documents:portal:batch", { type: "COMMENT", accountId: "a1", text: "Documents arrived" });
    h.c.paused = true; await runOperation(op); expect(record(op.id).data.state).toBe("RETRY_WAIT");
    h.c.paused = false; await runOperation((await get<Operation>(op.id))!); expect(record(op.id).data.state).toBe("RETRY_WAIT"); expect(record(op.id).data.text).toBe("Documents arrived"); expect(h.front.mock.calls.some(c => c[1] === "POST")).toBe(false);
  });
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
      await lead(); await prepareJake({ enabled: true, salesperson: true, champion: false });
      expect(await chooseJake()).toMatchObject({ ok: true, config: { defaultUserId: "jake" } });
      h.c = record("config").data;
      expect(await defaultWorkflow("new-lead", "New HOA")).toMatchObject({ salespersonId: "jake", assignmentIssue: undefined });
      expect(record("workflow:a1").data).toMatchObject({ salespersonId: "brian" });
      const { connectionChecks } = await import("../../amplify/functions/communications/setup");
      expect((await connectionChecks()).find(check => check.name === "Default responsibilities")).toMatchObject({ ok: true });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
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
  const initial = { userId: "jake", name: "Jake Greasley", email: profile.email, enabled: true, salesperson: true };
  await save(row("ELIGIBILITY", "eligibility:jake", initial));
  const { handler } = await import("../../amplify/functions/communications/handler");
  const write = (input: Record<string, unknown>) => handler({ arguments: { operation: "saveEligibility", input }, identity: { sub: "admin", groups: ["ADMIN"] } as never });
  const first = await write({ ...initial, version: 1, frontId: "tea_jake", dialpadId: "5655281245659136" });
  expect(first).toMatchObject({ ok: true, member: { ...initial, frontId: "tea_jake", dialpadId: "5655281245659136", version: 2 } });
  const committed = (first as { member: Record<string, unknown> }).member;
  expect(await write({ ...committed, salesperson: false })).toMatchObject({ ok: true, member: { version: 3, salesperson: false, frontId: "tea_jake", dialpadId: "5655281245659136" } });
});


describe("creation-only lead acquisition", () => {
  it("persists a selected property group on manual creation and rejects unknown values", async () => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    const create = (propertyType: unknown, requestId: string) => handler({ arguments: { operation: "createLead", input: { requestId, fields: { name: "Property group test", type: "ASSOCIATION", leadSource: "PHONE", propertyType } } }, identity: { sub: "brian", groups: ["ADMIN"] } as never });
    expect(await create("apartment", "manual-property-bad-123456789")).toMatchObject({ ok: false, error: "Choose a valid property type" });
    const classified = await create("CONDO", "manual-property-good-123456789") as { id: string };
    expect(h.records.get(`Account:${classified.id}`)).toMatchObject({ propertyType: "CONDO" });
    const unknown = await create(undefined, "manual-property-unknown-123456789") as { id: string };
    expect(h.records.get(`Account:${unknown.id}`)?.propertyType).toBeUndefined();
  });
  it.each([
    ["ASSOCIATION", "condominium", "CONDO"],
    ["ASSOCIATION", "other", "HOA_POA_POND_TOWNHOME"],
    ["ASSOCIATION", "unknown", undefined],
    ["PERSONAL", undefined, "INDIVIDUAL_UNIT_OWNER"],
  ])("preserves confirmed website property type %s / %s", async (type, propertyKind, expected) => {
    const result = await capture({ arguments: { name: "Condominium in a name is not evidence", type, propertyKind, unitCount: type === "PERSONAL" ? undefined : "24", source: "website-quote" } } as never, {} as never, () => {}) as { id: string };
    const stored = h.records.get(`Account:${result.id}`)!;
    expect(stored.propertyType).toBe(expected);
    expect(stored.unitCount).toBe(type === "PERSONAL" ? undefined : 24);
  });
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
  it("assigns a salesperson's new lead to its creator instead of the agency default", async () => {
    await save(row("ELIGIBILITY", "eligibility:sally", { userId: "sally", name: "Sally", enabled: true, salesperson: true }));
    const { handler } = await import("../../amplify/functions/communications/handler");
    const result = await handler({ arguments: { operation: "createLead", input: { requestId: "manual-own-lead-123456789", fields: { name: "Sally's lead", leadSource: "PHONE" } } }, identity: { sub: "sally", groups: ["PRODUCER"] } as never }) as { ok: boolean; id: string };
    expect(result.ok).toBe(true);
    expect(record(`workflow:${result.id}`).data.salespersonId).toBe("sally");
  });
  it("assigns a dual-role administrator's new lead to them while using the producer view", async () => {
    await save(row("ELIGIBILITY", "eligibility:sally", { userId: "sally", name: "Sally", enabled: true, salesperson: true }));
    const { handler } = await import("../../amplify/functions/communications/handler");
    const result = await handler({ arguments: { operation: "createLead", input: { requestId: "dual-role-own-lead-123456789", fields: { name: "Sally's lead", leadSource: "PHONE" } } }, identity: { sub: "sally", groups: ["ADMIN", "PRODUCER"] } as never, request: { headers: { "x-crm-role": "PRODUCER" } } }) as { ok: boolean; id: string };
    expect(result.ok).toBe(true);
    expect(record(`workflow:${result.id}`).data.salespersonId).toBe("sally");
  });
  it("requires a dual-role user to select ADMIN before accessing integration settings", async () => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    const identity = { sub: "brian", groups: ["ADMIN", "PRODUCER"] } as never;
    const reads = h.reads.length;
    expect(await handler({ arguments: { readOperation: "settings" }, identity, request: { headers: { "x-crm-role": "PRODUCER" } } })).toMatchObject({ ok: false, error: expect.stringContaining("admin") });
    expect(h.reads).toHaveLength(reads);
    expect(await handler({ arguments: { readOperation: "settings" }, identity, request: { headers: { "x-crm-role": "ADMIN" } } })).toMatchObject({ ok: true });
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

describe("approved sales and carrier revision: integration evidence", () => {
  async function routingSetup() {
    for (const id of ["manager", "marketing", "owner", "champion", "specialist"]) await save(row("ELIGIBILITY", `eligibility:${id}`, { userId: id, name: id, email: `${id}@example.com`, enabled: true, salesperson: false, champion: id === "champion" }));
    const r = (await get("team-routing"))!;
    await save(row("TEAM_ROUTING", r.id, { ownerId: "owner", marketingManagerId: "marketing", reportChannelId: "cha_reports", members: [{ userId: "brian", salesManagerId: "manager" }, { userId: "manager", salesManager: true }, { userId: "marketing", marketingManager: true }] }, { previous: r }), r);
  }
  it("does not turn a partial bind into completed acquisition", async () => {
    await lead(); await recordInbound(await inbound());
    h.records.set("Account:a1", { id: "a1", name: "Willow", stage: "CLIENT", createdAt: NOW, updatedAt: NOW });
    h.records.set("Quote:remaining", { id: "remaining", accountId: "a1", status: "DRAFT", effectiveDate: "2026-10-01", lines: ["Umbrella"] });
    const { syncAccountLifecycle } = await import("../../amplify/functions/communications/workflow"); await syncAccountLifecycle("a1");
    expect(record("workflow:a1").data.openLeadQuoteIds).toEqual(["remaining"]);
    expect(entries("TASK")).toHaveLength(0);
  });
  it("keeps the account salesperson on client correspondence after the final bind", async () => {
    await lead(); await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT", context: "LEAD", routing: "SALESPERSON" }, { accountId: "a1" }));
    await recordInbound(await inbound()); h.records.set("Account:a1", { id: "a1", name: "Willow", stage: "CLIENT", createdAt: NOW, updatedAt: NOW });
    const { syncAccountLifecycle } = await import("../../amplify/functions/communications/workflow"); await syncAccountLifecycle("a1");
    expect(record("front-link:cnv_a").data).toMatchObject({ context: "SERVICE", routing: "SALESPERSON" });
    expect(entries("TASK")).toHaveLength(0);
  });
  it("does not resume historical daily report editions or touch provider delivery", async () => {
    await routingSetup();
    for (const state of ["READY", "LEASED", "ACCEPTED", "UNKNOWN"] as const) {
      const id = `report:main:2026-09-09:${state}`;
      await save(row("REPORT_EDITION", id, { recipientId: "brian", state, uid: "legacy-receipt", leaseUntil: NOW, body: "Historical staff report" }));
    }
    const prior = structuredClone([...h.records.entries()]);
    const writes = h.transactions.length;
    h.reads.length = 0; h.readFailureId = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined;
    const { handler } = await import("../../amplify/functions/communications/reports");
    await expect(handler({ source: "aws.events", detail: { retry: true } })).resolves.toEqual({ retired: true, sent: false });
    await expect(handler()).resolves.toEqual({ retired: true, sent: false });
    expect(h.front).not.toHaveBeenCalled(); expect(h.batch).not.toHaveBeenCalled();
    expect(h.reads).toEqual([]); expect(h.transactions).toHaveLength(writes);
    expect([...h.records.entries()]).toEqual(prior);
  });

});

describe("native Front quote presentation", () => {
  async function prepare() {
    await lead(); await save(row("LINK", "front-link:cnv_a", { accountId: "a1", conversationId: "cnv_a", purpose: "PROSPECT" }, { accountId: "a1" }));
    h.records.set("Quote:q1", { id: "q1", accountId: "a1", carrierId: "c1", status: "QUOTED", premium: 1000, effectiveDate: "2026-10-01", expirationDate: "2027-10-01", lines: ["Property"], createdAt: NOW, updatedAt: NOW });
    h.records.set("Carrier:c1", { id: "c1", name: "Example Carrier" });
    h.front.mockResolvedValue({ _results: [{ id: "msg_original", is_inbound: true, recipients: [{ role: "from", handle: "jane@example.com" }] }] });
    const { prepareBusinessDraft } = await import("../../amplify/functions/communications/businessDelivery");
    return prepareBusinessDraft({ accountId: "a1", conversationId: "cnv_a", kind: "QUOTE", recordId: "q1" }, "brian");
  }
  it("a draft is not presentation; the actual matching sent quote is", async () => {
    const draft = await prepare(); expect(h.records.get("Quote:q1")!.status).toBe("QUOTED");
    expect(h.front.mock.calls.some(([,method]) => method === "POST")).toBe(false);
    await ingestFrontMessage({ id: "msg_draft", is_inbound: false, is_draft: true, created_at: Date.parse(NOW) / 1000, text: draft.body }, "cnv_a");
    expect(h.records.get("Quote:q1")!.status).toBe("QUOTED");
    const comm = await inbound("presented", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", actorId: "tea_brian", to: ["jane@example.com"], text: draft.body.replace(/<[^>]*>/g, "\n") });
    const { applyBusinessDelivery } = await import("../../amplify/functions/communications/businessDelivery");
    await applyBusinessDelivery(comm); await applyBusinessDelivery(comm);
    expect(h.records.get("Quote:q1")).toMatchObject({ status: "PRESENTED", presentedAt: comm.at });
    expect(entries("BUSINESS_DELIVERY")).toHaveLength(1); expect(entries("BUSINESS_DELIVERY")[0].data.state).toBe("SENT");
  });
  it("a copied reference without the quote or on another account cannot claim presentation", async () => {
    await prepare(); const proof = entries("BUSINESS_DELIVERY")[0];
    const { applyBusinessDelivery } = await import("../../amplify/functions/communications/businessDelivery");
    await applyBusinessDelivery(await inbound("copy", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", to: ["jane@example.com"], text: `Thanks. Reference: ${proof.data.reference}` }));
    expect(h.records.get("Quote:q1")!.status).toBe("QUOTED");
    const text = `${proof.data.reference}\n${proof.data.facts.join("\n")}`;
    await applyBusinessDelivery(await inbound("foreign", "2026-09-08T15:00:00Z", { accountId: "a2", direction: "OUTBOUND", to: ["jane@example.com"], text }));
    expect(h.records.get("Quote:q1")!.status).toBe("QUOTED");
  });
  it("does not mark a changed quote presented using an old draft", async () => {
    const draft = await prepare(); h.records.set("Quote:q1", { ...h.records.get("Quote:q1"), premium: 2000, updatedAt: "2026-09-08T14:30:00Z" });
    const { applyBusinessDelivery } = await import("../../amplify/functions/communications/businessDelivery");
    const comm = await inbound("old-quote", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", to: ["jane@example.com"], text: draft.body.replace(/<[^>]*>/g, "\n") });
    await expect(applyBusinessDelivery(comm)).rejects.toThrow("changed");
    expect(h.records.get("Quote:q1")).toMatchObject({ status: "QUOTED", premium: 2000 });
    expect(entries("ISSUE").some(i => String(i.data.message).includes("changed after"))).toBe(true);
  });
});

describe('routing repair and underlying business requirements', () => {
  it('preserves explicit client authorization and policy evidence without creating bind tasks', async () => {
    await lead();
    h.records.set('Quote:q1',{id:'q1',accountId:'a1',carrierId:'c1',status:'PRESENTED',premium:1200,lines:['Property'],effectiveDate:'2026-12-01',expirationDate:'2027-12-01',createdAt:NOW,updatedAt:NOW});
    const { handler } = await import('../../amplify/functions/communications/handler');
    const request = (clientAuthorized:boolean) => handler({arguments:{operation:'authorizeBind',input:{quoteId:'q1',updatedAt:NOW,clientAuthorized}},identity:{sub:'brian',groups:[]} as never});
    expect(await request(false)).toMatchObject({ok:false});
    expect(await request(true)).toMatchObject({ok:true}); expect(await request(true)).toMatchObject({ok:true});
    expect(h.records.get('Quote:q1')).toMatchObject({status:'PRESENTED',bindAuthorizedBy:'brian',bindAuthorizedAt:NOW});
    const { reconcileAccountWork } = await import('../../amplify/functions/communications/coverage');
    const account={id:'a1',name:'Willow HOA',stage:'LEAD',createdAt:NOW,updatedAt:NOW};
    await reconcileAccountWork(account);
    expect(entries("TASK")).toEqual([]);
    await recordOutbound(await inbound('bind-request','2026-09-08T15:00:00.000Z',{purpose:'CARRIER',direction:'OUTBOUND',actorId:'tea_brian',to:['underwriter@example.com']}));
    expect(entries("TASK")).toEqual([]);
    h.records.set('Policy:p1',{id:'p1',accountId:'a1',quoteId:'q1',status:'ACTIVE',lines:['Property'],expirationDate:'2027-12-01',createdAt:NOW});
    await reconcileAccountWork(account);
    expect(h.records.get("Policy:p1")?.quoteId).toBe("q1"); expect(entries("TASK")).toEqual([]);
  });
  it.each([{premium:-1200},{offerExpiresAt:'2026-01-01'},{expirationDate:'2026-11-01'}])('rejects unusable binding terms without recording client authorization: %j', async patch => {
    await lead();
    h.records.set('Quote:q1',{id:'q1',accountId:'a1',carrierId:'c1',status:'PRESENTED',premium:1200,lines:['Property'],effectiveDate:'2026-12-01',expirationDate:'2027-12-01',updatedAt:NOW,...patch});
    const { handler } = await import('../../amplify/functions/communications/handler');
    expect(await handler({arguments:{operation:'authorizeBind',input:{quoteId:'q1',updatedAt:NOW,clientAuthorized:true}},identity:{sub:'brian',groups:[]} as never})).toMatchObject({ok:false});
    expect(h.records.get('Quote:q1')?.bindAuthorizedAt).toBeUndefined();
    expect(entries('LIFECYCLE')).toHaveLength(0);
  });
});

// Pre-migration records deliberately retain the retired role fields.
describe("single salesperson ownership migration", () => {
  async function legacyAccount(id = "a1", salespersonId: string | undefined = "brian") {
    return save(row("WORKFLOW", `workflow:${id}`, { accountId: id, name: "Existing HOA", salespersonId, championId: "former-champ", disposition: "ACTIVE", version: 1, updatedAt: NOW }, { accountId: id }));
  }
  async function migrateAll() {
    const { migrateSalespersonOwnership } = await import("../../amplify/functions/communications/ownershipMigration");
    for (let n = 0; n < 30 && !record("migration:salesperson-ownership:v2")?.data.complete; n++) await migrateSalespersonOwnership();
    expect(record("migration:salesperson-ownership:v2").data.complete).toBe(true);
    const { syncResponsibilities } = await import("../../amplify/functions/communications/workflow");
    for (let n = 0; n < 80; n++) {
      const next = entries("ROLE_SYNC").find(r => r.dueAt); if (!next) break;
      await syncResponsibilities((await get<any>(next.id))!);
    }
    expect(entries("ROLE_SYNC").some(r => r.dueAt)).toBe(false);
  }
  it("resumes interrupted pages without changing existing salespeople or promoting champion-only teammates", async () => {
    for (let n = 0; n < 12; n++) await legacyAccount(`a${n}`);
    await save(row("ELIGIBILITY", "eligibility:former-champ", { userId: "former-champ", enabled: true, salesperson: false, champion: true }));
    const { migrateSalespersonOwnership } = await import("../../amplify/functions/communications/ownershipMigration");
    await migrateSalespersonOwnership(); // eligibility page commits independently
    h.failAt = h.transactions.length + 3;
    await expect(migrateSalespersonOwnership()).rejects.toThrow("Interrupted");
    await migrateAll();
    expect(entries("WORKFLOW")).toHaveLength(12);
    expect(entries("WORKFLOW").every(w => w.data.salespersonId === "brian" && !w.data.championId && w.data.ownershipModel === "SALESPERSON")).toBe(true);
    expect(entries("ROLE_SYNC")).toHaveLength(12);
    expect(record("eligibility:former-champ").data.salesperson).toBe(false);
  });
  it("uses the validated default for missing ownership and leaves invalid assignments visible", async () => {
    const missing = await legacyAccount("missing");
    await save(row("WORKFLOW", missing.id, { ...missing.data, salespersonId: undefined }, { accountId: "missing", previous: missing }), missing);
    const invalid = await legacyAccount("invalid", "former-champ");
    await save(row("WORKFLOW", invalid.id, { ...invalid.data, disposition: "BOUND" }, { accountId: "invalid", previous: invalid }), invalid);
    await save(row("ELIGIBILITY", "eligibility:former-champ", { userId: "former-champ", enabled: true, salesperson: false, champion: true }));
    await migrateAll();
    expect(record("workflow:missing").data).toMatchObject({ salespersonId: "brian", assignmentIssue: undefined });
    expect(record("workflow:invalid").data.assignmentIssue).toContain("eligible");
    expect(record("workflow:invalid").workKind).toBe("WORKFLOW");
    expect(record("eligibility:former-champ").data.salesperson).toBe(false);
  });
  it("skips deleted accounts and stops any pending assignment job for them", async () => {
    const old = await legacyAccount("deleted");
    await save(row("ACCOUNT_TOMBSTONE", "deleted-account:deleted", {}));
    await save(row("ROLE_SYNC", "role-sync:deleted", { accountId: "deleted", phase: "LINK" }, { accountId: "deleted", dueAt: NOW }));
    await migrateAll();
    expect(record(old.id)).toEqual(old);
    expect(entries("OPERATION")).toHaveLength(0);
  });
});

describe("assignment listing index rollout", () => {
  it("retries an interrupted page without publishing a partial index", async () => {
    const original = await lead(); delete record(original.id).assignedSalespersonId;
    const { migrateAssignmentIndex } = await import("../../amplify/functions/communications/assignmentIndex");
    h.failAt = h.transactions.length;
    await expect(migrateAssignmentIndex()).rejects.toThrow("Interrupted");
    expect(record("migration:assignment-index:v1")).toBeUndefined();
    await migrateAssignmentIndex();
    expect(record(original.id).assignedSalespersonId).toBe(original.data.salespersonId);
    expect(record("migration:assignment-index:v1").data.complete).toBe(true);
  });
  it("yields at the time budget and never overwrites a concurrent reassignment", async () => {
    const original = await lead(); delete record(original.id).assignedSalespersonId;
    const { migrateAssignmentIndex } = await import("../../amplify/functions/communications/assignmentIndex");
    await migrateAssignmentIndex({ budgetMs: 0 });
    expect(record("migration:assignment-index:v1")).toBeUndefined();
    expect(record(original.id).assignedSalespersonId).toBeUndefined();
    const read = h.batch.getMockImplementation()!;
    h.batch.mockImplementationOnce(input => {
      const current = read(input);
      h.records.set(`comms:${original.id}`, row("WORKFLOW", original.id, { ...original.data, salespersonId: "new-owner" }, { previous: original, accountId: "a1", dueAt: "2026-10-01T13:00:00.000Z" }));
      return current;
    });
    h.reads.length = 0; h.readFailureId = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined;
    await migrateAssignmentIndex();
    expect(record(original.id)).toMatchObject({ assignedSalespersonId: "new-owner", data: { salespersonId: "new-owner" }, dueAt: "2026-10-01T13:00:00.000Z" });
    expect(h.reads.filter(id => id.startsWith("workflow:"))).toEqual([original.id]);
    expect(record("migration:assignment-index:v1").data.complete).toBe(true);
  });
  it("backfills bounded pages without changing account ownership or deadlines", async () => {
    const base = await lead();
    h.records.delete("comms:workflow:a1");
    for (let i = 0; i < 252; i++) {
      const accountId = `indexed-${String(i).padStart(2, "0")}`;
      const legacy = row("WORKFLOW", `workflow:${accountId}`, { ...base.data, accountId }, { accountId, dueAt: "2026-09-30T13:00:00.000Z" });
      delete legacy.assignedSalespersonId;
      h.records.set(`comms:${legacy.id}`, legacy);
    }
    const { migrateAssignmentIndex } = await import("../../amplify/functions/communications/assignmentIndex");
    h.reads.length = 0; h.readFailureId = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined;
    await migrateAssignmentIndex({ maxPages: 1 });
    expect(record("migration:assignment-index:v1").data).toMatchObject({ complete: false, processed: 100 });
    expect(entries("WORKFLOW").filter(w => w.assignedSalespersonId)).toHaveLength(100);
    await migrateAssignmentIndex();
    expect(record("migration:assignment-index:v1").data).toMatchObject({ complete: true, processed: 252 });
    expect(h.batch.mock.calls.map(([input]) => input.RequestItems.comms.Keys.length)).toEqual([100, 100, 52]);
    expect(h.batch.mock.calls.every(([input]) => input.RequestItems.comms.ConsistentRead === true)).toBe(true);
    expect(h.reads.filter(id => id.startsWith("workflow:"))).toEqual([]);
    expect(h.maxInFlight).toBeGreaterThan(1); expect(h.maxInFlight).toBeLessThanOrEqual(25);
    for (const w of entries("WORKFLOW")) {
      expect(w.assignedSalespersonId).toBe(base.data.salespersonId);
      expect(w.data.salespersonId).toBe(base.data.salespersonId);
      expect(w.dueAt).toBe("2026-09-30T13:00:00.000Z");
    }
    const before = structuredClone(entries("WORKFLOW"));
    await migrateAssignmentIndex(); expect(entries("WORKFLOW")).toEqual(before);
  });
  it("retries only unprocessed rows and handles unordered or deleted batch results", async () => {
    const original = await lead(); delete record(original.id).assignedSalespersonId;
    const other = row("WORKFLOW", "workflow:a2", { ...original.data, accountId: "a2", salespersonId: "other-owner" }, { accountId: "a2", dueAt: "2026-10-02T13:00:00.000Z" });
    delete other.assignedSalespersonId;
    h.records.set(`comms:${other.id}`, other);
    h.records.set("comms:workflow:deleted", { ...other, id: "workflow:deleted" });
    const read = h.batch.getMockImplementation()!;
    h.batch.mockImplementationOnce(input => {
      h.records.delete("comms:workflow:deleted");
      const result = read(input);
      return { Responses: { comms: result.Responses.comms.filter((item: { id: string }) => item.id !== original.id) },
        UnprocessedKeys: { comms: { Keys: [{ id: original.id }] } } };
    }).mockImplementationOnce(input => {
      expect(record("migration:assignment-index:v1")).toBeUndefined();
      expect(record(other.id).assignedSalespersonId).toBeUndefined();
      return read(input);
    });
    const { migrateAssignmentIndex } = await import("../../amplify/functions/communications/assignmentIndex");
    const migration = migrateAssignmentIndex();
    await vi.runAllTimersAsync(); await migration;
    expect(h.batch.mock.calls.map(([input]) => input.RequestItems.comms.Keys)).toEqual([
      [{ id: original.id }, { id: other.id }, { id: "workflow:deleted" }], [{ id: original.id }],
    ]);
    expect(h.batch.mock.calls.every(([input]) => input.RequestItems.comms.ConsistentRead === true)).toBe(true);
    expect(record(original.id).assignedSalespersonId).toBe(original.data.salespersonId);
    expect(record(other.id)).toMatchObject({ assignedSalespersonId: "other-owner", dueAt: "2026-10-02T13:00:00.000Z" });
    expect(record("workflow:deleted")).toBeUndefined();
    expect(record("migration:assignment-index:v1").data).toMatchObject({ complete: true, processed: 3 });
  });
  it("bounds unprocessed-key retries and resumes the incomplete page on the next run", async () => {
    const original = await lead(); delete record(original.id).assignedSalespersonId;
    const read = h.batch.getMockImplementation()!;
    h.batch.mockImplementation(input => ({ UnprocessedKeys: input.RequestItems }));
    const { migrateAssignmentIndex } = await import("../../amplify/functions/communications/assignmentIndex");
    const failure = expect(migrateAssignmentIndex()).rejects.toThrow("batch read remains incomplete");
    await vi.runAllTimersAsync(); await failure;
    expect(h.batch).toHaveBeenCalledTimes(4);
    expect(record("migration:assignment-index:v1")).toBeUndefined();
    expect(record(original.id).assignedSalespersonId).toBeUndefined();
    h.batch.mockImplementation(read);
    await migrateAssignmentIndex();
    expect(record(original.id).assignedSalespersonId).toBe(original.data.salespersonId);
    expect(record("migration:assignment-index:v1").data).toMatchObject({ complete: true, processed: 1 });
  });
  it("yields without writes or a checkpoint when retrying a batch would exceed the time budget", async () => {
    const original = await lead(); delete record(original.id).assignedSalespersonId;
    h.batch.mockImplementationOnce(input => ({ UnprocessedKeys: input.RequestItems }));
    const { migrateAssignmentIndex } = await import("../../amplify/functions/communications/assignmentIndex");
    await migrateAssignmentIndex({ budgetMs: 20 });
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(record("migration:assignment-index:v1")).toBeUndefined();
    expect(record(original.id).assignedSalespersonId).toBeUndefined();
    await migrateAssignmentIndex();
    expect(record(original.id).assignedSalespersonId).toBe(original.data.salespersonId);
    expect(record("migration:assignment-index:v1").data).toMatchObject({ complete: true, processed: 1 });
  });
  it("updates the listing index in the same write as assignment changes", async () => {
    const original = await lead();
    expect(original.assignedSalespersonId).toBe(original.data.salespersonId);
    const reassigned = row("WORKFLOW", original.id, { ...original.data, salespersonId: "another" }, { previous: original, accountId: "a1" });
    expect(reassigned.assignedSalespersonId).toBe("another");
    expect(row("WORKFLOW", original.id, { ...original.data, salespersonId: undefined }, { previous: reassigned, accountId: "a1" }).assignedSalespersonId).toBeUndefined();
  });
});

describe("CRM task retirement", () => {
  it("rejects cached task operations for staff and administrators before reading or changing records", async () => {
    const { handler } = await import("../../amplify/functions/communications/handler");
    const { RETIRED_TASK_OPERATIONS } = await import("../../../shared/retiredTaskOperations");
    const before = structuredClone([...h.records.entries()]);
    for (const groups of [[], ["ADMIN"]]) for (const operation of RETIRED_TASK_OPERATIONS) {
      const writes = h.transactions.length; h.reads.length = 0;
      const result = await handler({ arguments: { operation, input: { taskId: "historical-task", accountId: "a1" } }, identity: { sub: "brian", groups } as never });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("removed") });
      expect(h.reads).toEqual([]); expect(h.transactions).toHaveLength(writes);
    }
    for (const kind of [undefined, null, "", " ", "TASK", " TASK ", "NOTIFICATION"]) {
      expect(await handler({ arguments: { readOperation: "work", input: { kind } }, identity: { sub: "brian", groups: ["ADMIN"] } as never })).toMatchObject({ ok: false, error: expect.stringContaining("removed") });
    }
    expect([...h.records.entries()]).toEqual(before); expect(h.front).not.toHaveBeenCalled();
  });
  it("blocks direct task writes and task helpers while retaining historical records", async () => {
    await seedLegacyPromise({ id: "historical-task", accountId: "a1", dueAt: NOW, sourceIds: ["comm:original"], custom: true }, "brian");
    const historical = structuredClone(record("historical-task")) as Row<Record<string, unknown>>;
    await expect(makeTask({ accountId: "a1", title: "No new task", kind: "FOLLOW_UP" })).rejects.toThrow("removed");
    await expect(save(row("TASK", "new-task", { status: "OPEN" }))).rejects.toThrow("removed");
    await expect(save(row("NOTIFICATION", "new-notice", { recipient: "brian" }))).rejects.toThrow("removed");
    await expect(save(row("TASK", historical.id, { ...historical.data, status: "COMPLETE" }, { previous: historical }), historical)).rejects.toThrow("removed");
    await expect(retiredSaveTask({ accountId: "a1", title: "Old action", role: "SALESPERSON", kind: "FOLLOW_UP", dueAt: NOW, reason: "test" }, "brian")).rejects.toThrow("removed");
    await expect(completeTask({ id: historical.id, version: 1 }, "brian")).rejects.toThrow("removed");
    await expect(mergeTasks({ accountId: "a1", tasks: [], reason: "old action" }, "brian")).rejects.toThrow("removed");
    expect(record(historical.id)).toEqual(historical);
  });
  it("drains old task and notification schedules without changing their stored business data or sending", async () => {
    await seedLegacyPromise({ id: "historical-task", accountId: "a1", dueAt: NOW, sourceIds: ["original"], escalationAt: NOW, status: "OPEN" }, "brian");
    const notification = { ...record("historical-task"), id: "historical-notice", kind: "NOTIFICATION", data: { recipient: "former-manager", at: NOW, title: "Historical notice" }, workKind: "NOTIFICATION" };
    h.records.set("comms:historical-notice", notification);
    const original = [structuredClone(record("historical-task")), structuredClone(notification)];
    const { dispatchTask } = await import("../../amplify/functions/communications/worker");
    for (const item of original) {
      await dispatchTask(item as never); const first = structuredClone(record(item.id));
      await dispatchTask(item as never);
      expect(record(item.id)).toEqual(first); expect(first.data).toEqual(item.data);
      for (const key of ["workKind", "workAt", "dueGroup", "dueAt"]) expect(first).not.toHaveProperty(key);
    }
    expect(entries("TASK")).toHaveLength(1); expect(entries("NOTIFICATION")).toHaveLength(1);
    expect(h.front).not.toHaveBeenCalled(); expect(h.dialpad).not.toHaveBeenCalled();
  });
  it("makes renewal, reminder, contact-task and census entry points inert", async () => {
    const before = structuredClone([...h.records.entries()]), writes = h.transactions.length; h.reads.length = 0;
    await (await import("../../amplify/functions/renewal-tasks/handler")).handler();
    await (await import("../../amplify/functions/communications/reminders")).migrateReminderSchedules();
    await (await import("../../amplify/functions/communications/contactProgress")).migrateContactProgress();
    await (await import("../../amplify/functions/communications/coverage")).coverageSweep();
    expect(h.reads).toEqual([]); expect(h.transactions).toHaveLength(writes); expect([...h.records.entries()]).toEqual(before);
    expect(h.accountList).not.toHaveBeenCalled(); expect(h.front).not.toHaveBeenCalled();
  });
  it("captures inbound/outbound correspondence and contact evidence without touching historical tasks", async () => {
    await lead(); await seedLegacyPromise({ id: "historical-task", accountId: "a1", dueAt: NOW, sourceIds: ["request"] }, "brian");
    const historical = structuredClone(record("historical-task"));
    await recordInbound(await inbound("request"));
    await recordOutbound(await inbound("sent", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", actorId: "tea_brian" }));
    expect(record("comm:request").data).toMatchObject({ resolved: true, resolvedByCommunicationId: "comm:sent" });
    expect(record("comm:sent").data).toMatchObject({ contactApplied: true, contactAppliedKind: "CONTACT" });
    expect(record(historical.id)).toEqual(historical); expect(entries("TASK")).toHaveLength(1); expect(entries("NOTIFICATION")).toEqual([]);
    expect(entries("OPERATION").some(op => op.data.type === "REOPEN")).toBe(true);
  });
  it("resolves delayed requests only against the correct contact and preserves newer unanswered correspondence", async () => {
    await lead();
    h.records.set("Contact:jane", { accountId: "a1", email: "jane@example.com", phone: "+16175550100" });
    h.records.set("Contact:other", { accountId: "a1", email: "other@example.com", phone: "+16175550200" });
    await recordOutbound(await inbound("sent", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", to: ["jane@example.com"], conversationId: undefined }));
    await recordInbound(await inbound("older", NOW, { from: "+16175550100", provider: "dialpad", channel: "CALL", conversationId: undefined }));
    await recordInbound(await inbound("other", NOW, { from: "other@example.com", conversationId: undefined }));
    await recordInbound(await inbound("newer", "2026-09-08T16:00:00Z", { from: "jane@example.com", conversationId: undefined }));
    expect(record("comm:older").data.resolved).toBe(true);
    expect(record("comm:other").data.resolved).not.toBe(true); expect(record("comm:newer").data.resolved).not.toBe(true);
    expect(entries("TASK")).toEqual([]);
  });
  it("repairs a historical draft's false contact evidence without reviving old tasks", async () => {
    await lead(); await recordInbound(await inbound("request"));
    const draft = await inbound("draft", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", frontDraft: undefined });
    const source = await get<Communication>("comm:request");
    await save(row("COMMUNICATION", source!.id, { ...source!.data, resolved: true, resolvedByCommunicationId: draft.id }, { accountId: "a1", previous: source }), source);
    await seedLegacyPromise({ id: "historical-task", accountId: "a1", status: "COMPLETE", dueAt: NOW, completedByCommunicationId: draft.id }, "brian");
    const history = structuredClone(record("historical-task"));
    await (await import("../../amplify/functions/communications/drafts")).repairMisclassifiedDraft(record(draft.id) as never);
    expect(record(draft.id).data).toMatchObject({ status: "DRAFT", contactApplied: false });
    expect(record("comm:request").data.resolved).toBe(false); expect(record("historical-task")).toEqual(history);
  });
  it("records unsuccessful attempts without marking inbound requests answered or creating a retry", async () => {
    await lead(); await recordInbound(await inbound("request"));
    await recordOutbound(await inbound("attempt", "2026-09-08T15:00:00Z", { direction: "OUTBOUND", provider: "dialpad", channel: "CALL", status: "MISSED", endedAt: "2026-09-08T15:01:00Z" }));
    expect(record("comm:request").data.resolved).not.toBe(true);
    expect(record("comm:attempt").data.contactAppliedKind).toBe("ATTEMPT"); expect(entries("TASK")).toEqual([]);
  });
  it("preserves lead status changes and reopening without requiring a follow-up date", async () => {
    const wf = await lead(); const { setLeadDisposition } = await import("../../amplify/functions/communications/workflow");
    await setLeadDisposition("a1", "LOST", wf.version, "brian");
    const { handler } = await import("../../amplify/functions/communications/handler");
    expect(await handler({ arguments: { operation: "reopenLead", input: { accountId: "a1", version: record(wf.id).version, reason: "Prospect returned" } }, identity: { sub: "brian", groups: [] } as never })).toMatchObject({ ok: true });
    expect(record(wf.id).data.disposition).toBe("ACTIVE"); expect(entries("TASK")).toEqual([]);
  });
  it("continues bounded Front assignment repair from old task phases without editing legacy tasks", async () => {
    const wf = await lead();
    await save(row("ELIGIBILITY", "eligibility:new", { userId: "new", enabled: true, salesperson: true, frontId: "tea_new" }));
    await seedLegacyPromise({ id: "historical-task", accountId: "a1", dueAt: NOW }, "brian"); const history = structuredClone(record("historical-task"));
    for (let i = 0; i < 31; i++) await save(row("LINK", `link:${i}`, { accountId: "a1", conversationId: `cnv_${i}`, routing: "SALESPERSON" }, { accountId: "a1" }));
    await setResponsibilities("a1", "new", wf.version, "admin");
    const { syncResponsibilities } = await import("../../amplify/functions/communications/workflow");
    for (let n = 0; n < 4; n++) for (const job of entries("ROLE_SYNC").filter(j => j.dueAt)) await syncResponsibilities(job as never);
    expect(entries("OPERATION").filter(o => o.data.type === "ASSIGN")).toHaveLength(31);
    expect(entries("OPERATION").every(o => o.data.assigneeId === "tea_new")).toBe(true); expect(record(history.id)).toEqual(history);
  });
  it("ignores retired task warnings for cleanup but still blocks real delivery failures", async () => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    await seedLegacyPromise({ id: "historical-custom-id", accountId: "a1", dueAt: NOW }, "brian");
    await save(row("ISSUE", "issue:historical-custom-id", { sourceId: "historical-custom-id", message: "Old reminder failure" }, { accountId: "a1" }));
    await save(row("ISSUE", "issue:task:gone", { sourceId: "task:gone" }, { accountId: "a1" }));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(true);
    await save(row("ISSUE", "issue:delivery:message", { sourceId: "delivery:message", message: "Actual message failed" }, { accountId: "a1" }));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(false);
  });
  it("ignores terminal legacy reminder uncertainty but preserves ordinary comment uncertainty", async () => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    for (const state of ["UNKNOWN", "FAILED"] as const) {
      await save(row<Operation>("OPERATION", `op:morning-summary:${state}`, { type: "COMMENT", accountId: "a1", state, attempts: 1 }, { accountId: "a1" }));
      await save(row<Operation>("OPERATION", `op:custom-reminder:${state}`, { type: "COMMENT", accountId: "a1", state, attempts: 1, reminder: { taskId: "task:legacy", noticeAt: NOW, recipientId: "brian", escalated: false } }, { accountId: "a1" }));
    }
    await save(row("ISSUE", "issue:op:custom-reminder:UNKNOWN", { sourceId: "op:custom-reminder:UNKNOWN", message: "Historical uncertain reminder" }, { accountId: "a1" }));
    const historical = structuredClone(entries("OPERATION"));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(true);
    const { workPage } = await import("../../amplify/functions/communications/work");
    expect((await workPage({ kind: "OPERATION", actor: "brian" })).items).toEqual([]);
    expect((await workPage({ kind: "ISSUE", actor: "brian" })).items).toEqual([]);
    expect(entries("OPERATION")).toEqual(historical);
    await save(row<Operation>("OPERATION", "op:ordinary-comment", { type: "COMMENT", accountId: "a1", state: "UNKNOWN", attempts: 1 }, { accountId: "a1" }));
    expect(await archiveAllowed("a1", "cnv_a")).toBe(false);
    expect((await workPage({ kind: "OPERATION", actor: "brian" })).items.map(r => r.id)).toEqual(["op:ordinary-comment"]);
  });
  it("activates a fresh integration without retired report settings while retaining provider checks", async () => {
    const setup = await import("../../amplify/functions/communications/setup");
    const checks = vi.spyOn(setup, "activationChecks");
    const { handler } = await import("../../amplify/functions/communications/handler");
    vi.stubEnv("COMMUNICATION_ENV", "main");
    h.c = { ...h.c, paused: true, activatedAt: undefined };
    h.records.delete("comms:team-routing");
    await save(row("CONFIG", "config", h.c));
    const activate = () => handler({ arguments: { operation: "activate", input: { nativeChecksConfirmed: true } }, identity: { sub: "brian", groups: ["ADMIN"] } as never });
    try {
      checks.mockResolvedValue([{ name: "Front company", ok: false, detail: "Wrong company" }]);
      const writes = h.transactions.length;
      expect(await activate()).toMatchObject({ ok: false, error: "Front company: Wrong company" });
      expect(h.transactions).toHaveLength(writes); expect(record("config").data.paused).toBe(true);
      checks.mockResolvedValue([{ name: "Front company", ok: true, detail: "Verified" }]);
      h.reads.length = 0; h.readFailureId = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined;
      expect(await activate()).toMatchObject({ ok: true, config: { activatedAt: NOW, paused: false } });
      expect(h.reads).not.toContain("team-routing");
      expect(record("config").data).toMatchObject({ paused: false, activatedAt: NOW });
    } finally { checks.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("suppresses historical task reminders before delivery even when communications are paused", async () => {
    h.c.paused = true; h.c.activatedAt = undefined;
    for (const [id, type, extra] of [
      ["op:morning-summary:a1", "COMMENT", {}],
      ["op:morning-reopen:a1", "REOPEN", {}],
      ["op:reminder-comment:a1", "COMMENT", {}],
      ["op:reopen:notice:a1", "REOPEN", {}],
      ["op:legacy-custom", "COMMENT", { reminderGroup: { day: "2026-09-08", role: "SALESPERSON", recipientId: "brian", anchorTaskId: "task:historical" } }],
    ] as const) {
      const op = await save(row<Operation>("OPERATION", id, { type, accountId: "a1", state: "RETRY_WAIT", attempts: 1, ...extra }, { accountId: "a1", dueAt: NOW }));
      await runOperation(op);
      expect(record(id).data).toMatchObject({ state: "SUPPRESSED", error: expect.stringContaining("removed") });
      expect(record(id).dueAt).toBeUndefined();
    }
    expect(entries("WORKFLOW")).toEqual([]); expect(h.front).not.toHaveBeenCalled(); expect(h.dialpad).not.toHaveBeenCalled();
  });
  it("omits retired task/report issues from account context and paged diagnostics without hiding business warnings", async () => {
    await lead();
    const retiredIds = ["coverage:a1", "incumbent-date:a1", "annual-date:a1", "policy-handoff:a1", "renewal-facts:a1:lead", "expired-risk:lead:a1", "bind-authorization:quote1", "coverage-census", "contact-progress-repair", "report-setup", "report:main:day:brian", "op:morning-summary:a1"];
    for (const id of retiredIds) await save(row("ISSUE", `issue:${id}`, { sourceId: id, message: "Retired warning" }, { accountId: "a1" }));
    for (let i = 0; i < 60; i++) await save(row("ISSUE", `issue:task:${i}`, { sourceId: `task:${i}`, message: "Retired task warning", at: "2026-09-07T14:00:00.000Z" }, { accountId: "a1" }));
    await seedLegacyPromise({ id: "custom-legacy-task", accountId: "a1", dueAt: NOW }, "brian");
    await save(row("ISSUE", "issue:custom-legacy-task", { sourceId: "custom-legacy-task", message: "Retired custom warning" }, { accountId: "a1" }));
    const activeIds = ["renewal-context:a1", "delivery:mail1", "salesperson-ownership"];
    for (const id of activeIds) await save(row("ISSUE", `issue:${id}`, { sourceId: id, message: "Current business warning" }, { accountId: "a1" }));
    const stored = structuredClone(entries("ISSUE"));
    const { handler } = await import("../../amplify/functions/communications/handler");
    const context = await handler({ arguments: { readOperation: "context", input: { accountId: "a1" } }, identity: { sub: "brian", groups: [] } as never });
    expect(context.ok).toBe(true);
    expect(context.issues?.map(r => r.id).sort()).toEqual(activeIds.map(id => `issue:${id}`).sort());
    const { workPage } = await import("../../amplify/functions/communications/work");
    const page = await workPage({ kind: "ISSUE", actor: "brian" });
    expect(page.items.map(r => r.id).sort()).toEqual(activeIds.map(id => `issue:${id}`).sort());
    expect(page.nextToken).toBeUndefined(); expect(entries("ISSUE")).toEqual(stored);
  });
  it("monitors actual processing without requiring a task census or daily staff delivery", async () => {
    vi.setSystemTime("2026-09-09T15:00:00Z");
    await save(row("HEALTH", "health:worker", { at: new Date().toISOString(), lagging: false }));
    const { handler } = await import("../../amplify/functions/communications/monitor");
    await expect(handler()).resolves.toEqual({ errors: [] });
    expect(record("health:monitor").data.errors).toEqual([]); expect(h.reads).not.toContain("coverage:census"); expect(h.reads).not.toContain("health:reports");
    record("health:worker").data.lagging = true;
    await expect(handler()).rejects.toThrow("Communication processing");
  });
});


describe("batched issue-source visibility", () => {
  const sourceBatches = () => h.batch.mock.calls.map(([input]) => input.RequestItems.comms);
  it("deduplicates sources within each diagnostics page and preserves pagination", async () => {
    await save(row("COMMUNICATION", "shared-source", { status: "FAILED" }));
    for (let i = 0; i < 60; i++) await save(row("ISSUE", `issue:delivery-${i}`, { sourceId: "shared-source" }, { accountId: "a1" }));
    h.reads.length = 0; h.readFailureId = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined; h.batch.mockClear();
    const { workPage } = await import("../../amplify/functions/communications/work");
    const first = await workPage({ kind: "ISSUE", actor: "brian" });
    expect(first.items).toHaveLength(50); expect(first.nextToken).toBeTruthy();
    const second = await workPage({ kind: "ISSUE", actor: "brian", nextToken: first.nextToken });
    expect(second.items).toHaveLength(10); expect(second.nextToken).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map(r => r.id)).size).toBe(60);
    expect(sourceBatches().map(batch => batch.Keys)).toEqual([[{ id: "shared-source" }], [{ id: "shared-source" }]]);
    expect(sourceBatches().every(batch => batch.ConsistentRead === true)).toBe(true);
    expect(h.reads).not.toContain("shared-source");
  });
  it.each(["context", "archive"])("chunks more than 100 unique sources for account %s without individual reads", async view => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    const ids = Array.from({ length: 125 }, (_, i) => `historical-source-${i}`);
    for (const id of ids) {
      await seedLegacyPromise({ id, accountId: "a1", dueAt: NOW }, "brian");
      await save(row("ISSUE", `issue:${id}`, { sourceId: id }, { accountId: "a1" }));
    }
    await save(row("ISSUE", "issue:duplicate", { sourceId: ids[0] }, { accountId: "a1" }));
    await save(row("ISSUE", "issue:resolved", { sourceId: "unneeded-resolved", resolved: true }, { accountId: "a1" }));
    await save(row("ISSUE", "issue:task:retired", { sourceId: "unneeded-retired" }, { accountId: "a1" }));
    h.reads.length = 0; h.readFailureId = undefined; h.userReads.length = 0; h.queries.length = 0; h.userError = undefined; h.queryError = undefined; h.batch.mockClear();
    if (view === "archive") expect(await archiveAllowed("a1", "cnv_a")).toBe(true);
    else {
      const { handler } = await import("../../amplify/functions/communications/handler");
      const context = await handler({ arguments: { readOperation: "context", input: { accountId: "a1" } }, identity: { sub: "brian", groups: [] } as never });
      expect(context).toMatchObject({ ok: true, issues: [] });
    }
    expect(sourceBatches().map(batch => batch.Keys.length)).toEqual([100, 25]);
    expect(new Set(sourceBatches().flatMap(batch => batch.Keys.map((key: { id: string }) => key.id)))).toEqual(new Set(ids));
    expect(sourceBatches().every(batch => batch.ConsistentRead === true)).toBe(true);
    expect(h.reads.some(id => ids.includes(id) || id.startsWith("unneeded-"))).toBe(false);
  });
  it("keeps missing sources and real delivery warnings visible without aliasing absent IDs", async () => {
    const { currentCommunicationIssues } = await import("../../amplify/functions/communications/retiredTasks");
    const { batchGet } = await import("../../amplify/functions/communications/store");
    for (const [id, kind, data] of [
      ["undefined", "TASK", {}], ["notice", "NOTIFICATION", {}], ["edition", "REPORT_EDITION", {}],
      ["old-operation", "OPERATION", { type: "COMMENT", reminder: { taskId: "old" } }],
      ["real-operation", "OPERATION", { type: "COMMENT", state: "UNKNOWN" }],
      ["real-message", "COMMUNICATION", { status: "FAILED" }],
    ] as const) h.records.set(`comms:${id}`, row(kind, id, data));
    const sources = [undefined, null, 7, "", "missing", "undefined", "notice", "edition", "old-operation", "real-operation", "real-message"];
    const items = sources.map((sourceId, i) => ({ id: `issue:source-${i}`, data: { sourceId } }));
    expect(await currentCommunicationIssues(items, batchGet)).toEqual([true, true, true, true, true, false, false, false, false, true, true]);
    expect(sourceBatches().map(batch => batch.Keys.length)).toEqual([7]);
    h.batch.mockClear();
    expect(await currentCommunicationIssues([{ id: "issue:task:old", data: { sourceId: "old" } }, { id: "issue:resolved", data: { resolved: true, sourceId: "source" } }], batchGet)).toEqual([false, false]);
    expect(h.batch).not.toHaveBeenCalled();
  });
  it("retries unprocessed sources before deciding which warnings to show", async () => {
    const { workPage } = await import("../../amplify/functions/communications/work");
    await seedLegacyPromise({ id: "historical-source", accountId: "a1", dueAt: NOW }, "brian");
    await save(row("ISSUE", "issue:custom", { sourceId: "historical-source" }, { accountId: "a1" }));
    h.batch.mockImplementationOnce(input => ({ UnprocessedKeys: input.RequestItems }));
    const assertion = expect(workPage({ kind: "ISSUE", actor: "brian" })).resolves.toMatchObject({ items: [], nextToken: undefined });
    await vi.runAllTimersAsync(); await assertion;
    expect(sourceBatches().map(batch => batch.Keys)).toEqual([[{ id: "historical-source" }], [{ id: "historical-source" }]]);
    expect(sourceBatches().every(batch => batch.ConsistentRead === true)).toBe(true);
  });
  it.each(["outage", "incomplete"])("does not authorize archive when a source batch is %s", async failure => {
    await lead(); await save(row("HEALTH", "health:worker", { at: NOW, lagging: false }));
    await save(row("ISSUE", "issue:delivery", { sourceId: "uncertain-delivery" }, { accountId: "a1" }));
    if (failure === "outage") h.batch.mockRejectedValue(new Error("Database unavailable"));
    else h.batch.mockImplementation(input => ({ UnprocessedKeys: input.RequestItems }));
    const assertion = expect(archiveAllowed("a1", "cnv_a")).rejects.toThrow(failure === "outage" ? "Database unavailable" : "batch read remains incomplete");
    await vi.runAllTimersAsync(); await assertion;
    expect(h.front).not.toHaveBeenCalled();
    expect(sourceBatches()).toHaveLength(failure === "outage" ? 1 : 4);
  });
});
