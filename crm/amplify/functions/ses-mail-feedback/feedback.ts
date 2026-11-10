import { STAGING_BUSINESS_RECIPIENTS, STAGING_LOGIN_RECIPIENTS } from "../transactional-mail/staging-recipients";
import { createHash } from "node:crypto";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

type Item = Record<string, unknown>;
type Environment = Record<string, string | undefined>;
type BusinessEnvironment = "main" | "staging";
type Context = { invokedFunctionArn: string };
export type SesFeedbackDependencies = {
  now: () => number;
  getItem: (table: string, pk: string) => Promise<Item | undefined>;
  transact: (input: TransactWriteCommandInput) => Promise<void>;
  alert: (eventType: string, environment: BusinessEnvironment) => void;
};
export const sesHash = (value: string) => createHash("sha256").update(value).digest("hex");
const MAX_BODY_BYTES = 256 * 1024;
const TOPICS = { main: "arn:aws:sns:us-east-1:917680434255:hoa-transactional-main-feedback", staging: "arn:aws:sns:us-east-1:917680434255:hoa-transactional-staging-feedback" } as const;
const IDENTITY = "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com";
const SENDERS = { main: new Set(["noreply@protectmyhoa.com", "insurance@protectmyhoa.com"]), staging: new Set(["noreply@protectmyhoa.com", "jake+testing@protectmyhoa.com"]) };
const FIELDS: Record<string, string> = { Send: "sentAt", Delivery: "deliveredAt", DeliveryDelay: "deliveryDelayedAt", Bounce: "bouncedAt", Complaint: "complainedAt", Reject: "rejectedAt", "Rendering Failure": "renderingFailedAt" };
const ADVERSE = new Set(["DeliveryDelay", "Bounce", "Complaint", "Reject", "Rendering Failure"]);
const OPERATION_KEY = /^OP#hoa\/(main|staging)\/(login|invite|invoice|report|accounting|test)\/[a-f0-9]{64}$/;
class InvalidSesFeedback extends Error { constructor() { super("Invalid SES feedback"); this.name = "InvalidSesFeedback"; } }
function object(value: unknown): Item {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidSesFeedback();
  return value as Item;
}
function identifier(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidSesFeedback();
  return value;
}
function address(value: unknown): string {
  if (typeof value !== "string" || /[\r\n]/.test(value)) throw new InvalidSesFeedback();
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(normalized)) throw new InvalidSesFeedback();
  return normalized;
}
function instant(value: unknown, now: number): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now + 300_000) throw new InvalidSesFeedback();
  return new Date(value).toISOString();
}
function tag(tags: Item, name: string): string {
  const values = tags[name];
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string") throw new InvalidSesFeedback();
  return values[0];
}
function configuration(env: Environment, context: Context) {
  const arn = context.invokedFunctionArn.split(":");
  const environment: BusinessEnvironment | undefined = env.HOA_MIGRATION_BRANCH === "codex-hoa-account-migration" ? "main" : env.HOA_MIGRATION_BRANCH === "codex-hoa-staging-migration" ? "staging" : undefined;
  if (arn[0] !== "arn" || arn[1] !== "aws" || arn[2] !== "lambda" || arn[3] !== "us-east-1" || arn[4] !== "917680434255" || arn[5] !== "function"
    || !arn[6] || (env.AWS_LAMBDA_FUNCTION_NAME && arn[6] !== env.AWS_LAMBDA_FUNCTION_NAME)
    || env.AWS_REGION !== "us-east-1" || env.HOA_MIGRATION_APP_ID !== "d1nuh9rw1hcuxo" || !environment
    || env.HOA_TRANSACTIONAL_MAIL_PROVIDER !== "ses" || env.HOA_TRANSACTIONAL_MAIL_TABLE !== "HOA-TransactionalMail"
    || env.HOA_SES_CONFIGURATION_SET !== `hoa-transactional-${environment}` || env.HOA_SES_FEEDBACK_TOPIC_ARN !== TOPICS[environment]) throw new Error("SES feedback binding unavailable");
  return { table: env.HOA_TRANSACTIONAL_MAIL_TABLE, topic: TOPICS[environment], environment };
}
type Parsed = {
  eventId: string; digest: string; eventType: string; eventAt: string; providerId: string;
  environment: BusinessEnvironment; operationHash: string; mailKind: string; recipientHashes: string[]; recipientDigest: string;
  suppressedHashes: string[]; reason?: "BOUNCE" | "COMPLAINT";
};
/** SNS invokes the function through its topic-bound resource policy; no HTTP URL exists. */
export function parseSesRecord(recordValue: unknown, topic: string, now: number): Parsed {
  const environment = topic === TOPICS.main ? "main" : topic === TOPICS.staging ? "staging" : undefined;
  if (!environment) throw new InvalidSesFeedback();
  const record = object(recordValue); const sns = object(record.Sns);
  if (record.EventSource !== "aws:sns" || sns.Type !== "Notification" || sns.TopicArn !== topic) throw new InvalidSesFeedback();
  const eventId = identifier(sns.MessageId, 128);
  if (typeof sns.Message !== "string" || !sns.Message.length || Buffer.byteLength(sns.Message) > MAX_BODY_BYTES) throw new InvalidSesFeedback();
  const publishedAt = instant(sns.Timestamp, now); const event = object(JSON.parse(sns.Message));
  const eventType = event.eventType;
  if (typeof eventType !== "string" || !Object.hasOwn(FIELDS, eventType)) throw new InvalidSesFeedback();
  const mail = object(event.mail); const tags = object(mail.tags);
  if (mail.sendingAccountId !== "917680434255" || mail.sourceArn !== IDENTITY || typeof mail.source !== "string" || /[\r\n]/.test(mail.source)) throw new InvalidSesFeedback();
  const sender = address(/<([^<>]+)>$/.exec(mail.source)?.[1] ?? mail.source);
  if (!SENDERS[environment].has(sender) || tag(tags, "ses:configuration-set") !== `hoa-transactional-${environment}` || tag(tags, "HOAEnvironment") !== environment) throw new InvalidSesFeedback();
  const operationHash = tag(tags, "HOAOperation"); const mailKind = tag(tags, "HOAMailKind");
  if (!/^[a-f0-9]{64}$/.test(operationHash) || !["login", "invite", "invoice", "report", "accounting", "test"].includes(mailKind)) throw new InvalidSesFeedback();
  const providerId = identifier(mail.messageId);
  if (!Array.isArray(mail.destination) || !mail.destination.length || mail.destination.length > 50) throw new InvalidSesFeedback();
  const recipients = [...new Set(mail.destination.map(address))];
  if (environment === "staging") {
    const allowed = mailKind === "login" ? STAGING_LOGIN_RECIPIENTS : STAGING_BUSINESS_RECIPIENTS;
    if (recipients.some(recipient => !allowed.includes(recipient)) || (mailKind === "login" && recipients.length !== 1)) throw new InvalidSesFeedback();
  }
  const recipientHashes = recipients.map(sesHash).sort();
  const parsed: Parsed = { eventId, digest: sesHash(sns.Message), eventType, eventAt: publishedAt, providerId, environment, operationHash, mailKind, recipientHashes, recipientDigest: sesHash(recipientHashes.join("\n")), suppressedHashes: [] };
  let details: Item | undefined;
  if (eventType === "Bounce") {
    details = object(event.bounce);
    if (!["Permanent", "Transient", "Undetermined"].includes(String(details.bounceType))) throw new InvalidSesFeedback();
    const bounced = affected(details.bouncedRecipients, recipients);
    if (details.bounceType === "Permanent") { parsed.suppressedHashes = bounced.map(sesHash); parsed.reason = "BOUNCE"; }
  } else if (eventType === "Complaint") {
    details = object(event.complaint); parsed.suppressedHashes = affected(details.complainedRecipients, recipients).map(sesHash); parsed.reason = "COMPLAINT";
  } else if (eventType === "Delivery") details = object(event.delivery);
  else if (eventType === "DeliveryDelay") details = object(event.deliveryDelay);
  else if (eventType === "Reject") details = object(event.reject);
  else if (eventType === "Rendering Failure") details = object(event.failure);
  if (details?.timestamp !== undefined) parsed.eventAt = instant(details.timestamp, now);
  else if (eventType === "Send") parsed.eventAt = instant(mail.timestamp, now);
  return parsed;
}
function affected(value: unknown, allRecipients: string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new InvalidSesFeedback();
  const emails = [...new Set(value.map(v => address(object(v).emailAddress)))];
  if (emails.some(v => !allRecipients.includes(v))) throw new InvalidSesFeedback();
  return emails;
}

