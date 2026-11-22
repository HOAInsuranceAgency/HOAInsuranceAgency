/** Historical receipt inputs: down payment/origination are dollars; the broker fee is cents. */
export interface InitialPaymentLoan { downPayment: number; originationFee: number; brokerFeeCents?: number | null }

/** Legacy checkout rounded each dollar component to cents independently. Upfront fees
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
  return { premiumCents, originationFeeCents, brokerFeeCents, totalCents: premiumCents + originationFeeCents + brokerFeeCents };
}
