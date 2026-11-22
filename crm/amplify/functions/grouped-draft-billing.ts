import { isGroupedInvoice } from '../../../shared/groupedInvoiceGuard';
import { accountModels, getModel, modelTable, versionCheck, type Write } from './broker-fees/store';

export type BillingPolicy = {
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
    throw new GroupedDraftBillingBlocked('This carrier-direct policy cannot be billed as an agency premium invoice.');
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

type LegacyLoan = Record<string, unknown> & { id: string };

function hasPremiumCommitment(loan: LegacyLoan): boolean {
  if (loan.status !== 'QUOTED' && loan.status !== 'CANCELLED') return true;
  if (loan.downPaymentIntentId || loan.downPaidAt || loan.activatedAt || loan.cancellationEffectiveAt ||
      loan.expectedCarrierRefundAt || Number(loan.paidThrough) > 0) return true;
  if (loan.status === 'CANCELLED') return false;
  if (loan.agreementSignedAt || loan.electedAt) return true;
  const expires = Date.parse(String(loan.electionCheckoutExpiresAt ?? ''));
  return !!loan.electionCheckoutUrl && (!Number.isFinite(expires) || expires > Date.now());
}

/** A financed premium can span multiple policies or still be attached to its pre-bind quote. */
export async function assertPremiumNotFinanced(accountId: string, policyIds: string[], quoteId: string | null | undefined, sourceLoanId?: unknown) {
  const policies = new Set(policyIds);
  const loans = await accountModels<LegacyLoan>('PfLoan', accountId);
  const matchedIds = new Set(loans.filter(loan =>
    policies.has(String(loan.policyId)) || !!quoteId && loan.quoteId === quoteId ||
    Array.isArray(loan.groupedPolicyIds) && loan.groupedPolicyIds.some(id => policies.has(id))
  ).map(loan => loan.id));
  if (typeof sourceLoanId === 'string' && sourceLoanId) matchedIds.add(sourceLoanId);
  for (const id of matchedIds) {
    const loan = await getModel<LegacyLoan>('PfLoan', id);
    if (!loan || loan.accountId !== accountId) {
      throw new GroupedDraftBillingBlocked('The existing premium financing could not be verified. Review this policy before billing.');
    }
    if (hasPremiumCommitment(loan)) {
      throw new GroupedDraftBillingBlocked('This premium is covered by an existing financing agreement or payment in progress. Review the agreement before billing.');
    }
  }
}
