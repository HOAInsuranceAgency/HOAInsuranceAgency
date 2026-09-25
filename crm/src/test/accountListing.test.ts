import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>(), db: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async load => ({ ...(await load<typeof import("@aws-sdk/lib-dynamodb")>()), DynamoDBDocumentClient: { from: () => ({ send: h.db }) } }));
import { AccountAccess } from "../../amplify/functions/crm-access/access";
import { listAssigned, matchesFilter } from "../../amplify/functions/crm-access/listing";
import { ACCOUNT_MODELS, listPartition, type RecordData } from "../../amplify/functions/crm-access/policy";
const put = (model: string, key: string, data: RecordData) => h.records.set(`${model}:${key}`, data);
const access = (sub = "alice") => new AccountAccess({ sub });
function account(key: string, owner: string) {
  put("Account", key, { id: key, name: key, stage: "LEAD" });
  put("Communication", `workflow:${key}`, { id: `workflow:${key}`, accountId: key, assignedSalespersonId: owner, data: { salespersonId: owner } });
}
beforeEach(() => {
  h.records.clear(); h.db.mockReset();
  process.env.COMMUNICATION_TABLE = "Communication";
  process.env.ACCESS_TABLES = JSON.stringify(Object.fromEntries(ACCOUNT_MODELS.map(model => [model, model])));
  process.env.ACCESS_INDEXES = JSON.stringify(Object.fromEntries([...ACCOUNT_MODELS.map(model => [`${model}.${listPartition(model)}`, `by_${listPartition(model)}`]), ["Document.entityType", "by_entityType"]]));
  put("Communication", "migration:assignment-index:v1", { data: { complete: true } });
  put("Communication", "team-routing", { data: { members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager" }, { userId: "bob", salesManagerId: "elsewhere" }] } });
  account("a", "alice"); account("b", "bob");
  h.db.mockImplementation(async command => {
    const input = command.input;
    if (command.constructor.name === "ScanCommand") throw new Error("A scoped list must never scan");
    if (input.RequestItems) return { Responses: Object.fromEntries(Object.entries(input.RequestItems).map(([model, request]) => [model, (request as { Keys: RecordData[] }).Keys.map(key => h.records.get(`${model}:${key.id ?? key.accountId}`)).filter(Boolean)])) };
    if (input.Key) return { Item: h.records.get(`${input.TableName}:${input.Key.id ?? input.Key.accountId}`) };
    const field = input.ExpressionAttributeNames["#scope"], key = input.ExpressionAttributeValues[":scope"];
    const all = [...h.records.entries()].filter(([k, value]) => k.startsWith(`${input.TableName}:`) && value[field] === key).map(([, v]) => v).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const start = input.ExclusiveStartKey ? all.findIndex(item => item.id === input.ExclusiveStartKey.id) + 1 : 0;
    const items = all.slice(start, start + input.Limit);
    return { Items: items, ...(start + items.length < all.length ? { LastEvaluatedKey: { id: items.at(-1)!.id, [field]: key } } : {}) };
  });
});
async function allPages(model: string, sub = "alice", filter?: RecordData) {
  const items: RecordData[] = []; let nextToken: string | null | undefined;
  for (let count = 0; count < 100; count++) {
    const page = await listAssigned(access(sub), model, { limit: 1, filter, nextToken });
    items.push(...page.items as RecordData[]); nextToken = page.nextToken;
    if (!nextToken) return items;
  }
  throw new Error("Pagination did not terminate");
}
describe("assignment-scoped listings", () => {
  it("uses assignment queries and batched reads regardless of unrelated account count", async () => {
    for (let i = 0; i < 1000; i++) account(`unrelated-${i}`, "bob");
    account("a2", "alice");
    const page = await listAssigned(access(), "Account", {});
    expect(page.items).toMatchObject([{ id: "a" }, { id: "a2" }]);
    expect(page.nextToken).toBeNull();
    const queries = h.db.mock.calls.map(([c]) => c).filter(c => c.input.IndexName);
    expect(queries).toHaveLength(1);
    expect(queries[0].input).toMatchObject({ IndexName: "assignment", ExpressionAttributeValues: { ":scope": "alice" } });
    expect(h.db.mock.calls).toHaveLength(5); // team, migration, assignment query, ownership batch, account batch
    expect(h.db.mock.calls.filter(([c]) => c.input.RequestItems)).toHaveLength(2);
  });
  it("paginates manager-owned accounts and direct reports without other teams", async () => {
    account("manager-account", "manager"); account("a2", "alice");
    expect((await allPages("Account", "manager")).map(r => r.id)).toEqual(["a", "a2", "manager-account"]);
  });
  it("returns a cursor for an empty filtered page and preserves later results", async () => {
    account("a2", "alice");
    const first = await listAssigned(access(), "Account", { limit: 1, filter: { name: { eq: "a2" } } });
    expect(first.items).toEqual([]); expect(first.nextToken).toBeTruthy();
    const second = await listAssigned(access(), "Account", { limit: 1, filter: { name: { eq: "a2" } }, nextToken: first.nextToken });
    expect(second.items).toMatchObject([{ id: "a2" }]); expect(second.nextToken).toBeNull();
  });
  it("rejects stale GSI assignments and retired accounts", async () => {
    put("Communication", "workflow:a", { id: "workflow:a", accountId: "a", assignedSalespersonId: "alice", data: { salespersonId: "bob" } });
    account("a2", "alice"); put("Communication", "deleted-account:a2", { id: "deleted-account:a2" });
    expect((await listAssigned(access(), "Account", {})).items).toEqual([]);
  });
  it("does not present the migration or a failed ownership lookup as an empty list", async () => {
    put("Communication", "migration:assignment-index:v1", { data: { complete: false } });
    await expect(listAssigned(access(), "Account", {})).rejects.toThrow("being prepared");
    put("Communication", "migration:assignment-index:v1", { data: { complete: true } });
    const normal = h.db.getMockImplementation()!;
    h.db.mockImplementation(command => command.input.RequestItems ? Promise.reject(new Error("offline")) : normal(command));
    await expect(listAssigned(access(), "Account", {})).rejects.toThrow("offline");
  });
  it("scopes child queries to assigned accounts and preserves child pagination", async () => {
    put("Contact", "ca", { id: "ca", accountId: "a" }); put("Contact", "ca2", { id: "ca2", accountId: "a" }); put("Contact", "cb", { id: "cb", accountId: "b" });
    expect((await allPages("Contact")).map(r => r.id)).toEqual(["ca", "ca2"]);
    expect(h.db.mock.calls.filter(([c]) => c.input.TableName === "Contact").every(([c]) => c.input.ExpressionAttributeValues[":scope"] === "a")).toBe(true);
  });
  it("revokes a previously issued child-list cursor after reassignment", async () => {
    put("Contact", "ca", { id: "ca", accountId: "a" }); put("Contact", "ca2", { id: "ca2", accountId: "a" });
    const first = await listAssigned(access(), "Contact", { limit: 1 }); expect(first.nextToken).toBeTruthy();
    account("a", "bob");
    expect((await listAssigned(access(), "Contact", { limit: 1, nextToken: first.nextToken })).items).toEqual([]);
  });
  it("does not authorize a moved record using stale GSI parent fields", async () => {
    put("Contact", "moved", { id: "moved", accountId: "b", name: "Current private data" });
    const normal = h.db.getMockImplementation()!;
    h.db.mockImplementation(command => command.input.TableName === "Contact" && command.input.IndexName
      ? { Items: [{ id: "moved", accountId: "a", name: "Old projection" }] } : normal(command));
    expect((await listAssigned(access(), "Contact", {})).items).toEqual([]);
  });
  it("retries unprocessed batch keys instead of treating them as missing accounts", async () => {
    const normal = h.db.getMockImplementation()!; let retry = true;
    h.db.mockImplementation(command => {
      if (command.input.RequestItems && retry) { retry = false; return { Responses: {}, UnprocessedKeys: command.input.RequestItems }; }
      return normal(command);
    });
    expect((await listAssigned(access(), "Account", {})).items).toMatchObject([{ id: "a" }]);
  });
  it("checks exact parent filters before querying, without enumerating assignments", async () => {
    put("Contact", "ca", { id: "ca", accountId: "a" });
    expect((await listAssigned(access(), "Contact", { filter: { accountId: { eq: "a" } } })).items).toMatchObject([{ id: "ca" }]);
    expect(h.db.mock.calls.some(([c]) => c.input.IndexName === "assignment")).toBe(false);
    await expect(listAssigned(access(), "Contact", { filter: { accountId: { eq: "b" } } })).rejects.toThrow("not available");
  });
  it("reads indirect records through their parents, including old invoice lines without accountId", async () => {
    put("Invoice", "ia", { id: "ia", accountId: "a" }); put("Invoice", "ib", { id: "ib", accountId: "b" });
    put("InvoiceLine", "line", { id: "line", invoiceId: "ia" }); put("InvoiceLine", "foreign", { id: "foreign", invoiceId: "ib", accountId: "a" });
    expect((await allPages("InvoiceLine")).map(r => r.id)).toEqual(["line"]);
  });
  it("includes account, legacy nested, and shared documents without foreign documents", async () => {
    put("Policy", "pa", { id: "pa", accountId: "a" }); put("Carrier", "shared", { id: "shared" });
    process.env.ACCESS_TABLES = JSON.stringify({ ...JSON.parse(process.env.ACCESS_TABLES!), Carrier: "Carrier" });
    for (const [key, type, parent] of [["da", "ACCOUNT", "a"], ["db", "ACCOUNT", "b"], ["dp", "POLICY", "pa"], ["dc", "CARRIER", "shared"]]) put("Document", key, { id: key, entityType: type, entityId: parent });
    expect((await allPages("Document")).map(r => r.id)).toEqual(["da", "dp", "dc"]);
  });
  it("handles singleton applications and binds cursors to actor, team, model, and filter", async () => {
    put("GlApplication", "a", { accountId: "a" });
    expect(await allPages("GlApplication")).toEqual([{ accountId: "a" }]);
    account("a2", "alice"); const first = await listAssigned(access(), "Account", { limit: 1 });
    for (const [sub, model, filter] of [["bob", "Account", {}], ["alice", "Contact", {}], ["alice", "Account", { stage: { eq: "CLIENT" } }]] as const) await expect(listAssigned(access(sub), model, { nextToken: first.nextToken, filter })).rejects.toThrow("Refresh");
    const forged = JSON.parse(Buffer.from(first.nextToken!, "base64url").toString()); forged.account = "b";
    expect((await listAssigned(access(), "Account", { nextToken: Buffer.from(JSON.stringify(forged)).toString("base64url") })).items).toEqual([]);
  });
});
it("retains search, date, numeric, boolean, and nested filter behavior", () => {
  const record = { name: "Willow HOA", amount: 100, active: true, date: "2026-09-25", lines: ["Property"] };
  expect(matchesFilter(record, { and: [{ name: { contains: "Willow", beginsWith: "Will" } }, { amount: { between: [99, 100], ge: 100, lt: 101 } }, { or: [{ date: { ge: "2026-09-01" } }, { active: { eq: false } }] }], not: { name: { eq: "Other" } }, lines: { contains: "Property" } })).toBe(true);
  expect(matchesFilter(record, { amount: { gt: 100 } })).toBe(false);
  expect(matchesFilter(record, { name: { size: { ge: 4 } }, active: { attributeType: "BOOL" }, absent: { attributeExists: false } })).toBe(true);
  expect(() => matchesFilter(record, { name: { unsupported: true } })).toThrow("Unsupported");
});
