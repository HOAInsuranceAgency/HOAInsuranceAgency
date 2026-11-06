/** Checkout inputs: down payment/origination are dollars; the broker fee is cents. */
export interface InitialPaymentLoan { downPayment: number; originationFee: number; brokerFeeCents?: number | null }
/** Agreement/public display inputs express every component in dollars. */
export interface InitialPaymentDollars { downPayment: number; originationFee: number; brokerFee?: number | null }

// Preserve the same component order in every policy, including floating-point sums.
const sumParts = (premium: number, originationFee: number, brokerFee: number) => premium + originationFee + brokerFee;

/** Checkout rounds each dollar component to cents independently. Upfront fees
 * never reduce financed principal or enter the installment schedule. */
export function initialPaymentTotals(loan: InitialPaymentLoan) {
  const cents = (amount: number) => {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid initial payment amount");
    return Math.round(amount * 100);
  };
  const premiumCents = cents(loan.downPayment);
  const originationFeeCents = cents(loan.originationFee);
  const brokerFeeCents = loan.brokerFeeCents ?? 0;
  if (!Number.isSafeInteger(brokerFeeCents) || brokerFeeCents < 0) throw new Error("Invalid broker fee amount");
  return { premiumCents, originationFeeCents, brokerFeeCents, totalCents: sumParts(premiumCents, originationFeeCents, brokerFeeCents) };
}

/** Legacy public offers without an explicit server total keep their unrounded
 * dollar sum. Validation and the authoritative server-total choice stay with callers. */
export function initialPaymentTotalDollars(amounts: InitialPaymentDollars): number {
  return sumParts(amounts.downPayment, amounts.originationFee, amounts.brokerFee ?? 0);
}

/** Agreements historically round the combined dollar total, rather than each
 * component. Keep that presentation policy separate from checkout/receipt cents. */
export function initialPaymentTotalRoundedDollars(amounts: InitialPaymentDollars): number {
  return Math.round(initialPaymentTotalDollars(amounts) * 100) / 100;
}
