import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ send: vi.fn(), list: vi.fn(), lookup: vi.fn(), checkout: vi.fn(), debit: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }),
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  PfLoan: { list: m.list, listPfLoanByElectionToken: m.lookup },
  AgencySettings: { get: async () => ({ data: { premiumFinanceEnabled: true } }) },
  Account: { get: async () => ({ data: { name: "Test HOA" } }) },
  Invoice: { list: async () => ({ data: [] }) },
} }) }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: m.send }) },
}));
vi.mock("stripe", () => ({ default: class {
  checkout = { sessions: { create: m.checkout } };
  paymentIntents = { create: m.debit };
} }));
vi.mock("../../amplify/functions/void-invoice/handler", () => ({ handler: vi.fn() }));
import { handler as elect } from "../../amplify/functions/pf-election/handler";
import { handler as collect } from "../../amplify/functions/pf-autopay/handler";
import { SECURITY_INTEREST_AND_AUTHORITY } from "../../amplify/functions/pf-agreement/agreementTerms";

const loan = {
  id: "loan-1", accountId: "account-1", policyId: "policy-1", state: "RI", status: "QUOTED",
  premium: 33742.08, downPayment: 8435.52, originationFee: 10, months: 11,
  electedAt: "2026-09-04T12:00:00Z", agreementSignedAt: "2026-09-04T12:00:00Z",
  electionToken: "a".repeat(43), electionTokenExpiresAt: "2099-01-01T00:00:00Z",
  nextDueAt: "2026-10-03", paidThrough: 0,
  schedule: JSON.stringify([{ n: 1, dueDate: "2026-10-03", payment: 2464.75, principal: 2169.51, interest: 295.24, balance: 23137.05 }]),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PF_LOAN_TABLE = "Loans";
  process.env.AGENCY_SETTINGS_TABLE = "Settings";
  process.env.STRIPE_SECRET_KEY = "test-placeholder";
  process.env.SITE_URL = "https://example.test";
  delete process.env.PF_COMPLIANCE_LOG_TABLE;
  m.lookup.mockResolvedValue({ data: [{ ...loan }] });
  m.list.mockResolvedValue({ data: [] });
  m.send.mockResolvedValue({ Item: { premiumFinanceEnabled: true } });
  m.checkout.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/session", expires_at: 4070908800 });
  m.debit.mockResolvedValue({ id: "pi_monthly" });
});

describe("billing initiation", () => {
  it("includes signing authority in the same agreement and requires that signature before deposit", async () => {
    const terms = await elect({ arguments: { token: loan.electionToken } });
    expect(terms).toMatchObject({ agreementTerms: expect.arrayContaining([SECURITY_INTEREST_AND_AUTHORITY]) });
    m.lookup.mockResolvedValue({ data: [{ ...loan, agreementSignedAt: null }] });
    expect(await elect({ arguments: { accept: true, token: loan.electionToken } })).toMatchObject({
      ok: false, error: expect.stringContaining("sign the agreement first"),
    });
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("creates the real Checkout request with premium plus fee and a reusable monthly mandate", async () => {
    expect(await elect({ arguments: { accept: true, token: loan.electionToken } })).toMatchObject({ state: "checkout" });
    const params = m.checkout.mock.calls[0][0];
    expect(params.line_items.map((r: { price_data: { unit_amount: number } }) => r.price_data.unit_amount)).toEqual([843552, 1000]);
    expect(params.payment_intent_data).toEqual({ setup_future_usage: "off_session",
      metadata: { pfLoanId: loan.id, pfKind: "down", pfBillingVersion: "2" } });
    expect(params.payment_method_types).toEqual(["us_bank_account"]);
    expect(m.send.mock.calls.some(([c]) => c.input.ExpressionAttributeValues?.[":version"] === 2)).toBe(true);
  });

  it("does not reopen a still-payable legacy session without the fee", async () => {
    m.lookup.mockResolvedValue({ data: [{ ...loan, electionCheckoutUrl: "https://checkout.stripe.test/old",
      electionCheckoutExpiresAt: "2099-01-01T00:00:00Z" }] });
    expect(await elect({ arguments: { accept: true, token: loan.electionToken } })).toMatchObject({ state: "closed" });
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("recovers a settled legacy election and automatically debits its first due installment", async () => {
    m.list.mockResolvedValue({ data: [{ ...loan, status: "ACCEPTED", nextDueAt: "2020-01-01",
      downPaidAt: "2020-01-01T00:00:00Z", downPaymentIntentId: "pi_down",
      stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }] });
    await collect();
    expect(m.debit).toHaveBeenCalledWith(expect.objectContaining({ amount: 246475, off_session: true,
      customer: "cus_1", payment_method: "pm_1", confirm: true }), { idempotencyKey: "pf-auto-loan-1-1" });
    const writes = m.send.mock.calls.map(([c]) => c.input);
    expect(writes[0].ExpressionAttributeValues[":active"]).toBe("ACTIVE");
    expect(writes[1].ConditionExpression).toContain("attribute_not_exists(autopayPendingIntentId)");
  });

  it("leaves unsettled legacy elections and future installments uncharged", async () => {
    m.list.mockResolvedValue({ data: [{ ...loan, status: "ACCEPTED" }, { ...loan, status: "ACTIVE",
      nextDueAt: "2099-01-01", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }] });
    await collect();
    expect(m.debit).not.toHaveBeenCalled();
  });

  it("does not debit when another worker owns the installment", async () => {
    m.list.mockResolvedValue({ data: [{ ...loan, status: "ACTIVE", nextDueAt: "2020-01-01",
      stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }] });
    m.send.mockRejectedValue(Object.assign(new Error("claimed"), { name: "ConditionalCheckFailedException" }));
    await collect();
    expect(m.debit).not.toHaveBeenCalled();
  });
});
