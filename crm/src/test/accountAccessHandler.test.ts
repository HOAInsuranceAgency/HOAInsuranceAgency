import { beforeEach, expect, it, vi } from "vitest";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
const h = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>(), db: vi.fn(), s3: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async load => ({ ...(await load<typeof import("@aws-sdk/lib-dynamodb")>()), DynamoDBDocumentClient: { from: () => ({ send: h.db }) } }));
vi.mock("@aws-sdk/client-s3", async load => ({ ...(await load<typeof import("@aws-sdk/client-s3")>()), S3Client: class { send = h.s3; } }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: h.sign }));
import { handler } from "../../amplify/functions/crm-access/handler";
import { ACCOUNT_MODELS, RETIRED_MODELS, LIST_PARENTS, type RecordData } from "../../amplify/functions/crm-access/policy";
const identity = { sub: "alice" };
it.each(["source", "leadSource", "leadAttribution"])("keeps %s immutable even when the caller can delete leads", async field => {
  for (const groups of [["ADMIN"], ["OWNER"], ["PRODUCER"], ["STAFF"]]) {
    for (const operation of ["create", "update"]) {
      for (const value of ["changed", null]) {
        await expect(handler({
          mode: "write", model: "Account", operation,
          identity: { sub: "alice", groups },
          arguments: { input: { id: "a", [field]: value } },
        })).rejects.toThrow("not available");
      }
    }
  }
});
it.each(["ADMIN", "OWNER"])("lets %s finish deleting a lead whose automated work was already retired", async role => {
  const identity = { sub: "alice", groups: [role, "PRODUCER"] };
  const request = { headers: { "x-crm-role": role } };
  h.records.set("communications:deleted-account:a", { id: "deleted-account:a" });
  await expect(handler({ mode: "admin", identity, request, previous: "allowed" })).resolves.toBe("allowed");
  await expect(handler({ mode: "write", model: "Account", operation: "delete", identity, request, arguments: { input: { id: "a" } }, previous: "allowed" })).resolves.toBe("allowed");
  await expect(handler({ mode: "admin", identity, request: { headers: { "x-crm-role": "PRODUCER" } } })).rejects.toThrow("not available");
});
it.each(["ADMIN", "OWNER", "PRODUCER", "STAFF"])("keeps normal account edits available to %s without acquisition fields", async role => {
  await expect(handler({
    mode: "write", model: "Account", operation: "update",
    identity: { sub: "alice", groups: [role] },
    arguments: { input: { id: "a", name: "Updated association", notes: null } }, previous: "allowed",
  })).resolves.toBe("allowed");
});
it.each(['dashboardAssignments', 'dashboardInterestPage', 'dashboardPolicyAnchors', 'dashboardLeadPlansPage', 'dashboardOpenQuotesPage', 'dashboardBoundPoliciesPage', 'dashboardQuotesPage', 'dashboardQuoteStates', 'dashboardInvoiceAnchors'])('keeps %s admin-only at the custom resolver boundary', async readOperation => {
  await expect(handler({ mode: 'custom-pre', field: 'communicationRead', identity, arguments: { readOperation, input: '{}' } })).rejects.toThrow();
  await expect(handler({ mode: 'custom-pre', field: 'communicationRead', identity: { sub: 'admin', groups: ['ADMIN'] }, arguments: { readOperation, input: '{}' } })).resolves.toBeUndefined();
});
beforeEach(() => {
  vi.clearAllMocks(); h.records.clear();
  process.env.ACCESS_TABLES = JSON.stringify({ Account: "accounts", Document: "documents", Quote: "quotes", Policy: "policies", Certificate: "certificates", Invoice: "invoices", Carrier: "carriers", License: "licenses", GlApplication: "gl", PfLoan: "loans", UserProfile: "profiles" });
  process.env.COMMUNICATION_TABLE = "communications"; process.env.STORAGE_BUCKET = "bucket";
  h.records.set("communications:workflow:a", { data: { salespersonId: "alice" } });
  h.records.set("communications:workflow:b", { data: { salespersonId: "bob" } });
  h.records.set("accounts:a", { id: "a" }); h.records.set("accounts:b", { id: "b" });
  h.records.set("documents:doc", { id: "doc", entityType: "ACCOUNT", entityId: "a", s3Key: "documents/ACCOUNT/a/doc/file.pdf" });
  h.records.set("gl:a", { accountId: "a" });
  h.records.set("loans:loan", { id: "loan", accountId: "a" });
  h.records.set("profiles:bob", { id: "bob", userId: "bob" });
  h.db.mockImplementation(async ({ input }) => {
    if (input.RequestItems) return { Responses: Object.fromEntries(Object.entries(input.RequestItems).map(([table, request]) => [table,
      (request as { Keys: RecordData[] }).Keys.flatMap(key => {
        const record = h.records.get(`${table}:${key.id ?? key.accountId}`);
        return record ? [{ ...record, ...key }] : [];
      }),
    ])) };
    return { Item: h.records.get(`${input.TableName}:${input.Key.id ?? input.Key.accountId}`) };
  });
  h.sign.mockResolvedValue("https://files.example.test/signed"); h.s3.mockResolvedValue({});
});
it("filters raw list/relationship responses without dropping the pagination cursor", async () => {
  const result = await handler({ mode: "read", model: "Account", identity, previous: { items: [{ id: "b", name: "Hidden" }, { id: "a", name: "Visible" }], nextToken: "cursor" } });
  expect(result).toEqual({ items: [{ id: "a", name: "Visible" }], nextToken: "cursor" });
  expect(h.db.mock.calls.every(([command]) => command.input.ConsistentRead || Object.values(command.input.RequestItems ?? {}).every(request => (request as { ConsistentRead?: boolean }).ConsistentRead))).toBe(true);
});
it("authorizes account search only as a read and filters names by current assignment with consistent batched reads", async () => {
  const args = { readOperation: "searchAccounts", input: { query: "community" } };
  await expect(handler({ mode: "custom-pre", field: "communicationRead", identity, arguments: args })).resolves.toBeUndefined();
  await expect(handler({ mode: "custom-pre", field: "communicationWrite", identity, arguments: { operation: "searchAccounts", input: args.input } })).rejects.toThrow();
  const previous = { ok: true, items: [{ id: "a", name: "My community" }, { id: "b", name: "Private community" }], nextToken: "later" };
  const event = { mode: "custom-post" as const, field: "communicationRead", identity, arguments: args, previous };
  expect(await handler(event)).toEqual({ ...previous, items: [previous.items[0]] });
  expect(h.db.mock.calls).toHaveLength(1);
  expect(h.db.mock.calls[0][0].input.RequestItems.communications.ConsistentRead).toBe(true);
  h.records.set("communications:workflow:a", { data: { salespersonId: "bob" } });
  expect(await handler(event)).toEqual({ ...previous, items: [] });
  h.records.set("communications:workflow:a", { data: { salespersonId: "alice" } });
  h.records.set("communications:deleted-account:a", {});
  expect(await handler(event)).toEqual({ ...previous, items: [] });
});
it("keeps admin and owner searches unrestricted unless an alternate role was selected", async () => {
  const previous = { ok: true, items: [{ id: "a", name: "A" }, { id: "b", name: "B" }], nextToken: "later" };
  const event = { mode: "custom-post" as const, field: "communicationRead", arguments: { readOperation: "searchAccounts", input: { query: "a" } }, previous };
  for (const role of ["ADMIN", "OWNER"]) {
    const identity = { sub: "alice", groups: [role, "PRODUCER"] };
    expect(await handler({ ...event, identity })).toEqual(previous);
    expect(await handler({ ...event, identity, request: { headers: { "x-crm-role": "PRODUCER" } } })).toEqual({ ...previous, items: [previous.items[0]] });
  }
});
it("fails closed on search permission read failures and malformed result shapes", async () => {
  const event = { mode: "custom-post" as const, field: "communicationRead", identity, arguments: { readOperation: "searchAccounts" }, previous: { ok: true, items: [{ id: "a", name: "A" }], nextToken: "later" } };
  h.db.mockRejectedValueOnce(new Error("assignment unavailable"));
  await expect(handler(event)).rejects.toThrow("assignment unavailable");
  for (const items of [null, [{ name: "No ID" }], Array.from({ length: 26 }, () => ({ id: "a", name: "A" }))]) {
    await expect(handler({ ...event, previous: { ...event.previous, items } })).rejects.toThrow();
  }
});
it.each(ACCOUNT_MODELS.filter(model => !RETIRED_MODELS.includes(model)))("batches permission reads for a large %s connection", async model => {
  const tables = JSON.parse(process.env.ACCESS_TABLES!);
  const items = Array.from({ length: 120 }, (_, i) => {
    const accountId = `account-${i}`, parentId = `parent-${i}`;
    h.records.set(`communications:workflow:${accountId}`, { data: { salespersonId: i % 2 === 0 ? "alice" : "bob" } });
    if (i === 4) h.records.set(`communications:deleted-account:${accountId}`, {});
    const value: RecordData = { id: `record-${i}`, accountId, label: `Row ${i}` };
    if (model === "Account") value.id = accountId;
    if (model === "Activity") { value.entityId = accountId; value.accountId = "wrong-mirror"; }
    if (model === "Document") {
      const parent = ["Account", "Quote", "Policy", "Certificate"][i % 4];
      value.entityType = parent.toUpperCase(); value.entityId = parent === "Account" ? accountId : parentId;
      value.accountId = "wrong-mirror";
      h.records.set(`${tables[parent]}:${value.entityId}`, { id: value.entityId, accountId });
    }
    const parent = LIST_PARENTS[model];
    if (parent) {
      value[parent.field] = parentId; value.accountId = "wrong-mirror";
      h.records.set(`${tables[parent.model]}:${parentId}`, { id: parentId, accountId });
    }
    return value;
  });
  const result = await handler({ mode: "read", model, identity, previous: { items, nextToken: "later", startedAt: 123 } });
  expect(result).toEqual({ items: items.filter((_, i) => i % 2 === 0 && i !== 4), nextToken: "later", startedAt: 123 });
  const commands = h.db.mock.calls.map(([command]) => command.input);
  // Every row-specific read is a consistent batch. Retired team-routing
  // configuration is not read for account authorization.
  expect(commands.filter(input => input.Key)).toEqual([]);
  const batches = commands.filter(input => input.RequestItems).flatMap(input => Object.values(input.RequestItems)) as { Keys: RecordData[]; ConsistentRead: boolean }[];
  expect(batches.length).toBeLessThanOrEqual(7);
  expect(batches.every(batch => batch.Keys.length <= 100 && batch.ConsistentRead)).toBe(true);
  expect(batches.flatMap(batch => batch.Keys).some(key => String(key.id).includes("wrong-mirror"))).toBe(false);
});
it.each(["work"])("batches %s ownership reads and limits former managers to current personal assignments", async readOperation => {
  h.records.set("communications:team-routing", { data: { members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager" }] } });
  const rows = Array.from({ length: 60 }, (_, i) => {
    const accountId = `work-${i}`;
    h.records.set(`communications:workflow:${accountId}`, { data: { salespersonId: i % 3 === 0 ? "manager" : i % 3 === 1 ? "alice" : "bob" } });
    return { id: `task-${i}`, accountId };
  });
  h.records.set("communications:deleted-account:work-3", {});
  const items = [...rows, rows[0], { id: "unlinked" }];
  const previous = readOperation === "work" ? { ok: true, items, nextToken: "later" } : { ok: true, report: { items, accountCount: 60, createdAt: "today" } };
  const event = { mode: "custom-post" as const, field: "communicationRead", identity: { sub: "manager" }, arguments: { readOperation, input: { kind: "WORKFLOW" } }, previous };
  const permitted = [...rows.filter((_, i) => i % 3 === 0 && i !== 3), rows[0]];
  expect(await handler(event)).toEqual(readOperation === "work" ? { ...previous, items: permitted } : { ok: true, report: { items: permitted, accountCount: 19, createdAt: "today" } });
  expect(h.db.mock.calls).toHaveLength(2); // Two ownership batches, no routing read.
  const ownershipKeys = h.db.mock.calls.flatMap(([command]) => command.input.RequestItems?.communications?.Keys ?? []);
  expect(ownershipKeys).toHaveLength(120); expect(new Set(ownershipKeys.map(key => key.id)).size).toBe(120);
  h.records.set("communications:workflow:work-0", { data: { salespersonId: "bob" } });
  const refreshed = await handler(event) as RecordData;
  const refreshedItems = (readOperation === "work" ? refreshed.items : (refreshed.report as RecordData).items) as RecordData[];
  expect(refreshedItems.some(row => row.accountId === "work-0")).toBe(false);
});
it("batches mixed document parents while rejecting missing or invalid parents and retaining shared documents", async () => {
  h.records.set("policies:moved", { id: "moved", accountId: "b" });
  h.records.set("carriers:shared", { id: "shared" });
  const visible = { id: "visible", entityType: "ACCOUNT", entityId: "a" }, shared = { id: "shared", entityType: "CARRIER", entityId: "shared" };
  const items = [visible, shared, { id: "moved", entityType: "POLICY", entityId: "moved", accountId: "a" }, { id: "missing", entityType: "QUOTE", entityId: "gone", accountId: "a" }, { id: "invalid", entityType: "UNKNOWN", entityId: "a" }, null];
  expect(await handler({ mode: "read", model: "Document", identity, previous: { items, nextToken: "later" } })).toEqual({ items: [visible, shared], nextToken: "later" });
  expect(h.db.mock.calls.filter(([command]) => command.input.Key)).toEqual([]);
});
it.each(["parent", "ownership"])("propagates a failed %s batch instead of returning an incomplete page", async failure => {
  const normal = h.db.getMockImplementation()!;
  h.db.mockImplementation(command => command.input.RequestItems?.[failure === "parent" ? "accounts" : "communications"] ? Promise.reject(new Error("storage unavailable")) : normal(command));
  await expect(handler({ mode: "read", model: "Document", identity, previous: { items: [{ entityType: "ACCOUNT", entityId: "a" }] } })).rejects.toThrow("storage unavailable");
});
it("retries unprocessed parent and ownership keys before filtering", async () => {
  const normal = h.db.getMockImplementation()!, retried = new Set<string>();
  h.db.mockImplementation(command => {
    const table = Object.keys(command.input.RequestItems ?? {})[0];
    if (table && !retried.has(table)) { retried.add(table); return { UnprocessedKeys: command.input.RequestItems }; }
    return normal(command);
  });
  const visible = { entityType: "ACCOUNT", entityId: "a" };
  expect(await handler({ mode: "read", model: "Document", identity, previous: { items: [visible], nextToken: "later" } })).toEqual({ items: [visible], nextToken: "later" });
  expect(retried).toEqual(new Set(["accounts", "communications"]));
});
it("denies guessed IDs and preserves a missing record response", async () => {
  await expect(handler({ mode: "read", model: "Account", identity, previous: { id: "b" } })).rejects.toThrow("not available");
  expect(await handler({ mode: "read", model: "Account", identity, previous: null })).toBeNull();
});
it("denies copied account and file URLs to former managers before any file side effect", async () => {
  h.records.set("communications:team-routing", { data: { ownerId: "manager", members: [{ userId: "manager", salesManager: true }, { userId: "alice", salesManagerId: "manager", coverId: "manager", away: true }] } });
  const formerManager = { sub: "manager", groups: ["STAFF"] };
  await expect(handler({ mode: "read", model: "Account", identity: formerManager, previous: { id: "a" } })).rejects.toThrow("not available");
  await expect(handler({ fieldName: "crmAccess", identity: formerManager })).resolves.toEqual({ actorId: "manager", admin: false, salespersonIds: ["manager"] });
  for (const operation of ["read", "write", "delete"]) {
    await expect(handler({ fieldName: "crmFile", identity: formerManager, arguments: { operation, path: "documents/ACCOUNT/a/doc/file.pdf", sizeBytes: 10, validateObjectExistence: true } })).rejects.toThrow("not available");
  }
  expect(h.sign).not.toHaveBeenCalled(); expect(h.s3).not.toHaveBeenCalled();
  expect(h.db.mock.calls.some(([command]) => command.input.Key?.id === "team-routing")).toBe(false);
});
it("keeps administrators unfiltered but requires a signed-in identity", async () => {
  const previous = { items: [{ id: "a" }, { id: "b" }] };
  expect(await handler({ mode: "read", model: "Account", identity: { sub: "admin", groups: ["ADMIN"] }, previous })).toEqual(previous);
  expect(h.db).not.toHaveBeenCalled();
  await expect(handler({ mode: "read", model: "Account", previous })).rejects.toThrow("not available");
});
it.each(["PRODUCER", "STAFF"])("uses a dual-role administrator's selected %s scope across records, custom operations, and files", async role => {
  const event = { identity: { sub: "alice", groups: ["ADMIN", role] }, request: { headers: { "x-crm-role": role } } };
  await expect(handler({ ...event, fieldName: "crmAccess" })).resolves.toEqual({ actorId: "alice", admin: false, salespersonIds: ["alice"] });
  await expect(handler({ ...event, mode: "read", model: "Account", previous: { items: [{ id: "a" }, { id: "b" }], nextToken: "later" } })).resolves.toEqual({ items: [{ id: "a" }], nextToken: "later" });
  await expect(handler({ ...event, mode: "read", model: "Account", previous: { id: "b" } })).rejects.toThrow("not available");
  await expect(handler({ ...event, mode: "write", model: "Account", operation: "update", arguments: { input: { id: "b", name: "Changed" } } })).rejects.toThrow("not available");
  await expect(handler({ ...event, mode: "custom-pre", field: "sendInvoice", arguments: { invoiceId: "foreign" } })).rejects.toThrow("not available");
  await expect(handler({ ...event, mode: "custom-post", field: "communicationRead", arguments: { readOperation: "work", input: { kind: "WORKFLOW" } }, previous: { items: [{ accountId: "a" }, { accountId: "b" }] } })).resolves.toEqual({ items: [{ accountId: "a" }] });
  await expect(handler({ ...event, fieldName: "crmFile", arguments: { operation: "read", path: "generated/b/form.pdf" } })).rejects.toThrow("not available");
  await expect(handler({ ...event, mode: "admin" })).rejects.toThrow("not available");
  expect(h.sign).not.toHaveBeenCalled(); expect(h.s3).not.toHaveBeenCalled();
  await expect(handler({ ...event, request: { headers: { "x-crm-role": "ADMIN" } }, mode: "read", model: "Account", previous: { items: [{ id: "a" }, { id: "b" }] } })).resolves.toEqual({ items: [{ id: "a" }, { id: "b" }] });
  await expect(handler({ ...event, request: { headers: { "x-crm-role": "ADMIN" } }, mode: "admin", previous: "authorized" })).resolves.toBe("authorized");
});
it.each(["ADMIN", "UNKNOWN", "", ["PRODUCER"], null])("rejects unassigned or malformed role selection %j before reading data", async selected => {
  await expect(handler({ identity: { sub: "alice", groups: ["PRODUCER"] }, request: { headers: { "x-crm-role": selected } }, fieldName: "crmAccess" })).rejects.toThrow("not available");
  expect(h.db).not.toHaveBeenCalled(); expect(h.s3).not.toHaveBeenCalled();
});
it("validates mixed-case role headers and the signed JWT claims fallback", async () => {
  const identity = { sub: "alice", claims: { "cognito:groups": ["ADMIN", "PRODUCER"] } };
  await expect(handler({ identity, request: { headers: { "X-CRM-Role": "PRODUCER" } }, fieldName: "crmAccess" })).resolves.toMatchObject({ admin: false });
  await expect(handler({ identity, request: { headers: { "x-crm-role": "PRODUCER", "X-CRM-Role": "ADMIN" } }, fieldName: "crmAccess" })).rejects.toThrow("not available");
});
it("uses accountId for models with a natural key and returns the preceding pipeline value", async () => {
  expect(await handler({ mode: "write", model: "GlApplication", operation: "update", arguments: { input: { accountId: "a", description: "Updated" } }, identity, previous: {} })).toEqual({});
  expect(h.db.mock.calls.some(([command]) => command.input.TableName === "gl" && command.input.Key.accountId === "a")).toBe(true);
});
it("blocks direct file calls for another account before signing or deleting anything", async () => {
  for (const operation of ["read", "write", "delete"]) await expect(handler({ fieldName: "crmFile", identity, arguments: { operation, path: "generated/b/form.pdf", sizeBytes: 10, validateObjectExistence: true, downloadAs: "private.pdf" } })).rejects.toThrow("not available");
  expect(h.sign).not.toHaveBeenCalled(); expect(h.s3).not.toHaveBeenCalled();
});
it("signs permitted uploads with a bounded lifetime and exact content length", async () => {
  await handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation: "write", path: "documents/ACCOUNT/a/doc/file.pdf", contentType: "application/pdf", sizeBytes: 25 } });
  expect(h.sign.mock.calls[0][1].input).toEqual({ Bucket: "bucket", Key: "documents/ACCOUNT/a/doc/file.pdf", ContentLength: 25, ContentType: "application/pdf" });
  expect(h.sign.mock.calls[0][2]).toEqual({ expiresIn: 60, signableHeaders: new Set(["content-type", "content-length"]) });
  for (const sizeBytes of [undefined, 0, -1, 0.5, 101 * 1024 * 1024]) await expect(handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation: "write", path: "generated/a/form.pdf", sizeBytes } })).rejects.toThrow("100 MB");
});
it("supports existing finance PDF paths through their stored loan account", async () => {
  await handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation: "read", path: "generated/pf/loan/premium-finance-agreement.pdf" } });
  expect(h.sign).toHaveBeenCalledOnce();
  h.records.set("loans:loan", { id: "loan", accountId: "b" });
  await expect(handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation: "read", path: "generated/pf/loan/premium-finance-agreement.pdf" } })).rejects.toThrow("not available");
});
it("never signs or deletes another person's signature or a protected finance agreement", async () => {
  for (const operation of ["read", "write", "delete"]) await expect(handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation, path: "signatures/bob.png", sizeBytes: 10 } })).rejects.toThrow("not available");
  for (const operation of ["write", "delete"]) await expect(handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation, path: "generated/pf/loan/premium-finance-agreement.pdf", sizeBytes: 10 } })).rejects.toThrow("not available");
  expect(h.sign).not.toHaveBeenCalled(); expect(h.s3).not.toHaveBeenCalled();
});
it("accepts the top-level field name emitted by Amplify for access and file operations", async () => {
  await expect(handler({ fieldName: "crmAccess", identity })).resolves.toEqual({ actorId: "alice", admin: false, salespersonIds: ["alice"] });
  await handler({ fieldName: "crmFile", identity, arguments: { operation: "read", path: "templates/acord25.pdf" } });
  expect(h.sign.mock.calls[0][1].input).toEqual({ Bucket: "bucket", Key: "templates/acord25.pdf", ResponseContentDisposition: undefined });
  expect(h.s3).not.toHaveBeenCalled();
});
it("allows signed-in staff to list template pages without granting other bucket listings", async () => {
  h.s3.mockResolvedValue({ Contents: [{ Key: "templates/acord25.pdf", Size: 123, LastModified: new Date("2026-09-28T00:00:00Z") }], NextContinuationToken: "next-page" });
  await expect(handler({ fieldName: "crmFile", identity, arguments: { operation: "list", path: "templates/", nextToken: "first-page" } })).resolves.toEqual({ items: [{ path: "templates/acord25.pdf", size: 123, lastModified: "2026-09-28T00:00:00.000Z" }], nextToken: "next-page" });
  expect(h.s3.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
  expect(h.s3.mock.calls[0][0].input).toEqual({ Bucket: "bucket", Prefix: "templates/", ContinuationToken: "first-page", MaxKeys: 100 });
});
it("rejects anonymous template listings and other prefixes for both staff and administrators", async () => {
  await expect(handler({ fieldName: "crmFile", arguments: { operation: "list", path: "templates/" } })).rejects.toThrow("not available");
  for (const user of [identity, { sub: "admin", groups: ["ADMIN"] }]) {
    for (const path of ["", "documents/", "generated/a/", "templates/../", "templates"]) {
      await expect(handler({ fieldName: "crmFile", identity: user, arguments: { operation: "list", path } })).rejects.toThrow("not available");
    }
  }
  expect(h.s3).not.toHaveBeenCalled();
});
it("keeps template uploads and deletion administrator-only", async () => {
  for (const operation of ["write", "delete"]) await expect(handler({ fieldName: "crmFile", identity, arguments: { operation, path: "templates/acord25.pdf", sizeBytes: 10 } })).rejects.toThrow("not available");
  expect(h.s3).not.toHaveBeenCalled(); expect(h.sign).not.toHaveBeenCalled();
  await handler({ fieldName: "crmFile", identity: { sub: "admin", groups: ["ADMIN"] }, arguments: { operation: "write", path: "templates/acord25.pdf", sizeBytes: 10 } });
  expect(h.sign).toHaveBeenCalledOnce();
  await handler({ fieldName: "crmFile", identity: { sub: "admin", groups: ["ADMIN"] }, arguments: { operation: "delete", path: "templates/acord25.pdf" } });
  expect(h.s3).toHaveBeenCalledOnce();
});
it("checks an authorized object's existence before signing its sanitized download response", async () => {
  h.s3.mockImplementation(async command => {
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(command.input).toEqual({ Bucket: "bucket", Key: "documents/ACCOUNT/a/doc/file.pdf" });
    expect(h.sign).not.toHaveBeenCalled();
    return {};
  });
  await handler({ fieldName: "crmFile", identity, arguments: { operation: "read", path: "documents/ACCOUNT/a/doc/file.pdf", validateObjectExistence: true, downloadAs: 'budget"\r\n/2026\\.pdf' } });
  expect(h.s3).toHaveBeenCalledOnce();
  expect(h.sign.mock.calls[0][1].input).toEqual({ Bucket: "bucket", Key: "documents/ACCOUNT/a/doc/file.pdf", ResponseContentDisposition: 'attachment; filename="budget_2026.pdf"' });
  expect(h.sign.mock.calls[0][2].expiresIn).toBe(60);
});
it.each(["NotFound", "ServiceUnavailable"])("does not return a signed download when the existence check fails with %s", async name => {
  h.s3.mockRejectedValue(Object.assign(new Error(name), { name }));
  await expect(handler({ fieldName: "crmFile", identity, arguments: { operation: "read", path: "generated/a/missing.pdf", validateObjectExistence: true } })).rejects.toThrow(name);
  expect(h.s3).toHaveBeenCalledOnce(); expect(h.sign).not.toHaveBeenCalled();
});
it("skips HEAD and disposition overrides for normal previews", async () => {
  await handler({ fieldName: "crmFile", identity, arguments: { operation: "read", path: "generated/a/form.pdf", validateObjectExistence: false } });
  expect(h.s3).not.toHaveBeenCalled();
  expect(h.sign.mock.calls[0][1].input.ResponseContentDisposition).toBeUndefined();
});
it("applies custom before/after guards to the real handler event shape", async () => {
  await expect(handler({ mode: "custom-pre", field: "startHoneycombSubmission", identity, arguments: { accountId: "b" } })).rejects.toThrow("not available");
  expect(await handler({ mode: "custom-post", field: "communicationRead", identity, arguments: { readOperation: "work", input: { kind: "WORKFLOW" } }, previous: JSON.stringify({ ok: true, items: [{ accountId: "b" }], nextToken: "next" }) })).toEqual({ ok: true, items: [], nextToken: "next" });
});

it("rejects retired task model access before touching storage for every signed-in role", async () => {
  for (const groups of [[], ["ADMIN"]]) for (const mode of ["list", "read", "write"] as const) {
    await expect(handler({ mode, model: "MarketingTask", identity: { sub: "alice", groups }, operation: "create", arguments: { input: { accountId: "a" } }, previous: { items: [{ accountId: "a" }] } })).rejects.toThrow("not available");
  }
  expect(h.db).not.toHaveBeenCalled();
});


it("requires active Owner for the private profitability guard", async () => {
  const owner = { sub: "owner", groups: ["OWNER", "ADMIN", "PRODUCER"] };
  await expect(handler({ identity: owner, mode: "owner", previous: "allowed" })).resolves.toBe("allowed");
  await expect(handler({ identity: { sub: "owner", groups: ["OWNER"] }, mode: "admin", previous: "admin access" })).resolves.toBe("admin access");
  for (const selected of ["ADMIN", "PRODUCER"]) {
    await expect(handler({ identity: owner, request: { headers: { "x-crm-role": selected } }, mode: "owner" })).rejects.toThrow("not available");
  }
  await expect(handler({ identity: { sub: "admin", groups: ["ADMIN"] }, mode: "owner" })).rejects.toThrow("not available");
  await expect(handler({ identity: { sub: "admin", groups: ["ADMIN"] }, request: { headers: { "x-crm-role": "OWNER" } }, mode: "owner" })).rejects.toThrow("not available");
});
