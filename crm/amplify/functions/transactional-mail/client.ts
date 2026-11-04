import { SESv2Client, type SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { assertDestination, hash, payload, selectedProvider, sesConfigurationSet, trackedMailProvider, MailDeliveryError, type MailDetails, type MailKind, type MailProvider, type Payload } from "./contract";
import { sesCommand, sesFailure } from "./ses";

const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
const secrets = new SecretsManagerClient();
const s3 = new S3Client();
// A single SDK attempt is essential: SES does not deduplicate SendEmail requests.
const ses = new SESv2Client({ region: "us-east-1", maxAttempts: 1 });
type Operation = { pk: string; state: string; payloadHash: string; payloadKey?: string; provider?: string; providerId?: string; attempt?: number; nextRetryAt?: string };
export interface TransportDependencies {
  database: Pick<typeof db, "send">;
  storage: Pick<typeof s3, "send">;
  secrets: Pick<typeof secrets, "send">;
  ses?: Pick<typeof ses, "send">;
  fetch: typeof fetch;
  now: () => number;
}
const defaults: TransportDependencies = { database: db, storage: s3, secrets, ses, fetch: globalThis.fetch, now: Date.now };
const logicalEnvironment = () => process.env.HOA_MIGRATION_BRANCH === "codex-hoa-account-migration" ? "main" : "staging";
const table = () => process.env.HOA_TRANSACTIONAL_MAIL_TABLE!;
/** Resend keeps its original shared counters. SES caps require explicit configuration to expand. */
export function quotaPolicy(provider: MailProvider, kind: MailKind, now: string, env = process.env) {
  if (provider === "resend") return { dayKey: `QUOTA#DAY#${now.slice(0, 10)}`, monthKey: `QUOTA#MONTH#${now.slice(0, 7)}`, dayLimit: kind === "login" ? 100 : 95, monthLimit: kind === "login" ? 3000 : 2950 };
  const daily = Number(env.HOA_SES_DAILY_LIMIT ?? "100");
  const monthly = Number(env.HOA_SES_MONTHLY_LIMIT ?? "3000");
  if (!Number.isSafeInteger(daily) || daily < 1 || daily > 50000 || !Number.isSafeInteger(monthly) || monthly < 1 || monthly > 1550000) throw new Error("SES application limits are not configured safely.");
  return { dayKey: `QUOTA#SES#DAY#${now.slice(0, 10)}`, monthKey: `QUOTA#SES#MONTH#${now.slice(0, 7)}`, dayLimit: daily - (kind === "login" ? 0 : Math.min(5, daily - 1)), monthLimit: monthly - (kind === "login" ? 0 : Math.min(50, monthly - 1)) };
}
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
    const destination = process.env.HOA_MIGRATION_AUTH === "true" || process.env.HOA_MIGRATION_APP_ID === "d1nuh9rw1hcuxo" || trackedMailProvider(process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER) || process.env.HOA_MIGRATION_PREVIEW === "true" || process.env.AWS_LAMBDA_FUNCTION_NAME?.startsWith("amplify-d1nuh9rw1hcuxo-");
    if (!destination) return new SESv2Client(this.kind === "report" ? { maxAttempts: 1 } : {}).send(command);
    const body = payload(command.input, details);
    assertDestination(this.kind, body, process.env, this.deps.now());
    return this.sendTracked(body, details);
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
    return this.sendTracked(body, {}, operationKey);
  }
  private async sendTracked(body: Payload, details: MailDetails, replayKey?: string) {
    const deps = this.deps;
    const environment = logicalEnvironment();
    const encoded = JSON.stringify(body);
    const digest = hash(encoded);
    const idempotencyKey = replayKey ? replayKey.slice(3) : `hoa/${environment}/${this.kind}/${hash(details.idempotencyKey ?? digest)}`;
    const operationKey = `OP#${idempotencyKey}`;
    const provider = selectedProvider(this.kind, body, process.env, deps.now());
    const policy = quotaPolicy(provider, this.kind, new Date(deps.now()).toISOString());
    // Conversion is local and must succeed before reserving an attempt.
    const sesRequest = provider === "ses" ? sesCommand(body, sesConfigurationSet(), environment, this.kind, operationKey) : undefined;
    let operation: Operation | undefined = await get(operationKey, deps);
    if (operation && operation.payloadHash !== digest) throw new Error("The email operation already exists with different content. Review it before creating a replacement.");
    if (operation?.state === "ACCEPTED" && operation.providerId) return { MessageId: operation.providerId };
    if (operation?.state === "DEFERRED" && (!operation.nextRetryAt || !Number.isFinite(Date.parse(operation.nextRetryAt)) || Date.parse(operation.nextRetryAt) > deps.now())) throw new MailDeliveryError("DEFERRED", operationKey);
    if (operation && !["DEFERRED", "RESERVED"].includes(operation.state)) {
      alarm(operation.state, this.kind, operationKey);
      throw new MailDeliveryError(operation.state === "SUPPRESSED" ? "SUPPRESSED" : operation.state === "REJECTED" ? "REJECTED" : "UNKNOWN", operationKey);
    }
    if (operation && (operation.provider ?? "resend") !== provider) {
      // A provider cutover never creates a replacement send for an old operation.
      alarm("PROVIDER_REVIEW_REQUIRED", this.kind, operationKey);
      throw new MailDeliveryError(trackedMailProvider(operation.provider ?? "resend") ? "DEFERRED" : "UNKNOWN", operationKey);
    }
    if (!operation) {
      const payloadKey = `outbox/${environment}/${hash(idempotencyKey)}/${digest}.json`;
      // The full envelope and attachments survive quota/service failures. Never public.
      await deps.storage.send(new PutObjectCommand({ Bucket: process.env.HOA_TRANSACTIONAL_MAIL_BUCKET, Key: payloadKey, Body: encoded, ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*" })).catch((error: any) => { if (error?.$metadata?.httpStatusCode !== 412) throw error; });
      const now = new Date(deps.now()).toISOString();
      operation = { pk: operationKey, state: "RESERVED", payloadHash: digest, attempt: 0, provider };
      try { await deps.database.send(new PutCommand({ TableName: table(), Item: { ...operation, kind: "OPERATION", mailKind: this.kind, environment, idempotencyKey, payloadKey, createdAt: now, updatedAt: now }, ConditionExpression: "attribute_not_exists(pk)" })); }
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
    let apiKey: string | undefined;
    if (provider === "resend") {
      try {
        const secret = await deps.secrets.send(new GetSecretValueCommand({ SecretId: process.env.HOA_RESEND_SECRET_ARN }));
        apiKey = JSON.parse(secret.SecretString ?? "{}").apiKey;
        if (typeof apiKey !== "string" || !apiKey.startsWith("re_") || /\s/.test(apiKey)) throw new Error("Missing sending key.");
      } catch { throw await recordFailure(operationKey, "DEFERRED", this.kind, deps, operation.attempt ?? 0); }
    }
    const now = new Date(deps.now()).toISOString();
    const attempt = (operation.attempt ?? 0) + 1;
    // Count every recipient and every reserved attempt conservatively. Never
    // decrement after an ambiguous response, and share limits across both backends.
    // Five recipient slots remain available for sign-in if other mail fills a day.
    try {
      await deps.database.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: table(), Key: { pk: operationKey }, UpdateExpression: "SET #state = :sending, #provider = if_not_exists(#provider, :provider), attempt = :attempt, updatedAt = :now", ConditionExpression: "(#state = :reserved OR #state = :deferred) AND payloadHash = :hash AND attempt = :oldAttempt AND (attribute_not_exists(#provider) OR #provider = :provider)", ExpressionAttributeNames: { "#state": "state", "#provider": "provider" }, ExpressionAttributeValues: { ":sending": "SENDING", ":reserved": "RESERVED", ":deferred": "DEFERRED", ":provider": provider, ":hash": digest, ":oldAttempt": operation.attempt ?? 0, ":attempt": attempt, ":now": now } } },
        ...[[policy.dayKey, policy.dayLimit], [policy.monthKey, policy.monthLimit]].map(([pk, limit]) => ({ Update: { TableName: table(), Key: { pk }, UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :cost", ConditionExpression: "attribute_not_exists(#count) OR #count <= :remaining", ExpressionAttributeNames: { "#count": "count" }, ExpressionAttributeValues: { ":zero": 0, ":cost": recipientCost, ":remaining": Number(limit) - recipientCost } } })),
      ] }));
    } catch (error: any) {
      if (error.name === "TransactionCanceledException") {
        const current = await get(operationKey, deps);
        if (current?.state === "ACCEPTED" && current.providerId) return { MessageId: current.providerId };
        if (["SENDING", "UNKNOWN"].includes(current?.state)) throw new MailDeliveryError("UNKNOWN", operationKey);
      }
      const month = await get(policy.monthKey, deps).catch(() => undefined);
      const reason = (month?.count ?? 0) + recipientCost > policy.monthLimit ? "monthly_quota_exceeded" : error.name === "TransactionCanceledException" ? "daily_quota_exceeded" : "service_unavailable";
      throw await recordFailure(operationKey, "DEFERRED", this.kind, deps, operation.attempt ?? 0, false, reason);
    }
    // Recheck the deadline after potentially slow AWS persistence/credential calls.
    try { assertDestination(this.kind, body, process.env, deps.now()); if (selectedProvider(this.kind, body, process.env, deps.now()) !== provider) throw new Error("The provider selection changed before sending."); }
    catch { throw await recordFailure(operationKey, "DEFERRED", this.kind, deps, attempt, true); }
    let providerId: string;
    if (provider === "ses") {
      try {
        const result = await (deps.ses ?? ses).send(sesRequest!, { abortSignal: AbortSignal.timeout(this.kind === "login" ? 2500 : 8000) });
        if (typeof result.MessageId !== "string" || !/^[a-zA-Z0-9_-]{8,256}$/.test(result.MessageId)) throw new Error("No receipt.");
        providerId = result.MessageId;
      } catch (error) {
        const failure = sesFailure(error);
        throw await recordFailure(operationKey, failure.state, this.kind, deps, attempt, true, failure.reason);
      }
    } else {
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
      try { providerId = (await response.json()).id; if (typeof providerId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(providerId)) throw new Error("No receipt."); }
      catch { throw await recordFailure(operationKey, "UNKNOWN", this.kind, deps, attempt, true); }
    }
    try {
      await deps.database.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: table(), Key: { pk: operationKey }, UpdateExpression: "SET #state = :accepted, providerId = :id, acceptedAt = :now, updatedAt = :now", ConditionExpression: "#state = :sending AND attempt = :attempt AND #provider = :provider", ExpressionAttributeNames: { "#state": "state", "#provider": "provider" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":sending": "SENDING", ":provider": provider, ":attempt": attempt, ":id": providerId, ":now": new Date(deps.now()).toISOString() } } },
        { Update: { TableName: table(), Key: { pk: provider === "ses" ? `RECEIPT#ses#${providerId}` : `RECEIPT#${providerId}` }, UpdateExpression: "SET #kind = :kind, #provider = :provider, operationKey = :operation, operationHash = :operationHash, environment = :environment, providerId = :id, #status = :accepted, acceptedAt = :now", ConditionExpression: "(attribute_not_exists(operationKey) OR operationKey = :operation) AND (attribute_not_exists(operationHash) OR operationHash = :operationHash) AND (attribute_not_exists(#provider) OR #provider = :provider) AND (attribute_not_exists(environment) OR environment = :environment)", ExpressionAttributeNames: { "#kind": "kind", "#status": "status", "#provider": "provider" }, ExpressionAttributeValues: { ":kind": "RECEIPT", ":provider": provider, ":operation": operationKey, ":operationHash": hash(operationKey), ":environment": environment, ":id": providerId, ":accepted": "ACCEPTED", ":now": new Date(deps.now()).toISOString() } } },
      ] }));
    } catch { throw await recordFailure(operationKey, "UNKNOWN", this.kind, deps, attempt, true); }
    return { MessageId: providerId };
  }
}
