import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { isGroupedInvoice } from '../../../shared/groupedInvoiceGuard';
import { db, getModel, modelTable, versionCheck, type Write } from './broker-fees/store';

export type BillingPolicy = {
  id: string;
  accountId?: unknown;
  billType?: unknown;
  carrierBillType?: unknown;
  groupedDraftInvoiceId?: unknown;
  sourcePricingLoanId?: unknown;
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
export function standalonePolicyBillingGuard(policy: BillingPolicy, checkVersion = false): { ConditionCheck: NonNullable<Write['ConditionCheck']> } {
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

type TrackedLoan = { id: string; policyId?: string | null; accountId: string; status: string };

/** The pointer is authoritative even while the account index is catching up. */
export async function readTrackedPolicyLoan<T extends TrackedLoan>(policy: BillingPolicy): Promise<T | undefined> {
  const loanId = policy.sourcePricingLoanId;
  if (loanId == null) return;
  const tableName = process.env.PF_LOAN_TABLE;
  const loan = typeof loanId === 'string' && loanId && tableName
    ? (await db.send(new GetCommand({ TableName: tableName, Key: { id: loanId }, ConsistentRead: true }))).Item as T | undefined
    : undefined;
  if (!loan || loan.id !== loanId || loan.policyId !== policy.id || loan.accountId !== policy.accountId) {
    throw new GroupedDraftBillingBlocked('The existing policy financing offer could not be verified.');
  }
  return loan;
}

export type PolicyLoanClaim = (loanId: string) => Write;

/** Serialize creation with grouping and keep every newly created live loan discoverable. */
export async function claimStandalonePolicyLoan(policy: BillingPolicy): Promise<PolicyLoanClaim> {
  const prior = await readTrackedPolicyLoan(policy);
  if (prior && prior.status !== 'CANCELLED') {
    throw new GroupedDraftBillingBlocked('This policy already has a financing offer. Resolve it before creating another.');
  }
  const guard = standalonePolicyBillingGuard(policy).ConditionCheck;
  const pointer = prior ? 'sourcePricingLoanId = :priorLoan' : 'attribute_not_exists(sourcePricingLoanId)';
  return loanId => ({ Update: {
    ...guard,
    ConditionExpression: `${guard.ConditionExpression} AND ${pointer}`,
    UpdateExpression: 'SET sourcePricingLoanId = :newLoan',
    ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ...(prior ? { ':priorLoan': prior.id } : {}), ':newLoan': loanId },
  } });
}
