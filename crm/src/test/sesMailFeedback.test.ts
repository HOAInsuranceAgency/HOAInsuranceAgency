// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSesFeedbackHandler, parseSesRecord, sesFeedbackTransaction, sesHash } from "../../amplify/functions/ses-mail-feedback/feedback";

const now = Date.parse("2026-11-04T02:00:00Z");
const topic = "arn:aws:sns:us-east-1:917680434255:hoa-transactional-main-feedback";
const context = { invokedFunctionArn: "arn:aws:lambda:us-east-1:917680434255:function:destination-ses-feedback" };
const env = { AWS_REGION: "us-east-1", HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration", HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail", HOA_SES_CONFIGURATION_SET: "hoa-transactional-main", HOA_SES_FEEDBACK_TOPIC_ARN: topic };
const opKey = `OP#hoa/main/test/${"a".repeat(64)}`;
const providerId = "010001963-example-provider-id-000000";
const raw = (type = "Delivery") => ({
  eventType: type,
  mail: { timestamp: new Date(now - 30_000).toISOString(), source: "HOA Insurance Agency <noreply@protectmyhoa.com>", sourceArn: "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com", sendingAccountId: "917680434255", messageId: providerId, destination: ["owner@example.com", "second@example.com"], tags: { "ses:configuration-set": ["hoa-transactional-main"], HOAEnvironment: ["main"], HOAMailKind: ["test"], HOAOperation: [sesHash(opKey)] } },
  ...(type === "Delivery" ? { delivery: { timestamp: new Date(now - 1_000).toISOString(), recipients: ["owner@example.com"] } } : {}),
  ...(type === "Send" ? { send: {} } : {}),
  ...(type === "Bounce" ? { bounce: { timestamp: new Date(now - 1_000).toISOString(), bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "owner@example.com" }] } } : {}),
  ...(type === "Complaint" ? { complaint: { timestamp: new Date(now - 1_000).toISOString(), complainedRecipients: [{ emailAddress: "second@example.com" }] } } : {}),
  ...(type === "DeliveryDelay" ? { deliveryDelay: { timestamp: new Date(now - 1_000).toISOString(), delayType: "TransientCommunicationFailure" } } : {}),
  ...(type === "Reject" ? { reject: { reason: "Bad content" } } : {}),
  ...(type === "Rendering Failure" ? { failure: { errorMessage: "Template attribute absent" } } : {}),
});
function record(data: unknown = raw(), id = "sns-message-1") {
  return { EventSource: "aws:sns", Sns: { Type: "Notification", TopicArn: topic, MessageId: id, Timestamp: new Date(now).toISOString(), Message: JSON.stringify(data) } };
}
function setup(overrides: Record<string, string | undefined> = {}) {
  const items = new Map<string, Record<string, unknown>>();
  const deps = {
    now: () => now,
    getItem: vi.fn(async (_table: string, pk: string) => items.get(pk)),
    transact: vi.fn(async (input: ReturnType<typeof sesFeedbackTransaction>) => {
      const item = input.TransactItems![0].Put!.Item!;
      if (items.has(String(item.pk))) throw new Error("ConditionalCheckFailedException");
      items.set(String(item.pk), item);
    }),
    alert: vi.fn(),
  };
  return { items, deps, handler: createSesFeedbackHandler(deps, { ...env, ...overrides }) };
}

