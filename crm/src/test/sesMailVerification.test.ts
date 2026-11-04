import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { unzipSync } from "fflate";
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../amplify/functions/transactional-mail/client", () => ({ TransactionalMailClient: class { send = h.send; } }));
import { handler } from "../../amplify/functions/transactional-mail/verification";

const runtime = "amplify-d1nuh9rw1hcuxo-ma-mailverificationlambda56-fixture";
const context = { invokedFunctionArn: `arn:aws:lambda:us-east-1:917680434255:function:${runtime}` } as never;
const event = { fixture: "complete", runId: "e275d490-3268-41ba-88dd-6e922351d421" };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T02:00:00Z"));
  h.send.mockReset().mockResolvedValue({ MessageId: "synthetic-ses-receipt" });
  for (const [k, v] of Object.entries({
    HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration", HOA_MIGRATION_PREVIEW: "false",
    HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_MIGRATION_WORKERS_ENABLED: "true",
    HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail", HOA_TRANSACTIONAL_MAIL_BUCKET: "hoa-transactional-mail-917680434255-us-east-1",
    HOA_SES_IDENTITY_ARN: "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com",
    HOA_SES_VERIFICATION_EXPIRES_AT: "2026-11-04T02:30:00.000Z", HOA_SES_CONFIGURATION_SET: "hoa-transactional-main", AWS_REGION: "us-east-1", AWS_LAMBDA_FUNCTION_NAME: runtime,
  })) vi.stubEnv(k, v);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("operator-only combined SES verification", () => {
  it("sends one synthetic HTML/text envelope with a real PDF and XLSX and no business token", async () => {
    expect(await handler(event, context)).toMatchObject({ provider: "ses", fixture: "complete", synthetic: true }); expect(h.send).toHaveBeenCalledOnce();
    const [command, details] = h.send.mock.calls[0]; expect(command.input.Destination).toEqual({ ToAddresses: ["jake@getgim.com"] });
    expect(command.input.FromEmailAddress).toBe("HOA Insurance Agency <noreply@protectmyhoa.com>"); expect(command.input.Content.Simple.Subject.Data).toBe("[Migration test] HOA SES email delivery");
    expect(command.input.Content.Simple.Body.Text.Data).toContain("no customer information"); expect(command.input.Content.Simple.Body.Html.Data).not.toContain("#magic=");
    expect(details.idempotencyKey).toBe(`verification:${event.runId}:complete`); expect(details.attachments).toHaveLength(2);
    const pdf = await PDFDocument.load(details.attachments[0].content); expect(pdf.getPages()).toHaveLength(1);
    const workbook = unzipSync(details.attachments[1].content); expect(Object.keys(workbook)).toContain("xl/workbook.xml");
    expect(Object.entries(workbook).filter(([name]) => name.endsWith(".xml")).some(([, data]) => new TextDecoder().decode(data).includes("Migration test only"))).toBe(true);
  });
  it("supports the insurance sender with the same fixed owner and a separate operation identity", async () => {
    expect(await handler({ ...event, sender: "insurance" }, context)).toMatchObject({ provider: "ses", fixture: "complete" });
    expect(h.send).toHaveBeenCalledOnce(); const [command, details] = h.send.mock.calls[0];
    expect(command.input.FromEmailAddress).toBe("HOA Insurance Agency <insurance@protectmyhoa.com>"); expect(command.input.Destination).toEqual({ ToAddresses: ["jake@getgim.com"] });
    expect(details.idempotencyKey).toBe(`verification:${event.runId}:complete:insurance`); expect(details.attachments).toHaveLength(2);
  });
  it("supports the stage test mailbox but preserves its config and sender isolation", async () => {
    vi.stubEnv("HOA_MIGRATION_BRANCH", "codex-hoa-staging-migration"); vi.stubEnv("HOA_SES_CONFIGURATION_SET", "hoa-transactional-staging");
    expect(await handler({ ...event, sender: "testing" }, context)).toMatchObject({ provider: "ses" });
    const [command, details] = h.send.mock.calls[0];
    expect(command.input.FromEmailAddress).toBe("HOA Insurance Agency <jake+testing@protectmyhoa.com>");
    expect(command.input.Destination).toEqual({ ToAddresses: ["jake@getgim.com"] });
    expect(details.idempotencyKey).toBe(`verification:${event.runId}:complete:testing`);
    await expect(handler({ ...event, sender: "insurance" }, context)).rejects.toThrow("sender");
    expect(h.send).toHaveBeenCalledOnce();
  });
  it("rejects unknown or address-shaped sender overrides before transport", async () => {
    for (const sender of ["other", "noreply@protectmyhoa.com", "insurance@other.example"]) await expect(handler({ ...event, sender }, context)).rejects.toThrow("sender");
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([
    { HOA_SES_VERIFICATION_EXPIRES_AT: "" }, { HOA_SES_VERIFICATION_EXPIRES_AT: "2026-11-04T01:59:59.000Z" }, { HOA_SES_VERIFICATION_EXPIRES_AT: "2026-11-04T04:00:00.000Z" }, { HOA_TRANSACTIONAL_MAIL_PROVIDER: "resend" },
    { HOA_MIGRATION_PREVIEW: "true" }, { HOA_MIGRATION_BRANCH: "codex-hoa-staging-migration" }, { AWS_REGION: "us-west-2" }, { AWS_LAMBDA_FUNCTION_NAME: runtime.replace("mailverification", "other") },
  ])("refuses a missing/expired or incorrectly scoped verification before sending: %o", async patch => {
    for (const [k, v] of Object.entries(patch)) vi.stubEnv(k, v); await expect(handler(event, context)).rejects.toThrow(); expect(h.send).not.toHaveBeenCalled();
  });
  it("rejects an unbound run ID, function and separate multiple-message fixtures", async () => {
    for (const bad of [{ ...event, runId: "not-an-operator-run" }, { ...event, fixture: "invoice" }]) await expect(handler(bad, context)).rejects.toThrow();
    await expect(handler(event, { invokedFunctionArn: "arn:aws:lambda:us-east-1:637423611040:function:wrong" } as never)).rejects.toThrow(); expect(h.send).not.toHaveBeenCalled();
  });
});
