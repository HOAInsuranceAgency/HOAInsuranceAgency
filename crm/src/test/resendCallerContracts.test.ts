import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payload, MailDeliveryError } from "../../amplify/functions/transactional-mail/contract";

// These are offline caller contracts. AWS, Stripe, and the sending boundary are
// mocked; the actual five callers still assemble their own production messages.
const h = vi.hoisted(() => ({
  mail: vi.fn(), cognito: vi.fn(), db: vi.fn(), models: {} as Record<string, any>,
  order: [] as string[], run: undefined as any, reportUpdates: [] as any[],
  invoice: {} as any, writePayment: vi.fn(), createdSub: "synthetic-member-1",
}));
vi.mock("../../amplify/functions/transactional-mail/client", () => ({ TransactionalMailClient: class {
  constructor(private readonly kind: string) {}
  send(command: unknown, details: unknown = {}) { return h.mail(this.kind, command, details); }
} }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async original => ({ ...await original<object>(), CognitoIdentityProviderClient: class { send = h.cognito; } }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({ ...await original<object>(), DynamoDBDocumentClient: { from: () => ({ send: h.db }) } }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: h.models }) }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock("../../amplify/functions/crm-access/user-status", () => ({ assertUserSession: async () => {}, readUserAccess: async () => undefined }));
vi.mock("../../amplify/functions/magic-link/token", () => ({ getSigningSecret: async () => "synthetic-only", mintToken: () => "synthetic-token-never-valid" }));
vi.mock("../../amplify/functions/send-invoice/pdf", () => ({ pdfFilename: (number: string) => `${number}.pdf`, renderInvoicePdf: async () => Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]) }));
vi.mock("../../amplify/functions/marketing-report/snapshot", () => ({ reportSnapshot: async () => ({ accounts: [], quotes: [], policies: [], priorCarriers: [], carriers: [], documents: [], activities: [], workflows: [], communications: [], submissions: [] }) }));
vi.mock("../../amplify/functions/marketing-report/store", () => ({
  assertRecipient: async () => {}, environment: () => "main", readSettings: async () => undefined,
  readRun: async () => h.run, reserveRun: async () => ({ record: h.run }), conflict: () => false,
  updateRun: async (record: any, patch: any) => { h.reportUpdates.push(patch); h.run = { ...record, data: { ...record.data, ...patch } }; return h.run; },
}));
vi.mock("stripe", () => ({ default: class { webhooks = { constructEvent: () => ({ type: "payment_intent.succeeded", data: { object: {} } }) }; } }));
vi.mock("../../amplify/functions/stripe-webhook/decide", () => ({
  decidePfEvent: () => null,
  decideEvent: () => ({ invoiceId: "synthetic-invoice", outcome: "PAID", paymentIntentId: "pi_synthetic" }),
  decideUpdate: () => ({ action: "write", status: "PAID", paidAt: "2026-10-30", paymentIntentId: "pi_synthetic", occurredAt: "2026-10-30T12:00:00Z", intentCreatedAt: "2026-10-30T11:00:00Z" }),
}));
vi.mock("../../amplify/functions/stripe-webhook/pf", () => ({ applyPfEvent: vi.fn() }));
vi.mock("../../amplify/functions/stripe-webhook/persist", () => ({ readInvoice: async () => h.invoice, writePaymentState: h.writePayment }));
vi.mock("../../amplify/functions/stripe-webhook/lookups", () => ({ readPaidContext: async () => ({ associationName: "Synthetic HOA", policyNumber: "SYN-001", carrierName: "Synthetic carrier" }) }));

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  h.mail.mockReset().mockImplementation(async () => { h.order.push("mail"); return { MessageId: "synthetic-provider-receipt" }; });
  h.order.length = 0; h.reportUpdates.length = 0; h.createdSub = "synthetic-member-1";
  h.db.mockReset().mockImplementation(async () => { h.order.push("business-write"); return {}; });
  h.cognito.mockReset().mockImplementation(async command => command.constructor.name === "AdminCreateUserCommand" ? { User: { Username: "synthetic-member", Attributes: [{ Name: "sub", Value: h.createdSub }] } } : {});
  h.writePayment.mockReset().mockImplementation(async () => { h.order.push("payment-write"); return true; });
  for (const [key, value] of Object.entries({
    HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_PREVIEW: "false", HOA_MIGRATION_WORKERS_ENABLED: "true",
    MAGIC_LINK_BASE_URL: "https://crm.protectmyhoa.com", MAGIC_LINK_FROM: "noreply@protectmyhoa.com",
    USER_POOL_ID: "synthetic-destination-pool", PORTAL_URL: "https://crm.protectmyhoa.com", INVITE_FROM: "noreply@protectmyhoa.com",
    AGENCY_MAILBOX: "insurance@protectmyhoa.com", ACCOUNTING_MAILBOX: "accounting@example.com", INVOICE_TABLE: "synthetic-invoice-table",
    MARKETING_REPORT_FROM: "insurance@protectmyhoa.com", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_only",
  })) vi.stubEnv(key, value);
  vi.stubEnv("STRIPE_SECRET_KEY", ""); vi.stubEnv("PF_LOAN_TABLE", ""); vi.stubEnv("SITE_URL", "");
  h.invoice = { id: "synthetic-invoice", number: "INV-SYN-001", accountId: "synthetic-account", policyId: "synthetic-policy", status: "DRAFT", issuedAt: "2026-10-30", updatedAt: "2026-10-30T11:00:00Z", stripePaymentIntentId: "pi_synthetic", remittanceCarrierCents: 80000, remittanceCommissionCents: 20000, remittanceInterestCents: 0 };
  const lines = [{ id: "synthetic-line", invoiceId: h.invoice.id, policyId: h.invoice.policyId, description: "Synthetic premium", kind: "PREMIUM", retailAmount: 1000, costAmount: 800 }];
  h.models = {
    Invoice: { get: async () => ({ data: h.invoice }), list: async () => ({ data: [h.invoice] }) },
    Account: { get: async () => ({ data: { id: "synthetic-account", name: "Synthetic HOA", state: "NH", address: "1 Test Way" } }) },
    InvoiceLine: { list: async () => ({ data: lines }) },
    Contact: { list: async () => ({ data: [{ id: "synthetic-contact", email: "board@example.com", name: "Synthetic Board", isPrimary: true }] }) },
    Policy: { get: async () => ({ data: { id: "synthetic-policy", policyNumber: "SYN-001", lines: ["Property"] } }) },
  };
  const runId = `marketing-report:run:manual:${"a".repeat(64)}`;
  h.run = { id: runId, version: 1, data: { id: runId, kind: "manual", actor: "synthetic-admin", status: "queued", recipient: "reports@example.com", asOf: "2026-10-30T12:00:00Z" } };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function captured() { const [kind, command, details] = h.mail.mock.calls[0]; return { kind, command, details, body: payload(command.input, details) }; }

