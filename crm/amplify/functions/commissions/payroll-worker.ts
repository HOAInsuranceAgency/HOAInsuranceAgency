import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { cycleBatches, payrollDay, suggestPayrollDates, type PayrollCycle, type PayrollDelivery, type PayrollSettings } from '../../../../shared/commissionPayroll';
import { batchPaidCents, type CommissionBatch } from '../../../../shared/commissions';
import { readReport, reportFiles } from './report-history';
import { processPayrollFeedback } from './payroll-feedback';
import { TransactionalMailClient } from '../transactional-mail/client';
import { MailDeliveryError } from '../transactional-mail/contract';
import { absentCycle, change, condition, payrollEnvironment, payrollSettings } from './payroll';
import * as store from './store';

const mail = new TransactionalMailClient('report');
const conflict = (error: unknown) => ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes((error as Error)?.name);
interface Event { trigger?: string; scheduleArn?: string; scheduledAt?: string }
export function verifyPayrollSchedule(event: Event, now = Date.now()) {
  if (!process.env.COMMISSION_PAYROLL_SCHEDULE_ARN || event.trigger !== 'scheduled' || event.scheduleArn !== process.env.COMMISSION_PAYROLL_SCHEDULE_ARN || !event.scheduledAt) throw new Error('Unrecognized commission payroll schedule.');
  const at = Date.parse(event.scheduledAt);
  if (!Number.isFinite(at)) throw new Error('Invalid commission payroll schedule time.');
  const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  if (!Number.isFinite(at) || now - at < -60_000 || now - at > 60 * 60_000 || local.minute !== '00' || local.second !== '00' || Number(local.hour) < 8 || Number(local.hour) > 17) throw new Error('The commission payroll schedule invocation expired or has an invalid time.');
}
async function deliver(cycle: PayrollCycle, settings: PayrollSettings, kind: PayrollDelivery['reportType'], today: string) {
  const id = `${cycle.id}:${cycle.revision}:${kind}${kind === 'OVERDUE' || kind === 'CALENDAR' ? `:${today}` : ''}`;
  const old = await store.get<PayrollDelivery>('PAYROLL_DELIVERY', id);
  if (old && !(old.status === 'FAILED' && old.retryRequested)) {
    if (old.status === 'SENDING' && Date.now() - Date.parse(old.updatedAt) > 15 * 60_000) {
      await store.commit([change('PAYROLL_DELIVERY', { ...old, status: 'UNKNOWN', error: 'The worker stopped before confirming delivery. Review delivery history before any replacement.', updatedAt: new Date().toISOString() }, old)], 'payroll-worker');
      throw new Error('A commission report delivery needs review.');
    }
    return;
  }
  const recipient = kind === 'PAYROLL' ? settings.hrRecipient : settings.reviewRecipient;
  if (!recipient) throw new Error('Payroll recipients are incomplete.');
  if (old && old.recipient !== recipient) throw new Error('The recipient changed. Review the original failed delivery before retrying.');
  const link = `${process.env.COMMISSION_PAYROLL_URL ?? ''}/commissions`;
  const subject = old?.subject ?? `HOA commissions ${cycle.id} - ${kind === 'HOLD' ? 'approval needs review' : kind === 'CALENDAR' ? 'payroll calendar missing' : kind === 'PAYROLL' ? `approved payroll v${cycle.revision}${cycle.replacesRevision ? ' REVISED' : ''}` : kind === 'REVIEW' ? 'review due' : 'action overdue'}`;
  const text = old?.text ?? `${kind === 'PAYROLL' && cycle.replacesRevision ? `REPLACES revision ${cycle.replacesRevision}. Use this revision only; do not pay both reports. HR hold confirmed by ${cycle.hrHeldBy ?? 'Owner before original delivery'} at ${cycle.hrHeldAt ?? 'not previously sent'}.\n\n` : ''}` + (kind === 'HOLD'
    ? `A commission issue was recorded after approval of the ${cycle.id} payroll cycle. Further report delivery is on hold.\n\n${cycle.reviewRequired}\n\nCheck delivery history now. A report accepted or already in progress cannot be recalled automatically. HR inbox: ${settings.hrRecipient}. Processing: ${cycle.processingOn}; pay date: ${cycle.payDate}.\n\n${link}`
    : kind === 'CALENDAR'
    ? `Set up the ${cycle.id} monthly commission payroll cycle. No active calendar is configured, so the approved HR report cannot be scheduled.\n\nPayroll is processed Monday morning and paid Friday. Carrier receipts must arrive by the preceding Friday EOD. The approved HR report is due Monday at 8 AM Eastern. Check holiday changes. HR inbox: ${settings.hrRecipient}.\n\n${link}`
    : kind === 'PAYROLL'
    ? `Approved commissions: $${(cycle.totalCents / 100).toFixed(2)} for ${cycle.id}. Scheduled payday: ${cycle.payDate}; processing: ${cycle.processingOn}.\n\nAttached: HR summary and a separate earnings PDF for each employee's personal pay file. Enter the approved dollar amounts manually during payroll. No CRM acknowledgement is required.\n\nCarrier receipt cutoff: ${cycle.cutoff}, EOD Eastern. HR report due: ${cycle.hrDueOn}, 8 AM Eastern.${today > cycle.processingOn ? '\nThis report is late. Verify any prior payments and arrange outstanding amounts in the appropriate payroll.' : ''}\nSending this report does not record payment.\n\n${link}`
    : kind === 'REVIEW'
      ? `Review and approve the ${cycle.id} commission cycle. Receipt cutoff: ${cycle.cutoff} (inclusive, Eastern). HR needs the approved report by ${cycle.hrDueOn}; payroll processing is ${cycle.processingOn}, payment ${cycle.payDate}.\n\nResolve missing carrier receipts and eligibility evidence before approval. No payroll amounts have been sent to HR by this notice.\n\n${link}`
      : `Action is overdue for the ${cycle.id} commission cycle. Check outstanding approval, report delivery, or payment confirmation. HR report due: ${cycle.hrDueOn}; processing: ${cycle.processingOn}; pay date: ${cycle.payDate}.\n\n${link}`);
  let attachments: { filename: string; contentType: string; content: Uint8Array }[] = [];
  let reportId: string | undefined, reportHash: string | undefined;
  if (kind === 'PAYROLL') {
    if (cycle.reviewRequired) throw new Error(cycle.reviewRequired);
    const batches = await store.getMany<CommissionBatch>(cycle.batchIds.map(id => ({ kind: 'BATCH', id })));
    cycleBatches(cycle, batches);
    if (batches.some(b => batchPaidCents(b) > 0)) throw new Error('Payment was recorded before report delivery. Review payroll before sending the approved amounts.');
    const report = await readReport(cycle.id, cycle.revision);
    if (!report) throw new Error('The approved PDF archive is unavailable.');
    attachments = await reportFiles(report);
    reportId = report.id; reportHash = report.contentHash;
    if (attachments.reduce((n, f) => n + f.content.byteLength, 0) > 5 * 1024 * 1024) throw new Error('Payroll attachment is too large. No report was sent.');
  }
  const at = new Date().toISOString();
  const run: PayrollDelivery = { id, version: (old?.version ?? 0) + 1, cycleId: cycle.id, cycleRevision: cycle.revision, reportType: kind, status: 'SENDING', recipient, subject, text, reportId, reportHash, createdAt: old?.createdAt ?? at, updatedAt: at };
  try { await store.commit([change('PAYROLL_DELIVERY', run, old)], 'payroll-worker', [condition('PAYROLL_SETTINGS', settings), cycle.version === 0 ? absentCycle(cycle.id) : condition('PAYROLL_CYCLE', cycle)]); }
  catch (error) { if (conflict(error)) return; throw error; }
  let attempted = false;
  try {
    // Always use the existing durable SES transport; no untracked fallback sends.
    if (process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER !== 'ses' || !process.env.COMMISSION_PAYROLL_FROM) throw new Error('The approved commission report sender is not configured.');
    attempted = true;
    const result = await mail.send(new SendEmailCommand({ FromEmailAddress: process.env.COMMISSION_PAYROLL_FROM, Destination: { ToAddresses: [recipient] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } }), { idempotencyKey: `commission-payroll:${id}`, subject, text, attachments });
    if (!result.MessageId) throw new Error('Email acceptance was not confirmed.');
    await store.commit([change('PAYROLL_DELIVERY', { ...run, status: 'SENT', messageId: result.MessageId, updatedAt: new Date().toISOString() }, run)], 'payroll-worker');
  } catch (error) {
    const uncertain = attempted && !(error instanceof MailDeliveryError && error.state !== 'UNKNOWN');
    await store.commit([change('PAYROLL_DELIVERY', { ...run, status: uncertain ? 'UNKNOWN' : 'FAILED', failureState: error instanceof MailDeliveryError ? error.state : undefined, error: uncertain ? 'Email acceptance is uncertain. Review the mail ledger and recipient inbox before any replacement.' : 'The report was not sent. Check the sender, recipient, and mail delivery history before retrying.', updatedAt: new Date().toISOString() }, run)], 'payroll-worker');
    throw new Error(`Commission payroll delivery ${uncertain ? 'needs review' : 'failed'}.`);
  }
}
export async function handler(event: Event) {
  if (payrollEnvironment() !== 'main' || process.env.HOA_MIGRATION_PREVIEW === 'true' || process.env.HOA_MIGRATION_BUSINESS_HELD === 'true') return { skipped: true };
  verifyPayrollSchedule(event);
  const settings = await payrollSettings();
  if (!settings?.enabled) return { skipped: true };
  const cycles = await store.list<PayrollCycle>('PAYROLL_CYCLE');
  const today = payrollDay();
  let failed = false;
  // Owner-requested retries retain the original day and identity, including
  // reminders from an earlier day. A new calendar revision invalidates them.
  const retries = (await store.list<PayrollDelivery>('PAYROLL_DELIVERY')).filter(d => d.status === 'FAILED' && d.retryRequested && d.reportType !== 'OWNER_COPY');
  for (const retry of retries) {
    const existing = cycles.find(c => c.id === retry.cycleId);
    const calendar = retry.reportType === 'CALENDAR';
    if (calendar ? existing ? existing.status !== 'CANCELLED' || existing.revision !== retry.cycleRevision : retry.cycleRevision !== 0 : !existing || !['OPEN', 'APPROVED'].includes(existing.status) || existing.revision !== retry.cycleRevision) continue;
    const source: PayrollCycle = existing ?? { ...suggestPayrollDates(retry.cycleId), cutoff: '', version: 0, revision: 0, status: 'OPEN', batchIds: [], totalCents: 0, employees: [] };
    const deliveryDay = ['CALENDAR', 'OVERDUE'].includes(retry.reportType) ? retry.id.slice(-10) : today;
    try { await deliver(source, settings, retry.reportType, deliveryDay); }
    catch { console.error('Commission payroll retry requires review', { cycleId: retry.cycleId }); failed = true; }
  }
  const month = today.slice(0, 7), monthly = cycles.find(c => c.id === month);
  const suggested = suggestPayrollDates(month);
  if ((!monthly || monthly.status === 'CANCELLED') && (new Date(`${today}T12:00:00Z`).getUTCDay() === 1 || today >= suggested.reviewOn)) {
    const missing: PayrollCycle = monthly ?? { ...suggested, cutoff: '', version: 0, revision: 0, status: 'OPEN', batchIds: [], totalCents: 0, employees: [] };
    try { await deliver(missing, settings, 'CALENDAR', today); }
    catch { console.error('Commission payroll calendar reminder requires review', { cycleId: month }); failed = true; }
  }
  // Complete every due cycle even if one delivery requires review.
  for (const cycle of cycles.filter(c => c.status === 'OPEN' || c.status === 'APPROVED')) {
    try {
      if (cycle.status === 'OPEN' && today >= cycle.reviewOn && today < cycle.processingOn) await deliver(cycle, settings, 'REVIEW', today);
      if (cycle.status === 'APPROVED' && cycle.reviewRequired) await deliver(cycle, settings, 'HOLD', today);
      else if (cycle.status === 'APPROVED' && today >= cycle.hrDueOn) await deliver(cycle, settings, 'PAYROLL', today);
    } catch (error) { console.error('Commission payroll report requires review', { cycleId: cycle.id, error: error instanceof Error ? error.message : 'Unknown report failure' }); failed = true; }
    try {
      const reportDue = today > cycle.hrDueOn || (today === cycle.hrDueOn && cycle.hrDueOn === cycle.processingOn);
      const report = reportDue ? await store.get<PayrollDelivery>('PAYROLL_DELIVERY', `${cycle.id}:${cycle.revision}:PAYROLL`) : undefined;
      if ((reportDue && (cycle.status === 'OPEN' || report?.status !== 'SENT')) || today > cycle.payDate) await deliver(cycle, settings, 'OVERDUE', today);
    } catch (error) { console.error('Commission payroll reminder requires review', { cycleId: cycle.id, error: error instanceof Error ? error.message : 'Unknown reminder failure' }); failed = true; }
  }
  try { await processPayrollFeedback(settings); } catch { failed = true; }
  if (failed) throw new Error('One or more commission payroll reports require review.');
  return { ok: true };
}
