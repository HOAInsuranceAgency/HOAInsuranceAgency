import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  records: new Map<string, any>(), requests: [] as { name: string; input: any }[],
  projected: undefined as any[] | undefined,
  beforeWrite: undefined as ((record: any) => void) | undefined,
  batchFailures: 0, batchUnprocessed: 0,
  nonProducers: new Set<string>(), disabled: new Set<string>(), deactivated: new Set<string>(), directory: [] as string[],
  groupError: undefined as Error | undefined,
  onLookup: undefined as (() => void) | undefined,
}));
vi.mock("../../amplify/functions/crm-access/user-status", () => ({ teamUserDisabled: async (userId: string) => h.deactivated.has(userId) }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async importOriginal => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>()),
  CognitoIdentityProviderClient: class { send = async (command: any) => {
    const input = command.input;
    if (command.constructor.name === "AdminListGroupsForUserCommand") {
      if (h.groupError) throw h.groupError;
      return { Groups: h.nonProducers.has(input.Username) ? [] : [{ GroupName: "PRODUCER" }] };
    }
    if (command.constructor.name === "ListUsersInGroupCommand") {
      const offset = Number(input.NextToken ?? 0), ids = h.directory.slice(offset, offset + input.Limit);
      return { Users: ids.map(id => ({ Username: id, Attributes: [{ Name: "sub", Value: id }] })), ...(h.directory.length > offset + ids.length ? { NextToken: String(offset + ids.length) } : {}) };
    }
    const userId = /"([^"]+)"/.exec(input.Filter)?.[1];
    if (!userId) throw new Error("Expected one teammate");
    h.onLookup?.();
    return { Users: [{ Username: userId, Enabled: !h.disabled.has(userId), Attributes: [{ Name: "email", Value: `${userId}@example.com` }] }] };
  }; },
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...(await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>()),
  DynamoDBDocumentClient: { from: () => ({ send: async (command: any) => {
    const input = command.input, name = command.constructor.name;
    h.requests.push({ name, input });
    if (name === "GetCommand") return { Item: structuredClone(h.records.get(input.Key.id)) };
    if (name === "BatchGetCommand") {
      if (h.batchFailures-- > 0) throw new Error("Interrupted batch read");
      const [table, request] = Object.entries(input.RequestItems)[0] as [string, { Keys: { id: string }[] }];
      if (h.batchUnprocessed-- > 0) return { UnprocessedKeys: { [table]: { Keys: request.Keys } } };
      return { Responses: { [table]: request.Keys.flatMap(key => h.records.has(key.id) ? [structuredClone(h.records.get(key.id))] : []) } };
    }
    if (name === "QueryCommand") {
      let values = (h.projected ?? [...h.records.values()]).filter(record => input.IndexName === "website-producers"
        ? record.producerGroup === input.ExpressionAttributeValues[":group"] : record.kind === input.ExpressionAttributeValues[":k"]);
      const after = input.ExpressionAttributeValues[":after"], through = input.ExpressionAttributeValues[":through"];
      if (after !== undefined) values = values.filter(record => record.id > after);
      if (through !== undefined) values = values.filter(record => record.id <= through);
      values.sort((a, b) => a.id.localeCompare(b.id));
      if (input.ExclusiveStartKey) values = values.filter(record => record.id > input.ExclusiveStartKey.id);
      const page = values.slice(0, input.Limit);
      return { Items: structuredClone(page), ...(values.length > page.length ? { LastEvaluatedKey: { id: page.at(-1).id, ...(input.IndexName === "website-producers" ? { producerGroup: "WEBSITE" } : { kind: "ELIGIBILITY" }) } } : {}) };
    }
    if (name === "TransactWriteCommand") {
      for (const write of input.TransactItems) {
        const change = write.Put, next = change.Item;
        h.beforeWrite?.(next);
        const current = h.records.get(next.id);
        if (change.ConditionExpression === "attribute_not_exists(id)" ? !!current : current?.version !== change.ExpressionAttributeValues[":v"]) {
          throw Object.assign(new Error("Concurrent eligibility change"), { name: "ConditionalCheckFailedException" });
        }
      }
      for (const write of input.TransactItems) h.records.set(write.Put.Item.id, structuredClone(write.Put.Item));
      return {};
    }
    throw new Error(`Unexpected ${name}`);
  } }) },
}));

import { row } from "../../amplify/functions/communications/store";
import { indexedProducerPage, migrateProducerIndex, PRODUCER_INDEX_MIGRATION_ID } from "../../amplify/functions/communications/producerIndex";

