import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>(), db: vi.fn(), s3: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async load => ({ ...(await load<typeof import("@aws-sdk/lib-dynamodb")>()), DynamoDBDocumentClient: { from: () => ({ send: h.db }) } }));
vi.mock("@aws-sdk/client-s3", async load => ({ ...(await load<typeof import("@aws-sdk/client-s3")>()), S3Client: class { send = h.s3; } }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: h.sign }));
import { handler } from "../../amplify/functions/crm-access/handler";
const identity = { sub: "alice" };
beforeEach(() => {
  vi.clearAllMocks(); h.records.clear();
  process.env.ACCESS_TABLES = JSON.stringify({ Account: "accounts", Document: "documents", Quote: "quotes", GlApplication: "gl", PfLoan: "loans", UserProfile: "profiles" });
  process.env.COMMUNICATION_TABLE = "communications"; process.env.STORAGE_BUCKET = "bucket";
  h.records.set("communications:workflow:a", { data: { salespersonId: "alice" } });
  h.records.set("communications:workflow:b", { data: { salespersonId: "bob" } });
  h.records.set("accounts:a", { id: "a" }); h.records.set("accounts:b", { id: "b" });
  h.records.set("documents:doc", { id: "doc", entityType: "ACCOUNT", entityId: "a", s3Key: "documents/ACCOUNT/a/doc/file.pdf" });
  h.records.set("gl:a", { accountId: "a" });
  h.records.set("loans:loan", { id: "loan", accountId: "a" });
  h.records.set("profiles:bob", { id: "bob", userId: "bob" });
  h.db.mockImplementation(async ({ input }) => ({ Item: h.records.get(`${input.TableName}:${input.Key.id ?? input.Key.accountId}`) }));
  h.sign.mockResolvedValue("https://files.example.test/signed"); h.s3.mockResolvedValue({});
});
it("filters raw list/relationship responses without dropping the pagination cursor", async () => {
  const result = await handler({ mode: "read", model: "Account", identity, previous: { items: [{ id: "b", name: "Hidden" }, { id: "a", name: "Visible" }], nextToken: "cursor" } });
  expect(result).toEqual({ items: [{ id: "a", name: "Visible" }], nextToken: "cursor" });
  expect(h.db.mock.calls.every(([command]) => command.input.ConsistentRead)).toBe(true);
});
it("denies guessed IDs and preserves a missing record response", async () => {
  await expect(handler({ mode: "read", model: "Account", identity, previous: { id: "b" } })).rejects.toThrow("not available");
  expect(await handler({ mode: "read", model: "Account", identity, previous: null })).toBeNull();
});
it("keeps administrators unfiltered but requires a signed-in identity", async () => {
  const previous = { items: [{ id: "a" }, { id: "b" }] };
  expect(await handler({ mode: "read", model: "Account", identity: { sub: "admin", groups: ["ADMIN"] }, previous })).toEqual(previous);
  expect(h.db).not.toHaveBeenCalled();
  await expect(handler({ mode: "read", model: "Account", previous })).rejects.toThrow("not available");
});
it("uses accountId for models with a natural key and returns the preceding pipeline value", async () => {
  expect(await handler({ mode: "write", model: "GlApplication", operation: "update", arguments: { input: { accountId: "a", description: "Updated" } }, identity, previous: {} })).toEqual({});
  expect(h.db.mock.calls.some(([command]) => command.input.TableName === "gl" && command.input.Key.accountId === "a")).toBe(true);
});
it("blocks direct file calls for another account before signing or deleting anything", async () => {
  for (const operation of ["read", "write", "delete"]) await expect(handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation, path: "generated/b/form.pdf", sizeBytes: 10 } })).rejects.toThrow("not available");
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
it("reserves raw bucket listings for administrator templates", async () => {
  await expect(handler({ info: { fieldName: "crmFile" }, identity, arguments: { operation: "list", path: "templates/" } })).rejects.toThrow("not available");
  await expect(handler({ info: { fieldName: "crmFile" }, identity: { sub: "admin", groups: ["ADMIN"] }, arguments: { operation: "list", path: "documents/" } })).rejects.toThrow("not available");
  expect(h.s3).not.toHaveBeenCalled();
});
it("applies custom before/after guards to the real handler event shape", async () => {
  await expect(handler({ mode: "custom-pre", field: "startHoneycombSubmission", identity, arguments: { accountId: "b" } })).rejects.toThrow("not available");
  expect(await handler({ mode: "custom-post", field: "communicationRead", identity, arguments: { readOperation: "work" }, previous: JSON.stringify({ ok: true, items: [{ accountId: "b" }], nextToken: "next" }) })).toEqual({ ok: true, items: [], nextToken: "next" });
});
