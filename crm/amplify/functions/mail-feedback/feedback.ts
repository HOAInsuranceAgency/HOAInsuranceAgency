import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

const MAX_BODY_BYTES = 256 * 1024;
const TIMESTAMP_TOLERANCE_SECONDS = 300;
const EMAIL_FIELDS: Record<string, string> = {
  "email.sent": "sentAt",
  "email.delivered": "deliveredAt",
  "email.delivery_delayed": "deliveryDelayedAt",
  "email.failed": "failedAt",
  "email.bounced": "bouncedAt",
  "email.complained": "complainedAt",
  "email.suppressed": "suppressedAt",
};

export type FeedbackRequest = {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
};
export type FeedbackContext = { invokedFunctionArn: string };
type Environment = Record<string, string | undefined>;
type Item = Record<string, unknown>;
export type FeedbackDependencies = {
  now: () => number;
  readSecret: (arn: string) => Promise<string>;
  transact: (input: TransactWriteCommandInput) => Promise<void>;
  getEvent: (table: string, pk: string) => Promise<Item | undefined>;
  alert: (eventType: string, environment: "main" | "staging") => void;
};

class InvalidFeedback extends Error {}

export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidFeedback();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new InvalidFeedback();
  return value;
}

function address(value: unknown): string {
  if (typeof value !== "string") throw new InvalidFeedback();
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(normalized)) throw new InvalidFeedback();
  return normalized;
}

function rawBody(request: FeedbackRequest): string {
  if (typeof request.body !== "string" || !request.body.length || request.body.length > MAX_BODY_BYTES * 2) throw new InvalidFeedback();
  let bytes: Buffer;
  if (request.isBase64Encoded) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.body)) throw new InvalidFeedback();
    bytes = Buffer.from(request.body, "base64");
  } else {
    bytes = Buffer.from(request.body, "utf8");
  }
  if (bytes.length > MAX_BODY_BYTES) throw new InvalidFeedback();
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new InvalidFeedback(); }
}

