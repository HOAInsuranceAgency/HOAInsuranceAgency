import { client } from './client';
import type { CommissionOverview, CommissionBasis, CarrierPaymentArrangement } from '../../../shared/commissions';
export interface CarrierPaymentPreview {
  carrierTermsVersion: number;
  basis: CommissionBasis;
  payment?: Pick<CarrierPaymentArrangement,
    'id' | 'payor' | 'trigger' | 'cadence' | 'lagDays' | 'cutoffDay' | 'paymentDay' | 'earningMethod'>;
}
export function commissionResponse<T>(response: {
  data?: unknown;
  errors?: readonly { message: string }[];
}): T {
  if (response.errors?.length) throw new Error(response.errors[0].message);
  const value = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  if (!value?.ok) throw new Error(value?.error ?? 'Commission request failed.');
  return value as T;
}
export const readCommissions = async () =>
  commissionResponse<CommissionOverview>(await client.queries.commissionOverview());
export const readCarrierPaymentPreview = async (quoteId: string, billType: string) =>
  commissionResponse<CarrierPaymentPreview>(
    await client.queries.carrierPaymentPreview({ quoteId, billType }),
  );
export const commissionAction = async <T = { ok: true }>(operation: string, input: unknown) =>
  commissionResponse<T>(
    await client.mutations.commissionAction({ operation, input: JSON.stringify(input) }),
  );