describe("real sender to Resend adapter contracts", () => {
  it("login preserves its exact destination, encoded link, expiry copy, and sender", async () => {
    const { sendDestinationLink } = await import("../../amplify/functions/magic-link/send");
    await sendDestinationLink("member@example.com");
    const { kind, body } = captured();
    expect(kind).toBe("login"); expect(body.from).toBe("noreply@protectmyhoa.com"); expect(body.to).toEqual(["member@example.com"]);
    expect(body.text).toContain("https://crm.protectmyhoa.com/#magic=synthetic-token-never-valid"); expect(body.text).toContain("15 minutes");
    expect(body.subject).toBe("Your HOA CRM sign-in link");
  });
  it("login bubbles a definite transport failure instead of claiming acceptance", async () => {
    const { sendDestinationLink } = await import("../../amplify/functions/magic-link/send");
    h.mail.mockRejectedValue(new MailDeliveryError("DEFERRED", "OP#synthetic"));
    await expect(sendDestinationLink("member@example.com")).rejects.toMatchObject({ state: "DEFERRED" });
  });
  it("invitation preserves roles and portal while giving recreated members a new operation", async () => {
    const { handler } = await import("../../amplify/functions/team-admin/handler");
    const event = { arguments: { email: " New@Example.com ", roles: ["ADMIN", "PRODUCER"] }, info: { fieldName: "inviteUser" }, identity: { username: "admin", sub: "admin", groups: ["ADMIN"] }, request: { headers: {} } };
    expect(await handler(event as never)).toMatchObject({ ok: true });
    const { kind, body, details } = captured();
    expect(kind).toBe("invite"); expect(body.to).toEqual(["new@example.com"]); expect(body.html).toContain("ADMIN and PRODUCER"); expect(body.html).toContain("https://crm.protectmyhoa.com");
    expect(details.idempotencyKey).toBe("invite:synthetic-member-1");
    expect(h.cognito.mock.calls[0][0].input.MessageAction).toBe("SUPPRESS");
    h.createdSub = "synthetic-member-2"; await handler(event as never);
    expect(h.mail.mock.calls[1][2].idempotencyKey).toBe("invite:synthetic-member-2");
  });
  it("uncertain invitation keeps the created identity and never performs rollback deletion", async () => {
    const { handler } = await import("../../amplify/functions/team-admin/handler");
    h.mail.mockRejectedValue(new MailDeliveryError("UNKNOWN", "OP#synthetic"));
    const result = await handler({ arguments: { email: "new@example.com", roles: ["ADMIN"] }, info: { fieldName: "inviteUser" }, identity: { username: "admin", sub: "admin", groups: ["ADMIN"] }, request: { headers: {} } } as never);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("uncertain") });
    expect(h.cognito.mock.calls.some(([command]) => command.constructor.name === "AdminDeleteUserCommand")).toBe(false);
  });
  it("invoice preserves To/BCC/Reply-To, HTML/text, PDF bytes, and records send only after acceptance", async () => {
    const { handler } = await import("../../amplify/functions/send-invoice/handler");
    expect(await handler({ arguments: { invoiceId: h.invoice.id, toEmail: "board@example.com" } })).toMatchObject({ ok: true });
    const { kind, command, details, body } = captured();
    expect(kind).toBe("invoice"); expect(body.to).toEqual(["board@example.com"]); expect(body.bcc).toEqual(["insurance@protectmyhoa.com"]); expect(body.reply_to).toBe("insurance@protectmyhoa.com");
    expect(body.text).toContain("Synthetic HOA"); expect(body.html).toContain("INV-SYN-001"); expect(details.idempotencyKey).toContain("synthetic-invoice");
    expect(Buffer.from(body.attachments![0].content, "base64").toString()).toBe("%PDF-1.7");
    const mime = Buffer.from(command.input.Content.Raw.Data).toString(); expect(mime).not.toMatch(/^Bcc:/mi); expect(mime).toContain(body.attachments![0].content);
    expect(h.order.indexOf("mail")).toBeLessThan(h.order.indexOf("business-write"));
  });
  it("invoice does not mark a deferred message sent", async () => {
    const { handler } = await import("../../amplify/functions/send-invoice/handler");
    h.mail.mockRejectedValue(new MailDeliveryError("DEFERRED", "OP#synthetic"));
    expect(await handler({ arguments: { invoiceId: h.invoice.id, toEmail: "board@example.com" } })).toMatchObject({ ok: false });
    expect(h.db).not.toHaveBeenCalled();
  });
  it("report preserves the reserved recipient/run key and real XLSX attachment", async () => {
    const { handler } = await import("../../amplify/functions/marketing-report/worker");
    const runId = h.run.id; expect(await handler({ trigger: "manual", runId })).toMatchObject({ sent: true });
    const { kind, command, details, body } = captured();
    expect(kind).toBe("report"); expect(body.to).toEqual(["reports@example.com"]); expect(body.reply_to).toBe("insurance@protectmyhoa.com"); expect(details.idempotencyKey).toBe(runId);
    const bytes = Buffer.from(body.attachments![0].content, "base64"); expect(bytes.subarray(0, 2).toString()).toBe("PK"); expect(body.attachments![0].filename).toBe("HOA_LEAD_UPDATE_2026-10-30.xlsx");
    expect(Buffer.from(command.input.Content.Raw.Data).toString()).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(h.run.data).toMatchObject({ status: "sent", messageId: "synthetic-provider-receipt" });
  });
  it.each(["DEFERRED", "UNKNOWN"] as const)("report distinguishes %s without blind requeue", async state => {
    const { handler } = await import("../../amplify/functions/marketing-report/worker");
    h.mail.mockRejectedValue(new MailDeliveryError(state, "OP#synthetic")); const runId = h.run.id;
    await expect(handler({ trigger: "manual", runId })).rejects.toThrow();
    expect(h.run.data).toMatchObject({ status: state === "UNKNOWN" ? "unknown" : "failed", retryable: state !== "UNKNOWN" });
    await handler({ trigger: "manual", runId }); expect(h.mail).toHaveBeenCalledOnce();
  });
  it.each([false, true])("accounting preserves remittance and commits payment before mail (deferred=%s)", async deferred => {
    const { handler } = await import("../../amplify/functions/stripe-webhook/handler");
    if (deferred) h.mail.mockImplementation(async () => { h.order.push("mail"); throw new MailDeliveryError("DEFERRED", "OP#synthetic"); });
    expect(await handler({ body: "synthetic signed fixture", headers: { "stripe-signature": "synthetic" } })).toMatchObject({ statusCode: 200 });
    const { kind, body } = captured(); expect(kind).toBe("accounting"); expect(body.to).toEqual(["accounting@example.com"]); expect(body.from).toContain("insurance@protectmyhoa.com");
    expect(body.text).toContain("INV-SYN-001"); expect(body.text).toContain("Synthetic HOA"); expect(body.html).toContain("Synthetic carrier");
    expect(h.order.indexOf("payment-write")).toBeLessThan(h.order.indexOf("mail")); expect(h.writePayment).toHaveBeenCalledOnce();
  });
});