function member(userId: string, options: { enabled?: boolean; salesperson?: boolean; receiveNewLeads?: boolean; legacy?: boolean } = {}) {
  const result = row("ELIGIBILITY", `eligibility:${userId}`, { userId, name: userId, email: `${userId}@example.com`, enabled: options.enabled ?? true, salesperson: options.salesperson ?? true,
    ...(!options.legacy ? { receiveNewLeads: options.receiveNewLeads ?? true } : {}) });
  if (options.legacy) delete result.producerGroup;
  h.records.set(result.id, result);
  return result;
}
function members(count: number, legacy = false) {
  return Array.from({ length: count }, (_, index) => member(`user${String(index).padStart(3, "0")}`, { legacy }));
}
beforeEach(() => {
  h.records.clear(); h.requests = []; h.projected = undefined; h.beforeWrite = undefined;
  h.batchFailures = 0; h.batchUnprocessed = 0;
  h.nonProducers.clear(); h.disabled.clear(); h.deactivated.clear(); h.directory = [];
  h.onLookup = undefined;
  h.groupError = undefined;
  process.env.COMMUNICATION_TABLE = "comms";
});
afterEach(() => { vi.useRealTimers(); });

describe("bounded website producer index", () => {
  it("materializes only enabled salesperson membership and removes it on every rewrite", () => {
    const previous = member("active");
    expect(previous.producerGroup).toBe("WEBSITE");
    for (const patch of [{ enabled: false }, { salesperson: false }, { receiveNewLeads: false }]) {
      expect(row("ELIGIBILITY", previous.id, { ...previous.data, ...patch }, { previous }).producerGroup).toBeUndefined();
    }
    expect(row("OTHER", "other", previous.data).producerGroup).toBeUndefined();
    expect(member("!invalid").producerGroup).toBeUndefined();
    expect(row("ELIGIBILITY", "eligibility:another", previous.data).producerGroup).toBeUndefined();
  });

  it("uses bounded key-only queries and one consistent batch read per page", async () => {
    members(21);
    for (let index = 0; index < 30; index++) member(`ineligible${index}`, { salesperson: false });
    const first = await indexedProducerPage();
    expect(first.items.map(item => item.data.userId)).toEqual(Array.from({ length: 8 }, (_, n) => `user00${n}`));
    expect(first.lastUserId).toBe("user007"); expect(first.nextToken).toBeTruthy();
    const second = await indexedProducerPage({ nextToken: first.nextToken });
    const third = await indexedProducerPage({ nextToken: second.nextToken });
    expect(second.items).toHaveLength(8); expect(third.items).toHaveLength(5); expect(third.nextToken).toBeUndefined();
    const queries = h.requests.filter(request => request.name === "QueryCommand");
    expect(queries).toHaveLength(3);
    for (const { input } of queries) {
      expect(input).toMatchObject({ IndexName: "website-producers", Limit: 8, KeyConditionExpression: "#group = :group", ScanIndexForward: true });
      expect(input.FilterExpression).toBeUndefined();
    }
    const batches = h.requests.filter(request => request.name === "BatchGetCommand");
    expect(batches).toHaveLength(3);
    for (const { input } of batches) expect(input.RequestItems.comms.ConsistentRead).toBe(true);
    expect(h.requests.some(request => request.name === "GetCommand")).toBe(false);
  });

  it("keeps both rotation legs ordered and resumes with the original bound", async () => {
    members(21);
    const normal = await indexedProducerPage({ after: "user007" });
    expect(normal.items[0].data.userId).toBe("user008"); expect(normal.items.at(-1)?.data.userId).toBe("user015");
    const remaining = await indexedProducerPage({ after: "user007", nextToken: normal.nextToken });
    expect(remaining.items.map(item => item.data.userId)).toEqual(["user016", "user017", "user018", "user019", "user020"]);
    const wrapped = await indexedProducerPage({ through: "user007" });
    expect(wrapped.items[0].data.userId).toBe("user000"); expect(wrapped.items.at(-1)?.data.userId).toBe("user007");
    expect(wrapped.nextToken).toBeUndefined();
    await expect(indexedProducerPage({ after: "user002", through: "user005" })).rejects.toThrow("one producer rotation bound");
  });

  it("rejects disabled and deleted stale projections while retaining page continuation", async () => {
    const rows = members(10); h.projected = structuredClone(rows);
    h.records.delete(rows[0].id);
    for (const previous of rows.slice(1, 8)) h.records.set(previous.id, row("ELIGIBILITY", previous.id, { ...previous.data, enabled: false }, { previous }));
    const stale = await indexedProducerPage();
    expect(stale.items).toEqual([]); expect(stale.lastUserId).toBe("user007"); expect(stale.nextToken).toBeTruthy();
    const current = await indexedProducerPage({ nextToken: stale.nextToken });
    expect(current.items.map(item => item.data.userId)).toEqual(["user008", "user009"]);
  });

  it("retries unprocessed primary reads instead of treating producers as missing", async () => {
    vi.useFakeTimers(); member("active"); h.batchUnprocessed = 1;
    const pending = indexedProducerPage(); await vi.runAllTimersAsync();
    expect((await pending).items).toHaveLength(1);
    expect(h.requests.filter(request => request.name === "BatchGetCommand")).toHaveLength(2);
  });

  it("skips malformed historical identities without blocking valid producers behind them", async () => {
    const invalid = member("!invalid"); invalid.producerGroup = "WEBSITE";
    member("active");
    const page = await indexedProducerPage();
    expect(page.items.map(item => item.data.userId)).toEqual(["active"]);
    expect(page.lastUserId).toBe("active");
    await migrateProducerIndex();
    expect(h.records.get(invalid.id).producerGroup).toBeUndefined();
  });
});

