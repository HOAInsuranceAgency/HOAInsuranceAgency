import { SESv2Client, type SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { assertDestination, hash, payload, MailDeliveryError, type MailDetails, type MailKind, type Payload } from "./contract";

const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
const secrets = new SecretsManagerClient();
const s3 = new S3Client();
type Operation = { pk: string; state: string; payloadHash: string; payloadKey?: string; providerId?: string; attempt?: number; nextRetryAt?: string };
export interface TransportDependencies {
  database: Pick<typeof db, "send">;
  storage: Pick<typeof s3, "send">;
  secrets: Pick<typeof secrets, "send">;
  fetch: typeof fetch;
  now: () => number;
}
const defaults: TransportDependencies = { database: db, storage: s3, secrets, fetch: globalThis.fetch, now: Date.now };
const logicalEnvironment = () => process.env.HOA_MIGRATION_BRANCH === "codex-hoa-account-migration" ? "main" : "staging";
const table = () => process.env.HOA_TRANSACTIONAL_MAIL_TABLE!;
function alarm(state: string, kind: MailKind, operationKey: string) {
  // No API keys, email addresses, subjects, links, or payloads in logs/metrics.
  console.error(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: "HOA/TransactionalMail", Dimensions: [["Environment"]], Metrics: [{ Name: "DeliveryNeedsReview", Unit: "Count" }] }] }, Environment: logicalEnvironment(), DeliveryNeedsReview: 1, state, kind, operationKey }));
}
async function get(pk: string, deps: TransportDependencies): Promise<any> {
  return (await deps.database.send(new GetCommand({ TableName: table(), Key: { pk }, ConsistentRead: true }))).Item;
}
export function retryAt(now: number, reason: string, retryAfter?: string | null) {
  const date = new Date(now);
  if (reason === "daily_quota_exceeded") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
  if (reason === "monthly_quota_exceeded") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
  const seconds = Number(retryAfter);
  return new Date(now + Math.max(60, Math.min(Number.isFinite(seconds) ? seconds : 60, 86400)) * 1000).toISOString();
}
async function recordFailure(operationKey: string, state: MailDeliveryError["state"], kind: MailKind, deps: TransportDependencies, attempt: number, beganSend = false, reason = "service_unavailable", nextRetryAt = retryAt(deps.now(), reason)) {
  try {
    await deps.database.send(new UpdateCommand({ TableName: table(), Key: { pk: operationKey },
      UpdateExpression: "SET #state = :state, updatedAt = :now, failureReason = :reason, nextRetryAt = :retry",
      ConditionExpression: "attribute_exists(pk) AND attempt = :attempt AND " + (beganSend ? "#state = :sending" : "(#state = :reserved OR #state = :deferred)"),
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":state": state, ":now": new Date(deps.now()).toISOString(), ":reason": reason, ":retry": nextRetryAt, ":attempt": attempt, ...(beganSend ? { ":sending": "SENDING" } : { ":reserved": "RESERVED", ":deferred": "DEFERRED" }) } }));
  } catch { /* The original durable SENDING/RESERVED row remains a fail-closed hold. */ }
  alarm(state, kind, operationKey);
  return new MailDeliveryError(state, operationKey);
}

