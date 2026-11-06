import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TransactionalMailClient, retryAt } from "../../amplify/functions/transactional-mail/client";
import { assertDestination, hash, payload } from "../../amplify/functions/transactional-mail/contract";
import { bound, command, harness, now } from "./helpers/transactionalMail";

beforeEach(() => {
  for (const [key, value] of Object.entries(bound)) vi.stubEnv(key, value);
  vi.stubEnv("HOA_SES_DAILY_LIMIT", "1000"); vi.stubEnv("HOA_SES_MONTHLY_LIMIT", "30000");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("HTTP email is retired"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("SES-only destination boundaries", () => {
  it.each(Object.entries({
    wrongApp: { HOA_MIGRATION_APP_ID: "old" }, wrongBranch: { HOA_MIGRATION_BRANCH: "main" },
    wrongAccount: { HOA_SES_IDENTITY_ARN: bound.HOA_SES_IDENTITY_ARN.replace("917680434255", "637423611040") },
    preview: { HOA_MIGRATION_PREVIEW: "true" }, noRelease: { HOA_TRANSACTIONAL_MAIL_RELEASE: "false" },
    workersHeld: { HOA_MIGRATION_WORKERS_ENABLED: "false" }, oldProvider: { HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend" },
    wrongConfig: { HOA_SES_CONFIGURATION_SET: "unreviewed" }, wrongRegion: { AWS_REGION: "us-west-2" },
    wrongRuntime: { AWS_LAMBDA_FUNCTION_NAME: "source-function" },
  }))("rejects %s before persistence or network sends", async (_, patch) => {
    for (const [key, value] of Object.entries(patch)) vi.stubEnv(key, value);
    const h = harness(); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toThrow();
    expect(h.database.send).not.toHaveBeenCalled(); expect(h.storage.send).not.toHaveBeenCalled(); expect(h.sesMock).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("allows existing main/staging report names with their own configuration set only", () => {
    for (const [branch, name, config] of [
      ["codex-hoa-account-migration", "marketing-report-mplifyd1nuh9rw1hcuxomainbranch0e4fdbd849", "hoa-transactional-main"],
      ["codex-hoa-staging-migration", "marketing-report-ifyd1nuh9rw1hcuxostagingbranch3787a09124", "hoa-transactional-staging"],
    ]) {
      const env = { ...bound, HOA_MIGRATION_BRANCH: branch, AWS_LAMBDA_FUNCTION_NAME: name, HOA_SES_CONFIGURATION_SET: config };
      expect(() => assertDestination("report", payload(command().input, {}), env, now)).not.toThrow();
      expect(() => assertDestination("report", payload(command().input, {}), { ...env, AWS_LAMBDA_FUNCTION_NAME: name + "-other" }, now)).toThrow();
    }
  });
  it("no longer depends on any Resend secret or preview setting", async () => {
    vi.stubEnv("HOA_RESEND_SECRET_ARN", ""); vi.stubEnv("HOA_RESEND_PREVIEW_ENABLED", "false");
    const h = harness(); await expect(new TransactionalMailClient("login", h.deps).send(command())).resolves.toEqual({ MessageId: "ses-receipt-12345" });
     expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("durable delivery and recovery", () => {
  it("persists once, reserves current production counters and reuses acceptance", async () => {
    const h = harness(); const client = new TransactionalMailClient("login", h.deps);
    expect(await client.send(command())).toEqual({ MessageId: "ses-receipt-12345" });
    expect(await client.send(command())).toEqual({ MessageId: "ses-receipt-12345" });
    expect(h.sesMock).toHaveBeenCalledOnce(); expect(h.storage.send).toHaveBeenCalledOnce();
    expect(h.rows.get("QUOTA#SES#DAY#2026-11-04").count).toBe(1);
    expect(h.rows.get("QUOTA#SES#MONTH#2026-11").count).toBe(1);
    expect(h.transactions[1].TransactItems[1].Update.UpdateExpression).not.toMatch(/delivered|bounced/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("refuses different content under an existing operation key", async () => {
    const h = harness(); const client = new TransactionalMailClient("invoice", h.deps);
    await client.send(command(), { idempotencyKey: "one-logical-send" });
    await expect(client.send(command(), { idempotencyKey: "one-logical-send", text: "changed" })).rejects.toThrow("different content");
    expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it("checks shared suppressions before SES or quota reservation", async () => {
    const h = harness({ suppression: true }); await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "SUPPRESSED" });
    expect(h.sesMock).not.toHaveBeenCalled(); expect(h.transactions).toHaveLength(0);
    expect(h.database.send.mock.calls.some(([c]) => c.input.Key?.pk === `SUPPRESSION#${hash("jake@getgim.com")}`)).toBe(true);
  });
  it("keeps quota-deferred mail saved and prevents an early retry", async () => {
    const h = harness({ quota: true }); const client = new TransactionalMailClient("invoice", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    const before = h.database.send.mock.calls.length;
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.sesMock).not.toHaveBeenCalled(); expect(h.objects.size).toBe(1); expect(h.database.send.mock.calls.length).toBe(before + 1);
  });
  it("replays only the exact saved definitely-unsent SES envelope after cooldown", async () => {
    const options = { quota: true }; const h = harness(options); const client = new TransactionalMailClient("invoice", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    const row = [...h.rows.values()].find(r => r.kind === "OPERATION"); options.quota = false; h.deps.now = () => Date.parse(row.nextRetryAt) + 1;
    await expect(client.replay(row.pk, "0".repeat(64))).rejects.toThrow("definitely unsent");
    await expect(client.replay(row.pk, row.payloadHash)).resolves.toEqual({ MessageId: "ses-receipt-12345" });
    expect(h.sesMock).toHaveBeenCalledOnce(); expect(h.objects.size).toBe(1);
    await expect(client.replay(row.pk, row.payloadHash)).rejects.toThrow("definitely unsent");
  });
  it("rejects tampered replay payload without a provider call", async () => {
    const h = harness({ quota: true }); const client = new TransactionalMailClient("invoice", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    const row = [...h.rows.values()].find(r => r.kind === "OPERATION"); h.objects.set(row.payloadKey, h.objects.get(row.payloadKey)! + " ");
    await expect(client.replay(row.pk, row.payloadHash)).rejects.toThrow("checksum"); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it("never recovers an uncertain accounting send", async () => {
    const h = harness({ sesError: new TypeError("lost response") }); const client = new TransactionalMailClient("accounting", h.deps);
    await expect(client.send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    const row = [...h.rows.values()].find(r => r.kind === "OPERATION");
    await expect(client.replay(row.pk, row.payloadHash)).rejects.toThrow("definitely unsent"); expect(h.sesMock).toHaveBeenCalledOnce();
  });
  it("preserves a concurrent send claim as uncertain instead of retrying or overwriting it", async () => {
    const h = harness({ beforeClaim: () => { Object.assign([...h.rows.values()].find(r => r.kind === "OPERATION"), { state: "SENDING", attempt: 1 }); } });
    await expect(new TransactionalMailClient("invoice", h.deps).send(command())).rejects.toMatchObject({ state: "UNKNOWN" });
    expect([...h.rows.values()].find(r => r.kind === "OPERATION")).toMatchObject({ state: "SENDING", attempt: 1 }); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it("returns a concurrent winner's accepted receipt without a second SES call", async () => {
    const h = harness({ beforeClaim: () => { Object.assign([...h.rows.values()].find(r => r.kind === "OPERATION"), { state: "ACCEPTED", attempt: 1, providerId: "concurrent-ses-receipt" }); } });
    await expect(new TransactionalMailClient("invoice", h.deps).send(command())).resolves.toEqual({ MessageId: "concurrent-ses-receipt" }); expect(h.sesMock).not.toHaveBeenCalled();
  });
  it("rechecks release withdrawal after persistence and before SES", async () => {
    const h = harness({ beforeClaim: () => vi.stubEnv("HOA_TRANSACTIONAL_MAIL_RELEASE", "false") });
    await expect(new TransactionalMailClient("login", h.deps).send(command())).rejects.toMatchObject({ state: "DEFERRED" });
    expect(h.sesMock).not.toHaveBeenCalled(); expect([...h.rows.values()].find(r => r.kind === "OPERATION")).toMatchObject({ state: "DEFERRED", attempt: 1 });
  });
  it("refuses raw MIME without its structured attachment envelope", () => {
    expect(() => payload({ ...command().input, Content: { Raw: { Data: Buffer.from("mime") } } }, {})).toThrow("structured");
  });
  it("calculates bounded daily, monthly and provider retry windows", () => {
    expect(retryAt(now, "daily_quota_exceeded")).toBe("2026-11-05T00:00:00.000Z");
    expect(retryAt(now, "monthly_quota_exceeded")).toBe("2026-12-01T00:00:00.000Z");
    expect(retryAt(now, "rate_limit_exceeded", "120")).toBe("2026-11-04T02:02:00.000Z");
    expect(retryAt(now, "service_unavailable", "999999")).toBe("2026-11-05T02:00:00.000Z");
  });
});
