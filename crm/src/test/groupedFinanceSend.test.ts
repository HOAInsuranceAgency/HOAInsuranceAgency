import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PDFPage } from "pdf-lib";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";

const h = vi.hoisted(() => ({
  invoice: {} as Record<string, unknown>, loan: undefined as Record<string, unknown> | undefined,
  ledger: undefined as Record<string, unknown> | undefined,
  client: {} as Record<string, unknown>, database: vi.fn(), mail: vi.fn(), group: vi.fn(),
  begin: vi.fn(), finish: vi.fn(), stripe: vi.fn(), settings: vi.fn(),
}));
vi.mock("../../amplify/functions/data-client", () => ({ createDataClientGetter: () => async () => h.client }));
vi.mock("../../amplify/functions/grouped-finance", () => ({ loadGroupedFinance: h.group }));
vi.mock("../../amplify/functions/live-write", () => ({ sendCrmWrite: async (write: Promise<unknown>) => await write }));
vi.mock("../../amplify/functions/transactional-mail/client", () => ({ TransactionalMailClient: class { send = h.mail; } }));
vi.mock("../../amplify/functions/send-invoice/sendOperation", async original => ({
  ...await original<typeof import("../../amplify/functions/send-invoice/sendOperation")>(),
  beginInvoiceSend: h.begin, completeInvoiceSend: h.finish, InvoiceSendBlocked: class extends Error {},
}));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: h.database }) },
}));
vi.mock("stripe", () => ({ default: class { constructor() { h.stripe(); } } }));

import { handler } from "../../amplify/functions/send-invoice/handler";
import { handler as election } from "../../amplify/functions/pf-election/handler";
import { hash, MailDeliveryError, payload, type MailDetails } from "../../amplify/functions/transactional-mail/contract";

const account = { id: "account", name: "Example Association", state: "MA", type: "ASSOCIATION" };
const policyIds = ["property", "liability"];
const agreementLines = ["Property carrier | policy A | $12,500.00", "Liability carrier | policy B | $20,000.00"];
const operation = { version: 1, key: "invoice:group:mail", leaseId: "mail-lease", leaseUntil: 100,
  previousSentAt: null, recipients: hash("board@example.test") };
