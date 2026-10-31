import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { TransactionalMailClient, retryAt, type TransportDependencies } from "../../amplify/functions/transactional-mail/client";
import { assertDestination, hash, payload } from "../../amplify/functions/transactional-mail/contract";

const now = Date.parse("2026-10-30T12:00:00Z");
const env = { HOA_MIGRATION_AUTH: "true", HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend", HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration", HOA_MIGRATION_PREVIEW: "true", HOA_PREVIEW_ADMIN_LOGIN: "true", HOA_RESEND_PREVIEW_ENABLED: "true", HOA_PREVIEW_ADMIN_EMAIL: "jake@getgim.com", HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT: "2026-10-30T13:00:00Z", HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail", HOA_TRANSACTIONAL_MAIL_BUCKET: "hoa-transactional-mail-917680434255-us-east-1", HOA_RESEND_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/sending-Z7Fxul", AWS_LAMBDA_FUNCTION_NAME: "amplify-d1nuh9rw1hcuxo-main-magicLinkVerify" };
const command = () => new SendEmailCommand({ FromEmailAddress: "HOA Insurance Agency <noreply@protectmyhoa.com>", Destination: { ToAddresses: ["jake@getgim.com"] }, Content: { Simple: { Subject: { Data: "[Migration test] sign-in" }, Body: { Text: { Data: "Synthetic fixture only" } } } } });
function harness(options: { http?: number; network?: boolean; quota?: boolean; suppression?: boolean; receiptFailure?: boolean } = {}) {
  const rows = new Map<string, any>();
  const transactions: any[] = [];
  const database = { send: vi.fn(async (c: any) => {
    const i = c.input;
    if (c.constructor.name === "GetCommand") return { Item: options.suppression && i.Key.pk.startsWith("SUPPRESSION#") ? { suppressed: true } : rows.get(i.Key.pk) };
    if (c.constructor.name === "PutCommand") { rows.set(i.Item.pk, { ...i.Item }); return {}; }
    if (c.constructor.name === "UpdateCommand") {
      const old = rows.get(i.Key.pk); const v = i.ExpressionAttributeValues;
      if (old && old.attempt === v[":attempt"] && (v[":sending"] ? old.state === "SENDING" : ["RESERVED", "DEFERRED"].includes(old.state))) rows.set(i.Key.pk, { ...old, state: v[":state"], nextRetryAt: v[":retry"] });
      return {};
    }
    if (c.constructor.name === "TransactWriteCommand") {
      transactions.push(i);
      const update = i.TransactItems[0].Update; const v = update.ExpressionAttributeValues;
      if (v[":sending"] && !v[":accepted"]) {
        if (options.quota) throw Object.assign(new Error("quota"), { name: "TransactionCanceledException" });
        const old = rows.get(update.Key.pk); if (!["RESERVED", "DEFERRED"].includes(old.state)) throw Object.assign(new Error("race"), { name: "TransactionCanceledException" });
        rows.set(update.Key.pk, { ...old, state: "SENDING", attempt: v[":attempt"] });
      } else {
        if (options.receiptFailure) throw new Error("receipt write failed");
        rows.set(update.Key.pk, { ...rows.get(update.Key.pk), state: "ACCEPTED", providerId: v[":id"] });
      }
      return {};
    }
    throw new Error("Unexpected DB command");
  }) };
  const fetchMock = vi.fn(async () => { if (options.network) throw new TypeError("network"); return new Response(JSON.stringify({ id: "resend-message-123456" }), { status: options.http ?? 200 }); });
  const objects = new Map<string, string>();
  const storage = { send: vi.fn(async (c: any) => { if (c.constructor.name === "GetObjectCommand") return { Body: { transformToString: async () => objects.get(c.input.Key)! }, ContentLength: objects.get(c.input.Key)?.length }; objects.set(c.input.Key, c.input.Body); return {}; }) };
  const secrets = { send: vi.fn(async () => ({ SecretString: JSON.stringify({ apiKey: "re_fixture" }) })) };
  return { rows, objects, transactions, database, storage, secrets, fetchMock, deps: { database, storage, secrets, fetch: fetchMock, now: () => now } as unknown as TransportDependencies };
}
beforeEach(() => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("destination transport fences", () => {
  for (const [name, patch] of Object.entries({ wrongApp: { HOA_MIGRATION_APP_ID: "old" }, wrongBranch: { HOA_MIGRATION_BRANCH: "main" }, wrongAccount: { HOA_RESEND_SECRET_ARN: env.HOA_RESEND_SECRET_ARN.replace("917680434255", "637423611040") }, missingPreview: { HOA_MIGRATION_PREVIEW: "" }, expired: { HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT: "2026-10-30T11:00:00Z" }, disabled: { HOA_PREVIEW_ADMIN_LOGIN: "false" }, wrongRuntime: { AWS_LAMBDA_FUNCTION_NAME: "source-function" } })) {
    it(`blocks ${name} before credentials, persistence, and HTTPS`, async () => {
      for (const [k, v] of Object.entries(patch)) vi.stubEnv(k, v);
      const h = harness(); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toThrow();
      expect(h.secrets.send).not.toHaveBeenCalled(); expect(h.database.send).not.toHaveBeenCalled(); expect(h.storage.send).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled();
    });
  }
  it("blocks every business sender in preview", () => { for (const kind of ["invite", "invoice", "report", "accounting"] as const) expect(() => assertDestination(kind, payload(command().input, {}), env, now)).toThrow(); });
  it("rejects a customer or hidden BCC during owner preview", () => { for (const field of ["to", "cc", "bcc"]) expect(() => assertDestination("login", { ...payload(command().input, {}), [field]: ["customer@example.com"] }, env, now)).toThrow(); });
  it("requires separate release approval and keeps staging owner-only", () => {
    const body = payload(command().input, {});
    expect(() => assertDestination("invoice", body, { ...env, HOA_MIGRATION_PREVIEW: "false" }, now)).toThrow();
    expect(() => assertDestination("invoice", body, { ...env, HOA_MIGRATION_PREVIEW: "false", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_MIGRATION_WORKERS_ENABLED: "true" }, now)).not.toThrow();
    expect(() => assertDestination("invoice", { ...body, to: ["customer@example.com"] }, { ...env, HOA_MIGRATION_PREVIEW: "false", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_MIGRATION_WORKERS_ENABLED: "true", HOA_MIGRATION_BRANCH: "codex-hoa-staging-migration" }, now)).toThrow();
  });
  it("accepts only the exact existing main and staging report runtime names", () => {
    for (const [branch, name] of [["codex-hoa-account-migration", "marketing-report-mplifyd1nuh9rw1hcuxomainbranch0e4fdbd849"], ["codex-hoa-staging-migration", "marketing-report-ifyd1nuh9rw1hcuxostagingbranch3787a09124"]]) {
      const bound = { ...env, HOA_MIGRATION_BRANCH: branch, AWS_LAMBDA_FUNCTION_NAME: name, HOA_MIGRATION_PREVIEW: "false", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_MIGRATION_WORKERS_ENABLED: "true" };
      expect(() => assertDestination("report", payload(command().input, {}), bound, now)).not.toThrow();
      expect(() => assertDestination("report", payload(command().input, {}), { ...bound, AWS_LAMBDA_FUNCTION_NAME: name + "-other" }, now)).toThrow();
    }
  });
});
describe("durable send semantics", () => {
  it("persists envelope, reserves shared quotas, sends once and reuses accepted receipt", async () => {
    const h = harness(); const client = new TransactionalMailClient("login", h.deps);
    expect(await client.send(command())).toEqual({ MessageId: "resend-message-123456" });
    expect(await client.send(command())).toEqual({ MessageId: "resend-message-123456" });
    expect(h.fetchMock).toHaveBeenCalledTimes(1); expect(h.storage.send).toHaveBeenCalledTimes(1);
    expect(h.transactions[0].TransactItems[1].Update.Key.pk).toBe("QUOTA#DAY#2026-10-30");
    expect(h.transactions[0].TransactItems[2].Update.ExpressionAttributeValues[":remaining"]).toBe(2999);
    const request = h.fetchMock.mock.calls[0] as any[];
    expect(request[0]).toBe("https://api.resend.com/emails"); expect(request[1].redirect).toBe("error");
    expect(request[1].headers["Idempotency-Key"]).toMatch(/^hoa\/main\/login\//);
    expect(h.transactions[1].TransactItems[1].Update.UpdateExpression).not.toMatch(/feedback|delivered|bounced/i);
  });
  it("rejects changed content under the same operation", async () => {
    const h = harness(); const client = new TransactionalMailClient("login", h.deps); await client.send(command(), { idempotencyKey: "same" });
    await expect(client.send(command(), { idempotencyKey: "same", text: "changed" })).rejects.toThrow("different content"); expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
  it("holds uncertain network sends permanently instead of retrying after provider expiry", async () => {
    const h = harness({ network: true }); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    expect(h.fetchMock).toHaveBeenCalledTimes(1); expect([...h.rows.values()][0].state).toBe("UNKNOWN");
  });
  it("saves quota exhaustion without contacting the provider", async () => {
    const h = harness({ quota: true }); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.storage.send).toHaveBeenCalledOnce(); expect([...h.rows.values()][0].state).toBe("DEFERRED");
  });
  it("checks the shared suppression mirror before reading sending credentials", async () => {
    const h = harness({ suppression: true }); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "SUPPRESSED" });
    expect(h.secrets.send).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.database.send.mock.calls.some(([c]: any) => c.input.Key?.pk === `SUPPRESSION#${hash("jake@getgim.com")}`)).toBe(true);
  });
  for (const [http, state] of [[429, "DEFERRED"], [403, "REJECTED"], [422, "REJECTED"], [409, "UNKNOWN"], [500, "UNKNOWN"]] as const) it(`records HTTP ${http} as ${state}`, async () => {
    const h = harness({ http }); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state }); expect(h.fetchMock).toHaveBeenCalledOnce();
  });
  it("holds accepted sends when local receipt persistence fails", async () => {
    const h = harness({ receiptFailure: true }); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); expect(h.fetchMock).toHaveBeenCalledOnce();
  });
  it("honors rate/daily/monthly cooldowns without a repeat provider call", async () => {
    expect(retryAt(now, "daily_quota_exceeded")).toBe("2026-10-31T00:00:00.000Z");
    expect(retryAt(now, "monthly_quota_exceeded")).toBe("2026-11-01T00:00:00.000Z");
    expect(retryAt(now, "rate_limit_exceeded", "120")).toBe("2026-10-30T12:02:00.000Z");
    const h = harness({ http: 429 }); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });
  it("rechecks owner expiry immediately before HTTPS after slow persistence", async () => {
    const h = harness(); h.secrets.send.mockImplementation(async () => { h.deps.now = () => Date.parse(env.HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT) + 1; return { SecretString: JSON.stringify({ apiKey: "re_fixture" }) }; });
    await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" }); expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it("blocks a provider preview grant disabled while credentials were loading", async () => {
    const h = harness(); h.secrets.send.mockImplementation(async () => { vi.stubEnv("HOA_RESEND_PREVIEW_ENABLED", "false"); return { SecretString: JSON.stringify({ apiKey: "re_fixture" }) }; });
    await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" }); expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it("recovers only a reviewed definitely-unsent envelope without running a business event", async () => {
    vi.stubEnv("HOA_MIGRATION_PREVIEW", "false"); vi.stubEnv("HOA_TRANSACTIONAL_MAIL_RELEASE", "true"); vi.stubEnv("HOA_MIGRATION_WORKERS_ENABLED", "true");
    const options = { http: 429 }; const h = harness(options); const client = new TransactionalMailClient("accounting", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    const [key, row] = [...h.rows.entries()][0];
    options.http = 200; h.deps.now = () => now + 120_000;
    await expect(client.replay(key, "0".repeat(64))).rejects.toThrow();
    expect(await client.replay(key, row.payloadHash)).toEqual({ MessageId: "resend-message-123456" });
    const first = h.fetchMock.mock.calls[0] as any[], second = h.fetchMock.mock.calls[1] as any[];
    expect(second[1].body).toBe(first[1].body); expect(second[1].headers["Idempotency-Key"]).toBe(first[1].headers["Idempotency-Key"]);
    await expect(client.replay(key, row.payloadHash)).rejects.toThrow("definitely unsent"); expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });
  it("cannot recover unknown sends or altered saved payloads", async () => {
    vi.stubEnv("HOA_MIGRATION_PREVIEW", "false"); vi.stubEnv("HOA_TRANSACTIONAL_MAIL_RELEASE", "true"); vi.stubEnv("HOA_MIGRATION_WORKERS_ENABLED", "true");
    const h = harness({ network: true }); const client = new TransactionalMailClient("accounting", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); const [key, row] = [...h.rows.entries()][0];
    await expect(client.replay(key, row.payloadHash)).rejects.toThrow("definitely unsent");
    row.state = "DEFERRED"; row.nextRetryAt = new Date(now - 1).toISOString(); h.objects.set(row.payloadKey, "{}");
    await expect(client.replay(key, row.payloadHash)).rejects.toThrow("checksum"); expect(h.fetchMock).toHaveBeenCalledOnce();
  });
});
describe("message fidelity", () => {
  it("keeps BCC outside content, UTF-8, reply-to and byte-exact PDF/XLSX attachments", () => {
    const pdf = Buffer.from("%PDF-1.7\nfixture"); const xlsx = Uint8Array.from([80, 75, 3, 4, 255]);
    const input = command().input; input.Destination!.BccAddresses = ["insurance@protectmyhoa.com"];
    const body = payload(input, { subject: "HOA — résumé", replyTo: "insurance@protectmyhoa.com", attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", content: pdf }, { filename: "report.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: xlsx }] });
    expect(body.bcc).toEqual(["insurance@protectmyhoa.com"]); expect(body.text).not.toContain("insurance@"); expect(body.subject).toBe("HOA — résumé"); expect(body.reply_to).toBe("insurance@protectmyhoa.com");
    expect(Buffer.from(body.attachments![0].content, "base64")).toEqual(pdf); expect(Buffer.from(body.attachments![1].content, "base64")).toEqual(Buffer.from(xlsx));
  });
  it("refuses raw MIME without structured content rather than dropping its attachments", () => { expect(() => payload({ ...command().input, Content: { Raw: { Data: Buffer.from("mime") } } }, {})).toThrow("structured"); });
});
