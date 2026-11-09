import { client, type Policy, type Account } from './client';
import { isRecord, privateApiCall } from './apiResponse';
import type { ApiRecord } from '../../../shared/apiResponse';
import type { BrokerFeeRecord } from '../../../shared/brokerFees';

export type BrokerFeeStatus = Pick<BrokerFeeRecord, 'quoteId' | 'amountCents' | 'terms' | 'signedAt' | 'submittedCents' | 'collectedCents' | 'refundedCents'>;
function feeStatus(value: unknown): value is BrokerFeeStatus {
  return isRecord(value) && typeof value.quoteId === 'string' && typeof value.terms === 'string'
    && ['amountCents', 'submittedCents', 'collectedCents', 'refundedCents'].every(key => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && (value.signedAt === undefined || typeof value.signedAt === 'string');
}
export async function readBrokerFeeStatus(accountId: string, quoteIds?: readonly string[]): Promise<BrokerFeeStatus[]> {
  const result = await privateApiCall(client.mutations.brokerFeeAction({ input: JSON.stringify({ op: 'status', accountId, ...(quoteIds ? { quoteIds } : {}) }) }),
    (value): value is ApiRecord & { fees: BrokerFeeStatus[] } => Array.isArray(value.fees) && value.fees.every(feeStatus),
    { fallback: 'Could not load broker fee status.' });
  return result.fees;
}
export async function confirmInvoicePayment(invoiceId: string): Promise<void> {
  await privateApiCall(client.mutations.brokerFeeAction({ input: JSON.stringify({ op: 'confirmInvoicePayment', invoiceId }) }),
    (value): value is ApiRecord & { ok: true } => value.ok === true, { fallback: 'Could not confirm payment.' });
}
export async function bindCommissionPolicy(input: { quoteId: string; terms: string; premium: string; agencyRate: string; billType: string; policyNumber: string; carrierTermsVersion: number; carrierArrangementId?: string; issuedRenewalEvidence?: string; carrierBillType?: 'AGENCY' | 'DIRECT' }): Promise<{ policy: Policy; account: Account }> {
  return await privateApiCall(client.mutations.bindCommissionPolicy({ input: JSON.stringify(input) }),
    (value): value is ApiRecord & { policy: Policy; account: Account } => isRecord(value.policy) && typeof value.policy.id === 'string' && isRecord(value.account) && typeof value.account.id === 'string',
    { fallback: 'Could not bind this policy.' });
}
