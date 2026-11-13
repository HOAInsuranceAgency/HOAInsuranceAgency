import { departureDecision, type CommissionEarning, type CommissionDeparture } from './commissionExceptions';
import { assertCommissionReviewed, day, integer, required, sum, validateAllocationSnapshot, type CommissionBatch, type CommissionPolicy, type CommissionStatement } from './commissions';

export const PAYROLL_TIME_ZONE = 'America/New_York';
export const COMMISSION_START_MONTH = '2026-10';
export interface PayrollEmployee { producerId: string; employeeId: string; earningsCode: string }
export interface PayrollSettings {
  id: 'payroll'; version: number; enabled: boolean;
  hrRecipient: string; reviewRecipient: string;
  /** Retained on old records only; HR enters commission totals manually. */
  employees?: PayrollEmployee[];
}
export interface PayrollCycle {
  cycleType?: 'MONTHLY' | 'OFF_CYCLE'; reason?: string; producerIds?: string[];
  /** Absent means all eligible earnings; explicit keys freeze the off-cycle selection. */
  selectedEarningKeys?: string[];
  correctionReason?: string; replacesRevision?: number; hrHeldAt?: string; hrHeldBy?: string;
  id: string; version: number; revision: number; cutoff: string; reviewOn: string; hrDueOn: string;
  processingOn: string; payDate: string; status: 'OPEN' | 'APPROVED' | 'PAID' | 'CANCELLED';
  batchIds: string[]; totalCents: number; employees?: PayrollEmployee[];
  approvedAt?: string; approvedBy?: string;
  paidOn?: string; paymentReference?: string; confirmationPaidOn?: string;
  reviewRequired?: string;
  approvalToken?: string; cancellationReason?: string;
  preview?: { token: string; totalCents: number; entryCount: number; employees: { producerId: string; name: string; amountCents: number }[]; blockers: string[] };
}
export interface PayrollDelivery {
  id: string; version: number; cycleId: string; cycleRevision: number; reportType: 'REVIEW' | 'PAYROLL' | 'OVERDUE' | 'CALENDAR' | 'HOLD' | 'OWNER_COPY';
  status: 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN'; recipient: string;
  subject: string; text: string; createdAt: string; updatedAt: string;
  messageId?: string; error?: string;
  retryRequested?: boolean;
  reportId?: string; reportHash?: string; sourceDeliveryId?: string; ownerId?: string;
  feedback?: string[]; feedbackObservedAt?: string; failureState?: string;
}
export interface PayrollReport {
  id: string; version: number; cycle: PayrollCycle; batches: CommissionBatch[];
  contentHash: string; createdAt: string; createdBy: string;
  documents?: { id: string; documentId: string; filename: string; contentType: string; sha256: string }[];
}
export interface PayrollWorkspace {
  owner: boolean; settings?: PayrollSettings; cycles: PayrollCycle[];
  deliveries: PayrollDelivery[]; batches: CommissionBatch[];
  environment: string;
  reports?: { id: string; cycleId: string; revision: number; totalCents: number; createdAt: string; createdBy: string; contentHash: string }[];
  legacyBatches?: CommissionBatch[];
  producers?: { id: string; name: string }[];
  availableEarnings?: ReturnType<typeof payrollPreview>;
  statementReadiness?: { activeStatements: number; statementsNeedingReview: number; unmatchedRows: number; pendingSettlements: { id: string; reference: string; receivedOn: string; status: string }[] };

}
export const defaultPayrollSettings = (reviewRecipient = ''): PayrollSettings => ({ id: 'payroll', version: 0, enabled: false, hrRecipient: 'hr@cobaltemployment.com', reviewRecipient });
export const payrollDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: PAYROLL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
/** Last Friday payday, Monday morning processing, carrier receipts through
 * the preceding Friday EOD, and HR report Monday 8 AM ET. Holidays are editable. */
