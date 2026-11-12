import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { TransactionalMailClient, quotaPolicy } from "../../amplify/functions/transactional-mail/client";
import { hash, payload } from "../../amplify/functions/transactional-mail/contract";
import { sesCommand } from "../../amplify/functions/transactional-mail/ses";
import { now, bound, command, harness } from "./helpers/transactionalMail";

beforeEach(() => {
  for (const [k, v] of Object.entries(bound)) vi.stubEnv(k, v);
  vi.stubEnv("HOA_SES_DAILY_LIMIT", "1000"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "30000");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("HTTP email is retired"));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("per-environment SES transport", () => {
  it.each(["login", "invite", "invoice", "report", "accounting", "test"] as const)("sends new %s mail through SES only", async kind => {
    const h = harness(); await new TransactionalMailClient(kind, h.deps).send(command());
    expect(h.sesMock).toHaveBeenCalledOnce();
    expect([...h.rows.values()].find(r => r.kind === "OPERATION").provider).toBe("ses");
    expect(h.sesMock.mock.calls[0][0].input.ConfigurationSetName).toBe("hoa-transactional-main");
  });
  it.each(["invoice", "report", "accounting"] as const)("preserves the staging %s test mailbox and blocks customers in every envelope field", async kind => {
    vi.stubEnv("HOA_MIGRATION_BRANCH", "codex-hoa-staging-migration"); vi.stubEnv("HOA_SES_CONFIGURATION_SET", "hoa-transactional-staging");
    const owner = new SendEmailCommand({ ...command().input, FromEmailAddress: "HOA Insurance Agency <jake+testing@protectmyhoa.com>" });
    const h = harness(); await new TransactionalMailClient(kind, h.deps).send(owner);
    expect(h.sesMock).toHaveBeenCalledOnce(); expect(h.sesMock.mock.calls[0][0].input.FromEmailAddress).toContain("jake+testing@protectmyhoa.com");
    expect(h.sesMock.mock.calls[0][0].input.EmailTags).toContainEqual({ Name: "HOAEnvironment", Value: "staging" });
    for (const field of ["ToAddresses", "CcAddresses", "BccAddresses"] as const) {
      const customer = new SendEmailCommand({ ...owner.input, Destination: { ToAddresses: ["jake@getgim.com"], [field]: ["customer@example.com"] } });
      const blocked = harness(); await expect(new TransactionalMailClient(kind, blocked.deps).send(customer)).rejects.toThrow("Staging");
      expect(blocked.database.send).not.toHaveBeenCalled(); expect(blocked.sesMock).not.toHaveBeenCalled();
    }
  });
  it.each(["main", "staging"])("rejects senders from the other environment in %s", async environment => {
    const stage = environment === "staging";
    vi.stubEnv("HOA_MIGRATION_BRANCH", stage ? "codex-hoa-staging-migration" : "codex-hoa-account-migration");
    vi.stubEnv("HOA_SES_CONFIGURATION_SET", stage ? "hoa-transactional-staging" : "hoa-transactional-main");
    const h = harness(); const wrong = new SendEmailCommand({ ...command().input, FromEmailAddress: `HOA Insurance Agency <${stage ? "insurance" : "jake+testing"}@protectmyhoa.com>` });
    await expect(new TransactionalMailClient("invoice", h.deps).send(wrong)).rejects.toThrow("sender"); expect(h.database.send).not.toHaveBeenCalled();
  });
  it("rechecks a verification deadline after slow persistence and defers before SES", async () => {
    const h = harness({ beforeClaim: () => { h.deps.now = () => Date.parse(bound.HOA_SES_VERIFICATION_EXPIRES_AT) + 1; } });
    await expect(new TransactionalMailClient("test", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.sesMock).not.toHaveBeenCalled(); expect([...h.rows.values()].find(r => r.kind === "OPERATION")).toMatchObject({ provider: "ses", state: "DEFERRED", attempt: 1 });
  });
  it("keeps main quotas and old Resend counters intact while stage uses its own cap", async () => {
    vi.stubEnv("HOA_MIGRATION_BRANCH", "codex-hoa-staging-migration"); vi.stubEnv("HOA_SES_CONFIGURATION_SET", "hoa-transactional-staging");
    vi.stubEnv("HOA_SES_DAILY_LIMIT", "100"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "3000");
    const h = harness(); h.rows.set("QUOTA#SES#DAY#2026-11-04", { count: 1000 }); h.rows.set("QUOTA#DAY#2026-11-04", { count: 100 });
    await new TransactionalMailClient("login", h.deps).send(command());
    expect(h.rows.get("QUOTA#SES#STAGING#DAY#2026-11-04").count).toBe(1); expect(h.rows.get("QUOTA#SES#STAGING#MONTH#2026-11").count).toBe(1);
    expect(h.rows.get("QUOTA#SES#DAY#2026-11-04")).toEqual({ count: 1000 }); expect(h.rows.get("QUOTA#DAY#2026-11-04")).toEqual({ count: 100 });
    expect(quotaPolicy("invoice", "2026-11-04T02:00:00Z")).toMatchObject({ dayLimit: 95, monthLimit: 2950 });
  });
});

describe("reviewed staging login recipients", () => {
  beforeEach(() => {
    vi.stubEnv("HOA_MIGRATION_BRANCH", "codex-hoa-staging-migration");
    vi.stubEnv("HOA_SES_CONFIGURATION_SET", "hoa-transactional-staging");
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "amplify-d1nuh9rw1hcuxo-st-magiclinkverify");
  });
  it.each(["jake@getgim.com", "ethanroden@getgim.com", "brian@protectmyhoa.com"])("delivers one tracked sign-in link to %s", async recipient => {
    const h = harness();
    await expect(new TransactionalMailClient("login", h.deps).send(command(recipient))).resolves.toEqual({ MessageId: "ses-receipt-12345" });
    expect(h.sesMock).toHaveBeenCalledOnce();
    expect(h.sesMock.mock.calls[0][0].input.Destination).toEqual({ ToAddresses: [recipient] });
    expect([...h.rows.values()].find(row => row.kind === "OPERATION")).toMatchObject({ environment: "staging", mailKind: "login", state: "ACCEPTED" });
  });
  it.each(["ethanroden@getgim.com", "brian@protectmyhoa.com"].flatMap(recipient =>
    (["invite", "invoice", "report", "accounting", "test"] as const).map(kind => ({ recipient, kind }))
  ))("does not extend $recipient's login exception to $kind", async ({ recipient, kind }) => {
    const h = harness();
    await expect(new TransactionalMailClient(kind, h.deps).send(command(recipient))).rejects.toThrow("Staging");
    expect(h.database.send).not.toHaveBeenCalled(); expect(h.storage.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it.each(["ToAddresses", "CcAddresses", "BccAddresses"] as const)("blocks unapproved login recipients in %s", async field => {
    const c = new SendEmailCommand({ ...command("ethanroden@getgim.com").input, Destination: { ToAddresses: ["ethanroden@getgim.com"], [field]: ["customer@example.com"] } });
    const h = harness();
    await expect(new TransactionalMailClient("login", h.deps).send(c)).rejects.toThrow("Staging");
    expect(h.database.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it.each([
    { ToAddresses: ["ethanroden@getgim.com", "jake@getgim.com"] },
    { ToAddresses: ["ethanroden@getgim.com"], CcAddresses: ["jake@getgim.com"] },
    { ToAddresses: ["ethanroden@getgim.com"], BccAddresses: ["jake@getgim.com"] },
    { ToAddresses: ["brian@protectmyhoa.com", "ethanroden@getgim.com"] },
    { ToAddresses: ["brian@protectmyhoa.com"], CcAddresses: ["jake@getgim.com"] },
    { ToAddresses: ["brian@protectmyhoa.com"], BccAddresses: ["ethanroden@getgim.com"] },
  ])("never copies a sign-in link even to another approved tester: %o", async destination => {
    const h = harness();
    const c = new SendEmailCommand({ ...command().input, Destination: destination });
    await expect(new TransactionalMailClient("login", h.deps).send(c)).rejects.toThrow("one recipient");
    expect(h.database.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled();
  });
});

describe("provider pinning and uncertainty", () => {
  it("uses a separate SES receipt namespace and reuses the accepted original operation", async () => {
    const h = harness(); const client = new TransactionalMailClient("login", h.deps);
    expect(await client.send(command())).toEqual({ MessageId: "ses-receipt-12345" });
    expect(await client.send(command())).toEqual({ MessageId: "ses-receipt-12345" });
    expect(h.sesMock).toHaveBeenCalledOnce();
    expect(h.rows.get("RECEIPT#ses#ses-receipt-12345")).toMatchObject({ provider: "ses", environment: "main" });
  });
  it.each(["main", "staging"])("returns accepted Resend history in %s without rewriting receipts or sending", async environment => {
    if (environment === "staging") { vi.stubEnv("HOA_MIGRATION_BRANCH", "codex-hoa-staging-migration"); vi.stubEnv("HOA_SES_CONFIGURATION_SET", "hoa-transactional-staging"); }
    const h = harness(); const body = payload(command().input, {}); const key = `OP#hoa/${environment}/invoice/${hash(hash(JSON.stringify(body)))}`;
    h.rows.set(key, { pk: key, kind: "OPERATION", provider: "resend", state: "ACCEPTED", payloadHash: hash(JSON.stringify(body)), providerId: "old-resend-receipt", attempt: 1 });
    h.rows.set("RECEIPT#old-resend-receipt", { kind: "RECEIPT", provider: "resend", operationKey: key, status: "DELIVERED" });
    const prior = structuredClone([...h.rows]);
    expect(await new TransactionalMailClient("invoice", h.deps).send(command())).toEqual({ MessageId: "old-resend-receipt" });
    expect([...h.rows]).toEqual(prior); expect(h.sesMock).not.toHaveBeenCalled(); expect(h.storage.send).not.toHaveBeenCalled(); expect(h.transactions).toHaveLength(0);
  });
  it.each(["RESERVED", "DEFERRED"])("holds old Resend %s work instead of replacing it with an SES operation", async state => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); const h = harness(); const body = payload(command().input, {}); const key = `OP#hoa/main/invoice/${hash(hash(JSON.stringify(body)))}`;
    const prior = { pk: key, kind: "OPERATION", provider: "resend", state, payloadHash: hash(JSON.stringify(body)), attempt: 0, nextRetryAt: new Date(now - 1).toISOString() }; h.rows.set(key, structuredClone(prior));
    await expect(new TransactionalMailClient("invoice", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.rows.get(key)).toEqual(prior); expect(h.sesMock).not.toHaveBeenCalled();  expect(h.storage.send).not.toHaveBeenCalled();
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
    expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it.each([{ missingReceipt: true }, { receiptFailure: true }])("holds missing/persistence-lost SES receipts: %o", async options => {
    const h = harness(options); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" }); expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it("never retries an uncertain SES operation or uses retired HTTP", async () => {
    const h = harness({ sesError: new TypeError("network") }); const client = new TransactionalMailClient("login", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" });  expect(h.sesMock).toHaveBeenCalledOnce();
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
    expect(quotaPolicy("login", "2026-11-04T02:00:00Z")).toMatchObject({ dayKey: "QUOTA#SES#DAY#2026-11-04", dayLimit: 1000, monthLimit: 30000 });
  });
  it.each([
    { kind: "login", daily: "1", monthly: "3000", reason: "daily_quota_exceeded", retry: "2026-11-05T00:00:00.000Z" },
    { kind: "login", daily: "100", monthly: "1", reason: "monthly_quota_exceeded", retry: "2026-12-01T00:00:00.000Z" },
    { kind: "invoice", daily: "6", monthly: "3000", reason: "daily_quota_exceeded", retry: "2026-11-05T00:00:00.000Z" },
    { kind: "invoice", daily: "100", monthly: "51", reason: "monthly_quota_exceeded", retry: "2026-12-01T00:00:00.000Z" },
  ] as const)("defers two recipients beyond a fresh effective cap without claiming or sending: %o", async ({ kind, daily, monthly, reason, retry }) => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); vi.stubEnv("HOA_SES_DAILY_LIMIT", daily); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", monthly);
    const h = harness();
    const c = new SendEmailCommand({ ...command().input, Destination: { ToAddresses: ["jake@getgim.com"], CcAddresses: ["member@example.com"] } });
    await expect(new TransactionalMailClient(kind, h.deps).send(c)).rejects.toMatchObject({ state: "DEFERRED" });
    expect([...h.rows.values()]).toEqual([expect.objectContaining({ kind: "OPERATION", provider: "ses", state: "DEFERRED", attempt: 0, failureReason: reason, nextRetryAt: retry })]);
    expect(h.objects.size).toBe(1); expect(JSON.parse([...h.objects.values()][0])).toMatchObject({ to: ["jake@getgim.com"], cc: ["member@example.com"] });
    expect(h.transactions).toHaveLength(0);
    expect(h.database.send.mock.calls.some(([c]) => c.input.Key?.pk?.startsWith("QUOTA#"))).toBe(false);
    expect(h.sesMock).not.toHaveBeenCalled();
  });
  it("permits a fresh send whose recipient cost exactly equals both effective caps", async () => {
    vi.stubEnv("HOA_TRANSACTIONAL_MAIL_PROVIDER", "ses"); vi.stubEnv("HOA_SES_DAILY_LIMIT", "2"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "2");
    const h = harness(); const c = new SendEmailCommand({ ...command().input, Destination: { ToAddresses: ["jake@getgim.com"], BccAddresses: ["member@example.com"] } });
    await expect(new TransactionalMailClient("login", h.deps).send(c)).resolves.toEqual({ MessageId: "ses-receipt-12345" });
    expect(h.sesMock).toHaveBeenCalledOnce();
    for (const { Update: counter } of h.transactions[0].TransactItems.slice(1)) expect(counter.ExpressionAttributeValues).toMatchObject({ ":cost": 2, ":remaining": 0 });
  });
  it.each([{ HOA_SES_DAILY_LIMIT: "50001" }, { HOA_SES_DAILY_LIMIT: "1.5" }, { HOA_SES_MONTHLY_LIMIT: "0" }, { HOA_SES_MONTHLY_LIMIT: "1500001" }])("rejects unsafe SES application caps before persistence: %o", async patch => {
    for (const [k, v] of Object.entries(patch)) vi.stubEnv(k, v); const h = harness(); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toThrow("limits"); expect(h.database.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled();
  });
});

describe('withdrawn invoice mail remains retired across operator recovery',()=>{
 it.each(['DEFERRED','RESERVED','ACCEPTED','UNKNOWN'])('never sends or replays retired %s evidence',async state=>{
  const h=harness(),body=payload(command().input,{}),digest=hash(JSON.stringify(body)),pk=`OP#hoa/main/invoice/${hash(digest)}`;
  h.rows.set(pk,{pk,state,payloadHash:digest,payloadKey:`outbox/main/${hash(pk.slice(3))}/${digest}.json`,attempt:1,provider:'ses',providerId:'historic-provider',retiredAt:new Date(now).toISOString()});
  const client=new TransactionalMailClient('invoice',h.deps);
  await expect(client.send(command())).rejects.toThrow('retired');
  await expect(client.replay(pk,digest)).rejects.toThrow('retired');
  expect(h.sesMock).not.toHaveBeenCalled();expect(h.rows.get(pk)).toMatchObject({state,providerId:'historic-provider'});
 });
 it('a retirement marker winning after replay reads stops its actual provider claim',async()=>{
  const h=harness({beforeClaim:()=>{const op=[...h.rows.values()].find(row=>row.kind==='OPERATION');op.retiredAt=new Date(now).toISOString();}});
  await expect(new TransactionalMailClient('invoice',h.deps).send(command())).rejects.toThrow('retired');
  expect(h.sesMock).not.toHaveBeenCalled();
  expect(h.transactions[0].TransactItems[0].Update.ConditionExpression).toContain('attribute_not_exists(retiredAt)');
 });
});
