import { initialPaymentTotals, type InitialPaymentLoan } from "../../../shared/premiumFinance/initialPayment";

export const PF_CHECKOUT_BILLING_VERSION = 3;

/** Preserve what older in-flight checkouts actually collected; never invent fee receipts. */
export function initialPaymentReceipt(loan: InitialPaymentLoan, amount: number | null, billingVersion: number | null) {
  const expected = initialPaymentTotals(loan);
  const received = amount == null ? NaN : Math.round(amount * 100);
  if (received === expected.totalCents) {
    return { initialPaymentAmount: received / 100, originationFeeCollected: expected.originationFeeCents / 100, brokerFeeCollectedCents: expected.brokerFeeCents };
  }
  if (billingVersion === 2 && received === expected.premiumCents + expected.originationFeeCents) {
    return { initialPaymentAmount: received / 100, originationFeeCollected: expected.originationFeeCents / 100, brokerFeeCollectedCents: 0 };
  }
  if (billingVersion == null && received === expected.premiumCents) {
    return { initialPaymentAmount: received / 100, originationFeeCollected: 0, brokerFeeCollectedCents: 0 };
  }
  throw new Error("Initial payment does not match the premium down payment and upfront fees");
}
