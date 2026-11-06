import type { CommissionOperationName } from '../../../shared/apiOperations';
import type { CommissionPlan, CommissionAccount, AccountCommissionClass, CommissionBasis, CarrierPaymentArrangement, CommissionReceiptForecast, StatementLine } from '../../../shared/commissions';
import type { ApiAccepted } from './communicationContracts';
interface Operation<I, R = ApiAccepted> { input: I; result: R & ApiAccepted }
export interface CarrierArrangementInput extends Omit<CarrierPaymentArrangement, 'basis' | 'trigger' | 'cadence' | 'earningMethod'> {
  /** A draft can be submitted for validation; server rejects unselected terms. */
  basis: CarrierPaymentArrangement['basis'] | '';
  trigger: CarrierPaymentArrangement['trigger'] | '';
  cadence: CarrierPaymentArrangement['cadence'] | '';
  earningMethod?: CarrierPaymentArrangement['earningMethod'] | '';
}
export interface CommissionContracts {
  savePlan: Operation<Pick<CommissionPlan, 'producerId' | 'name' | 'version' | 'terms' | 'accountBoundFrom' | 'receiptsFrom'>>;
  getAccountClassification: Operation<{ id: string }, { classification: CommissionAccount | null; accountName: string }>;
  saveAccountClassification: Operation<{ id: string; version: number; bindingEvidence: string; periods: (Omit<CommissionAccount['periods'][number], 'classification'> & { classification: AccountCommissionClass | '' })[]; firstBoundOn?: string; neverBound?: boolean }>;
  saveCarrier: Operation<{ id: string; version: number; basis: CommissionBasis | '' | undefined; schedule: string; evidence: string | undefined; arrangements: CarrierArrangementInput[] }>;
  saveReceiptForecast: Operation<{ policyId: string; version: number; receiptForecast: Pick<CommissionReceiptForecast, 'items' | 'evidence' | 'confirmed' | 'complete'> }>;
  saveStatement: Operation<{ version: number; carrierId: string; reference: string; source: string; receivedOn: string; settlementRef: string; settlementType: string; totalCents: number; lines: StatementLine[] }>;
  postStatement: Operation<{ id: string; version: number; confirmed: boolean }>;
  preparePayroll: Operation<{ producerId: string; cutoff: string; payDate: string; requestId: string }>;
  payPayroll: Operation<{ id: string; version: number; reference: string; payDate: string }>;
  cancelPayroll: Operation<{ id: string; version: number; reference: string; payDate: string }>;
  adoptPolicy: Operation<{ policyId: string; producerId: string; boundOn: string; transaction: 'NEW' | 'RENEWAL' | ''; evidence: string; premium: string; agencyRate: string; effectiveDate: string; expirationDate: string }>;
  updatePolicyNumber: Operation<{ id: string; version: number; policyNumber: string }>;
}
export type CommissionOperation = Exclude<CommissionOperationName, 'file'>;
export type CommissionInput<K extends CommissionOperation> = CommissionContracts[K]['input'];
export type CommissionResult<K extends CommissionOperation> = CommissionContracts[K]['result'];
export interface CommissionFileUpload { action: 'upload'; size: number; contentType: string; filename: string }
export interface CommissionFileRead { action?: 'read'; key: string }