const sentAt = "2026-11-09T18:00:00.000Z";
const memberGuard = { ConditionCheck: {
  TableName: "Policy", Key: { id: "property" }, ConditionExpression: "updatedAt = :v", ExpressionAttributeValues: { ":v": "policy-version" },
} };
function acceptMail(command: SendEmailCommand, details: MailDetails) {
  const idempotencyKey = `hoa/main/invoice/${hash(details.idempotencyKey!)}`;
  h.ledger = { pk: `OP#${idempotencyKey}`, idempotencyKey, kind: "OPERATION", mailKind: "invoice", environment: "main",
    state: "ACCEPTED", provider: "ses", providerId: "test-only", acceptedAt: sentAt, payloadHash: hash(JSON.stringify(payload(command.input, details))) };
  return { MessageId: "test-only" };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(sentAt));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  for (const [name, value] of Object.entries({ HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", INVOICE_TABLE: "Invoice",
    HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail", HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration",
    PF_LOAN_TABLE: "Loan", PF_COMPLIANCE_LOG_TABLE: "Compliance", AGENCY_SETTINGS_TABLE: "Settings",
    STRIPE_SECRET_KEY: "fixture-key", SITE_URL: "https://agency.example.test" })) vi.stubEnv(name, value);
  h.invoice = { id: "group", accountId: "account", number: "INV-GROUP", status: "DRAFT", updatedAt: "invoice-version",
    sourcePricingVersion: 3, groupedPolicyIds: policyIds };
  h.loan = undefined;
  h.ledger = undefined;
  h.settings.mockResolvedValue({ data: { premiumFinanceEnabled: true } });
  h.client = { models: {
    Invoice: { get: async () => ({ data: { ...h.invoice } }) },
    Account: { get: async () => ({ data: account }) },
    Contact: { list: async () => ({ data: [{ id: "board", email: "board@example.test", isPrimary: true }] }) },
    AgencySettings: { get: h.settings },
    PfLoan: { listPfLoanByElectionToken: async ({ electionToken }: { electionToken: string }) =>
      ({ data: h.loan?.electionToken === electionToken ? [h.loan] : [] }) },
  } };
  h.group.mockImplementation(async () => ({
    invoice: { ...h.invoice }, account, premium: 32500, agreementLines,
    policies: policyIds.map(id => ({ id, lines: ["Commercial Property"], effectiveDate: "2026-11-01", expirationDate: "2027-11-01" })),
    lines: [{ description: "Property premium", retailAmount: 12500, costAmount: 10000 },
      { description: "Liability premium", retailAmount: 20000, costAmount: 20000 }],
    guards: [memberGuard], invoiceGuard: { ConditionCheck: {
      TableName: "Invoice", Key: { id: "group" }, ConditionExpression: "updatedAt = :v", ExpressionAttributeValues: { ":v": "invoice-version" },
    } },
  }));
  h.begin.mockImplementation(async () => {
    h.invoice.invoiceSendOperation = operation;
    return { operation };
  });
  h.mail.mockImplementation(async (command: SendEmailCommand, details: MailDetails) => acceptMail(command, details));
  h.database.mockImplementation(async command => {
    const input = command.input;
    if (command.constructor.name === "TransactWriteCommand") {
      const put = input.TransactItems.find((item: { Put?: { TableName: string } }) => item.Put?.TableName === "Loan")?.Put;
      if (put) {
        h.loan = put.Item;
        h.invoice.groupedFinanceLoanId = put.Item.id;
      }
      const completion = input.TransactItems.find((item: { Update?: { UpdateExpression: string } }) => item.Update?.UpdateExpression.startsWith("SET #op = :complete"))?.Update;
      if (completion) {
        const values = completion.ExpressionAttributeValues;
        Object.assign(h.invoice, { status: "SENT", sentAt: values[":sentAt"], sentTo: values[":sentTo"],
          updatedAt: values[":now"], invoiceSendOperation: values[":complete"] });
      }
    }
    if (command.constructor.name === "UpdateCommand" && input.TableName === "Loan" && h.loan) {
      const values = input.ExpressionAttributeValues;
      Object.assign(h.loan, { electionToken: values[":tok"], electionTokenExpiresAt: values[":exp"] });
    }
    if (command.constructor.name === "UpdateCommand" && input.UpdateExpression === "SET #op = :prepared") h.invoice.invoiceSendOperation = input.ExpressionAttributeValues[":prepared"];
    if (command.constructor.name === "GetCommand" && input.TableName === "Loan") return { Item: h.loan };
    if (command.constructor.name === "GetCommand" && input.TableName === "Invoice") return { Item: { ...h.invoice } };
    if (command.constructor.name === "GetCommand" && input.TableName === "HOA-TransactionalMail") return { Item: h.ledger?.pk === input.Key.pk ? h.ledger : undefined };
    return {};
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const send = (args: { expectedSentAt?: string; toEmail?: string } = {}) => handler({ arguments: { invoiceId: "group", ...args } });

it("reserves one group loan and sends an itemized invoice with a single financing route", async () => {
  const pdfText = vi.spyOn(PDFPage.prototype, "drawText");
  await expect(send({ expectedSentAt: "" })).resolves.toMatchObject({ ok: true, sentTo: "board@example.test" });
  expect(h.stripe).not.toHaveBeenCalled();
  expect(h.mail).toHaveBeenCalledTimes(1);
  expect(h.loan).toMatchObject({ groupedInvoiceId: "group", groupedPolicyIds: policyIds,
    groupedPolicyAgreementLines: agreementLines, premium: 32500, downPayment: 8125, originationFee: 10 });
  expect(h.loan).not.toHaveProperty("policyId");
  expect(h.loan).not.toHaveProperty("quoteId");
  const [origination] = h.database.mock.calls.map(([command]) => command.input.TransactItems).filter(Boolean);
  expect(origination).toEqual(expect.arrayContaining([memberGuard, expect.objectContaining({ Update: expect.objectContaining({
    TableName: "Invoice", UpdateExpression: "SET groupedFinanceLoanId = :groupNewLoan",
    ConditionExpression: expect.stringContaining("attribute_not_exists(groupedFinanceLoanId)"),
    ExpressionAttributeValues: expect.objectContaining({ ":groupLease": "mail-lease", ":groupNewLoan": h.loan?.id }),
  }) })]));
  const [, email] = h.mail.mock.calls[0]!;
  expect(email.text).toContain("$8,135.00 initial payment");
  expect(email.html).toContain("Review and set up financing");
  expect(email.text).toContain("https://agency.example.test/finance/?t=");
  expect(email.html).not.toMatch(/Amount due|Pay this invoice|Payable by/);
  expect(email.attachments).toHaveLength(1);
  const printed = pdfText.mock.calls.map(([text]) => text).join(" ");
  expect(printed).toContain("$8,135.00 initial payment");
  expect(printed).toContain("Use the financing link in your invoice email");
  expect(printed).not.toMatch(/TOTAL DUE|Due Date|Make checks payable|To pay by bank transfer/);
  expect(h.invoice).toMatchObject({ status: "SENT", sentAt, invoiceSendOperation: { completed: { providerId: "test-only" } } });
  expect(h.finish).not.toHaveBeenCalled();
});

it("releases a fresh reservation when financing cannot originate before any mail or payment", async () => {
  h.settings.mockResolvedValue({ data: { premiumFinanceEnabled: false } });
  await expect(send()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Financing could not be prepared") });
  expect(h.mail).not.toHaveBeenCalled();
  expect(h.stripe).not.toHaveBeenCalled();
  expect(h.loan).toBeUndefined();
  expect(h.database.mock.calls.map(([command]) => command.input)).toEqual(expect.arrayContaining([expect.objectContaining({
    UpdateExpression: "REMOVE #op", ConditionExpression: expect.stringContaining("attribute_not_exists(groupedFinanceLoanId)"),
    ExpressionAttributeValues: { ":operation": operation, ":draft": "DRAFT" },
  })]));
});

it("restricts the grouped election email to current account contacts before reserving delivery", async () => {
  await expect(send({ toEmail: "other@example.test" })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("current account contacts") });
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.mail).not.toHaveBeenCalled();
});

it("rechecks every policy before reusing an unsent same-day grouped quote", async () => {
  h.invoice.groupedFinanceLoanId = "standing";
  h.loan = { id: "standing", status: "QUOTED", accountId: "account", state: "MA", premium: 32500,
    groupedInvoiceId: "group", groupedPolicyIds: policyIds, groupedPolicyAgreementLines: agreementLines,
    effectiveDate: "2026-11-09", coverageEffectiveDate: "2026-11-01", downPct: 25, months: 11, apr: 14, amountFinanced: 24375 };
  const group = await h.group();
  group.policies[1].lines = ["HO-6"];
  h.group.mockResolvedValue(group);
  await expect(send()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Financing could not be prepared") });
  expect(h.mail).not.toHaveBeenCalled();
  expect(h.database.mock.calls.map(([command]) => command.constructor.name)).toEqual(["GetCommand", "GetCommand"]);
});

it("returns a completed lost-response retry and refuses a deliberate second group send", async () => {
  Object.assign(h.invoice, { status: "SENT", sentAt });
  const completed = { ok: true, sentTo: "board@example.test", subject: "Group financing", sentAt };
  h.begin.mockResolvedValue({ operation, completed });
  await expect(send({ expectedSentAt: "" })).resolves.toEqual(completed);
  await expect(send({ expectedSentAt: sentAt })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("already been sent") });
  expect(h.begin).toHaveBeenCalledTimes(1);
  expect(h.group).not.toHaveBeenCalled();
  expect(h.database.mock.calls.map(([command]) => command.constructor.name)).toEqual(["GetCommand"]);
  expect(h.mail).not.toHaveBeenCalled();
});

it("opens the recovered original election link after exact SES acceptance without a second send", async () => {
  h.mail.mockImplementationOnce(async (command: SendEmailCommand, details: MailDetails) => {
    acceptMail(command, details);
    h.ledger!.state = "DEFERRED";
    throw new MailDeliveryError("DEFERRED", String(h.ledger!.pk));
  });
  await expect(send({ expectedSentAt: "" })).resolves.toMatchObject({ ok: false });
  expect(h.invoice.status).toBe("DRAFT");
  const token = h.loan?.electionToken;
  expect(typeof token).toBe("string");
  const terms = () => election({ info: { fieldName: "financeElectionTerms" }, arguments: { token } });
  await expect(terms()).resolves.toMatchObject({ ok: true, state: "closed" });

  const recoveredAt = "2026-11-09T21:30:00.000Z";
  vi.setSystemTime(new Date(recoveredAt));
  const exact = { ...h.ledger, state: "ACCEPTED", acceptedAt: recoveredAt };
  h.ledger = { ...exact, payloadHash: hash("another envelope") };
  await expect(terms()).resolves.toMatchObject({ ok: true, state: "closed" });
  expect(h.invoice.status).toBe("DRAFT");

  h.ledger = exact;
  await expect(terms()).resolves.toMatchObject({ ok: true, state: "open", initialPaymentAmount: 8135 });
  expect(h.invoice).toMatchObject({ status: "SENT", sentAt: recoveredAt, sentTo: "board@example.test",
    invoiceSendOperation: { completed: { providerId: "test-only" } } });
  await expect(send({ expectedSentAt: "" })).resolves.toMatchObject({ ok: true, sentAt: recoveredAt });
  expect(h.begin).toHaveBeenCalledTimes(1);
  expect(h.mail).toHaveBeenCalledTimes(1);
  expect(h.stripe).not.toHaveBeenCalled();
  const completions = h.database.mock.calls.flatMap(([command]) => command.input.TransactItems ?? [])
    .filter(write => write.Update?.UpdateExpression.startsWith("SET #op = :complete"));
  expect(completions).toHaveLength(1);
});
