import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialPaymentReceipt, initialPaymentTotals } from "../../amplify/functions/pfInitialPayment";
import { activateSettledElection } from "../../amplify/functions/pfAutomaticActivation";

const mocks = vi.hoisted(() => ({ send: vi.fn(), mail: vi.fn() }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: mocks.send }) },
}));
vi.mock("@aws-sdk/client-sesv2", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-sesv2")>(),
  SESv2Client: class { send = mocks.mail; },
}));
vi.mock("../../amplify/functions/stripe-webhook/lookups", () => ({
  readPaidContext: vi.fn(async () => ({ associationName: "Test HOA", policyNumber: "POL-1" })),
}));
import { applyPfEvent } from "../../amplify/functions/stripe-webhook/pf";
import { decidePfEvent } from "../../amplify/functions/stripe-webhook/decide";

const signed = {
  id: "loan-1", accountId: "account-1", status: "QUOTED", state: "RI", policyId: "policy-1",
  downPayment: 8435.52, originationFee: 10, months: 11,
  electedAt: "2026-09-04T19:54:24Z", agreementSignedAt: "2026-09-04T19:54:24Z",
  downPaymentIntentId: "pi_down", paidThrough: 0,
};
const event = (type: string, amount = 844552, version: string | null = "2") => decidePfEvent({
  type, created: 1789000000, data: { object: {
    id: "pi_down", amount, customer: "cus_1", payment_method: "pm_1",
    metadata: { pfLoanId: "loan-1", pfKind: "down", pfBillingVersion: version },
  } },
})!;
let loan: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PF_LOAN_TABLE = "Loans";
  process.env.PF_COMPLIANCE_LOG_TABLE = "Audit";
  process.env.ACCOUNTING_MAILBOX = "accounting@example.test";
  process.env.AGENCY_MAILBOX = "agency@example.test";
  delete process.env.AGENCY_SETTINGS_TABLE;
  loan = { ...signed };
  mocks.mail.mockResolvedValue({ MessageId: "ses-1" });
  mocks.send.mockImplementation(async (command) => {
    const p = command.input;
    if (command.constructor.name === "GetCommand") return { Item: { ...loan } };
    if (command.constructor.name === "ScanCommand") return { Items: [] };
    if (command.constructor.name === "UpdateCommand" && p.UpdateExpression.includes("initialPaymentAmount")) {
      loan = { ...loan, status: p.ExpressionAttributeValues[":active"],
        downPaidAt: p.ExpressionAttributeValues[":now"], activatedAt: p.ExpressionAttributeValues[":now"],
        stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1",
        initialPaymentAmount: p.ExpressionAttributeValues[":received"],
        originationFeeCollected: p.ExpressionAttributeValues[":fee"],
      };
    }
    return {};
  });
});

describe("automatic customer financing", () => {
  it("starts monthly collection at settlement without any board-document lookup or staff action", async () => {
    expect(await applyPfEvent(event("payment_intent.succeeded"))).toBe("activated");
    expect(loan).toMatchObject({ status: "ACTIVE", initialPaymentAmount: 8445.52, originationFeeCollected: 10,
      stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" });
    const updates = mocks.send.mock.calls.filter(([c]) => c.constructor.name === "UpdateCommand");
    expect(updates[0][0].input.ConditionExpression).toContain("attribute_exists(agreementSignedAt)");
    expect(mocks.send.mock.calls.filter(([c]) => c.constructor.name === "GetCommand").every(([c]) => c.input.TableName === "Loans")).toBe(true);
    const email = mocks.mail.mock.calls[0][0].input.Content.Simple.Body.Text.Data;
    expect(email).toContain("Total received: $8,445.52");
    expect(email).toContain("Premium down payment: $8,435.52");
    expect(email).toContain("Origination fee collected: $10.00");
    expect(email).toContain("Interest received: $0.00");
  });

  it("also automatically enrolls a customer who financed before binding", async () => {
    loan = { ...signed, policyId: null, quoteId: "quote-1" };
    await applyPfEvent(event("payment_intent.succeeded"));
    expect(loan.status).toBe("ACTIVE");
  });

  it("does not activate or send a received-payment email while ACH is processing", async () => {
    await applyPfEvent(event("payment_intent.processing"));
    expect(loan.status).toBe("QUOTED");
    expect(mocks.mail).not.toHaveBeenCalled();
  });

  it("replayed settlement does not activate or notify twice", async () => {
    await applyPfEvent(event("payment_intent.succeeded"));
    await applyPfEvent(event("payment_intent.succeeded"));
    expect(mocks.mail).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls.filter(([c]) => c.input.UpdateExpression?.includes("initialPaymentAmount"))).toHaveLength(1);
  });

  it("automatically enrolls Robin Hollow's already processing legacy debit without inventing fee receipt", async () => {
    await applyPfEvent(event("payment_intent.succeeded", 843552, null));
    expect(loan).toMatchObject({ status: "ACTIVE", initialPaymentAmount: 8435.52, originationFeeCollected: 0 });
    expect(mocks.mail.mock.calls[0][0].input.Content.Simple.Body.Text.Data).toContain("$10.00 of the contractual origination fee was not collected");
  });

  it("rejects a new checkout settlement that omits the initial fee", async () => {
    await expect(applyPfEvent(event("payment_intent.succeeded", 843552))).rejects.toThrow("does not match");
    expect(loan.status).toBe("QUOTED");
    expect(mocks.mail).not.toHaveBeenCalled();
  });

  it("does not activate a loan without a signature or reusable mandate", async () => {
    loan.agreementSignedAt = null;
    await expect(applyPfEvent(event("payment_intent.succeeded"))).rejects.toThrow("signature or saved payment mandate");
    expect(loan.status).toBe("QUOTED");
  });

  it("recovers an existing ACCEPTED loan without manual activation", async () => {
    const old = { ...signed, status: "ACCEPTED", downPaidAt: "2026-09-05T12:00:00Z",
      stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" };
    expect(await activateSettledElection({ send: mocks.send } as never, "Loans", old)).toBe(true);
    const p = mocks.send.mock.calls[0][0].input;
    expect(p.ExpressionAttributeValues).toMatchObject({ ":active": "ACTIVE", ":accepted": "ACCEPTED", ":pi": "pi_down" });
    expect(p.ConditionExpression).toContain("stripePaymentMethodId = :pm");
    expect(await activateSettledElection({ send: mocks.send } as never, "Loans", { ...old, downPaidAt: null })).toBe(false);
  });
});

describe("initial payment accounting", () => {
  it("keeps the fee out of premium and financed principal", () => {
    expect(initialPaymentTotals(signed)).toEqual({ premiumCents: 843552, originationFeeCents: 1000, totalCents: 844552 });
    expect(initialPaymentReceipt(signed, 8445.52, 2)).toEqual({ initialPaymentAmount: 8445.52, originationFeeCollected: 10 });
  });
  it("rejects unexpected amounts and invalid fees", () => {
    expect(() => initialPaymentReceipt(signed, 8446.52, 2)).toThrow();
    expect(() => initialPaymentTotals({ downPayment: 1, originationFee: NaN })).toThrow();
    expect(() => initialPaymentTotals({ downPayment: 1, originationFee: -10 })).toThrow();
  });
});
