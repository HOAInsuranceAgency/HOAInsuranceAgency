import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn(), debit: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }),
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { PfLoan: { list: m.list } } }) }));
vi.mock("@aws-sdk/lib-dynamodb", async original => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: m.send }) },
}));
vi.mock("stripe", () => ({ default: class { paymentIntents = { create: m.debit }; } }));
import { handler as collect } from "../../amplify/functions/pf-autopay/handler";

const loan = {
  id: "loan-1", accountId: "account-1", state: "RI", status: "ACTIVE", nextDueAt: "2020-01-01",
  paidThrough: 0, stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1",
  schedule: JSON.stringify([{ n: 1, dueDate: "2020-01-01", payment: 2464.75, principal: 2169.51, interest: 295.24, balance: 23137.05 }]),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PF_LOAN_TABLE = "Loans";
  process.env.STRIPE_SECRET_KEY = "test-placeholder";
  delete process.env.PF_COMPLIANCE_LOG_TABLE;
  m.send.mockResolvedValue({});
  m.debit.mockResolvedValue({ id: "pi_monthly" });
});

describe("legacy monthly collection", () => {
  it("charges the next frozen installment on a due active loan", async () => {
    m.list.mockResolvedValue({ data: [loan] });
    await collect();
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ filter: { status: { eq: "ACTIVE" } } }));
    expect(m.debit).toHaveBeenCalledWith(expect.objectContaining({ amount: 246475, off_session: true,
      customer: "cus_1", payment_method: "pm_1", confirm: true }), { idempotencyKey: "pf-auto-loan-1-1" });
    const claim = m.send.mock.calls[0][0].input;
    expect(claim.ConditionExpression).toContain("attribute_not_exists(autopayPendingIntentId)");
    expect(claim.ConditionExpression).toContain("#s = :active");
  });

  it("leaves quoted and accepted elections alone even when signed, funded and due", async () => {
    const settled = { ...loan, downPaidAt: "2020-01-01T00:00:00Z", downPaymentIntentId: "pi_down",
      agreementSignedAt: "2020-01-01T00:00:00Z", electedAt: "2020-01-01T00:00:00Z" };
    m.list.mockResolvedValue({ data: [{ ...settled, status: "QUOTED" }, { ...settled, status: "ACCEPTED" },
      { ...loan, nextDueAt: "2099-01-01" }] });
    await collect();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.debit).not.toHaveBeenCalled();
  });

  it("does not debit when another worker owns the installment", async () => {
    m.list.mockResolvedValue({ data: [loan] });
    m.send.mockRejectedValue(Object.assign(new Error("claimed"), { name: "ConditionalCheckFailedException" }));
    await collect();
    expect(m.debit).not.toHaveBeenCalled();
  });
});
