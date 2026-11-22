import { requireStatementIndexes } from './statement-reads';
import { settlementBankKey } from './statement-index';
import { createHash } from 'node:crypto';
import { batchPaidCents, commissionRevenueLabel, required, type CommissionBatch, type CommissionEntry, type CommissionPolicy, type CommissionStatement } from '../../../../shared/commissions';
import { depositReference, validateDeposit, type CommissionDeposit } from '../../../../shared/commissionDeposits';
import { departureDecision, receiptEarningId, type CommissionDeparture, type CommissionEarning } from '../../../../shared/commissionExceptions';
import { payrollDay, payrollRowKey } from '../../../../shared/commissionPayroll';
import * as store from './store';

export const depositOperations = new Set(['recordUnmatchedDeposit', 'resolveUnmatchedDeposit']);
export const depositKey = (reference: string) => createHash('sha256').update(depositReference(reference)).digest('hex');
const change = (kind: string, value: unknown, previous?: unknown): store.Change => ({kind, value: value as store.Change['value'], ...(previous ? {previous: previous as store.Data} : {})});
export const noSavedDeposit = (reference: string): store.Transaction[number] => ({ ConditionCheck: {
  TableName: store.table(), Key: {kind: 'COMMISSION_DEPOSIT', id: depositKey(reference)}, ConditionExpression: 'attribute_not_exists(id)',
} });
export interface ReceiptPayrollPosting { policy: CommissionPolicy; entry: CommissionEntry; earnings: CommissionEarning[] }

/** A refund or restoration affects the same frozen employee selection as its original receipt. */
function postingTargets({ policy, entry, earnings }: ReceiptPayrollPosting) {
  let receipt = entry;
  for (let i = policy.entries.length - 2; i >= 0 && receipt.originalId; i--) {
    if (policy.entries[i].id === receipt.originalId) receipt = policy.entries[i];
  }
  if (receipt.kind !== 'RECEIPT') throw new Error('The original commission receipt is missing.');
  if (receipt.excludedByCase || receipt.supersededBy) return [];
  const employees = entry.allocationId
    ? earnings.filter(e => e.amountCents !== 0 && (e.status === 'PAYABLE' || e.status === 'REVIEW')).map(e => e.producerId)
    : entry.producerCents ? [policy.producerId] : [];
  return employees.map(producerId => ({
    producerId, policyId: policy.id, entryId: receipt.id, receivedOn: receipt.receivedOn, transaction: policy.transaction,
    postedOn: entry.receivedOn, revenueKind: entry.revenueKind,
    earningId: entry.allocationId ? receiptEarningId(policy.id, receipt.id, producerId) : undefined,
  }));
}

/**
 * Unknown carrier deposits require conservative review. Posted receipts carry enough
 * information to match the employee, actual transaction date and frozen selection.
 * The caller reads the reconciliation version before this lookup and commits it with the holds.
 */
export async function holdReceiptPayroll(postings: string | readonly ReceiptPayrollPosting[]): Promise<store.Change[]> {
  const targets = typeof postings === 'string' ? undefined : postings.flatMap(postingTargets);
  const receiptDates = typeof postings === 'string' ? [postings] : postings.map(p => p.entry.receivedOn);
  if (!receiptDates.length || targets?.length === 0) return [];
  const earliestDate = receiptDates.reduce((earliest, date) => date < earliest ? date : earliest);
  const cycles = (await store.approvedPayrollCycles(earliestDate)).filter(c => !c.reviewRequired);
  const reviewReason = 'A carrier receipt was recorded within this payroll cutoff after approval. Reconcile it and review a replacement payroll approval before payment.';
  let holds = cycles.map(cycle => ({ cycle, reviewReason }));
  if (targets && holds.length) {
    const producerIds = [...new Set(targets.map(t => t.producerId))];
    const departures = await store.getMany<CommissionDeparture>(producerIds.map(id => ({kind: 'DEPARTURE', id})));
    const byProducer = new Map(departures.map(d => [d.producerId, d]));
    const relevant = targets.filter(t => {
      const departure = byProducer.get(t.producerId);
      return !departure || departureDecision(departure, t.policyId, t.entryId, t.receivedOn, t.transaction, t.earningId) !== 'EXCLUDE';
    });
    holds = cycles.flatMap(cycle => {
      const matched = relevant.filter(t => t.postedOn <= cycle.cutoff &&
        (!cycle.producerIds || cycle.producerIds.includes(t.producerId)) &&
        (!cycle.selectedEarningKeys || cycle.selectedEarningKeys.includes(payrollRowKey(t))));
      if (!matched.length) return [];
      const sources = [...new Set(matched.map(t => commissionRevenueLabel(t.revenueKind)))].join(', ');
      return [{ cycle, reviewReason: sources + ' affects employee earnings within this approved payroll cutoff. Review the transactions and replace this unpaid approval before payment.' }];
    });
  }
  // A partially paid approval cannot be replaced. Keep its recorded payments
  // and leave any additional earnings available for supplemental payroll.
  const ids = [...new Set(holds.flatMap(h => h.cycle.batchIds))];
  if (ids.length) {
    const batches = await store.getMany<CommissionBatch>(ids.map(id => ({ kind: 'BATCH', id })));
    const byId = new Map(batches.map(b => [b.id, b]));
    if (ids.some(id => !byId.has(id))) throw new Error('Approved payroll history is incomplete. Review the missing batch before posting.');
    holds = holds.filter(h => h.cycle.batchIds.every(id => batchPaidCents(byId.get(id)!) === 0));
  }
  if (holds.length > 90) throw new Error('Review outstanding payroll cycles before recording another receipt.');
  return holds.map(({cycle, reviewReason}) => change('PAYROLL_CYCLE', { ...cycle, reviewRequired: reviewReason }, cycle));
}
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
    await requireStatementIndexes();
    const [settlement, statements] = await Promise.all([
      store.get('INTAKE_BANK_REFERENCE', settlementBankKey(fields.reference)), store.list<CommissionStatement>('STATEMENT'),
    ]);
    if (settlement || statements.some(s => depositReference(s.settlementRef) === depositReference(fields.reference))) throw new Error('This reference is already recorded with a statement. Review the existing receipt.');
    const holds = await holdReceiptPayroll(fields.receivedOn);
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
