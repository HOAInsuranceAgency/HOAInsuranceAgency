import { createHash } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { payrollEmail, type PayrollCycle, type PayrollDelivery, type PayrollSettings } from '../../../../shared/commissionPayroll';
import { teamUserDisabled, activeTeamUserCheck } from '../crm-access/user-status';
import { TransactionalMailClient } from '../transactional-mail/client';
import { MailDeliveryError } from '../transactional-mail/contract';
import { change, condition } from './payroll';
import { readReport, reportFiles } from './report-history';
import * as store from './store';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const cognito = new CognitoIdentityProviderClient();
const mail = new TransactionalMailClient('report');
const operationKeyFor = (id: string) => `OP#hoa/main/report/${hash(`commission-payroll:${id}`)}`;
export async function payrollOwners() {
  if (!process.env.USER_POOL_ID) throw new Error('Owner directory is not configured.');
  const owners: { id: string; email: string }[] = [];
  let NextToken: string | undefined, unreachable = false;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: process.env.USER_POOL_ID, GroupName: 'OWNER', Limit: 60, NextToken }));
    for (const u of result.Users ?? []) {
      const attributes = Object.fromEntries((u.Attributes ?? []).map(a => [a.Name!, a.Value!]));
      if (!u.Enabled) continue;
      if (!attributes.sub) { unreachable = true; continue; }
      if (await teamUserDisabled(attributes.sub)) continue;
      try { owners.push({ id: attributes.sub, email: payrollEmail(attributes.email) }); }
      catch { unreachable = true; }
    }
    NextToken = result.NextToken;
    if (!NextToken) return { owners: [...new Map(owners.map(o => [o.id, o])).values()], unreachable };
    if (seen.has(NextToken)) break;
    seen.add(NextToken);
  }
  throw new Error('Owner directory could not be completely loaded.');
}
export async function deliveryFeedback(delivery: PayrollDelivery): Promise<{ types: string[]; observedAt?: string } | undefined> {
  if (!delivery.messageId) return undefined;
  const TableName = process.env.HOA_TRANSACTIONAL_MAIL_TABLE;
  if (!TableName) throw new Error('Email feedback storage is not configured.');
  const row = (await store.db.send(new GetCommand({ TableName, Key: { pk: `RECEIPT#ses#${delivery.messageId}` }, ConsistentRead: true }))).Item;
  if (!row) return undefined;
  const operationKey = operationKeyFor(delivery.id);
  if (row.kind !== 'RECEIPT' || row.provider !== 'ses' || row.environment !== 'main' || row.mailKind !== 'report' || row.providerId !== delivery.messageId || row.operationHash !== hash(operationKey)
    || (row.operationKey !== undefined && row.operationKey !== operationKey)
    || (row.recipientHashes !== undefined && (!Array.isArray(row.recipientHashes) || row.recipientHashes.length !== 1 || row.recipientHashes[0] !== hash(delivery.recipient)))) throw new Error('Email feedback does not match this delivery.');
  return { types: [...new Set<string>(row.feedbackEventTypes ?? [])].sort(), observedAt: row.lastFeedbackObservedAt };
}
async function ownerCopy(source: PayrollDelivery, owner: { id: string; email: string }, settings: PayrollSettings) {
  const id = `${source.id}:OWNER_COPY:${hash(owner.id).slice(0, 24)}`;
  const old = await store.get<PayrollDelivery>('PAYROLL_DELIVERY', id);
  if (old && !(old.status === 'FAILED' && old.retryRequested)) {
    if (old.status === 'UNKNOWN') throw new Error('Owner copy acceptance needs review.');
    if (old.status === 'SENDING' && Date.now() - Date.parse(old.updatedAt) > 15 * 60_000) {
      await store.commit([change('PAYROLL_DELIVERY', { ...old, status: 'UNKNOWN', updatedAt: new Date().toISOString(), error: 'Owner copy acceptance needs review.' }, old)], 'payroll-worker');
      throw new Error('Owner copy acceptance needs review.');
    }
    return;
  }
  if (old && old.recipient !== owner.email) throw new Error('Owner address changed; review the original copy before retrying.');
  const cycle = await store.get<PayrollCycle>('PAYROLL_CYCLE', source.cycleId);
  const report = source.reportType === 'PAYROLL' ? await readReport(source.cycleId, source.cycleRevision) : undefined;
  if (source.reportType === 'PAYROLL' && (!report || source.reportHash !== report.contentHash)) throw new Error('Original approved report archive is unavailable.');
  const attachments = report ? await reportFiles(report) : [];
  const subject = old?.subject ?? `DELIVERY FAILURE - ${source.subject}`;
  const text = old?.text ?? `A commission email to ${source.recipient} failed or was rejected. This copy is sent to each active CRM Owner so delivery can be resolved. It is not an additional payment instruction. Check the current cycle and recorded payments before acting.\n\nOriginal cycle ${source.cycleId}, revision ${source.cycleRevision}. Current status when copied: ${cycle?.status ?? 'unavailable'}, revision ${cycle?.revision ?? 'unavailable'}.\n\nOriginal message:\n${source.text}`;
  const at = new Date().toISOString();
  const run: PayrollDelivery = { id, version: (old?.version ?? 0) + 1, cycleId: source.cycleId, cycleRevision: source.cycleRevision, reportType: 'OWNER_COPY', sourceDeliveryId: source.id, ownerId: owner.id, reportId: report?.id, reportHash: report?.contentHash, status: 'SENDING', recipient: owner.email, subject, text, createdAt: old?.createdAt ?? at, updatedAt: at };
  await store.commit([change('PAYROLL_DELIVERY', run, old)], 'payroll-worker', [condition('PAYROLL_SETTINGS', settings), condition('PAYROLL_DELIVERY', source), activeTeamUserCheck(owner.id)]);
  let attempted = false;
  try {
    // Membership is checked again immediately before sending; access removal is
    // also checked transactionally when reserving the delivery above.
    if (!(await payrollOwners()).owners.some(o => o.id === owner.id && o.email === owner.email)) throw new Error('Owner access changed.');
    if (process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER !== 'ses' || !process.env.COMMISSION_PAYROLL_FROM) throw new Error('Payroll sender is unavailable.');
    attempted = true;
    const result = await mail.send(new SendEmailCommand({ FromEmailAddress: process.env.COMMISSION_PAYROLL_FROM, Destination: { ToAddresses: [owner.email] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } }), { idempotencyKey: `commission-payroll:${id}`, subject, text, attachments });
    if (!result.MessageId) throw new Error('Owner copy acceptance is uncertain.');
    await store.commit([change('PAYROLL_DELIVERY', { ...run, status: 'SENT', messageId: result.MessageId, updatedAt: new Date().toISOString() }, run)], 'payroll-worker');
  } catch (error) {
    const uncertain = attempted && !(error instanceof MailDeliveryError && error.state !== 'UNKNOWN');
    await store.commit([change('PAYROLL_DELIVERY', { ...run, status: uncertain ? 'UNKNOWN' : 'FAILED', error: 'Owner copy requires delivery review.', updatedAt: new Date().toISOString() }, run)], 'payroll-worker');
    throw error;
  }
}
/** Process feedback for closed and superseded cycles too; never recursively
 * forward failed Owner copies or resend an accepted original message. */
