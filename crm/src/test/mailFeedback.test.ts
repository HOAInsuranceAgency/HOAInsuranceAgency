// @vitest-environment node
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackHandler, emailHash, feedbackTransaction, verifySignature, type FeedbackRequest } from "../../amplify/functions/mail-feedback/feedback";

const now = Date.parse("2026-10-30T23:40:00Z");
const secret = `whsec_${Buffer.from("test-only-webhook-secret-32-bytes!").toString("base64")}`;
const context = { invokedFunctionArn: "arn:aws:lambda:us-east-1:917680434255:function:destination-mail-feedback" };
const env = {
  AWS_REGION: "us-east-1", HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration",
  HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend", HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail",
  RESEND_WEBHOOK_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/webhook-test123",
};
const payload = (type = "email.delivered", extra: Record<string, unknown> = {}) => JSON.stringify({
  type, created_at: "2026-10-30T23:39:58.000Z",
  data: { email_id: "provider-email-id", from: "HOA Insurance Agency <noreply@protectmyhoa.com>", to: ["owner@example.com"], ...extra },
});
function request(body = payload(), id = "msg_test1", timestamp = String(now / 1000)): FeedbackRequest {
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { body, requestContext: { http: { method: "POST" } }, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` } };
}
function setup(overrides: Record<string, string | undefined> = {}) {
  const deps = { now: () => now, readSecret: vi.fn(async () => secret), transact: vi.fn(async () => undefined), getEvent: vi.fn(async () => undefined as Record<string, unknown> | undefined), alert: vi.fn() };
  return { deps, handler: createFeedbackHandler(deps, { ...env, ...overrides }) };
}

describe("Resend feedback signature and boundary", () => {
  it.each(["email.bounced", "email.complained", "email.failed", "email.suppressed"])("alerts once after newly committed %s with no recipient data", async type => {
    const { deps, handler } = setup();
    const body = payload(type, type === "email.bounced" ? { bounce: { type: "Permanent" } } : {});
    expect((await handler(request(body), context)).statusCode).toBe(200);
    expect(deps.alert).toHaveBeenCalledExactlyOnceWith(type, "main");
    expect(deps.transact.mock.invocationCallOrder[0]).toBeLessThan(deps.alert.mock.invocationCallOrder[0]);
    deps.transact.mockRejectedValue(new Error("duplicate"));
    deps.getEvent.mockResolvedValue({ kind: "EVENT", provider: "resend", payloadDigest: createHash("sha256").update(body).digest("hex") });
    expect(JSON.parse((await handler(request(body), context)).body).status).toBe("duplicate");
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });
  it("does not alert on uncommitted adverse feedback or ordinary delivery", async () => {
    const { deps, handler } = setup();
    await handler(request(), context); expect(deps.alert).not.toHaveBeenCalled();
    deps.transact.mockRejectedValue(new Error("unavailable"));
    expect((await handler(request(payload("email.failed")), context)).statusCode).toBe(503);
    expect(deps.alert).not.toHaveBeenCalled();
  });
  it("matches the independent official Svix test vector", () => {
    expect(() => verifySignature('{"event_type":"ping","data":{"success":true}}', "msg_loFOjxBNrRLzqYUf", "1731705121", "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=", "whsec_plJ3nmyCDGBKInavdOK15jsl", 1731705121000)).not.toThrow();
  });
  it("accepts the matching v1 signature among rotated signatures", async () => {
    const { deps, handler } = setup(); const input = request();
    input.headers!["svix-signature"] = `v2,not-supported v1,${Buffer.alloc(32).toString("base64")} ${input.headers!["svix-signature"]}`;
    expect((await handler(input, context)).statusCode).toBe(200); expect(deps.transact).toHaveBeenCalledTimes(1);
  });
  it.each(["body", "signature", "old_timestamp", "future_timestamp", "missing_header", "duplicate_header"])("rejects %s before any persistence", async (variant) => {
    const { deps, handler } = setup(); let input = request();
    if (variant === "body") input.body += " ";
    if (variant === "signature") input.headers!["svix-signature"] = `v1,${Buffer.alloc(32).toString("base64")}`;
    if (variant === "old_timestamp") input = request(payload(), "msg_test1", String(now / 1000 - 301));
    if (variant === "future_timestamp") input = request(payload(), "msg_test1", String(now / 1000 + 301));
    if (variant === "missing_header") delete input.headers!["svix-id"];
    if (variant === "duplicate_header") input.headers!["Svix-Id"] = "msg_test1";
    expect((await handler(input, context)).statusCode).toBe(400); expect(deps.transact).not.toHaveBeenCalled(); expect(deps.getEvent).not.toHaveBeenCalled();
  });
  it("decodes base64 without changing the signed Unicode body", async () => {
    const { handler } = setup(); const input = request(payload("email.delivered", { subject: "Résumé" }));
    input.body = Buffer.from(input.body!).toString("base64"); input.isBase64Encoded = true;
    expect((await handler(input, context)).statusCode).toBe(200);
  });
  it.each(["invalid_base64", "oversize", "invalid_json", "wrong_sender", "invalid_recipient", "unknown_bounce"])("rejects malformed %s without persistence", async (variant) => {
    const { deps, handler } = setup(); let input = request();
    if (variant === "invalid_base64") { input.body = "!invalid!"; input.isBase64Encoded = true; }
    if (variant === "oversize") input = request(payload("email.delivered", { subject: "a".repeat(256 * 1024) }));
    if (variant === "invalid_json") input = request("{");
    if (variant === "wrong_sender") input = request(payload("email.delivered", { from: "sender@another-business.com" }));
    if (variant === "invalid_recipient") input = request(payload("email.delivered", { to: ["not-an-address"] }));
    if (variant === "unknown_bounce") input = request(payload("email.bounced", { bounce: { type: "Other" } }));
    expect((await handler(input, context)).statusCode).toBe(400); expect(deps.transact).not.toHaveBeenCalled();
  });
  it.each([
    { HOA_TRANSACTIONAL_MAIL_TABLE: "production-customer-data" }, { HOA_MIGRATION_APP_ID: "old-source-app" },
    { HOA_MIGRATION_BRANCH: "main" }, { HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses" }, { AWS_REGION: "us-west-2" },
    { RESEND_WEBHOOK_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:637423611040:secret:source/secret" },
  ])("fails closed on incorrect destination binding %j", async (overrides) => {
    const { deps, handler } = setup(overrides);
    expect((await handler(request(), context)).statusCode).toBe(503);
    expect(deps.readSecret).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it("refuses the source account and non-POST requests without reads/writes", async () => {
    const { deps, handler } = setup();
    expect((await handler(request(), { invokedFunctionArn: context.invokedFunctionArn.replace("917680434255", "637423611040") })).statusCode).toBe(503);
    expect((await handler({ ...request(), requestContext: { http: { method: "GET" } } }, context)).statusCode).toBe(405);
    expect(deps.readSecret).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
});

describe("atomic feedback receipts and suppression", () => {
  it("keeps independent event facts and never overwrites adapter acceptance/operation data", () => {
    const input = feedbackTransaction(payload(), "msg_test1", env.HOA_TRANSACTIONAL_MAIL_TABLE, now)!;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems![0].Put!.ConditionExpression).toBe("attribute_not_exists(pk)");
    const update = input.TransactItems![1].Update!;
    expect(update.Key).toEqual({ pk: "RECEIPT#provider-email-id" });
    expect(update.ExpressionAttributeNames!["#time"]).toBe("deliveredAt");
    expect(update.UpdateExpression).not.toMatch(/\b(status|operationKey|environment|acceptedAt)\b/);
    expect(update.ExpressionAttributeValues![":types"]).toEqual(new Set(["email.delivered"]));
  });
  it.each(["email.bounced", "email.complained", "email.suppressed"])("atomically suppresses only impacted normalized recipients for %s", (type) => {
    const input = feedbackTransaction(payload(type, { to: [" OWNER@Example.com ", "owner@example.com", "second@example.com"], bounce: { type: "Permanent" } }), "msg_test1", env.HOA_TRANSACTIONAL_MAIL_TABLE, now)!;
    expect(input.TransactItems).toHaveLength(4);
    const updates = input.TransactItems!.slice(2).map((x) => x.Update!);
    expect(updates[0].Key!.pk).toBe(`SUPPRESSION#${emailHash("owner@example.com")}`);
    for (const update of updates) { expect(update.ExpressionAttributeValues![":true"]).toBe(true); expect(update.UpdateExpression).toContain("reason = if_not_exists(reason, :reason)"); }
    expect(JSON.stringify(input)).not.toMatch(/owner@|second@/);
  });
  it("records temporary bounces without turning them into permanent suppressions", () => {
    expect(feedbackTransaction(payload("email.bounced", { bounce: { type: "Temporary" } }), "msg_test1", env.HOA_TRANSACTIONAL_MAIL_TABLE, now)!.TransactItems).toHaveLength(2);
  });
  it("mirrors provider suppressions and never automatically clears existing suppressions", () => {
    const data = { id: "suppression-id", email: "owner@example.com", origin: "manual" };
    const added = feedbackTransaction(JSON.stringify({ type: "suppression.added", created_at: new Date(now).toISOString(), data }), "msg_add", env.HOA_TRANSACTIONAL_MAIL_TABLE, now)!;
    expect(added.TransactItems).toHaveLength(2); expect(added.TransactItems![1].Update!.ExpressionAttributeValues![":reason"]).toBe("MANUAL");
    const removed = feedbackTransaction(JSON.stringify({ type: "suppression.removed", created_at: new Date(now).toISOString(), data }), "msg_remove", env.HOA_TRANSACTIONAL_MAIL_TABLE, now)!;
    expect(removed.TransactItems).toHaveLength(1); expect(JSON.stringify(removed)).not.toContain("owner@example.com");
  });
  it("recognizes an atomic duplicate after a failed response only when the body digest matches", async () => {
    const { deps, handler } = setup(); const body = payload();
    deps.transact.mockRejectedValue(new Error("transaction cancelled"));
    deps.getEvent.mockResolvedValue({ kind: "EVENT", provider: "resend", payloadDigest: createHash("sha256").update(body).digest("hex") });
    expect(JSON.parse((await handler(request(body), context)).body).status).toBe("duplicate");
    expect(deps.getEvent).toHaveBeenCalledWith(env.HOA_TRANSACTIONAL_MAIL_TABLE, "EVENT#msg_test1");
  });
  it("rejects a reused event ID with a different body rather than acknowledging lost feedback", async () => {
    const { deps, handler } = setup(); deps.transact.mockRejectedValue(new Error("conflict"));
    deps.getEvent.mockResolvedValue({ kind: "EVENT", provider: "resend", payloadDigest: "different" });
    expect((await handler(request(), context)).statusCode).toBe(409);
  });
  it("returns retryable failure when the atomic write did not commit", async () => {
    const { deps, handler } = setup(); deps.transact.mockRejectedValue(new Error("throttled"));
    expect((await handler(request(), context)).statusCode).toBe(503);
  });
  it("returns retryable failure on missing secret, without persistence", async () => {
    const { deps, handler } = setup(); deps.readSecret.mockRejectedValue(new Error("unavailable"));
    expect((await handler(request(), context)).statusCode).toBe(503); expect(deps.transact).not.toHaveBeenCalled();
  });
  it.each(["email.opened", "constructor", "__proto__"])("ignores unsupported signed event %s without writes", async (type) => {
    const { deps, handler } = setup(); expect(JSON.parse((await handler(request(payload(type)), context)).body).status).toBe("ignored");
    expect(deps.transact).not.toHaveBeenCalled();
  });
});