function header(request: FeedbackRequest, name: string): string {
  const entries = Object.entries(request.headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  if (entries.length !== 1 || typeof entries[0][1] !== "string" || !entries[0][1]) throw new InvalidFeedback();
  return entries[0][1];
}

/** The exact Svix raw-body protocol; no parsed/re-serialized body is accepted. */
export function verifySignature(body: string, id: string, timestamp: string, signatures: string, secret: string, nowMs: number): void {
  identifier(id);
  if (!/^\d{1,12}$/.test(timestamp) || !Number.isFinite(nowMs) || Math.abs(nowMs / 1000 - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) throw new InvalidFeedback();
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new InvalidFeedback();
  const secretBytes = Buffer.from(secret.slice(6), "base64");
  if (secretBytes.length < 16 || signatures.length > 4096) throw new InvalidFeedback();
  const expected = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest();
  const matched = signatures.split(/\s+/).some((part) => {
    const match = /^v1,([A-Za-z0-9+/]{43}=)$/.exec(part);
    if (!match) return false;
    const actual = Buffer.from(match[1], "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!matched) throw new InvalidFeedback();
}

function configuration(env: Environment, context: FeedbackContext) {
  const arn = context.invokedFunctionArn.split(":");
  if (arn[0] !== "arn" || arn[1] !== "aws" || arn[2] !== "lambda" || arn[3] !== "us-east-1" || arn[4] !== "917680434255" || arn[5] !== "function" || !arn[6]
      || env.AWS_REGION !== "us-east-1" || env.HOA_MIGRATION_APP_ID !== "d1nuh9rw1hcuxo"
      || !["codex-hoa-account-migration", "codex-hoa-staging-migration"].includes(env.HOA_MIGRATION_BRANCH ?? "")
      || env.HOA_TRANSACTIONAL_MAIL_PROVIDER !== "resend"
      || env.HOA_TRANSACTIONAL_MAIL_TABLE !== "HOA-TransactionalMail"
      || !/^arn:aws:secretsmanager:us-east-1:917680434255:secret:[A-Za-z0-9/_+=.@-]+$/.test(env.RESEND_WEBHOOK_SECRET_ARN ?? "")) throw new Error("Feedback binding unavailable");
  return { table: env.HOA_TRANSACTIONAL_MAIL_TABLE, secretArn: env.RESEND_WEBHOOK_SECRET_ARN! };
}

export function feedbackTransaction(body: string, eventId: string, table: string, nowMs: number): TransactWriteCommandInput | null {
  const event = object(JSON.parse(body));
  const type = event.type;
  if (typeof type !== "string") throw new InvalidFeedback();
  const emailEvent = Object.hasOwn(EMAIL_FIELDS, type);
  if (!emailEvent && !["suppression.added", "suppression.removed"].includes(type)) return null;
  if (typeof event.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(event.created_at) || !Number.isFinite(Date.parse(event.created_at))) throw new InvalidFeedback();
  const data = object(event.data);
  const observedAt = new Date(nowMs).toISOString();
  const digest = createHash("sha256").update(body).digest("hex");
  const eventItem: Item = { pk: `EVENT#${eventId}`, kind: "EVENT", provider: "resend", eventId, eventType: type, eventCreatedAt: event.created_at, observedAt, payloadDigest: digest };
  const operations: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ Put: { TableName: table, Item: eventItem, ConditionExpression: "attribute_not_exists(pk)" } }];
  let suppress: string[] = [];
  let reason = "";
  if (emailEvent) {
    const providerId = identifier(data.email_id);
    if (typeof data.from !== "string") throw new InvalidFeedback();
    const sender = address(/<([^<>]+)>$/.exec(data.from)?.[1] ?? data.from);
    if (sender.split("@")[1] !== "protectmyhoa.com") throw new InvalidFeedback();
    if (!Array.isArray(data.to) || !data.to.length || data.to.length > 50) throw new InvalidFeedback();
    const recipients = [...new Set(data.to.map(address))];
    eventItem.providerId = providerId;
    eventItem.recipientHashes = recipients.map(emailHash);
    operations.push({ Update: {
      TableName: table, Key: { pk: `RECEIPT#${providerId}` },
      // Per-event facts survive out-of-order delivery. Arrival metadata is not a final delivery status.
      UpdateExpression: "SET #kind = if_not_exists(#kind, :kind), #provider = if_not_exists(#provider, :provider), providerId = if_not_exists(providerId, :providerId), #time = :eventTime, lastFeedbackEventId = :eventId, lastFeedbackObservedAt = :observedAt ADD feedbackEventTypes :types",
      ConditionExpression: "attribute_not_exists(pk) OR (#kind = :kind AND #provider = :provider)",
      ExpressionAttributeNames: { "#kind": "kind", "#provider": "provider", "#time": EMAIL_FIELDS[type] },
      ExpressionAttributeValues: { ":kind": "RECEIPT", ":provider": "resend", ":providerId": providerId, ":eventTime": event.created_at, ":eventId": eventId, ":observedAt": observedAt, ":types": new Set([type]) },
    } });
    if (type === "email.complained") { suppress = recipients; reason = "COMPLAINT"; }
    if (type === "email.suppressed") { suppress = recipients; reason = "RESEND_SUPPRESSED"; }
    if (type === "email.bounced") {
      const bounceType = object(data.bounce).type;
      if (bounceType !== "Permanent" && bounceType !== "Temporary" && bounceType !== "Transient") throw new InvalidFeedback();
      if (bounceType === "Permanent") { suppress = recipients; reason = "BOUNCE"; }
    }
  } else {
    const email = address(data.email);
    eventItem.emailHash = emailHash(email);
    identifier(data.id);
    if (type === "suppression.added") {
      if (!["bounce", "complaint", "manual"].includes(String(data.origin))) throw new InvalidFeedback();
      suppress = [email]; reason = String(data.origin).toUpperCase();
    }
    // Removal is recorded, but never silently clears an imported/local suppression.
    // An operator must reconcile the original reason before permitting another send.
  }
  for (const email of suppress) {
    const hash = emailHash(email);
    operations.push({ Update: {
      TableName: table, Key: { pk: `SUPPRESSION#${hash}` },
      UpdateExpression: "SET #kind = if_not_exists(#kind, :kind), emailHash = :hash, suppressed = :true, reason = if_not_exists(reason, :reason), createdAt = if_not_exists(createdAt, :createdAt), lastReason = :reason, eventId = :eventId, updatedAt = :observedAt ADD reasons :reasons",
      ConditionExpression: "attribute_not_exists(pk) OR (#kind = :kind AND emailHash = :hash)",
      ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: { ":kind": "SUPPRESSION", ":hash": hash, ":true": true, ":reason": reason, ":createdAt": event.created_at, ":eventId": eventId, ":observedAt": observedAt, ":reasons": new Set([reason]) },
    } });
  }
  return { TransactItems: operations };
}

export function createFeedbackHandler(deps: FeedbackDependencies, env: Environment) {
  return async (request: FeedbackRequest, context: FeedbackContext) => {
    const reply = (statusCode: number, status: string) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ status }) });
    if (request.requestContext?.http?.method !== "POST") return reply(405, "method_not_allowed");
    let config: ReturnType<typeof configuration>;
    try { config = configuration(env, context); } catch { return reply(503, "unavailable"); }
    let body: string, id: string, input: TransactWriteCommandInput | null;
    try {
      body = rawBody(request);
      id = header(request, "svix-id");
      const timestamp = header(request, "svix-timestamp");
      const signature = header(request, "svix-signature");
      let secret: string;
      try { secret = await deps.readSecret(config.secretArn); } catch { return reply(503, "unavailable"); }
      verifySignature(body, id, timestamp, signature, secret, deps.now());
      input = feedbackTransaction(body, id, config.table, deps.now());
    } catch { return reply(400, "invalid_feedback"); }
    if (!input) return reply(200, "ignored");
    try {
      await deps.transact(input);
      const type = input.TransactItems?.[0].Put?.Item?.eventType;
      if (typeof type === "string" && ["email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(type)) {
        deps.alert(type, env.HOA_MIGRATION_BRANCH === "codex-hoa-account-migration" ? "main" : "staging");
      }
      return reply(200, "recorded");
    }
    catch {
      // Transactions are atomic: an existing identical EVENT proves the receipt and
      // suppressions also committed, even if the original HTTP/AWS response was lost.
      try {
        const prior = await deps.getEvent(config.table, `EVENT#${id}`);
        if (prior?.kind === "EVENT" && prior.provider === "resend" && prior.payloadDigest === createHash("sha256").update(body).digest("hex")) return reply(200, "duplicate");
        if (prior) return reply(409, "event_conflict");
      } catch { /* Return retryable failure; never acknowledge an unpersisted event. */ }
      return reply(503, "persistence_unavailable");
    }
  };
}
