import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginInvoiceSend, completeInvoiceSend, INVOICE_SEND_GENERATION, validLegacyAdoptionProof } from "../../amplify/functions/send-invoice/sendOperation";
import { hash } from "../../amplify/functions/transactional-mail/contract";

const start = Date.parse("2026-11-02T14:00:00Z");
let clock: number, row: any, proof: any, ledger: Map<string, any>, calls: any[], next: number;
const clone = (v: any) => v === undefined ? undefined : structuredClone(v);
const fail = () => { const e = new Error("conditional"); e.name = "ConditionalCheckFailedException"; throw e; };
const db = { send: vi.fn(async (command: any): Promise<any> => {
  const a = command.input; calls.push(command);
  if (command.constructor.name === "GetCommand") {
    expect(a.ConsistentRead).toBe(true);
    return { Item: clone(a.TableName === "invoices" ? row : a.Key.pk.startsWith("CONTROL#") ? proof : ledger.get(a.Key.pk)) };
  }
  expect(command.constructor.name).toBe("UpdateCommand"); expect(a.TableName).toBe("invoices");
  const v = a.ExpressionAttributeValues;
  if (a.UpdateExpression === "SET #op = :op") {
    if (v[":status"] !== row.status || v[":updated"] !== row.updatedAt
      || JSON.stringify(v[":previous"]) !== JSON.stringify(row.invoiceSendOperation)) fail();
    row.invoiceSendOperation = clone(v[":op"]);
  } else {
    if (JSON.stringify(v[":previous"]) !== JSON.stringify(row.invoiceSendOperation) || row.sentAt !== v[":sentAt"]) fail();
    row.invoiceSendOperation = clone(v[":completed"]);
  }
  return {};
}) };
const deps = () => ({ database: db as never, now: () => clock, uuid: () => `request-${++next}` });
const key = (op: { key: string }) => `OP#hoa/main/invoice/${hash(op.key)}`;
const begin = (expected: string | null | undefined = "", recipients = ["Board@example.com"]) => beginInvoiceSend(clone(row), recipients, expected, deps());
async function accepted() {
  const { operation } = await begin();
  const result = { ok: true as const, sentTo: "Board@example.com", subject: "Invoice", sentAt: new Date(clock).toISOString() };
  row.sentAt = result.sentAt; row.status = "SENT"; row.updatedAt = result.sentAt;
  ledger.set(key(operation), { state: "ACCEPTED", providerId: "accepted-original" });
  await completeInvoiceSend(row.id, operation, "accepted-original", result, deps());
  return { operation, result };
}
beforeEach(() => {
  clock = start; next = 0; calls = []; ledger = new Map(); db.send.mockClear();
  row = { id: "invoice-1", status: "DRAFT", createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T11:00:00Z" };
  vi.stubEnv("INVOICE_TABLE", "invoices"); vi.stubEnv("HOA_TRANSACTIONAL_MAIL_TABLE", "HOA-TransactionalMail");
  vi.stubEnv("HOA_MIGRATION_APP_ID", "d1nuh9rw1hcuxo"); vi.stubEnv("HOA_MIGRATION_BRANCH", "codex-hoa-account-migration");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "amplify-d1nuh9rw1hcuxo-main-sendInvoice");
  proof = { schema: 1, status: "ROOT_REVIEWED_ZERO_LEGACY_INVOICE_OPERATIONS", generation: INVOICE_SEND_GENERATION,
    account: "917680434255", app: "d1nuh9rw1hcuxo", environment: "main", runtimeBranch: "codex-hoa-account-migration",
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME, deployedCodeSha256: `${"A".repeat(43)}=`, inventorySha256: "a".repeat(64),
    deploymentVerifiedAt: "2026-11-02T13:00:00Z", scanStartedAt: "2026-11-02T13:01:01Z", observedAt: "2026-11-02T13:01:10Z",
    invoiceOperationCount: 0, consistentRead: true, completePagination: true };
});
afterEach(() => vi.unstubAllEnvs());

