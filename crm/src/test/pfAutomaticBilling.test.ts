import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialPaymentReceipt } from "../../amplify/functions/pfInitialPayment";
import { initialPaymentTotals } from "../../../shared/premiumFinance/initialPayment";

const mocks = vi.hoisted(() => ({ send: vi.fn(), mail: vi.fn(), feeSync: vi.fn() }));
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
vi.mock("../../amplify/functions/broker-fees/payments", () => ({ syncBrokerFeePayment: mocks.feeSync }));
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
  mocks.feeSync.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async (command) => {
    const p = command.input;
    if (command.constructor.name === "GetCommand") return { Item: { ...loan } };
    if (p.UpdateExpression?.includes("initialPaymentAmount")) {
      const v = p.ExpressionAttributeValues;
      if (loan.downPaidAt || !loan.electedAt || !loan.agreementSignedAt || !["QUOTED", "ACCEPTED"].includes(String(loan.status)) ||
          (loan.downPaymentIntentId && loan.downPaymentIntentId !== v[":pi"])) {
        throw Object.assign(new Error("receipt cannot be applied"), { name: "ConditionalCheckFailedException" });
      }
      loan = { ...loan, downPaidAt: v[":settled"], downPaymentIntentId: v[":pi"],
        initialPaymentAmount: v[":received"], originationFeeCollected: v[":fee"] };
    }
    return {};
  });
});

describe("historical financing receipts", () => {
  it.each(["QUOTED", "ACCEPTED"])("records a settled deposit on a %s loan without enabling collection", async status => {
    loan.status = status;
    expect(await applyPfEvent(event("payment_intent.succeeded"))).toBe("initial receipt recorded");
    expect(loan).toMatchObject({ status, initialPaymentAmount: 8445.52, originationFeeCollected: 10 });
    const update = mocks.send.mock.calls.find(([c]) => c.input.UpdateExpression?.includes("initialPaymentAmount"))![0].input;
    expect(update.UpdateExpression).not.toMatch(/#s|activatedAt|stripeCustomerId|stripePaymentMethodId/);
    expect(update.ConditionExpression).toContain("attribute_not_exists(downPaidAt)");
    const body = mocks.mail.mock.calls[0][0].input.Content.Simple.Body.Text.Data;
    expect(body).toContain("Total received: $8,445.52");
    expect(body).toContain("Premium down payment: $8,435.52");
    expect(body).toContain("Origination fee collected: $10.00");
    expect(body).toContain("Interest received: $0.00");
  });

  it("preserves an initial deposit collected before origination fees were included", async () => {
    await applyPfEvent(event("payment_intent.succeeded", 843552, null));
    expect(loan).toMatchObject({ status: "QUOTED", initialPaymentAmount: 8435.52, originationFeeCollected: 0 });
  });

  it("keeps delayed or duplicate events from overwriting a settled receipt", async () => {
    await applyPfEvent(event("payment_intent.succeeded"));
    expect(await applyPfEvent(event("payment_intent.succeeded"))).toBe("initial receipt already recorded");
    await applyPfEvent(event("payment_intent.processing"));
    await applyPfEvent(event("payment_intent.payment_failed"));
    expect(mocks.mail).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls.filter(([c]) => c.input.UpdateExpression?.includes("initialPaymentAmount"))).toHaveLength(1);
    expect(mocks.feeSync).not.toHaveBeenCalled();
  });

  it("preserves active loans when the deposit is replayed", async () => {
    loan = { ...signed, status: "ACTIVE", downPaidAt: signed.electedAt, stripePaymentMethodId: "original" };
    expect(await applyPfEvent(event("payment_intent.succeeded"))).toBe("initial receipt already recorded");
    expect(mocks.send.mock.calls.some(([c]) => c.input.UpdateExpression)).toBe(false);
    expect(mocks.mail).not.toHaveBeenCalled();
  });

  it("alerts accounting when another deposit clears on an already paid loan", async () => {
    loan = { ...signed, status: "ACTIVE", downPaymentIntentId: "pi_first", downPaidAt: signed.electedAt };
    expect(await applyPfEvent(event("payment_intent.succeeded"))).toBe("unmatched down payment; alerted");
    expect(loan.downPaymentIntentId).toBe("pi_first");
    expect(mocks.mail).toHaveBeenCalledTimes(1);
  });
});

