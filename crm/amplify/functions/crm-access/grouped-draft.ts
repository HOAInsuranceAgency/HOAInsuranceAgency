import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { db, modelTable, type Write } from '../broker-fees/store';
import { sendCrmWrite } from '../live-write';
import { assertTransactionEnvelope } from '../storage/transactions';
import type { AccountAccess } from './access';
import { id, type RecordData as Row } from './policy';
import { activeTeamUserCheck } from './user-status';

const MAX_MEMBERS = 8;
const retry = 'The source records changed during restoration. Refresh and review the drafts.';
const hasDelivery = (row: Row) => ['sentAt', 'paidAt', 'paymentUrl', 'stripePaymentLinkId', 'stripePaymentIntentId',
  'stripeLinkAmountCents', 'invoiceSendOperation', 'brokerFeeAllocations', 'brokerFeeFinanceUrl', 'groupedFinanceLoanId']
  .some(key => row[key] != null && row[key] !== '');
const usableId = (value: unknown) => { const key = id(value); if (!key) throw new Error(retry); return key; };
function versionCondition(row: Row) {
  if (typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error(retry);
  return { Key: { id: usableId(row.id) }, ConditionExpression: 'updatedAt = :old', ExpressionAttributeValues: { ':old': row.updatedAt } };
}

async function saveReview(writes: Write[]) {
  assertTransactionEnvelope(writes, { maxBytes: 3_500_000, keyFields: () => ['id'], error: () => new Error('Too many source records to restore at once.') });
  try { await sendCrmWrite(db.send(new TransactWriteCommand({ TransactItems: writes }))); }
  catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') throw new Error(retry);
    throw error;
  }
}

/** Undo a review without deleting any policy or invoice history. */
export async function restoreGroupedDraft(access: AccountAccess, args: Row) {
  const invoiceId = usableId(args.invoiceId);
  const invoice = await access.requireRecord('Invoice', invoiceId);
  const policyIds = Array.isArray(invoice.groupedPolicyIds) ? invoice.groupedPolicyIds.map(usableId) : [];
  const sourceIds = Array.isArray(invoice.groupedSourceInvoiceIds) ? invoice.groupedSourceInvoiceIds.map(usableId) : null;
  if (invoice.sourcePricingVersion !== 3 || hasDelivery(invoice) || policyIds.length < 2 || policyIds.length > MAX_MEMBERS ||
      new Set(policyIds).size !== policyIds.length || !sourceIds || sourceIds.length > policyIds.length || new Set(sourceIds).size !== sourceIds.length || sourceIds.includes(invoiceId)) {
    throw new Error('Only a complete, unsent grouped review can be restored.');
  }
  if (invoice.status === 'VOID' && invoice.groupedRestoredAt) return { ok: true };
  if (invoice.status !== 'DRAFT') throw new Error('Only a grouped draft can be restored.');
  const accountId = usableId(invoice.accountId);
  const [policies, sources] = await Promise.all([
    Promise.all(policyIds.map(key => access.requireRecord('Policy', key))),
    Promise.all(sourceIds.map(key => access.requireRecord('Invoice', key))),
  ]);
  if (policies.some(policy => policy.accountId !== accountId || policy.groupedDraftInvoiceId !== invoiceId) ||
      sources.some(source => source.accountId !== accountId || !policyIds.includes(id(source.policyId)) ||
        source.sourcePricingVersion !== 1 || source.status !== 'VOID' || source.supersededByGroupedInvoiceId !== invoiceId || hasDelivery(source))) {
    throw new Error('The separate drafts no longer match this grouped review.');
  }
  const now = new Date().toISOString();
  const guard = versionCondition(invoice);
  const writes: Write[] = [activeTeamUserCheck(access.actor), { Update: { TableName: modelTable('Invoice'), ...guard,
    ConditionExpression: `${guard.ConditionExpression} AND #status = :draft AND attribute_not_exists(invoiceSendOperation) AND attribute_not_exists(groupedFinanceLoanId)`,
    UpdateExpression: 'SET #status = :void, groupedRestoredAt = :now, updatedAt = :now, lastWriteBy = :actor',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ':draft': 'DRAFT', ':void': 'VOID', ':now': now, ':actor': access.actor },
  } }];
  for (const source of sources) {
    const version = versionCondition(source);
    writes.push({ Update: { TableName: modelTable('Invoice'), ...version,
      ConditionExpression: `${version.ConditionExpression} AND #status = :void AND supersededByGroupedInvoiceId = :group`,
      UpdateExpression: 'SET #status = :draft, updatedAt = :now, lastWriteBy = :actor REMOVE supersededByGroupedInvoiceId',
      ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ...version.ExpressionAttributeValues,
        ':void': 'VOID', ':group': invoiceId, ':draft': 'DRAFT', ':now': now, ':actor': access.actor },
    } });
  }
  for (const policy of policies) {
    const version = versionCondition(policy);
    writes.push({ Update: { TableName: modelTable('Policy'), ...version,
      ConditionExpression: `${version.ConditionExpression} AND groupedDraftInvoiceId = :group`,
      UpdateExpression: 'SET updatedAt = :now, lastWriteBy = :actor REMOVE groupedDraftInvoiceId',
      ExpressionAttributeValues: { ...version.ExpressionAttributeValues, ':group': invoiceId, ':now': now, ':actor': access.actor },
    } });
  }
  await saveReview(writes);
  return { ok: true };
}
