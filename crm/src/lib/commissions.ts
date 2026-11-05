import { privateApiRecord, privateApiError, ApiResponseError } from './apiResponse';
import { isCommissionOperationName } from '../../../shared/apiOperations';
import { client } from './client';
import type { CommissionOverview, CommissionBasis, CarrierPaymentArrangement } from '../../../shared/commissions';
import type { CommissionOperation, CommissionInput, CommissionResult, CommissionFileUpload, CommissionFileRead } from './commissionContracts';
export type { CommissionOperation, CommissionInput, CommissionResult } from './commissionContracts';
export interface CarrierPaymentPreview {
  carrierTermsVersion: number;
  basis: CommissionBasis;
  payment?: Pick<CarrierPaymentArrangement,
    'id' | 'payor' | 'trigger' | 'cadence' | 'lagDays' | 'cutoffDay' | 'paymentDay' | 'earningMethod'>;
}
function commissionResponse<T>(response: {
  data?: unknown;
  errors?: readonly { message: string }[];
}): T {
  const value = privateApiRecord(response, { fallback: 'Commission request failed.' });
  return value as T;
}
export const readCommissions = async () =>
  commissionResponse<CommissionOverview>(await client.queries.commissionOverview().catch(privateApiError));
export const readCarrierPaymentPreview = async (quoteId: string, billType: string) =>
  commissionResponse<CarrierPaymentPreview>(
    await client.queries.carrierPaymentPreview({ quoteId, billType }).catch(privateApiError),
  );
export function commissionAction(operation: 'file', input: CommissionFileUpload): Promise<{ key: string; url: string }>;
export function commissionAction(operation: 'file', input: CommissionFileRead): Promise<{ url: string }>;
export function commissionAction<K extends CommissionOperation>(operation: K, input: CommissionInput<K>): Promise<CommissionResult<K>>;
export async function commissionAction(operation: CommissionOperation | 'file', input: CommissionInput<CommissionOperation> | CommissionFileUpload | CommissionFileRead): Promise<unknown> {
  if (!isCommissionOperationName(operation)) throw new ApiResponseError('Unknown commission operation.', { code: 'INVALID_API_OPERATION' });
  return commissionResponse(await client.mutations.commissionAction({ operation, input: JSON.stringify(input) }).catch(privateApiError));
}