export function suggestPayrollDates(month: string): Pick<PayrollCycle, 'id' | 'cutoff' | 'reviewOn' | 'hrDueOn' | 'processingOn' | 'payDate'> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Use YYYY-MM for the payroll month.');
  const date = new Date(`${day(`${month}-01`)}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() - 5 + 7) % 7);
  const offset = (days: number) => { const shifted = new Date(date.getTime()); shifted.setUTCDate(shifted.getUTCDate() + days); return shifted.toISOString().slice(0, 10); };
  return { id: month, payDate: offset(0), cutoff: offset(-7), processingOn: offset(-4), hrDueOn: offset(-4), reviewOn: offset(-6) };
}
export function payrollEmail(value: unknown, optional = false): string {
  if (optional && value === '') return '';
  const email = required(value, 'one email address', 254).toLowerCase();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(email)) throw new Error('Enter one valid email address.');
  return email;
}
export function validatePayrollSettings(input: PayrollSettings): PayrollSettings {
  if (typeof input.enabled !== 'boolean') throw new Error('Choose whether automatic delivery is enabled.');
  return { id: 'payroll', version: integer(input.version, 0, Number.MAX_SAFE_INTEGER, 'settings version'), enabled: input.enabled,
    hrRecipient: payrollEmail(input.hrRecipient, !input.enabled), reviewRecipient: payrollEmail(input.reviewRecipient, !input.enabled) };
}
export function validatePayrollCycle(input: PayrollCycle): PayrollCycle {
  const id = required(input.id, 'a payroll month');
  if (!/^\d{4}-(0[1-9]|1[0-2])(?:-OFF-[a-f0-9]{8})?$/.test(id) || id < COMMISSION_START_MONTH) throw new Error('Use a payroll month from October 2026 onward.');
  const offCycle = id.includes('-OFF-');
  const producerIds = offCycle ? [...new Set((input.producerIds ?? []).map(id => required(id, 'an employee', 128)))].sort() : undefined;
  if (offCycle && (!producerIds?.length || producerIds.length > 50)) throw new Error('Choose the employees for this off-cycle payment.');
  const selectedEarningKeys = input.selectedEarningKeys === undefined ? undefined : Array.isArray(input.selectedEarningKeys) ? [...new Set(input.selectedEarningKeys.map(key => required(key, 'an earnings selection', 1000)))].sort() : [];
  if (selectedEarningKeys && (!offCycle || !selectedEarningKeys.length || selectedEarningKeys.length > 500)) throw new Error('Choose 1–500 earnings for an off-cycle payment.');
  const cutoff = day(input.cutoff), reviewOn = day(input.reviewOn), hrDueOn = day(input.hrDueOn), processingOn = day(input.processingOn), payDate = day(input.payDate);
  if (payDate.slice(0, 7) !== id.slice(0, 7)) throw new Error('The pay date must fall in the selected payroll month.');
  if (!(cutoff < reviewOn && reviewOn <= hrDueOn && hrDueOn <= processingOn && processingOn <= payDate)) throw new Error('Use cutoff < review date <= HR due date <= processing date <= pay date.');
  return { id, version: integer(input.version, 0, Number.MAX_SAFE_INTEGER, 'cycle version'), revision: 1, cutoff, reviewOn, hrDueOn, processingOn, payDate, status: 'OPEN', batchIds: [], totalCents: 0, employees: [], ...(offCycle ? { cycleType: 'OFF_CYCLE', reason: required(input.reason, 'the off-cycle reason', 1000), producerIds, ...(selectedEarningKeys ? { selectedEarningKeys } : {}) } : { cycleType: 'MONTHLY' }) };
}
export function payrollPreview(policies: CommissionPolicy[], cutoff: string, producerIds?: string[], earnings: CommissionEarning[] = [], departures: CommissionDeparture[] = []) {
  day(cutoff);
  const rows = [
    ...policies.flatMap(p => p.entries.filter(e => e.kind === 'RECEIPT' && !e.excludedByCase && !e.supersededBy && !e.batchId && !e.allocationId && e.producerCents > 0 && e.receivedOn <= cutoff).map(e => ({ producerId: p.producerId, producerName: p.producerName, policyId: p.id, entryId: e.id, accountName: p.accountName, policyNumber: p.policyNumber, receivedOn: e.receivedOn, transaction: p.transaction, agencyCents: e.agencyCents, producerBps: p.producerBps, amountCents: e.producerCents, earningId: undefined as string | undefined, source: undefined as CommissionEarning['source'] | undefined, shareBps: undefined as number | undefined }))),
    ...earnings.filter(e => e.status === 'PAYABLE' && !e.batchId && e.amountCents > 0 && e.receivedOn <= cutoff).map(e => ({producerId:e.producerId,producerName:e.producerName,policyId:e.policyId,entryId:e.entryId,accountName:e.accountName,policyNumber:e.policyNumber,receivedOn:e.receivedOn,transaction:e.transaction,agencyCents:e.agencyCents,producerBps:e.producerBps,amountCents:e.amountCents,earningId:e.id,source:e.source,shareBps:e.shareBps}))
  ];
  return rows.filter(r => (!producerIds || producerIds.includes(r.producerId)) && !departures.some(c => c.producerId === r.producerId && departureDecision(c,r.policyId,r.entryId,r.receivedOn,r.transaction,r.earningId) === 'EXCLUDE')).sort((a,b) => a.producerId.localeCompare(b.producerId) || a.policyId.localeCompare(b.policyId) || (a.earningId ?? a.entryId).localeCompare(b.earningId ?? b.entryId));
}
export const payrollRowKey = (row: { earningId?: string; policyId: string; entryId: string }) =>
  JSON.stringify(row.earningId ? ['earning', row.earningId] : ['receipt', row.policyId, row.entryId]);
export function cyclePayrollRows(cycle: PayrollCycle, policies: CommissionPolicy[], earnings: CommissionEarning[] = [], departures: CommissionDeparture[] = []) {
  const rows = payrollPreview(policies, cycle.cutoff, cycle.producerIds, earnings, departures);
  return cycle.selectedEarningKeys ? rows.filter(row => cycle.selectedEarningKeys!.includes(payrollRowKey(row))) : rows;
}
export function payrollBlockers(cycle: PayrollCycle, policies: CommissionPolicy[], statements: CommissionStatement[], earnings: CommissionEarning[] = [], departures: CommissionDeparture[] = []) {
  const blockers: string[] = [];
  if (cycle.selectedEarningKeys) {
    const available = new Set(payrollPreview(policies, cycle.cutoff, cycle.producerIds, earnings, departures).map(payrollRowKey));
    if (cycle.selectedEarningKeys.some(key => !available.has(key))) blockers.push('Selected off-cycle earnings changed or are no longer eligible. Review the selection before approval.');
  }
  for (const s of statements) if (s.status === 'DRAFT' && s.receivedOn <= cycle.cutoff) blockers.push(`Reconcile draft statement ${s.reference} received ${s.receivedOn}.`);
  for (const p of policies) {
    if (cycle.producerIds && !cycle.producerIds.includes(p.producerId)) continue;
    const payable = p.entries.some(e => e.kind === 'RECEIPT' && !e.batchId && e.producerCents > 0 && e.receivedOn <= cycle.cutoff);
    for (const hold of p.reviewHolds ?? []) if (hold.status === 'OPEN' && (payable || hold.dueOn <= cycle.payDate)) blockers.push(`${p.policyNumber}: ${hold.category.toLowerCase()} review due ${hold.dueOn}.`);
  }
  for (const c of departures) {
    if (cycle.producerIds && !cycle.producerIds.includes(c.producerId)) continue;
    if (c.status === 'DRAFT' && c.reviewOn <= cycle.payDate) blockers.push(c.producerName + ': departure terms need Owner approval.');
    for (const r of cyclePayrollRows(cycle, policies, earnings, departures).filter(r => r.producerId === c.producerId)) if (departureDecision(c,r.policyId,r.entryId,r.receivedOn,r.transaction,r.earningId) === 'REVIEW') blockers.push(c.producerName + ': review departure eligibility for ' + r.policyNumber + ' received ' + r.receivedOn + '.');
  }
  for (const e of earnings.filter(e => e.status === 'PAYABLE' && !e.batchId && e.receivedOn <= cycle.cutoff && (!cycle.producerIds || cycle.producerIds.includes(e.producerId)))) {
    const p=policies.find(p=>p.id===e.policyId); if(!p) blockers.push('Missing policy for employee earnings.');
    else for(const h of p.reviewHolds??[]) if(h.status==='OPEN') blockers.push(p.policyNumber + ': ' + h.category.toLowerCase() + ' review due ' + h.dueOn + '.');
  }
  return [...new Set(blockers)];
}
/** One approval reserves all included earnings for the named employee. */
export function buildPayrollApproval(cycle: PayrollCycle, policies: CommissionPolicy[], batches: CommissionBatch[], _settings: PayrollSettings, actor: string, at: string, earnings: CommissionEarning[] = [], departures: CommissionDeparture[] = []) {
  if (cycle.status !== 'OPEN') throw new Error('Only an open cycle can be approved.');
  if (payrollDay(new Date(at)) <= cycle.cutoff) throw new Error('Approve after the inclusive receipt cutoff has ended.');
  validateAllocationSnapshot(policies, batches, earnings);
  const blockers = payrollBlockers(cycle,policies,[],earnings,departures);
  if(blockers.length) throw new Error(blockers.join(' '));
  const rows = cyclePayrollRows(cycle, policies, earnings, departures);
  for (const policy of policies) if (rows.some(r => r.policyId === policy.id)) assertCommissionReviewed(policy);
  const producerIds = [...new Set(rows.map(r => r.producerId))];
  const created: CommissionBatch[] = producerIds.map(producerId => {
    const lines = rows.filter(r => r.producerId === producerId);
    return { id: `cycle:${cycle.id}:${cycle.revision}:${producerId}`, version: 0, cycleId: cycle.id, cycleRevision: cycle.revision, producerId, producerName: lines[0].producerName, cutoff: cycle.cutoff, payDate: cycle.payDate, status: 'APPROVED', totalCents: sum(lines.map(r => r.amountCents)), lines: lines.map(({ producerId: _id, producerName: _name, ...line }) => line) };
  });
  const selected = new Map(created.flatMap(b => b.lines.filter(l => !l.earningId).map(l => [`${l.policyId}|${l.entryId}`, b.id] as const)));
  const changed = policies.filter(p => p.entries.some(e => selected.has(`${p.id}|${e.id}`))).map(p => ({ ...p, entries: p.entries.map(e => selected.has(`${p.id}|${e.id}`) ? { ...e, batchId: selected.get(`${p.id}|${e.id}`)! } : e) }));
  const selectedEarnings = new Map(created.flatMap(b=>b.lines.filter(l=>l.earningId).map(l=>[l.earningId!,b.id] as const)));
  const changedEarnings = earnings.filter(e=>selectedEarnings.has(e.id)).map(e=>({...e,batchId:selectedEarnings.get(e.id)!}));
  if (changed.length + changedEarnings.length + 2 * created.length > 90 || rows.length > 500) throw new Error('This cycle exceeds the approval limit. Use smaller off-cycle groups and review historical balances before approving this month.');
  return { policies: changed, earnings: changedEarnings, batches: created, cycle: { ...cycle, status: 'APPROVED' as const, employees: [], batchIds: created.map(b => b.id), totalCents: sum(created.map(b => b.totalCents)), approvedBy: actor, approvedAt: at } };
}
export function cycleBatches(cycle: PayrollCycle, batches: CommissionBatch[]) {
  const selected = cycle.batchIds.map(id => {
    const batch = batches.find(b => b.id === id);
    if (!batch || batch.cycleId !== cycle.id || batch.cycleRevision !== cycle.revision || batch.status === 'CANCELLED' || batch.payDate !== cycle.payDate || batch.cutoff !== cycle.cutoff || sum(batch.lines.map(l => l.amountCents)) !== batch.totalCents) throw new Error('Payroll cycle records are incomplete or changed. Refresh and review the ledger.');
    return batch;
  });
  if ((!selected.length && cycle.totalCents !== 0) || new Set(cycle.batchIds).size !== cycle.batchIds.length || sum(selected.map(b => b.totalCents)) !== cycle.totalCents) throw new Error('Payroll cycle totals do not balance.');
  return selected;
}
