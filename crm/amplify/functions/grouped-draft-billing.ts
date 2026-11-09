import { isGroupedInvoice } from '../../../shared/groupedInvoiceGuard';
import { getModel, modelTable, versionCheck, type Write } from './broker-fees/store';

type BillingPolicy = {
  id: string;
  accountId?: unknown;
  billType?: unknown;
  carrierBillType?: unknown;
  groupedDraftInvoiceId?: unknown;
  updatedAt?: unknown;
};

export class GroupedDraftBillingBlocked extends Error {}

/** Review drafts reserve their policy terms without creating a receivable. */
export async function assertStandalonePolicyBilling(policy: BillingPolicy): Promise<void> {
  if (policy.carrierBillType === 'DIRECT' && policy.billType === 'AGENCY') {
    throw new GroupedDraftBillingBlocked('An agency-collected direct-bill advance requires grouped invoice review.');
  }
  const draftId = policy.groupedDraftInvoiceId;
  if (draftId == null) return;
  const draft = typeof draftId === 'string' && draftId ? await getModel('Invoice', draftId) : undefined;
  if (!draft || !isGroupedInvoice(draft) || draft.accountId !== policy.accountId ||
      !Array.isArray(draft.groupedPolicyIds) || !draft.groupedPolicyIds.includes(policy.id)) {
    throw new GroupedDraftBillingBlocked('The grouped invoice for this policy could not be verified.');
  }
  if (draft.status !== 'VOID') {
    throw new GroupedDraftBillingBlocked('This policy is reserved by a grouped invoice for review.');
  }
}

/** Fence a draft reservation or billing change after the standalone read. */
export function standalonePolicyBillingGuard(policy: BillingPolicy, checkVersion = false): Write {
  const tableName = modelTable('Policy');
  const version = checkVersion ? versionCheck(tableName, policy).ConditionCheck : undefined;
  const noDraft = policy.groupedDraftInvoiceId == null;
  const draftCondition = noDraft ? '(attribute_not_exists(groupedDraftInvoiceId) OR groupedDraftInvoiceId = :draft)' : 'groupedDraftInvoiceId = :draft';
  return { ConditionCheck: {
    TableName: tableName,
    Key: { id: policy.id },
    ConditionExpression: [
      'attribute_exists(id)',
      draftCondition,
      'NOT (carrierBillType = :direct AND billType = :agency)',
      version?.ConditionExpression,
    ].filter(Boolean).join(' AND '),
    ...(version?.ExpressionAttributeNames ? { ExpressionAttributeNames: version.ExpressionAttributeNames } : {}),
    ExpressionAttributeValues: { ...version?.ExpressionAttributeValues, ':draft': policy.groupedDraftInvoiceId ?? null, ':direct': 'DIRECT', ':agency': 'AGENCY' },
  } };
}
