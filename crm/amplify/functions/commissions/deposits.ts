import { createHash } from 'node:crypto';
import { required, type CommissionStatement } from '../../../../shared/commissions';
import { depositReference, validateDeposit, type CommissionDeposit } from '../../../../shared/commissionDeposits';
import type { IntakeSettlement } from '../../../../shared/commissionIntake';
import { payrollDay, type PayrollCycle } from '../../../../shared/commissionPayroll';
import * as store from './store';

export const depositOperations = new Set(['recordUnmatchedDeposit', 'resolveUnmatchedDeposit']);
export const depositKey = (reference: string) => createHash('sha256').update(depositReference(reference)).digest('hex');
const change = (kind: string, value: unknown, previous?: unknown): store.Change => ({kind, value: value as store.Change['value'], ...(previous ? {previous: previous as store.Data} : {})});
export const noSavedDeposit = (reference: string): store.Transaction[number] => ({ ConditionCheck: {
  TableName: store.table(), Key: {kind: 'COMMISSION_DEPOSIT', id: depositKey(reference)}, ConditionExpression: 'attribute_not_exists(id)',
} });
export async function depositAction(actor: string, operation: string, input: store.Data) {
  // Read the reconciliation version BEFORE duplicate discovery, so concurrent receipts conflict.
  const reconciliation = await store.get('PAYROLL_STATE', 'reconciliation');
  if (operation === 'recordUnmatchedDeposit') {
    const fields = validateDeposit(input, payrollDay());
    const id = depositKey(fields.reference);
    const old = await store.get<CommissionDeposit>('COMMISSION_DEPOSIT', id);
    if (old) {
      if (old.status === 'AWAITING_REMITTANCE' && Object.entries(fields).every(([k,v]) => old[k as keyof CommissionDeposit] === v) && old.carrierId === fields.carrierId) return {ok:true, depositId:id};
      throw new Error('This deposit reference already exists. Review the saved deposit or use a distinct correction reference.');
    }
    if (fields.carrierId && !(await store.get('CARRIER', fields.carrierId))) throw new Error('Choose a configured carrier or leave carrier unknown.');
    const [settlements, statements, cycles] = await Promise.all([
      store.list<IntakeSettlement>('INTAKE_SETTLEMENT'), store.list<CommissionStatement>('STATEMENT'), store.list<PayrollCycle>('PAYROLL_CYCLE'),
    ]);
    if (settlements.some(s => depositReference(s.reference) === depositReference(fields.reference)) || statements.some(s => depositReference(s.settlementRef) === depositReference(fields.reference))) throw new Error('This reference is already recorded with a statement. Review the existing receipt.');
    const holds = cycles.filter(c => c.status === 'APPROVED' && fields.receivedOn <= c.cutoff).map(c => change('PAYROLL_CYCLE', {...c, reviewRequired:'An unmatched bank deposit was recorded within this payroll cutoff after approval. Resolve it and review a replacement payroll approval before payment.'},c));
    if (holds.length > 90) throw new Error('Review outstanding payroll cycles before recording another deposit.');
    const deposit: CommissionDeposit = {id, version:0, ...fields, status:'AWAITING_REMITTANCE', createdAt:new Date().toISOString(), createdBy:actor};
    await store.commit([change('COMMISSION_DEPOSIT',deposit), change('PAYROLL_STATE',{id:'reconciliation'},reconciliation), ...holds],actor);
    return {ok:true,depositId:id};
  }
  const old = await store.get<CommissionDeposit>('COMMISSION_DEPOSIT', required(input.id,'a saved deposit',128));
  if (!old || old.status !== 'AWAITING_REMITTANCE') throw new Error('Only a deposit awaiting remittance can be resolved here. Review linked payments in their statement.');
  if (input.version !== old.version) throw new Error('This deposit changed. Refresh before confirming.');
  if (input.confirmed !== true || !['NO_EMPLOYEE_COMMISSION','VOID'].includes(String(input.status))) throw new Error('Confirm the deposit resolution.');
  const resolutionReason = required(input.reason,'the resolution reason and supporting evidence',2000);
  await store.commit([change('COMMISSION_DEPOSIT',{...old,status:input.status,resolutionReason},old),change('PAYROLL_STATE',{id:'reconciliation'},reconciliation)],actor);
  return {ok:true};
}