export async function processPayrollFeedback(settings: PayrollSettings) {
  let failed = false;
  for (let delivery of await store.list<PayrollDelivery>('PAYROLL_DELIVERY')) {
    try {
      // A transport acceptance can survive a worker interruption. Repair only
      // from the existing accepted operation, never by sending it a second time.
      if (['UNKNOWN','SENDING'].includes(delivery.status) && process.env.HOA_TRANSACTIONAL_MAIL_TABLE) {
        const key = operationKeyFor(delivery.id);
        const operation = (await store.db.send(new GetCommand({ TableName: process.env.HOA_TRANSACTIONAL_MAIL_TABLE, Key: { pk: key }, ConsistentRead: true }))).Item;
        if (operation?.state === 'ACCEPTED') {
          if (operation.pk !== key || operation.kind !== 'OPERATION' || operation.provider !== 'ses' || operation.environment !== 'main' || operation.mailKind !== 'report' || typeof operation.providerId !== 'string' || !operation.providerId) throw new Error('Email acceptance binding does not match.');
          const updated: PayrollDelivery = { ...delivery, status: 'SENT', messageId: operation.providerId, error: undefined, failureState: undefined, updatedAt: new Date().toISOString() };
          await store.commit([change('PAYROLL_DELIVERY', updated, delivery)], 'payroll-worker');
          delivery = { ...updated, version: delivery.version + 1 };
        }
      }
      const feedback = await deliveryFeedback(delivery);
      if (feedback && (JSON.stringify(feedback.types) !== JSON.stringify(delivery.feedback ?? []) || feedback.observedAt !== delivery.feedbackObservedAt)) {
        const updated = { ...delivery, feedback: feedback.types, feedbackObservedAt: feedback.observedAt, updatedAt: new Date().toISOString() };
        await store.commit([change('PAYROLL_DELIVERY', updated, delivery)], 'payroll-worker');
        delivery = { ...updated, version: delivery.version + 1 };
      }
      const adverse = delivery.feedback?.some(t => ['Bounce', 'Complaint', 'Reject', 'Rendering Failure'].includes(t)) || ['SUPPRESSED', 'REJECTED'].includes(delivery.failureState ?? '');
      if (!adverse) continue;
      if (delivery.reportType === 'OWNER_COPY') { failed = true; continue; }
      const roster = await payrollOwners();
      if (roster.unreachable || !roster.owners.length) failed = true;
      for (const owner of roster.owners) {
        try { await ownerCopy(delivery, owner, settings); }
        catch { failed = true; }
      }
    } catch { failed = true; }
  }
  if (failed) throw new Error('Commission email feedback or Owner escalation needs review.');
}
