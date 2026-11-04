/** Upfront fees never reduce financed principal or enter the installment schedule. */
export const PF_CHECKOUT_BILLING_VERSION = 3;
export interface InitialPaymentLoan { downPayment: number; originationFee: number; brokerFeeCents?: number | null }
export function initialPaymentTotals(loan: InitialPaymentLoan) {
  const cents = (amount: number) => {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid initial payment amount");
    return Math.round(amount * 100);
  };
  const premiumCents = cents(loan.downPayment);
  const originationFeeCents = cents(loan.originationFee);
  const brokerFeeCents = loan.brokerFeeCents ?? 0;
  if (!Number.isSafeInteger(brokerFeeCents) || brokerFeeCents < 0) throw new Error("Invalid broker fee amount");
  return { premiumCents, originationFeeCents, brokerFeeCents, totalCents: premiumCents + originationFeeCents + brokerFeeCents };
}

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