export function sesFeedbackTransaction(parsed: Parsed, table: string, now: number, operationKey?: string): TransactWriteCommandInput {
  const observedAt = new Date(now).toISOString();
  const event: Item = { pk: `EVENT#ses#${parsed.eventId}`, kind: "EVENT", provider: "ses", eventId: parsed.eventId, eventType: parsed.eventType, eventCreatedAt: parsed.eventAt, observedAt, payloadDigest: parsed.digest, providerId: parsed.providerId, operationHash: parsed.operationHash, environment: parsed.environment, recipientHashes: parsed.recipientHashes, needsReview: ADVERSE.has(parsed.eventType) };
  const operations: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ Put: { TableName: table, Item: event, ConditionExpression: "attribute_not_exists(pk)" } }];
  operations.push({ Update: { TableName: table, Key: { pk: `RECEIPT#ses#${parsed.providerId}` },
    UpdateExpression: "SET #kind = if_not_exists(#kind, :kind), #provider = if_not_exists(#provider, :provider), providerId = if_not_exists(providerId, :id), operationHash = if_not_exists(operationHash, :hash), environment = if_not_exists(environment, :environment), mailKind = if_not_exists(mailKind, :mailKind), recipientDigest = if_not_exists(recipientDigest, :recipients), recipientHashes = if_not_exists(recipientHashes, :recipientHashes), #time = :eventTime, lastFeedbackEventId = :eventId, lastFeedbackObservedAt = :observedAt ADD feedbackEventTypes :types",
    ConditionExpression: "(attribute_not_exists(pk) OR (#kind = :kind AND #provider = :provider)) AND (attribute_not_exists(providerId) OR providerId = :id) AND (attribute_not_exists(operationHash) OR operationHash = :hash) AND (attribute_not_exists(environment) OR environment = :environment) AND (attribute_not_exists(mailKind) OR mailKind = :mailKind) AND (attribute_not_exists(recipientDigest) OR recipientDigest = :recipients)" + (operationKey ? " AND operationKey = :operation" : ""),
    ExpressionAttributeNames: { "#kind": "kind", "#provider": "provider", "#time": FIELDS[parsed.eventType] },
    ExpressionAttributeValues: { ":kind": "RECEIPT", ":provider": "ses", ":id": parsed.providerId, ":hash": parsed.operationHash, ":environment": parsed.environment, ":mailKind": parsed.mailKind, ":recipients": parsed.recipientDigest, ":recipientHashes": parsed.recipientHashes, ":eventTime": parsed.eventAt, ":eventId": parsed.eventId, ":observedAt": observedAt, ":types": new Set([parsed.eventType]), ...(operationKey ? { ":operation": operationKey } : {}) },
  } });
  if (operationKey) operations.push({ Update: { TableName: table, Key: { pk: operationKey },
    UpdateExpression: "SET #time = :eventTime, lastFeedbackEventId = :eventId, lastFeedbackObservedAt = :observedAt ADD feedbackEventTypes :types",
    ConditionExpression: "attribute_exists(pk) AND #kind = :kind AND #provider = :provider AND environment = :environment AND mailKind = :mailKind AND providerId = :id AND #state = :accepted",
    ExpressionAttributeNames: { "#kind": "kind", "#provider": "provider", "#state": "state", "#time": FIELDS[parsed.eventType] },
    ExpressionAttributeValues: { ":kind": "OPERATION", ":provider": "ses", ":environment": parsed.environment, ":mailKind": parsed.mailKind, ":id": parsed.providerId, ":accepted": "ACCEPTED", ":eventTime": parsed.eventAt, ":eventId": parsed.eventId, ":observedAt": observedAt, ":types": new Set([parsed.eventType]) },
  } });
  for (const hash of parsed.suppressedHashes) operations.push({ Update: {
    TableName: table, Key: { pk: `SUPPRESSION#${hash}` },
    UpdateExpression: "SET #kind = if_not_exists(#kind, :kind), emailHash = :hash, suppressed = :true, reason = if_not_exists(reason, :reason), createdAt = if_not_exists(createdAt, :createdAt), lastReason = :reason, eventId = :eventId, updatedAt = :observedAt ADD reasons :reasons",
    ConditionExpression: "attribute_not_exists(pk) OR (#kind = :kind AND emailHash = :hash)",
    ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: { ":kind": "SUPPRESSION", ":hash": hash, ":true": true, ":reason": parsed.reason, ":createdAt": parsed.eventAt, ":eventId": `ses#${parsed.eventId}`, ":observedAt": observedAt, ":reasons": new Set([parsed.reason!]) },
  } });
  return { TransactItems: operations };
}