describe("invoice send reservation across business writes and delivery uncertainty", () => {
  it("pins the exact old key before link creation, then blocks UNKNOWN after updatedAt changes", async () => {
    let links = 0, provider = 0;
    const attempt = async () => {
      const { operation } = await begin();
      links++; row.stripePaymentLinkId = "plink-1"; row.updatedAt = new Date(clock + 1).toISOString();
      provider++; ledger.set(key(operation), { state: "UNKNOWN" });
      return operation;
    };
    const original = await attempt();
    expect(original.key).toBe("invoice:invoice-1:2026-11-01T11:00:00Z:Board@example.com");
    clock += 180_000;
    await expect(attempt()).rejects.toMatchObject({ state: "UNKNOWN" });
    expect([links, provider]).toEqual([1, 1]); expect(row.invoiceSendOperation.key).toBe(original.key);
  });
  it("also holds an accepted response whose invoice facts were never completed", async () => {
    const { operation } = await begin(); ledger.set(key(operation), { state: "ACCEPTED", providerId: "accepted-original" });
    row.updatedAt = new Date(clock + 5).toISOString(); clock += 180_000;
    await expect(begin()).rejects.toThrow("accepted");
  });
  it("returns the completed send for a lost caller response without creating a resend", async () => {
    const { result, operation } = await accepted();
    const writes = calls.filter(c => c.constructor.name === "UpdateCommand").length;
    expect((await begin("")).completed).toEqual(result);
    expect((await begin(undefined)).completed).toEqual(result);
    expect(row.invoiceSendOperation.key).toBe(operation.key);
    expect(calls.filter(c => c.constructor.name === "UpdateCommand")).toHaveLength(writes);
  });
  it("only the freshly observed confirmed sentAt authorizes an intentional resend", async () => {
    const prior = await accepted(); clock += 1000;
    const resend = await begin(prior.result.sentAt);
    expect(resend.operation.key).not.toBe(prior.operation.key);
    expect(resend.operation.previousSentAt).toBe(prior.result.sentAt);
    expect((await begin(prior.result.sentAt).catch(e => e)).message).toContain("in progress");
    expect(ledger.get(key(prior.operation))).toEqual({ state: "ACCEPTED", providerId: "accepted-original" });
  });
  it("does not rotate an UNKNOWN when invoice edits or recipient changes request another send", async () => {
    const { operation } = await begin(); ledger.set(key(operation), { state: "UNKNOWN" });
    row.updatedAt = new Date(clock + 1).toISOString(); row.sentAt = "2026-11-02T13:30:00Z";
    await expect(begin(row.sentAt)).rejects.toThrow("changed");
    await expect(begin("", ["other@example.com"])).rejects.toThrow("other recipients");
    expect(row.invoiceSendOperation.key).toBe(operation.key);
  });
  it("an unconsumed reservation is leased, then reused with the same key after its invocation expires", async () => {
    const a = await begin(); await expect(begin()).rejects.toThrow("in progress");
    clock += 120_001; const b = await begin();
    expect(b.operation.key).toBe(a.operation.key); expect(b.operation.leaseId).not.toBe(a.operation.leaseId);
  });
  it("one of two concurrent reservations wins the conditional write", async () => {
    const results = await Promise.allSettled([begin(), begin()]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
  });
  it.each(["UNKNOWN", "SENDING", "ACCEPTED", "DEFERRED", "RESERVED"])("does not bypass an existing legacy %s at the original key", async state => {
    const old = `invoice:${row.id}:${row.updatedAt}:Board@example.com`;
    ledger.set(key({ key: old }), { state, providerId: "old-provider" });
    await expect(begin()).rejects.toThrow(); expect(row.invoiceSendOperation).toBeUndefined();
  });
  it("holds an older un-reconstructible legacy key unless the zero-history adoption is actually certified", async () => {
    row.stripePaymentLinkId = "old-link"; row.updatedAt = "2026-11-01T11:01:00Z";
    ledger.set(key({ key: "invoice:invoice-1:lost-earlier-time:Board@example.com" }), { state: "UNKNOWN" });
    proof = undefined;
    await expect(begin()).rejects.toThrow("prior-delivery review"); expect(row.invoiceSendOperation).toBeUndefined();
  });
  it("permits a reviewed historical linked/SENT invoice without changing its customer fields", async () => {
    row.stripePaymentLinkId = "existing-link"; row.sentAt = "2026-11-01T11:00:00Z"; row.status = "SENT";
    const before = clone(row); await begin(row.sentAt);
    const { invoiceSendOperation: _, ...after } = row; expect(after).toEqual(before);
  });
  it("permits new and later-edited historical invoices under the same drained zero-operation generation proof", async () => {
    row.createdAt = "2026-11-02T13:30:00Z"; row.updatedAt = row.createdAt; await begin();
    delete row.invoiceSendOperation; row.createdAt = "2026-11-01T10:00:00Z";
    await expect(begin()).resolves.toHaveProperty("operation");
  });
  it("never marks completion without the exact reservation and persisted sentAt", async () => {
    const { operation } = await begin();
    await expect(completeInvoiceSend(row.id, operation, "accepted", { ok: true, sentAt: new Date(clock).toISOString(), sentTo: "board@example.com", subject: "Invoice" }, deps())).rejects.toThrow("conditional");
    expect(row.invoiceSendOperation.completed).toBeUndefined();
  });
  it.each([
    { invoiceOperationCount: 1 }, { consistentRead: false }, { completePagination: false }, { environment: "staging" },
    { generation: "wrong" }, { account: "637423611040" }, { functionName: "foreign" },
    { scanStartedAt: "2026-11-02T13:00:30Z" }, { observedAt: "2027-01-01T00:00:00Z" }, { inventorySha256: "bad" },
  ])("rejects invalid legacy adoption proof %j", patch => {
    expect(validLegacyAdoptionProof({ ...proof, ...patch }, "main", clock)).toBe(false);
  });
});