/** Source accounts retain SES; a destination can never silently fall back to it. */
export class TransactionalMailClient {
  constructor(private readonly kind: MailKind, private readonly deps: TransportDependencies = defaults) {}
  async send(command: SendEmailCommand, details: MailDetails = {}): Promise<{ MessageId?: string }> {
    const destination = process.env.HOA_MIGRATION_AUTH === "true" || process.env.HOA_MIGRATION_APP_ID === "d1nuh9rw1hcuxo" || process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER === "resend" || process.env.HOA_MIGRATION_PREVIEW === "true" || process.env.AWS_LAMBDA_FUNCTION_NAME?.startsWith("amplify-d1nuh9rw1hcuxo-");
    if (!destination) return new SESv2Client(this.kind === "report" ? { maxAttempts: 1 } : {}).send(command);
    const body = payload(command.input, details);
    assertDestination(this.kind, body, process.env, this.deps.now());
    return this.sendResend(body, details);
  }
  /** Operator-only recovery: exact saved envelope, no business/provider event replay. */
  async replay(operationKey: string, expectedPayloadHash: string) {
    const prefix = `OP#hoa/${logicalEnvironment()}/${this.kind}/`;
    if (!operationKey.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(operationKey.slice(prefix.length)) || this.kind === "login" || this.kind === "invite") throw new Error("This email is not eligible for operator recovery.");
    const operation: Operation | undefined = await get(operationKey, this.deps);
    if (!operation || operation.payloadHash !== expectedPayloadHash || !["DEFERRED", "RESERVED"].includes(operation.state) || !operation.payloadKey) throw new Error("Only definitely unsent saved mail can be recovered. Reconcile accepted or uncertain deliveries separately.");
    const idempotencyKey = operationKey.slice(3);
    const expected = `outbox/${logicalEnvironment()}/${hash(idempotencyKey)}/${operation.payloadHash}.json`;
    if (operation.payloadKey !== expected) throw new Error("Saved mail payload binding does not match.");
    const stored = await this.deps.storage.send(new GetObjectCommand({ Bucket: process.env.HOA_TRANSACTIONAL_MAIL_BUCKET, Key: expected }));
    if (!stored.Body || (stored.ContentLength ?? 0) > 12 * 1024 * 1024) throw new Error("Saved mail payload is missing or too large.");
    const raw = await stored.Body.transformToString();
    if (Buffer.byteLength(raw) > 12 * 1024 * 1024 || hash(raw) !== operation.payloadHash) throw new Error("Saved mail payload checksum mismatch.");
    const body = JSON.parse(raw) as Payload;
    if (JSON.stringify(body) !== raw || Object.keys(body).some(k => !["from", "to", "cc", "bcc", "reply_to", "subject", "text", "html", "attachments"].includes(k))) throw new Error("Saved mail payload is not canonical.");
    assertDestination(this.kind, body, process.env, this.deps.now());
    return this.sendResend(body, {}, operationKey);
  }
  private async sendResend(body: Payload, details: MailDetails, replayKey?: string) {
    const deps = this.deps;
    const environment = logicalEnvironment();
    const encoded = JSON.stringify(body);
    const digest = hash(encoded);
    const idempotencyKey = replayKey ? replayKey.slice(3) : `hoa/${environment}/${this.kind}/${hash(details.idempotencyKey ?? digest)}`;
    const operationKey = `OP#${idempotencyKey}`;
    let operation: Operation | undefined = await get(operationKey, deps);
    if (operation && operation.payloadHash !== digest) throw new Error("The email operation already exists with different content. Review it before creating a replacement.");
    if (operation?.state === "ACCEPTED" && operation.providerId) return { MessageId: operation.providerId };
    if (operation?.state === "DEFERRED" && (!operation.nextRetryAt || !Number.isFinite(Date.parse(operation.nextRetryAt)) || Date.parse(operation.nextRetryAt) > deps.now())) throw new MailDeliveryError("DEFERRED", operationKey);
    if (operation && !["DEFERRED", "RESERVED"].includes(operation.state)) {
      alarm(operation.state, this.kind, operationKey);
      throw new MailDeliveryError(operation.state === "SUPPRESSED" ? "SUPPRESSED" : operation.state === "REJECTED" ? "REJECTED" : "UNKNOWN", operationKey);
    }
    if (!operation) {
      const payloadKey = `outbox/${environment}/${hash(idempotencyKey)}/${digest}.json`;
      // The full envelope and attachments survive quota/service failures. Never public.
      await deps.storage.send(new PutObjectCommand({ Bucket: process.env.HOA_TRANSACTIONAL_MAIL_BUCKET, Key: payloadKey, Body: encoded, ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*" })).catch((error: any) => { if (error?.$metadata?.httpStatusCode !== 412) throw error; });
      const now = new Date(deps.now()).toISOString();
      operation = { pk: operationKey, state: "RESERVED", payloadHash: digest, attempt: 0 };
      try { await deps.database.send(new PutCommand({ TableName: table(), Item: { ...operation, kind: "OPERATION", mailKind: this.kind, environment, provider: "resend", idempotencyKey, payloadKey, createdAt: now, updatedAt: now }, ConditionExpression: "attribute_not_exists(pk)" })); }
      catch (error: any) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        // Do not run a second network send on a concurrent invocation.
        const winner = await get(operationKey, deps);
        if (winner?.state === "ACCEPTED" && winner.payloadHash === digest && winner.providerId) return { MessageId: winner.providerId };
        throw new MailDeliveryError("UNKNOWN", operationKey);
      }
    }
    const recipientCost = body.to.length + (body.cc?.length ?? 0) + (body.bcc?.length ?? 0);
    const recipients = [...new Set([...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])])];
    for (const recipient of recipients) {
      const suppression = await get(`SUPPRESSION#${hash(recipient)}`, deps);
      if (suppression && suppression.suppressed !== false) throw await recordFailure(operationKey, "SUPPRESSED", this.kind, deps, operation.attempt ?? 0);
    }
    let apiKey: string;
    try {
      const secret = await deps.secrets.send(new GetSecretValueCommand({ SecretId: process.env.HOA_RESEND_SECRET_ARN }));
      apiKey = JSON.parse(secret.SecretString ?? "{}").apiKey;
      if (typeof apiKey !== "string" || !apiKey.startsWith("re_") || /\s/.test(apiKey)) throw new Error("Missing sending key.");
    } catch { throw await recordFailure(operationKey, "DEFERRED", this.kind, deps, operation.attempt ?? 0); }
    const now = new Date(deps.now()).toISOString();
    const attempt = (operation.attempt ?? 0) + 1;
    // Count every recipient and every reserved attempt conservatively. Never
    // decrement after an ambiguous response, and share limits across both backends.
    // Five recipient slots remain available for sign-in if other mail fills a day.
    const ceiling = this.kind === "login" ? 100 : 95;
    try {
      await deps.database.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: table(), Key: { pk: operationKey }, UpdateExpression: "SET #state = :sending, attempt = :attempt, updatedAt = :now", ConditionExpression: "(#state = :reserved OR #state = :deferred) AND payloadHash = :hash AND attempt = :oldAttempt", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":sending": "SENDING", ":reserved": "RESERVED", ":deferred": "DEFERRED", ":hash": digest, ":oldAttempt": operation.attempt ?? 0, ":attempt": attempt, ":now": now } } },
        ...[[`QUOTA#DAY#${now.slice(0, 10)}`, ceiling], [`QUOTA#MONTH#${now.slice(0, 7)}`, this.kind === "login" ? 3000 : 2950]].map(([pk, limit]) => ({ Update: { TableName: table(), Key: { pk }, UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :cost", ConditionExpression: "attribute_not_exists(#count) OR #count <= :remaining", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":zero": 0, ":cost": recipientCost, ":remaining": Number(limit) - recipientCost } } })),
      ] }));
    } catch (error: any) {
      if (error.name === "TransactionCanceledException") {
        const current = await get(operationKey, deps);
        if (current?.state === "ACCEPTED" && current.providerId) return { MessageId: current.providerId };
        if (["SENDING", "UNKNOWN"].includes(current?.state)) throw new MailDeliveryError("UNKNOWN", operationKey);
      }
      const month = await get(`QUOTA#MONTH#${now.slice(0, 7)}`, deps).catch(() => undefined);
      const reason = (month?.count ?? 0) + recipientCost > (this.kind === "login" ? 3000 : 2950) ? "monthly_quota_exceeded" : error.name === "TransactionCanceledException" ? "daily_quota_exceeded" : "service_unavailable";
      throw await recordFailure(operationKey, "DEFERRED", this.kind, deps, operation.attempt ?? 0, false, reason);
    }
    // Recheck the deadline after potentially slow AWS persistence/credential calls.
    try { assertDestination(this.kind, body, process.env, deps.now()); }
    catch { throw await recordFailure(operationKey, "DEFERRED", this.kind, deps, attempt, true); }
    let response: Response;
    try {
      response = await deps.fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: encoded, signal: AbortSignal.timeout(this.kind === "login" ? 2500 : 8000) });
    } catch { throw await recordFailure(operationKey, "UNKNOWN", this.kind, deps, attempt, true); }
    if (!response.ok) {
      const state = response.status === 429 ? "DEFERRED" : [400, 401, 403, 404, 413, 422].includes(response.status) ? "REJECTED" : "UNKNOWN";
      let reason = `http_${response.status}`;
      try { const parsed = await response.json(); if (typeof parsed.name === "string" && /^[a-z_]{1,80}$/.test(parsed.name)) reason = parsed.name; } catch { /* Never log a provider response body. */ }
      throw await recordFailure(operationKey, state, this.kind, deps, attempt, true, reason, retryAt(deps.now(), reason, response.headers.get("retry-after")));
    }
    let providerId: string;
    try { providerId = (await response.json()).id; if (typeof providerId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(providerId)) throw new Error("No receipt."); }
    catch { throw await recordFailure(operationKey, "UNKNOWN", this.kind, deps, attempt, true); }
    try {
      await deps.database.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: table(), Key: { pk: operationKey }, UpdateExpression: "SET #state = :accepted, providerId = :id, acceptedAt = :now, updatedAt = :now", ConditionExpression: "#state = :sending AND attempt = :attempt", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":sending": "SENDING", ":attempt": attempt, ":id": providerId, ":now": new Date(deps.now()).toISOString() } } },
        { Update: { TableName: table(), Key: { pk: `RECEIPT#${providerId}` }, UpdateExpression: "SET #kind = :kind, provider = :provider, operationKey = :operation, environment = :environment, providerId = :id, #status = :accepted, acceptedAt = :now", ConditionExpression: "attribute_not_exists(operationKey) OR operationKey = :operation", ExpressionAttributeNames: { "#kind": "kind", "#status": "status" }, ExpressionAttributeValues: { ":kind": "RECEIPT", ":provider": "resend", ":operation": operationKey, ":environment": environment, ":id": providerId, ":accepted": "ACCEPTED", ":now": new Date(deps.now()).toISOString() } } },
      ] }));
    } catch { throw await recordFailure(operationKey, "UNKNOWN", this.kind, deps, attempt, true); }
    return { MessageId: providerId };
  }
}
