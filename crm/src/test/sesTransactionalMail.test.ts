import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { TransactionalMailClient, quotaPolicy, type TransportDependencies } from "../../amplify/functions/transactional-mail/client";
import { hash, payload } from "../../amplify/functions/transactional-mail/contract";
import { sesCommand } from "../../amplify/functions/transactional-mail/ses";

const now = Date.parse("2026-11-04T02:00:00Z");
const bound = {
  HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration",
  HOA_MIGRATION_PREVIEW: "false", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_MIGRATION_WORKERS_ENABLED: "true",
  HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend", HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail",
  HOA_TRANSACTIONAL_MAIL_BUCKET: "hoa-transactional-mail-917680434255-us-east-1",
  HOA_RESEND_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:917680434255:secret:hoa/resend/sending-Fixture",
  HOA_SES_CONFIGURATION_SET: "hoa-transactional-main", HOA_SES_CANARY_EXPIRES_AT: "2026-11-04T02:30:00Z", AWS_REGION: "us-east-1",
  AWS_LAMBDA_FUNCTION_NAME: "amplify-d1nuh9rw1hcuxo-main-magicLinkVerify",
};
const command = (to = "jake@getgim.com") => new SendEmailCommand({ FromEmailAddress: "HOA Insurance Agency <noreply@protectmyhoa.com>", Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: "SES verification" }, Body: { Text: { Data: "Synthetic only" }, Html: { Data: "<p>Synthetic only</p>" } } } } });
type Options = { sesError?: unknown; missingReceipt?: boolean; receiptFailure?: boolean; earlyFeedback?: boolean; wrongEarlyProvider?: boolean; wrongEarlyKind?: boolean; quota?: boolean; beforeClaim?: () => void };
function harness(options: Options = {}) {
  const rows = new Map<string, any>(); const objects = new Map<string, string>(); const transactions: any[] = [];
  const conditional = () => Object.assign(new Error("conflict"), { name: "TransactionCanceledException" });
  const database = { send: vi.fn(async (c: any) => {
    const i = c.input;
    if (c.constructor.name === "GetCommand") return { Item: structuredClone(rows.get(i.Key.pk)) };
    if (c.constructor.name === "PutCommand") {
      if (rows.has(i.Item.pk)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      rows.set(i.Item.pk, structuredClone(i.Item)); return {};
    }
    if (c.constructor.name === "UpdateCommand") {
      const row = rows.get(i.Key.pk); const v = i.ExpressionAttributeValues;
      if (row?.attempt === v[":attempt"] && (v[":sending"] ? row.state === "SENDING" : ["RESERVED", "DEFERRED"].includes(row.state))) Object.assign(row, { state: v[":state"], nextRetryAt: v[":retry"] });
      return {};
    }
    if (c.constructor.name === "TransactWriteCommand") {
      transactions.push(i); const op = i.TransactItems[0].Update; const v = op.ExpressionAttributeValues; const row = rows.get(op.Key.pk);
      if (v[":sending"] && !v[":accepted"]) {
        options.beforeClaim?.();
        if (options.quota || !["RESERVED", "DEFERRED"].includes(row?.state) || row.attempt !== v[":oldAttempt"] || (row.provider && row.provider !== v[":provider"])) throw conditional();
        Object.assign(row, { state: "SENDING", attempt: v[":attempt"], provider: v[":provider"] });
      } else {
        if (options.receiptFailure) throw new Error("receipt failure");
        const receipt = i.TransactItems[1].Update; const rv = receipt.ExpressionAttributeValues; const prior = rows.get(receipt.Key.pk);
        if (row.state !== "SENDING" || row.provider !== v[":provider"] || (prior?.provider && prior.provider !== rv[":provider"]) || (prior?.operationHash && prior.operationHash !== rv[":operationHash"]) || (prior?.mailKind && prior.mailKind !== rv[":mailKind"])) throw conditional();
        Object.assign(row, { state: "ACCEPTED", providerId: v[":id"] });
        rows.set(receipt.Key.pk, { ...prior, kind: "RECEIPT", provider: rv[":provider"], providerId: rv[":id"], operationKey: rv[":operation"], operationHash: rv[":operationHash"], environment: rv[":environment"], mailKind: rv[":mailKind"], status: receipt.UpdateExpression.includes("#status = if_not_exists(#status, :accepted)") ? prior?.status ?? "ACCEPTED" : "ACCEPTED" });
      }
      return {};
    }
    throw new Error("Unexpected command");
  }) };
  const storage = { send: vi.fn(async (c: any) => {
    if (c.constructor.name === "GetObjectCommand") return { Body: { transformToString: async () => objects.get(c.input.Key)! }, ContentLength: objects.get(c.input.Key)?.length };
    objects.set(c.input.Key, c.input.Body); return {};
  }) };
  const secrets = { send: vi.fn(async () => ({ SecretString: JSON.stringify({ apiKey: "re_fixture" }) })) };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-receipt-12345" }), { status: 200 }));
  const sesMock = vi.fn(async (c: any) => {
    if (options.sesError) throw options.sesError;
    if (options.earlyFeedback) {
      const operationHash = c.input.EmailTags.find((t: any) => t.Name === "HOAOperation").Value;
      rows.set("RECEIPT#ses#ses-receipt-12345", { kind: "RECEIPT", provider: options.wrongEarlyProvider ? "resend" : "ses", environment: "main", operationHash, mailKind: options.wrongEarlyKind ? "invoice" : c.input.EmailTags.find((t: any) => t.Name === "HOAMailKind").Value, status: "DELIVERED", deliveredAt: "2026-11-04T02:00:00Z" });
    }
    return options.missingReceipt ? {} : { MessageId: "ses-receipt-12345" };
  });
  const deps = { database, storage, secrets, ses: { send: sesMock }, fetch: fetchMock, now: () => now } as unknown as TransportDependencies;
  return { rows, transactions, database, storage, secrets, fetchMock, sesMock, deps, objects };
}
beforeEach(() => { for (const [k, v] of Object.entries(bound)) vi.stubEnv(k, v); vi.stubEnv("HOA_SES_DAILY_LIMIT", "100"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "3000"); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("SES pre-switch owner canary", () => {
  it("sends only the exact owner login or test through SES while Resend remains primary", async () => {
    for (const kind of ["login", "test"] as const) {
      const h = harness(); await new TransactionalMailClient(kind, h.deps).send(command());
      expect(h.sesMock).toHaveBeenCalledOnce(); expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.secrets.send).not.toHaveBeenCalled();
      expect([...h.rows.values()].find(r => r.kind === "OPERATION").provider).toBe("ses");
      expect(h.sesMock.mock.calls[0][0].input.ConfigurationSetName).toBe("hoa-transactional-main");
    }
  });
  it("keeps customer logins, other send kinds and hidden recipients on the primary provider", async () => {
    for (const [kind, c] of [["login", command("member@example.com")], ["invoice", command()], ["test", new SendEmailCommand({ ...command().input, Destination: { ToAddresses: ["jake@getgim.com"], BccAddresses: ["jake@getgim.com"] } })]] as const) {
      const h = harness(); await new TransactionalMailClient(kind, h.deps).send(c);
      expect(h.fetchMock).toHaveBeenCalledOnce(); expect(h.sesMock).not.toHaveBeenCalled();
    }
  });
  it("expires the owner canary without changing other primary delivery", async () => {
    vi.stubEnv("HOA_SES_CANARY_EXPIRES_AT", "2026-11-04T01:59:59Z"); const h = harness();
    await new TransactionalMailClient("login", h.deps).send(command()); expect(h.fetchMock).toHaveBeenCalledOnce(); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it.each([{ AWS_REGION: "us-west-2" }, { HOA_SES_CONFIGURATION_SET: "unreviewed" }])("blocks mismatched SES binding before persistence or provider calls: %o", async patch => {
    for (const [k, v] of Object.entries(patch)) vi.stubEnv(k, v);
    const h = harness(); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toThrow();
    expect(h.database.send).not.toHaveBeenCalled(); expect(h.storage.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled();
  });
  it("rechecks canary expiry after slow persistence without switching the reserved provider", async () => {
    const h = harness({ beforeClaim: () => { h.deps.now = () => Date.parse(bound.HOA_SES_CANARY_EXPIRES_AT) + 1; } });
    await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.sesMock).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled();
    expect([...h.rows.values()].find(r => r.kind === "OPERATION")).toMatchObject({ provider: "ses", state: "DEFERRED" });
  });
});

describe("provider pinning and uncertainty", () => {
  it("uses a separate SES receipt namespace and reuses the accepted original operation", async () => {
    const h = harness(); const client = new TransactionalMailClient("login", h.deps);
    expect(await client.send(command())).toEqual({ MessageId: "ses-receipt-12345" });
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "resend"); vi.stubEnv("HOA_SES_CANARY_EXPIRES_AT", "");
    expect(await client.send(command())).toEqual({ MessageId: "ses-receipt-12345" });
    expect(h.sesMock).toHaveBeenCalledOnce(); expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.rows.get("RECEIPT#ses#ses-receipt-12345")).toMatchObject({ provider: "ses", environment: "main" });
  });
  it("returns accepted Resend history after a primary SES switch, without sending again", async () => {
    vi.stubEnv("HOA_SES_CANARY_EXPIRES_AT", ""); const h = harness(); const client = new TransactionalMailClient("invoice", h.deps);
    await client.send(command()); vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses");
    expect(await client.send(command())).toEqual({ MessageId: "resend-receipt-12345" }); expect(h.fetchMock).toHaveBeenCalledOnce(); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it.each(["RESERVED", "DEFERRED"])("holds old Resend %s work instead of replacing it with an SES operation", async state => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); const h = harness(); const body = payload(command().input, {}); const key = `OP#hoa/main/invoice/${hash(hash(JSON.stringify(body)))}`;
    const prior = { pk: key, kind: "OPERATION", provider: "resend", state, payloadHash: hash(JSON.stringify(body)), attempt: 0, nextRetryAt: new Date(now - 1).toISOString() }; h.rows.set(key, structuredClone(prior));
    await expect(new TransactionalMailClient("invoice", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.rows.get(key)).toEqual(prior); expect(h.sesMock).not.toHaveBeenCalled(); expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.storage.send).not.toHaveBeenCalled();
  });
  it("treats legacy missing-provider unsent rows as Resend and holds them across the switch", async () => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); const h = harness(); const body = payload(command().input, {}); const key = `OP#hoa/main/invoice/${hash(hash(JSON.stringify(body)))}`;
    h.rows.set(key, { pk: key, state: "RESERVED", payloadHash: hash(JSON.stringify(body)), attempt: 0 });
    await expect(new TransactionalMailClient("invoice", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" }); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it.each([
    [new TypeError("network"), "UNKNOWN"],
    [Object.assign(new Error("timeout"), { name: "TimeoutError" }), "UNKNOWN"],
    [Object.assign(new Error("server"), { name: "InternalServerErrorException", $metadata: { httpStatusCode: 500 } }), "UNKNOWN"],
    [Object.assign(new Error("throttled"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } }), "DEFERRED"],
    [Object.assign(new Error("rejected"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } }), "REJECTED"],
    [Object.assign(new Error("unrecognized"), { name: "UnknownServiceError", $metadata: { httpStatusCode: 403 } }), "UNKNOWN"],
  ] as const)("classifies SES failures conservatively and never falls back: %s", async (sesError, state) => {
    const h = harness({ sesError }); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state }); await expect(client.send(command())).rejects.toMatchObject({ state });
    expect(h.sesMock).toHaveBeenCalledOnce(); expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.secrets.send).not.toHaveBeenCalled();
  });
  it.each([{ missingReceipt: true }, { receiptFailure: true }])("holds missing/persistence-lost SES receipts: %o", async options => {
    const h = harness(options); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it("cannot route an uncertain SES operation through Resend after rollback", async () => {
    const h = harness({ sesError: new TypeError("network") }); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); vi.stubEnv("HOA_SES_CANARY_EXPIRES_AT", "");
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); expect(h.fetchMock).not.toHaveBeenCalled(); expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it("merges feedback arriving before send acknowledgement without erasing delivered facts", async () => {
    const h = harness({ earlyFeedback: true }); await new TransactionalMailClient("login", h.deps).send(command());
    const row = h.rows.get("RECEIPT#ses#ses-receipt-12345"); expect(row).toMatchObject({ deliveredAt: "2026-11-04T02:00:00Z", status: "DELIVERED", provider: "ses", environment: "main" });
    expect(row.operationHash).toBe(hash(row.operationKey));
    expect(h.rows.get(row.operationKey)).toMatchObject({ state: "ACCEPTED", provider: "ses", providerId: "ses-receipt-12345" });
    expect(h.transactions[1].TransactItems[1].Update.UpdateExpression).not.toMatch(/delivered|bounced|feedback/i);
  });
  it("holds an incompatible early receipt instead of rebinding another provider's record", async () => {
    const h = harness({ earlyFeedback: true, wrongEarlyProvider: true }); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    expect(h.rows.get("RECEIPT#ses#ses-receipt-12345").provider).toBe("resend"); expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it("holds conflicting early mail-kind tags even when the provider and operation hash match", async () => {
    const h = harness({ earlyFeedback: true, wrongEarlyKind: true }); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    expect(h.rows.get("RECEIPT#ses#ses-receipt-12345").mailKind).toBe("invoice"); expect(h.sesMock).toHaveBeenCalledOnce();
  });
});

describe("SES envelope fidelity and independent application caps", () => {
  it("preserves UTF-8, all envelope recipients and binary PDF/XLSX while assigning trace tags", () => {
    const input = command().input; input.Destination = { ToAddresses: ["member@example.com"], CcAddresses: ["copy@example.com"], BccAddresses: ["insurance@protectmyhoa.com"] };
    const pdf = Buffer.from("%PDF-1.7\nfixture"); const xlsx = Buffer.from([80, 75, 3, 4, 255]);
    const body = payload(input, { subject: "HOA — résumé", replyTo: "insurance@protectmyhoa.com", attachments: [{ filename: "fixture.pdf", contentType: "application/pdf", content: pdf }, { filename: "fixture.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: xlsx }] });
    const key = `OP#hoa/main/test/${"a".repeat(64)}`; const actual = sesCommand(body, "hoa-transactional-main", "main", "test", key).input;
    expect(actual.Destination).toEqual(input.Destination); expect(actual.FromEmailAddress).toBe(input.FromEmailAddress); expect(actual.ReplyToAddresses).toEqual(["insurance@protectmyhoa.com"]);
    expect(actual.FromEmailAddressIdentityArn).toBe("arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com");
    expect(actual.Content?.Simple?.Subject).toEqual({ Data: "HOA — résumé", Charset: "UTF-8" }); expect(actual.Content?.Simple?.Body?.Html?.Data).toBe("<p>Synthetic only</p>");
    expect(actual.Content?.Simple?.Attachments?.map(x => Buffer.from(x.RawContent!))).toEqual([pdf, xlsx]);
    expect(actual.Content?.Simple?.Attachments?.every(x => x.ContentTransferEncoding === "BASE64")).toBe(true);
    expect(actual.EmailTags).toContainEqual({ Name: "HOAOperation", Value: hash(key) }); expect(actual.EmailTags).toContainEqual({ Name: "HOAEnvironment", Value: "main" });
  });
  it("reserves SES-specific counters and leaves original Resend limits untouched", async () => {
    vi.stubEnv("HOA_SES_DAILY_LIMIT", "1000"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "30000"); const h = harness(); await new TransactionalMailClient("test", h.deps).send(command());
    const [day, month] = h.transactions[0].TransactItems.slice(1).map((x: any) => x.Update);
    expect(day.Key.pk).toBe("QUOTA#SES#DAY#2026-11-04"); expect(day.ExpressionAttributeValues[":remaining"]).toBe(994);
    expect(month.Key.pk).toBe("QUOTA#SES#MONTH#2026-11"); expect(month.ExpressionAttributeValues[":remaining"]).toBe(29949);
    expect(quotaPolicy("resend", "login", "2026-11-04T02:00:00Z")).toMatchObject({ dayKey: "QUOTA#DAY#2026-11-04", dayLimit: 100, monthLimit: 3000 });
  });
  it.each([{ HOA_SES_DAILY_LIMIT: "50001" }, { HOA_SES_DAILY_LIMIT: "1.5" }, { HOA_SES_MONTHLY_LIMIT: "0" }])("rejects unsafe SES application caps before persistence: %o", async patch => {
    for (const [k, v] of Object.entries(patch)) vi.stubEnv(k, v); const h = harness(); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toThrow("limits"); expect(h.database.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled();
  });
});
