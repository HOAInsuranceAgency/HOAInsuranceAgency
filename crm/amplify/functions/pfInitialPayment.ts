/** The initial receipt contains premium and a fee; the fee never reduces loan principal. */
export const PF_CHECKOUT_BILLING_VERSION = 2;

export function initialPaymentTotals(loan: { downPayment: number; originationFee: number }) {
  const cents = (amount: number) => {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid initial payment amount");
    return Math.round(amount * 100);
  };
  const premiumCents = cents(loan.downPayment);
  const originationFeeCents = cents(loan.originationFee);
  return { premiumCents, originationFeeCents, totalCents: premiumCents + originationFeeCents };
}

/** Old in-flight checkouts collected premium only. Record that fact without charging again. */
export function initialPaymentReceipt(
  loan: { downPayment: number; originationFee: number },
  amount: number | null,
  billingVersion: number | null,
) {
  const expected = initialPaymentTotals(loan);
  const received = amount == null ? NaN : Math.round(amount * 100);
  if (received === expected.totalCents) {
    return { initialPaymentAmount: received / 100, originationFeeCollected: expected.originationFeeCents / 100 };
  }
  if (billingVersion == null && received === expected.premiumCents) {
    return { initialPaymentAmount: received / 100, originationFeeCollected: 0 };
  }
  throw new Error("Initial payment does not match the premium down payment and origination fee");
}