describe("website producer index bootstrap", () => {
  it("discovers new Producers without an eligibility row or a Team page visit, and refreshes after bootstrap", async () => {
    h.directory = ["new-producer", "stale-staff"];
    h.nonProducers.add("stale-staff");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:new-producer")).toMatchObject({ producerGroup: "WEBSITE", data: { salesperson: true, enabled: true, receiveNewLeads: true } });
    expect(h.records.has("eligibility:stale-staff")).toBe(false);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
    h.directory.push("another-producer");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:another-producer").producerGroup).toBe("WEBSITE");
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data.complete).toBe(true);
  });

  it.each(["Cognito", "CRM"])("removes old Staff eligibility and preserves a paused Producer across %s deactivation and restoration", async source => {
    member("legacy-staff", { legacy: true }); h.nonProducers.add("legacy-staff");
    member("paused", { salesperson: false, legacy: true });
    const disabled = source === "Cognito" ? h.disabled : h.deactivated;
    disabled.add("paused");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:legacy-staff")).toMatchObject({ data: { salesperson: false } });
    expect(h.records.get("eligibility:legacy-staff").producerGroup).toBeUndefined();
    expect(h.records.get("eligibility:paused")).toMatchObject({ data: { salesperson: false, receiveNewLeads: false } });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001); disabled.delete("paused");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:paused")).toMatchObject({ data: { salesperson: true, enabled: true, receiveNewLeads: false } });
    expect(h.records.get("eligibility:paused").producerGroup).toBeUndefined();
  });

  it("starts automatic rotation when a migrated legacy Staff member becomes a Producer", async () => {
    member("promoted-staff", { salesperson: false, legacy: true });
    h.nonProducers.add("promoted-staff");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:promoted-staff")).toMatchObject({ data: { salesperson: false, receiveNewLeads: true } });

    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
    h.nonProducers.delete("promoted-staff");
    h.directory = ["promoted-staff"];
    await migrateProducerIndex();
    expect(h.records.get("eligibility:promoted-staff")).toMatchObject({ producerGroup: "WEBSITE", data: { salesperson: true, receiveNewLeads: true } });
    expect((await indexedProducerPage()).items.map(item => item.data.userId)).toEqual(["promoted-staff"]);
  });

  it("preserves an explicit pause while a teammate loses and regains Producer membership", async () => {
    member("paused", { receiveNewLeads: false });
    h.nonProducers.add("paused");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:paused")).toMatchObject({ data: { salesperson: false, receiveNewLeads: false } });

    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
    h.nonProducers.delete("paused");
    await migrateProducerIndex();
    expect(h.records.get("eligibility:paused")).toMatchObject({ data: { salesperson: true, receiveNewLeads: false } });
    expect(h.records.get("eligibility:paused").producerGroup).toBeUndefined();
  });

  it("leaves the migration checkpoint unchanged when current Producer membership cannot be verified", async () => {
    const previous = member("paused", { salesperson: false, legacy: true });
    h.groupError = new Error("Cognito group service unavailable");
    await expect(migrateProducerIndex()).rejects.toThrow("Cognito group service unavailable");
    expect(h.records.get(previous.id)).toEqual(previous);
    expect(h.records.has(PRODUCER_INDEX_MIGRATION_ID)).toBe(false);

    h.groupError = undefined;
    await migrateProducerIndex();
    expect(h.records.get(previous.id)).toMatchObject({ data: { salesperson: true, receiveNewLeads: false } });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data.complete).toBe(true);
  });

  it("checkpoints completed small pages even when live identity checks exceed the time budget", async () => {
    vi.useFakeTimers();
    members(9, true);
    h.onLookup = () => vi.setSystemTime(Date.now() + 3_000);
    await migrateProducerIndex({ budgetMs: 10_000 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data).toMatchObject({ phase: "ELIGIBILITY", processed: 4 });
    await migrateProducerIndex({ budgetMs: 10_000 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data).toMatchObject({ phase: "ELIGIBILITY", processed: 8 });
    await migrateProducerIndex({ budgetMs: 10_000 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data.complete).toBe(true);
    const pages = h.requests.filter(request => request.name === "QueryCommand" && request.input.IndexName === "kind");
    expect(pages.map(request => request.input.Limit)).toEqual([4, 4, 4]);
  });

  it("preserves a concurrent pause instead of restoring rotation from a stale role snapshot", async () => {
    const previous = member("active", { legacy: true });
    h.beforeWrite = next => {
      if (next.id !== previous.id) return;
      h.beforeWrite = undefined;
      h.records.set(previous.id, row("ELIGIBILITY", previous.id, { ...previous.data, receiveNewLeads: false }, { previous }));
    };
    await migrateProducerIndex();
    expect(h.records.get(previous.id)).toMatchObject({ data: { salesperson: true, receiveNewLeads: false } });
    expect(h.records.get(previous.id).producerGroup).toBeUndefined();
  });

  it("checkpoints a bounded page and resumes existing eligibility without a full roster scan", async () => {
    const existing = members(9, true);
    await migrateProducerIndex({ maxPages: 1 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data).toMatchObject({ processed: 4, phase: "ELIGIBILITY" });
    expect(h.records.get(existing[3].id).producerGroup).toBe("WEBSITE");
    expect(h.records.get(existing[4].id).producerGroup).toBeUndefined();
    await migrateProducerIndex({ maxPages: 1 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data).toMatchObject({ processed: 8, phase: "ELIGIBILITY" });
    await migrateProducerIndex({ maxPages: 1 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data).toMatchObject({ processed: 9, phase: "PRODUCERS" });
    await migrateProducerIndex({ maxPages: 1 });
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data).toMatchObject({ processed: 9, complete: true });
    expect(h.records.get(existing[8].id).producerGroup).toBe("WEBSITE");
    const writes = h.requests.filter(request => request.name === "TransactWriteCommand").length;
    await migrateProducerIndex();
    expect(h.requests.filter(request => request.name === "TransactWriteCommand")).toHaveLength(writes);
  });

  it("leaves its checkpoint unchanged after an incomplete primary read and retries the page", async () => {
    member("active", { legacy: true }); h.batchFailures = 1;
    await expect(migrateProducerIndex()).rejects.toThrow("Interrupted batch read");
    expect(h.records.has(PRODUCER_INDEX_MIGRATION_ID)).toBe(false);
    expect(h.records.get("eligibility:active").producerGroup).toBeUndefined();
    await migrateProducerIndex();
    expect(h.records.get("eligibility:active").producerGroup).toBe("WEBSITE");
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data.complete).toBe(true);
  });

  it("re-reads a concurrent eligibility revocation instead of restoring its index membership", async () => {
    const previous = member("active", { legacy: true });
    h.beforeWrite = next => {
      if (next.id !== previous.id) return;
      h.beforeWrite = undefined;
      h.disabled.add("active");
      h.records.set(previous.id, row("ELIGIBILITY", previous.id, { ...previous.data, enabled: false }, { previous }));
    };
    await migrateProducerIndex();
    expect(h.records.get(previous.id)).toMatchObject({ version: 3, data: { enabled: false, salesperson: false } });
    expect(h.records.get(previous.id).producerGroup).toBeUndefined();
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data.complete).toBe(true);
  });

  it("does not rewrite deleted or already-current records and respects an exhausted budget", async () => {
    const deleted = member("deleted", { legacy: true }), active = member("active");
    h.projected = structuredClone([deleted, active]); h.records.delete(deleted.id);
    await migrateProducerIndex({ budgetMs: 0 });
    expect(h.records.has(PRODUCER_INDEX_MIGRATION_ID)).toBe(false);
    await migrateProducerIndex();
    expect(h.records.has(deleted.id)).toBe(false); expect(h.records.get(active.id).version).toBe(1);
    expect(h.records.get(PRODUCER_INDEX_MIGRATION_ID).data.complete).toBe(true);
  });
});