describe("SES feedback source and binding", () => {
  it.each(["Send", "Delivery", "Bounce", "Complaint", "DeliveryDelay", "Reject", "Rendering Failure"])("records validated %s events", async type => {
    const { handler, deps } = setup();
    expect((await handler({ Records: [record(raw(type))] }, context)).records[0].status).toBe("recorded");
    expect(deps.transact).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledTimes(["Send", "Delivery"].includes(type) ? 0 : 1);
  });
  it("also accepts the production insurance sender", () => {
    const body = raw(); body.mail.source = "HOA Insurance Agency <insurance@protectmyhoa.com>";
    expect(parseSesRecord(record(body), topic, now).providerId).toBe(providerId);
  });
  it.each([
    { AWS_REGION: "us-west-2" }, { HOA_MIGRATION_APP_ID: "source-app" }, { HOA_MIGRATION_BRANCH: "codex-hoa-staging-migration" },
    { HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend" }, { HOA_TRANSACTIONAL_MAIL_TABLE: "Customer" }, { HOA_SES_CONFIGURATION_SET: "other-config" },
    { HOA_SES_FEEDBACK_TOPIC_ARN: topic.replace("917680434255", "637423611040") }, { AWS_LAMBDA_FUNCTION_NAME: "different-function" },
  ])("rejects a mismatched runtime binding %j before database access", async override => {
    const { handler, deps } = setup(override);
    await expect(handler({ Records: [record()] }, context)).rejects.toThrow();
    expect(deps.getItem).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it("rejects the source account and forged HTTP input", async () => {
    const { handler, deps } = setup();
    await expect(handler({ Records: [record()] }, { invokedFunctionArn: context.invokedFunctionArn.replace("917680434255", "637423611040") })).rejects.toThrow();
    await expect(handler({ body: JSON.stringify(raw()), requestContext: { http: { method: "POST" } } }, context)).rejects.toThrow();
    expect(deps.getItem).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it.each(["source", "account", "identity", "configuration", "environment", "operation_hash", "kind", "message_id", "recipient", "header_injection"])("rejects incorrect SES %s", async variant => {
    const { handler, deps } = setup(); const body = raw();
    if (variant === "source") body.mail.source = "intruder@protectmyhoa.com";
    if (variant === "account") body.mail.sendingAccountId = "637423611040";
    if (variant === "identity") body.mail.sourceArn = body.mail.sourceArn.replace("identity/protectmyhoa.com", "identity/example.com");
    if (variant === "configuration") body.mail.tags["ses:configuration-set"] = ["other-config"];
    if (variant === "environment") body.mail.tags.HOAEnvironment = ["staging"];
    if (variant === "operation_hash") body.mail.tags.HOAOperation = ["not-a-hash"];
    if (variant === "kind") body.mail.tags.HOAMailKind = ["replay"];
    if (variant === "message_id") body.mail.messageId = "id/with/slash";
    if (variant === "recipient") body.mail.destination = ["invalid"];
    if (variant === "header_injection") body.mail.source = "Bad\r\nName <noreply@protectmyhoa.com>";
    await expect(handler({ Records: [record(body)] }, context)).rejects.toThrow();
    expect(deps.getItem).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it.each(["wrong_topic", "wrong_source", "oversize", "invalid_json", "future_time", "duplicate_tag"])("rejects %s before persistence", async variant => {
    const { handler, deps } = setup(); const event = record();
    if (variant === "wrong_topic") event.Sns.TopicArn += "-other";
    if (variant === "wrong_source") event.EventSource = "aws:sqs";
    if (variant === "oversize") event.Sns.Message = "a".repeat(256 * 1024 + 1);
    if (variant === "invalid_json") event.Sns.Message = "{";
    if (variant === "future_time") event.Sns.Timestamp = new Date(now + 301_000).toISOString();
    if (variant === "duplicate_tag") { const body = raw(); body.mail.tags.HOAOperation.push(sesHash(opKey)); event.Sns.Message = JSON.stringify(body); }
    await expect(handler({ Records: [event] }, context)).rejects.toThrow();
    expect(deps.getItem).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it("validates the complete batch before writing an otherwise valid first record", async () => {
    const { handler, deps } = setup(); const bad = record(raw(), "sns-message-2"); bad.Sns.TopicArn += "-other";
    await expect(handler({ Records: [record(), bad] }, context)).rejects.toThrow();
    expect(deps.getItem).not.toHaveBeenCalled(); expect(deps.transact).not.toHaveBeenCalled();
  });
});

describe("SES feedback facts, suppression and operation fencing", () => {
  it("keeps early receipt facts without manufacturing an accepted operation", async () => {
    const { handler, deps } = setup(); await handler({ Records: [record()] }, context);
    const tx = deps.transact.mock.calls[0][0]; expect(tx.TransactItems).toHaveLength(2);
    const update = tx.TransactItems![1].Update!;
    expect(update.Key).toEqual({ pk: `RECEIPT#ses#${providerId}` });
    expect(update.ExpressionAttributeValues![":hash"]).toBe(sesHash(opKey));
    expect(update.ExpressionAttributeValues![":environment"]).toBe("main");
    expect(update.ConditionExpression).toContain("mailKind = :mailKind");
    expect(update.UpdateExpression).not.toMatch(/\b(status|acceptedAt|operationKey|state)\s*=/);
  });
  it("uses independent time fields, preserving out-of-order delivery and bounce facts", () => {
    const delivered = sesFeedbackTransaction(parseSesRecord(record(), topic, now), env.HOA_TRANSACTIONAL_MAIL_TABLE, now);
    const bounced = sesFeedbackTransaction(parseSesRecord(record(raw("Bounce")), topic, now), env.HOA_TRANSACTIONAL_MAIL_TABLE, now);
    expect(delivered.TransactItems![1].Update!.ExpressionAttributeNames!["#time"]).toBe("deliveredAt");
    expect(bounced.TransactItems![1].Update!.ExpressionAttributeNames!["#time"]).toBe("bouncedAt");
    expect(delivered.TransactItems![1].Update!.UpdateExpression).not.toContain("bouncedAt");
  });
  it.each(["Bounce", "Complaint"])("suppresses only the affected recipients for %s without plaintext data", type => {
    const tx = sesFeedbackTransaction(parseSesRecord(record(raw(type)), topic, now), env.HOA_TRANSACTIONAL_MAIL_TABLE, now);
    expect(tx.TransactItems).toHaveLength(3);
    const suppressed = tx.TransactItems![2].Update!;
    expect(suppressed.Key!.pk).toBe(`SUPPRESSION#${sesHash(type === "Bounce" ? "owner@example.com" : "second@example.com")}`);
    expect(suppressed.UpdateExpression).toContain("reason = if_not_exists(reason, :reason)");
    expect(suppressed.ExpressionAttributeValues![":true"]).toBe(true);
    expect(JSON.stringify(tx)).not.toMatch(/owner@example|second@example|noreply@/);
  });
  it.each(["Transient", "Undetermined"])("records a %s bounce without permanent suppression", type => {
    const body = raw("Bounce"); body.bounce!.bounceType = type;
    expect(sesFeedbackTransaction(parseSesRecord(record(body), topic, now), env.HOA_TRANSACTIONAL_MAIL_TABLE, now).TransactItems).toHaveLength(2);
  });
  it("rejects affected recipients outside the original envelope", async () => {
    const { handler, deps } = setup(); const body = raw("Bounce"); body.bounce!.bouncedRecipients = [{ emailAddress: "not-in-envelope@example.com" }];
    await expect(handler({ Records: [record(body)] }, context)).rejects.toThrow(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it("CAS-updates only the matching accepted SES operation, preserving its state", async () => {
    const { handler, deps, items } = setup();
    items.set(`RECEIPT#ses#${providerId}`, { kind: "RECEIPT", provider: "ses", environment: "main", operationKey: opKey, operationHash: sesHash(opKey), providerId });
    items.set(opKey, { kind: "OPERATION", provider: "ses", environment: "main", mailKind: "test", providerId, state: "ACCEPTED" });
    await handler({ Records: [record()] }, context); const tx = deps.transact.mock.calls[0][0]; expect(tx.TransactItems).toHaveLength(3);
    const update = tx.TransactItems![2].Update!; expect(update.Key).toEqual({ pk: opKey });
    expect(update.ConditionExpression).toContain("#state = :accepted"); expect(update.ConditionExpression).toContain("#provider = :provider");
    expect(update.UpdateExpression).not.toContain("#state");
  });
  it.each(["UNKNOWN", "RESERVED", "DEFERRED", "SENDING"])("never releases or mutates a held %s operation", async state => {
    const { handler, deps, items } = setup();
    items.set(`RECEIPT#ses#${providerId}`, { kind: "RECEIPT", provider: "ses", environment: "main", operationKey: opKey, operationHash: sesHash(opKey), providerId });
    items.set(opKey, { kind: "OPERATION", provider: "ses", environment: "main", mailKind: "test", providerId, state });
    await handler({ Records: [record()] }, context);
    expect(deps.transact.mock.calls[0][0].TransactItems).toHaveLength(2); expect(items.get(opKey)!.state).toBe(state);
  });
  it.each(["provider", "environment", "operation", "message"])("rejects a mismatched accepted receipt %s", async variant => {
    const { handler, deps, items } = setup();
    const receipt = { kind: "RECEIPT", provider: "ses", environment: "main", operationKey: opKey, providerId };
    if (variant === "provider") receipt.provider = "resend";
    if (variant === "environment") receipt.environment = "staging";
    if (variant === "operation") receipt.operationKey = opKey.replace("/test/", "/invoice/");
    if (variant === "message") receipt.providerId = "other-id";
    items.set(`RECEIPT#ses#${providerId}`, receipt);
    await expect(handler({ Records: [record()] }, context)).rejects.toThrow(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it.each(["kind", "provider", "hash", "recipient_digest", "mail_kind"])("does not overwrite a mismatched early receipt %s", async variant => {
    const { handler, deps, items } = setup();
    const receipt: Record<string, unknown> = { kind: "RECEIPT", provider: "ses", environment: "main", providerId, operationHash: sesHash(opKey) };
    if (variant === "kind") receipt.kind = "OPERATION";
    if (variant === "provider") receipt.provider = "resend";
    if (variant === "hash") receipt.operationHash = "f".repeat(64);
    if (variant === "recipient_digest") receipt.recipientDigest = "e".repeat(64);
    if (variant === "mail_kind") receipt.mailKind = "invoice";
    items.set(`RECEIPT#ses#${providerId}`, receipt);
    await expect(handler({ Records: [record()] }, context)).rejects.toThrow(); expect(deps.transact).not.toHaveBeenCalled();
  });
  it("deduplicates a committed event after an ambiguous transaction response", async () => {
    const { handler, deps, items } = setup(); const sns = record(raw("Complaint"));
    items.set("EVENT#ses#sns-message-1", { kind: "EVENT", provider: "ses", payloadDigest: sesHash(sns.Sns.Message), needsReview: true });
    deps.transact.mockRejectedValue(new Error("response lost"));
    expect((await handler({ Records: [sns] }, context)).records[0].status).toBe("duplicate");
    expect(deps.alert).toHaveBeenCalledExactlyOnceWith("Complaint", "main");
  });
  it("rejects event-ID conflicts and uncommitted writes without an alert", async () => {
    const { handler, deps, items } = setup(); deps.transact.mockRejectedValue(new Error("unavailable"));
    await expect(handler({ Records: [record()] }, context)).rejects.toThrow("persistence unavailable"); expect(deps.alert).not.toHaveBeenCalled();
    items.set("EVENT#ses#sns-message-1", { kind: "EVENT", provider: "ses", payloadDigest: "different" });
    await expect(handler({ Records: [record()] }, context)).rejects.toThrow("persistence unavailable"); expect(deps.alert).not.toHaveBeenCalled();
  });
});


describe("SES feedback staging isolation", () => {
  const stagingTopic = topic.replace("-main-", "-staging-");
  const stagingKey = opKey.replace("/main/", "/staging/");
  const stagingEnv = { HOA_MIGRATION_BRANCH: "codex-hoa-staging-migration", HOA_SES_CONFIGURATION_SET: "hoa-transactional-staging", HOA_SES_FEEDBACK_TOPIC_ARN: stagingTopic };
  function stageRecord() {
    const body = raw();
    body.mail.source = "HOA Staging <jake+testing@protectmyhoa.com>";
    body.mail.destination = ["jake@getgim.com"];
    body.mail.tags["ses:configuration-set"] = ["hoa-transactional-staging"];
    body.mail.tags.HOAEnvironment = ["staging"];
    body.mail.tags.HOAOperation = [sesHash(stagingKey)];
    const item = record(body); item.Sns.TopicArn = stagingTopic;
    return item;
  }
  it("records staging delivery only on its own matching accepted operation", async () => {
    const { handler, deps, items } = setup(stagingEnv);
    items.set(`RECEIPT#ses#${providerId}`, { kind: "RECEIPT", provider: "ses", environment: "staging", operationKey: stagingKey, operationHash: sesHash(stagingKey), providerId });
    items.set(stagingKey, { kind: "OPERATION", provider: "ses", environment: "staging", mailKind: "test", providerId, state: "ACCEPTED" });
    await handler({ Records: [stageRecord()] }, context);
    const tx = deps.transact.mock.calls[0][0];
    expect(tx.TransactItems).toHaveLength(3);
    expect(tx.TransactItems![0].Put!.Item!.environment).toBe("staging");
    expect(tx.TransactItems![1].Update!.ExpressionAttributeValues![":environment"]).toBe("staging");
    expect(tx.TransactItems![2].Update!.Key).toEqual({ pk: stagingKey });
  });
  it.each(["topic", "tags", "recipient", "sender", "receipt_environment", "operation_environment"])("rejects staging %s boundary violations without writes", async variant => {
    const { handler, deps, items } = setup(stagingEnv);
    const event = stageRecord(); const body = JSON.parse(event.Sns.Message);
    if (variant === "topic") event.Sns.TopicArn = topic;
    if (variant === "tags") body.mail.tags.HOAEnvironment = ["main"];
    if (variant === "recipient") body.mail.destination = ["customer@example.com"];
    if (variant === "sender") body.mail.source = "insurance@protectmyhoa.com";
    if (variant === "receipt_environment") items.set(`RECEIPT#ses#${providerId}`, { kind: "RECEIPT", provider: "ses", environment: "main", providerId });
    if (variant === "operation_environment") items.set(`RECEIPT#ses#${providerId}`, { kind: "RECEIPT", provider: "ses", environment: "staging", operationKey: opKey, providerId });
    event.Sns.Message = JSON.stringify(body);
    await expect(handler({ Records: [event] }, context)).rejects.toThrow();
    expect(deps.transact).not.toHaveBeenCalled();
  });
  it("rejects the staging event on the production processor", async () => {
    const { handler, deps } = setup();
    await expect(handler({ Records: [stageRecord()] }, context)).rejects.toThrow();
    expect(deps.transact).not.toHaveBeenCalled();
  });
});