/** Preserve early receipt facts; never infer acceptance or release held operations. */
export function createSesFeedbackHandler(deps: SesFeedbackDependencies, env: Environment) {
  return async (eventValue: unknown, context: Context) => {
    const config = configuration(env, context); const event = object(eventValue);
    if (!Array.isArray(event.Records) || !event.Records.length || event.Records.length > 10) throw new InvalidSesFeedback();
    // Validate the entire incoming batch before any persistence.
    const parsedRecords = event.Records.map(record => parseSesRecord(record, config.topic, deps.now()));
    const results: { eventId: string; status: string }[] = [];
    for (const parsed of parsedRecords) {
      const receipt = await deps.getItem(config.table, `RECEIPT#ses#${parsed.providerId}`);
      let operationKey: string | undefined;
      if (receipt && (receipt.kind !== "RECEIPT" || receipt.provider !== "ses" || receipt.environment !== config.environment || receipt.providerId !== parsed.providerId
        || (receipt.operationHash !== undefined && receipt.operationHash !== parsed.operationHash)
        || (receipt.mailKind !== undefined && receipt.mailKind !== parsed.mailKind)
        || (receipt.recipientDigest !== undefined && receipt.recipientDigest !== parsed.recipientDigest))) throw new InvalidSesFeedback();
      if (receipt?.operationKey !== undefined) {
        if (typeof receipt.operationKey !== "string" || !OPERATION_KEY.test(receipt.operationKey) || OPERATION_KEY.exec(receipt.operationKey)?.[1] !== config.environment || OPERATION_KEY.exec(receipt.operationKey)?.[2] !== parsed.mailKind || sesHash(receipt.operationKey) !== parsed.operationHash
          || receipt.provider !== "ses" || receipt.environment !== config.environment || receipt.providerId !== parsed.providerId) throw new InvalidSesFeedback();
        const operation = await deps.getItem(config.table, receipt.operationKey);
        if (operation?.kind === "OPERATION" && operation.provider === "ses" && operation.environment === config.environment && operation.mailKind === parsed.mailKind && operation.providerId === parsed.providerId && operation.state === "ACCEPTED") operationKey = receipt.operationKey;
      }
      const input = sesFeedbackTransaction(parsed, config.table, deps.now(), operationKey);
      try {
        await deps.transact(input);
        if (ADVERSE.has(parsed.eventType)) deps.alert(parsed.eventType, config.environment);
        results.push({ eventId: parsed.eventId, status: "recorded" });
      } catch {
        const prior = await deps.getItem(config.table, `EVENT#ses#${parsed.eventId}`);
        if (prior?.kind === "EVENT" && prior.provider === "ses" && prior.payloadDigest === parsed.digest) {
          // An adverse event can commit just before a lost response or process
          // interruption. Re-emitting its metric is safe; missing it is not.
          if (prior.needsReview === true) deps.alert(parsed.eventType, config.environment);
          results.push({ eventId: parsed.eventId, status: "duplicate" });
        } else throw new Error("SES feedback persistence unavailable");
      }
    }
    return { records: results };
  };
}
