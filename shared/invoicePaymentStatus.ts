export interface InvoicePaymentStatus {
  sourcePricingVersion?: number | null;
  status?: string | null;
  sentAt?: string | null;
  stripePaymentLinkId?: string | null;
  paymentUrl?: string | null;
  brokerFeeFinanceUrl?: string | null;
  remittanceCarrierCents?: number | null;
  remittanceCommissionCents?: number | null;
  remittanceInterestCents?: number | null;
  remittanceBrokerFeeCents?: number | null;
}

/** A sent credit/zero statement is final without inventing an incoming receipt.
 * Only the send service writes the complete, immutable remittance snapshot. */
export function isNonpayableAdjustmentStatement(invoice: unknown): boolean {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) return false;
  const row = invoice as Record<string, unknown>;
  if (row.sourcePricingVersion !== 2 || row.status !== 'SENT' || typeof row.sentAt !== 'string' || !row.sentAt.trim()) return false;
  if (['stripePaymentLinkId', 'paymentUrl', 'brokerFeeFinanceUrl'].some(key => row[key] != null && row[key] !== '')) return false;
  const amounts = [row.remittanceCarrierCents, row.remittanceCommissionCents, row.remittanceInterestCents, row.remittanceBrokerFeeCents];
  if (!amounts.every(value => typeof value === 'number' && Number.isSafeInteger(value))) return false;
  if (row.remittanceInterestCents !== 0 || row.remittanceBrokerFeeCents !== 0) return false;
  const total = (amounts as number[]).reduce((sum, amount) => sum + amount, 0);
  return Number.isSafeInteger(total) && total <= 0;
}
