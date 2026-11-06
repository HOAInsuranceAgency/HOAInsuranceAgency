import type { CommissionEarning, CommissionDeparture, CommissionAdjustment } from '../../../../shared/commissionExceptions';
import { createHash, randomUUID } from 'node:crypto';
import { buildPayrollApproval, COMMISSION_START_MONTH, cycleBatches, defaultPayrollSettings, payrollBlockers, payrollDay, payrollPreview, suggestPayrollDates, validatePayrollCycle, validatePayrollSettings, type PayrollCycle, type PayrollDelivery, type PayrollSettings, type PayrollWorkspace } from '../../../../shared/commissionPayroll';
import { batchPaidCents, day, integer, required, sum, validateAllocationSnapshot, type CommissionBatch, type CommissionPolicy, type CommissionStatement } from '../../../../shared/commissions';
import type { PayrollReport } from '../../../../shared/commissionPayroll';
import { archiveReport, readReport, reportFiles } from './report-history';
import { PRODUCTION_OWNER_MAILBOX } from '../mailbox';
import type { Event } from './handler';
import * as store from './store';

export const payrollOperations = new Set(['payrollWorkspace', 'initializePayrollCalendar', 'savePayrollSettings', 'savePayrollCycle', 'approvePayrollCycle', 'cancelPayrollCycle', 'reopenPayrollCycle', 'confirmPayrollCycle', 'confirmPayrollEmployee', 'downloadPayrollCycle', 'retryPayrollDelivery', 'payrollAudit']);
export const payrollSettings = () => store.get<PayrollSettings>('PAYROLL_SETTINGS', 'payroll');
export const payrollEnvironment = () => process.env.COMMISSION_PAYROLL_ENV ?? 'local';
export const change = <T extends { id: string }>(kind: string, value: T, previous?: { id: string }) => ({ kind, value: value as unknown as store.Data & { id: string }, ...(previous ? { previous: previous as unknown as store.Data } : {}) });
export const condition = (kind: string, row: { id: string; version: number }): store.Transaction[number] => ({ ConditionCheck: { TableName: store.table(), Key: { kind, id: row.id }, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': row.version } } });
export const absentCycle = (id: string): store.Transaction[number] => ({ ConditionCheck: { TableName: store.table(), Key: { kind: 'PAYROLL_CYCLE', id }, ConditionExpression: 'attribute_not_exists(id)' } });
/** A new issue requires fresh approval, even if its review is later resolved.
 * The change competes with delivery reservation on the cycle version. */
export async function holdApprovedPayroll(policy: CommissionPolicy, dueOn: string) {
  const batchIds = new Set(policy.entries.map(e => e.batchId).filter(Boolean));
  const cycles = (await store.list<PayrollCycle>('PAYROLL_CYCLE')).filter(c => c.status === 'APPROVED' && (dueOn <= c.payDate || c.batchIds.some(id => batchIds.has(id))));
  if (cycles.length > 90) throw new Error('Too many outstanding payroll cycles. Review and close historical payroll first.');
  return cycles.map(c => change('PAYROLL_CYCLE', { ...c, reviewRequired: 'A policy review was added after approval. Resolve it and replace this unsent cycle with a fresh approval. If delivery already started, coordinate the correction with HR before recording payment.' }, c));
}
const version = (input: store.Data, row?: { version: number }) => { if (input.version !== (row?.version ?? 0)) throw new Error('Payroll records changed. Refresh before saving.'); };
function preview(cycle: PayrollCycle, policies: CommissionPolicy[], settings: PayrollSettings | undefined, statements: CommissionStatement[], earnings: CommissionEarning[] = [], departures: CommissionDeparture[] = [], adjustments: CommissionAdjustment[] = []) {
  const rows = payrollPreview(policies, cycle.cutoff, cycle.producerIds, earnings, departures);
  const token = createHash('sha256').update(JSON.stringify([cycle.version, settings?.version ?? 0, adjustments.map(a=>[a.id,a.version]).sort(), rows, earnings.map(e=>[e.id,e.version]).sort(), departures.map(c=>[c.id,c.version]).sort(), policies.filter(p => rows.some(r => r.policyId === p.id)).map(p => [p.id, p.version]).sort()])).digest('hex');
  return { token, blockers: [...payrollBlockers(cycle, policies, statements, earnings, departures), ...adjustments.filter(a=>a.status==='DRAFT'&&a.adjustmentType==='UNPAID_CORRECTION'&&a.effectiveOn<=cycle.payDate&&(!cycle.producerIds||cycle.producerIds.includes(a.producerId))).map(a=>'Resolve unpaid compensation correction '+a.id+' before payroll approval.')], totalCents: sum(rows.map(r => r.amountCents)), entryCount: rows.length, employees: [...new Set(rows.map(r => r.producerId))].map(producerId => ({ producerId, name: rows.find(r => r.producerId === producerId)!.producerName, amountCents: sum(rows.filter(r => r.producerId === producerId).map(r => r.amountCents)) })) };
}

export async function payrollAction(_event: Event, actor: string, owner: boolean, operation: string, input: store.Data) {
  if (!owner) throw new Error('Not authorized: only the active Owner can manage commission payroll.');
  const settings = await payrollSettings();
  if (operation === 'payrollAudit') return { ok: true, ...await store.auditPage(input.cursor) };
  if (operation === 'initializePayrollCalendar') {
    const cycles = await store.list<PayrollCycle>('PAYROLL_CYCLE');
    const end = new Date(`${payrollDay().slice(0, 7)}-01T12:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1);
    const changes: store.Change[] = [];
    for (const d = new Date(`${COMMISSION_START_MONTH}-01T12:00:00Z`); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
      const id = d.toISOString().slice(0, 7);
      if (!cycles.some(c => c.id === id)) changes.push(change('PAYROLL_CYCLE', validatePayrollCycle({ ...suggestPayrollDates(id), version: 0 } as PayrollCycle)));
      if (changes.length > 90) throw new Error('Initialize a smaller calendar range.');
    }
    if (!settings) changes.push(change('PAYROLL_SETTINGS', defaultPayrollSettings(PRODUCTION_OWNER_MAILBOX)));
    if (changes.length) await store.commit(changes, actor);
    return { ok: true };
  }
  if (operation === 'payrollWorkspace') {
    const [cycles, deliveries, batches] = await Promise.all([store.list<PayrollCycle>('PAYROLL_CYCLE'), store.list<PayrollDelivery>('PAYROLL_DELIVERY'), store.list<CommissionBatch>('BATCH')]);
    const [policies, statements, earnings, departures, adjustments] = await Promise.all([store.list<CommissionPolicy>('POLICY'), store.list<CommissionStatement>('STATEMENT'),store.list<CommissionEarning>('EARNING'),store.list<CommissionDeparture>('DEPARTURE'),store.list<CommissionAdjustment>('ADJUSTMENT')]);
    validateAllocationSnapshot(policies, batches, earnings);
    for (const c of cycles) if (c.status === 'OPEN') c.preview = preview(c, policies, settings, statements, earnings, departures, adjustments);
    const ids = new Set(cycles.flatMap(c => c.batchIds));
    const reports = (await store.list<PayrollReport>('PAYROLL_REPORT')).map(r => ({ id: r.id, cycleId: r.cycle.id, revision: r.cycle.revision, totalCents: r.cycle.totalCents, createdAt: r.createdAt, createdBy: r.createdBy, contentHash: r.contentHash }));
    const workspace: PayrollWorkspace = { owner, settings: settings ?? defaultPayrollSettings(PRODUCTION_OWNER_MAILBOX), cycles: cycles.sort((a,b) => b.id.localeCompare(a.id)), deliveries: deliveries.sort((a,b) => b.createdAt.localeCompare(a.createdAt)), batches: batches.filter(b => ids.has(b.id)), reports, legacyBatches: batches.filter(b => !b.cycleId && b.status === 'APPROVED'), environment: payrollEnvironment() };
    workspace.producers = [...new Map([...policies.map(p => [p.producerId, { id: p.producerId, name: p.producerName }] as const),...earnings.map(e => [e.producerId,{id:e.producerId,name:e.producerName}] as const)]).values()].sort((a,b) => a.name.localeCompare(b.name));
    return { ok: true, ...workspace };
  }
  if (operation === 'savePayrollSettings') {
    version(input, settings);
    const next = validatePayrollSettings(input as unknown as PayrollSettings);
    if (next.enabled && payrollEnvironment() !== 'main') throw new Error('Automatic commission delivery can only be enabled in production.');
    await store.commit([change('PAYROLL_SETTINGS', next, settings)], actor);
    return { ok: true };
  }
  if (operation === 'retryPayrollDelivery') {
    const delivery = await store.get<PayrollDelivery>('PAYROLL_DELIVERY', required(input.id, 'a delivery'));
    if (!delivery || delivery.status !== 'FAILED') throw new Error('Only a definitely unsent report can be retried. Uncertain sends require delivery review.');
    version(input, delivery);
    const sourceCycle = await store.get<PayrollCycle>('PAYROLL_CYCLE', delivery.cycleId);
    const missingCalendar = delivery.reportType === 'CALENDAR' && (!sourceCycle ? delivery.cycleRevision === 0 : sourceCycle.status === 'CANCELLED' && sourceCycle.revision === delivery.cycleRevision);
    if (delivery.reportType !== 'OWNER_COPY' && !missingCalendar && (!sourceCycle || sourceCycle.revision !== delivery.cycleRevision || !['OPEN', 'APPROVED'].includes(sourceCycle.status) || delivery.reportType === 'CALENDAR')) throw new Error('This report belongs to a closed or replaced payroll cycle.');
    // Keep its identity and original envelope; the worker retries this same operation.
    await store.commit([change('PAYROLL_DELIVERY', { ...delivery, error: undefined, updatedAt: new Date().toISOString(), retryRequested: true }, delivery)], actor, [sourceCycle ? condition('PAYROLL_CYCLE', sourceCycle) : absentCycle(delivery.cycleId)]);
    return { ok: true };
  }
  const id = required(input.id, 'a payroll month');
  const cycle = await store.get<PayrollCycle>('PAYROLL_CYCLE', id);
  if (operation === 'savePayrollCycle') {
    version(input, cycle);
    if (cycle && !['OPEN', 'CANCELLED'].includes(cycle.status)) throw new Error('Approved payroll dates are frozen.');
    if (cycle?.status === 'OPEN' && (await store.get('PAYROLL_DELIVERY', `${id}:${cycle.revision}:REVIEW`))) throw new Error('A review notice already exists. Keep these dates or cancel this cycle.');
    const next = validatePayrollCycle(input as unknown as PayrollCycle);
    if (next.producerIds) {
      const known = new Set([...(await store.list<CommissionPolicy>('POLICY')).map(p => p.producerId),...(await store.list<CommissionEarning>('EARNING')).map(e=>e.producerId)]);
      if (next.producerIds.some(id => !known.has(id))) throw new Error('Choose employees with existing commission policy records.');
    }
    next.revision = cycle ? cycle.revision + (cycle.status === 'CANCELLED' ? 1 : 0) : 1;
    if (cycle?.replacesRevision) Object.assign(next, { replacesRevision: cycle.replacesRevision, correctionReason: cycle.correctionReason, hrHeldAt: cycle.hrHeldAt, hrHeldBy: cycle.hrHeldBy });
    await store.commit([change('PAYROLL_CYCLE', next, cycle)], actor);
    return { ok: true };
  }
  if (!cycle) throw new Error('Payroll cycle not found.');
  if (operation === 'approvePayrollCycle' && ['APPROVED', 'PAID'].includes(cycle.status) && input.confirmed === true && cycle.approvalToken && input.previewToken === cycle.approvalToken) return { ok: true };
  if (operation === 'confirmPayrollCycle' && cycle.status === 'PAID' && input.confirmed === true && input.paidOn === (cycle.confirmationPaidOn ?? cycle.paidOn) && input.paymentReference === cycle.paymentReference) return { ok: true };
  if (operation === 'downloadPayrollCycle') {
    const revision = input.revision === undefined ? cycle.revision : integer(input.revision, 1, cycle.revision, 'report revision');
    const historical = input.historicalConfirmed === true || revision !== cycle.revision || cycle.status === 'CANCELLED' || cycle.status === 'PAID';
    if (historical && input.historicalConfirmed !== true) throw new Error('Confirm this is an historical record, not an instruction to pay.');
    if (!historical && !['APPROVED', 'PAID'].includes(cycle.status)) throw new Error('Approve this cycle before exporting payroll.');
    if (!historical && cycle.reviewRequired) throw new Error(cycle.reviewRequired);
    const report = await readReport(id, revision);
    if (!report) throw new Error('The approved PDF archive is unavailable. Review and replace this cycle.');
    const files = await reportFiles(report, input.documentId ? required(input.documentId, 'an employee report') : undefined);
    await store.commit([change('PAYROLL_ACCESS', { id: randomUUID(), cycleId: id, revision, documentId: input.documentId ?? 'all', contentHash: report.contentHash, historical, action: 'DOWNLOAD', at: new Date().toISOString() })], actor, [condition('PAYROLL_CYCLE', cycle)]);
    return { ok: true, files: files.map(f => ({ filename: `${historical ? 'HISTORICAL_' : ''}${f.filename}`, contentType: f.contentType, encoding: 'base64', content: Buffer.from(f.content).toString('base64') })) };
  }
  if (operation === 'confirmPayrollEmployee') {
    if (!['APPROVED', 'PAID'].includes(cycle.status) || input.confirmed !== true) throw new Error('Confirm the amount actually paid to this employee.');
    const batches = cycleBatches(cycle, await store.getMany<CommissionBatch>(cycle.batchIds.map(id => ({ kind: 'BATCH', id }))));
    const batch = batches.find(b => b.id === input.batchId);
    if (!batch) throw new Error('The employee batch is not part of this cycle.');
    const paidOn = day(input.paidOn), reference = required(input.paymentReference, 'the payroll payment reference');
    if (paidOn > payrollDay()) throw new Error('Confirm payment only after it occurs.');
    const paymentId = input.paymentId ? required(input.paymentId, 'a payment ID', 128) : `full:${batch.id}`;
    const prior = batch.payments?.find(p => p.id === paymentId);
    if (prior) {
      if (prior.paidOn === paidOn && prior.reference === reference && (input.amountCents === undefined || prior.amountCents === input.amountCents)) return { ok: true };
      throw new Error('This payment ID was already used for a different payment.');
    }
    if (batch.status === 'PAID') {
      if (!input.paymentId && input.amountCents === undefined && batch.actualPaidOn === paidOn && batch.reference === reference) return { ok: true };
      throw new Error('This employee payment was already recorded.');
    }
    version(input, cycle);
    const balance = batch.totalCents - batchPaidCents(batch);
    const amountCents = input.amountCents === undefined ? balance : integer(input.amountCents, 1, balance, 'payment amount within the unpaid balance');
    if (amountCents < balance && !input.paymentId) throw new Error('A partial payment needs a unique payment ID.');
    const payments = [...(batch.payments ?? []), { id: paymentId, amountCents, paidOn, reference, recordedAt: new Date().toISOString(), recordedBy: actor }];
    const fullyPaid = amountCents === balance;
    const complete = fullyPaid && batches.every(b => b.id === batch.id || b.status === 'PAID');
    const lastPaid = [paidOn, ...batches.flatMap(b => [b.actualPaidOn ?? '', ...(b.payments ?? []).map(p => p.paidOn)])].sort().at(-1)!;
    await store.commit([change('BATCH', { ...batch, payments, ...(fullyPaid ? { status: 'PAID', actualPaidOn: payments.map(p => p.paidOn).sort().at(-1), reference } : {}) }, batch), change('PAYROLL_CYCLE', { ...cycle, ...(complete ? { status: 'PAID', paidOn: lastPaid, paymentReference: 'See individual employee payment references' } : {}) }, cycle)], actor);
    return { ok: true };
  }
  version(input, cycle);
  if (operation === 'approvePayrollCycle') {
    if (input.confirmed !== true) throw new Error('Confirm reconciliation and payroll totals before approval.');
    if (!settings) throw new Error('Save report delivery settings or initialize the monthly calendars before approval.');
    const reconciliation = await store.get<{ id: string; version: number }>('PAYROLL_STATE', 'reconciliation');
    const [policies, batches, statements, earnings, departures, adjustments] = await Promise.all([store.list<CommissionPolicy>('POLICY'), store.list<CommissionBatch>('BATCH'), store.list<CommissionStatement>('STATEMENT'),store.list<CommissionEarning>('EARNING'),store.list<CommissionDeparture>('DEPARTURE'),store.list<CommissionAdjustment>('ADJUSTMENT')]);
    const current = preview(cycle, policies, settings, statements, earnings, departures, adjustments);
    if (current.blockers.length) throw new Error(current.blockers.join(' '));
    if (input.previewToken !== current.token) throw new Error('The reviewed payroll amounts or employee settings changed. Refresh and review before approval.');
    const approval = buildPayrollApproval(cycle, policies, batches, settings, actor, new Date().toISOString(), earnings, departures);
    await store.commit([
      ...approval.earnings.map(e=>change('EARNING',e,earnings.find(old=>old.id===e.id))),
      ...approval.policies.map(p => change('POLICY', p, policies.find(old => old.id === p.id))),
      ...approval.batches.map(b => change('BATCH', b)), change('PAYROLL_CYCLE', { ...approval.cycle, approvalToken: String(input.previewToken) }, cycle),
      ...await archiveReport(approval.cycle, approval.batches, actor),
      change('PAYROLL_STATE', { id: 'reconciliation' }, reconciliation),
    ], actor, [condition('PAYROLL_SETTINGS', settings)]);
    return { ok: true };
  }
  if (operation === 'confirmPayrollCycle') {
    if (cycle.status !== 'APPROVED' || input.confirmed !== true) throw new Error('Confirm that the entire approved cycle was paid.');
    const paidOn = day(input.paidOn), paymentReference = required(input.paymentReference, 'the payroll payment reference');
    if (paidOn > payrollDay()) throw new Error('Confirm payment only after it occurs.');
    const batches = cycleBatches(cycle, await store.getMany<CommissionBatch>(cycle.batchIds.map(id => ({ kind: 'BATCH', id }))));
    const lastPaid = [paidOn, ...batches.flatMap(b => [b.actualPaidOn ?? '', ...(b.payments ?? []).map(p => p.paidOn)])].sort().at(-1)!;
    await store.commit([...batches.filter(b => b.status === 'APPROVED').map(b => change('BATCH', { ...b, status: 'PAID', reference: paymentReference, actualPaidOn: [paidOn, ...(b.payments ?? []).map(p => p.paidOn)].sort().at(-1), payments: [...(b.payments ?? []), { id: `cycle:${cycle.id}:${cycle.revision}`, amountCents: b.totalCents - batchPaidCents(b), paidOn, reference: paymentReference, recordedAt: new Date().toISOString(), recordedBy: actor }] }, b)), change('PAYROLL_CYCLE', { ...cycle, status: 'PAID', paidOn: lastPaid, confirmationPaidOn: paidOn, paymentReference }, cycle)], actor);
    return { ok: true };
  }
  if (operation === 'cancelPayrollCycle' || operation === 'reopenPayrollCycle') {
    const reopen = operation === 'reopenPayrollCycle';
    if (reopen && cycle.status !== 'APPROVED') throw new Error('Only an approved, unpaid cycle can be revised.');
    if (!['OPEN', 'APPROVED'].includes(cycle.status)) throw new Error('This cycle cannot be cancelled.');
    const reason = required(input.reason, 'the cancellation reason');
    // Cancellation races a delivery reservation on the cycle version and its durable run key.
    const noSend: store.Transaction[number] = { ConditionCheck: { TableName: store.table(), Key: { kind: 'PAYROLL_DELIVERY', id: `${id}:${cycle.revision}:PAYROLL` }, ConditionExpression: 'attribute_not_exists(id)' } };
    const delivery = await store.get<PayrollDelivery>('PAYROLL_DELIVERY', `${id}:${cycle.revision}:PAYROLL`);
    if (reopen && delivery && ['SENDING', 'UNKNOWN'].includes(delivery.status)) throw new Error('Resolve uncertain email acceptance before replacing this report.');
    if (reopen && delivery?.status === 'SENT' && input.hrHeld !== true) throw new Error('Confirm HR has held the original report and no employee has been paid.');
    const batches = await store.getMany<CommissionBatch>(cycle.batchIds.map(id => ({ kind: 'BATCH', id })));
    if (cycle.status === 'APPROVED') cycleBatches(cycle, batches);
    if (batches.some(b => b.status !== 'APPROVED' || batchPaidCents(b) > 0)) throw new Error('Only unpaid batches can be cancelled or replaced. Use a reviewed supplemental cycle for corrections after payment.');
    const policies = await store.getMany<CommissionPolicy>([...new Set(batches.flatMap(b => b.lines.filter(l=>!l.earningId).map(l => l.policyId)))].map(id => ({ kind: 'POLICY', id })));
    const earnings = await store.getMany<CommissionEarning>(batches.flatMap(b=>b.lines.filter(l=>l.earningId).map(l=>({kind:'EARNING',id:l.earningId!}))));
    for (const b of batches) for (const line of b.lines) if (line.earningId ? !earnings.some(e=>e.id===line.earningId && e.batchId===b.id && e.amountCents===line.amountCents) : !policies.some(p => p.id === line.policyId && p.entries.some(e => e.id === line.entryId && e.batchId === b.id))) throw new Error('Payroll allocations are incomplete. Review the ledger before cancelling.');
    const ids = new Set(cycle.batchIds);
    const archive = cycle.status === 'APPROVED' && !await readReport(id, cycle.revision) ? await archiveReport({ ...cycle, reviewRequired: undefined }, batches, cycle.approvedBy ?? actor) : [];
    const next: PayrollCycle = reopen ? { ...validatePayrollCycle(cycle), revision: cycle.revision + 1, replacesRevision: cycle.revision, correctionReason: reason, ...(input.hrHeld === true ? { hrHeldAt: new Date().toISOString(), hrHeldBy: actor } : {}) } : { ...cycle, status: 'CANCELLED', cancellationReason: reason };
    await store.commit([...earnings.map(e=>{const {batchId:_batch,...rest}=e;return change('EARNING',rest,e);}),...policies.map(p => change('POLICY', { ...p, entries: p.entries.map(e => { if (!e.batchId || !ids.has(e.batchId)) return e; const { batchId: _id, ...entry } = e; return entry; }) }, p)), ...batches.map(b => change('BATCH', { ...b, status: 'CANCELLED', reference: reason }, b)), change('PAYROLL_CYCLE', next, cycle), ...archive], actor, [reopen && delivery ? condition('PAYROLL_DELIVERY', delivery) : noSend]);
    return { ok: true };
  }
  throw new Error('Unknown payroll action.');
}