describe("initial payment accounting", () => {
  it.each([
    { amount: 0.03, version: 3, originationFeeCollected: 0.01, brokerFeeCollectedCents: 1 },
    { amount: 0.02, version: 2, originationFeeCollected: 0.01, brokerFeeCollectedCents: 0 },
    { amount: 0.01, version: null, originationFeeCollected: 0, brokerFeeCollectedCents: 0 },
  ])('preserves the actual receipt for billing version $version', ({ amount, version, ...collected }) => {
    expect(initialPaymentReceipt({ downPayment: 0.005, originationFee: 0.005, brokerFeeCents: 1 }, amount, version))
      .toEqual({ initialPaymentAmount: amount, ...collected });
  });

  it("keeps the fee out of premium and financed principal", () => {
    expect(initialPaymentTotals(signed)).toEqual({ premiumCents: 843552, originationFeeCents: 1000, brokerFeeCents: 0, totalCents: 844552 });
    expect(initialPaymentReceipt(signed, 8445.52, 2)).toEqual({ initialPaymentAmount: 8445.52, originationFeeCollected: 10, brokerFeeCollectedCents: 0 });
  });
  it("rejects unexpected amounts and invalid fees", () => {
    expect(() => initialPaymentReceipt(signed, 8446.52, 2)).toThrow();
    expect(() => initialPaymentTotals({ downPayment: 1, originationFee: NaN })).toThrow();
    expect(() => initialPaymentTotals({ downPayment: 1, originationFee: -10 })).toThrow();
  });
});

describe("broker fee initial receipt", () => {
  const withFee = {...signed,brokerFeeCents:50000};
  it("collects all broker fee upfront independently from premium and origination", () => {
    expect(initialPaymentTotals(withFee)).toEqual({premiumCents:843552,originationFeeCents:1000,brokerFeeCents:50000,totalCents:894552});
    expect(initialPaymentReceipt(withFee,8945.52,3)).toMatchObject({brokerFeeCollectedCents:50000,originationFeeCollected:10});
  });
  it("preserves a legacy payment and rejects an incomplete new checkout", () => {
    expect(initialPaymentReceipt(withFee,8445.52,2)).toMatchObject({brokerFeeCollectedCents:0});
    expect(()=>initialPaymentReceipt(withFee,8445.52,3)).toThrow("does not match");
  });
});

describe("broker fee settlement and retries", () => {
  const allocations = [{quoteId:"q-1",policyId:"policy-1",amountCents:50000}];
  it("records submission while clearing without earning collected fee revenue", async () => {
    loan = {...signed,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify(allocations)};
    await applyPfEvent(event("payment_intent.processing",894552,"3"));
    expect(mocks.feeSync).toHaveBeenCalledWith(expect.objectContaining({sourceId:"pi_down",allocations,status:"PROCESSING"}));
    expect(loan.status).toBe("QUOTED");
  });
  it("recovers a failed fee hook after recording a historical deposit", async () => {
    loan = {...signed,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify(allocations)};
    mocks.feeSync.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(applyPfEvent(event("payment_intent.succeeded",894552,"3"))).rejects.toThrow("ledger unavailable");
    expect(loan.status).toBe("QUOTED");
    expect(await applyPfEvent(event("payment_intent.succeeded",894552,"3"))).toBe("initial receipt already recorded");
    expect(mocks.feeSync).toHaveBeenCalledTimes(2);
    expect(mocks.feeSync).toHaveBeenLastCalledWith(expect.objectContaining({status:"PAID",allocations}));
    expect(mocks.send.mock.calls.filter(([c])=>c.input.UpdateExpression?.includes("initialPaymentAmount"))).toHaveLength(1);
  });
});

it("uses the New York settlement day for broker fee payroll cutoff",async()=>{
 loan={...signed,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify([{quoteId:'q-1',policyId:'policy-1',amountCents:50000}])};
 const received={...event('payment_intent.succeeded',894552,'3'),occurredAt:'2026-11-04T01:30:00Z'};
 await applyPfEvent(received);
 expect(mocks.feeSync).toHaveBeenCalledWith(expect.objectContaining({status:'PAID',receivedOn:'2026-11-03'}));
});
