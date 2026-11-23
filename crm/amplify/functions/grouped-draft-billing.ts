import { batchGetComplete } from './storage/batchGet';
import { assertHoaCollection } from './ipfs-invoice';
import { isGroupedInvoice } from '../../../shared/groupedInvoiceGuard';
import { accountModels, db, getModel, modelTable, versionCheck, type Write } from './broker-fees/store';

export type BillingPolicy = {
  id: string;
  accountId?: unknown;
  billType?: unknown;
  carrierBillType?: unknown;
  ipfsAmountFinanced?: unknown;
  carrierBillToAgency?: unknown;
  groupedDraftInvoiceId?: unknown;
  updatedAt?: unknown;
};

export class GroupedDraftBillingBlocked extends Error {}

/** Review drafts reserve their policy terms without creating a receivable. */
export async function assertStandalonePolicyBilling(policy: BillingPolicy): Promise<void> {
  assertHoaCollection(policy);
  if (policy.carrierBillType === 'DIRECT' && policy.billType === 'AGENCY' && policy.carrierBillToAgency !== true) {
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
      '(NOT (carrierBillType = :direct AND billType = :agency) OR carrierBillToAgency = :yes)',
      '(attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil)',
      version?.ConditionExpression,
    ].filter(Boolean).join(' AND '),
    ...(version?.ExpressionAttributeNames ? { ExpressionAttributeNames: version.ExpressionAttributeNames } : {}),
    ExpressionAttributeValues: { ...version?.ExpressionAttributeValues, ':draft': policy.groupedDraftInvoiceId ?? null, ':direct': 'DIRECT', ':agency': 'AGENCY', ':yes': true, ':nil': null },
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
  if (!matchedIds.size) return;
  const unverified = () => new GroupedDraftBillingBlocked('The existing premium financing could not be verified. Review this policy before billing.');
  const current = await batchGetComplete<LegacyLoan>({
    send: command => db.send(command), table: modelTable('PfLoan'), keys: [...matchedIds].map(id => ({ id })),
    // Account discovery allows 5,000 rows plus one explicit source outside the index results.
    maxKeys: 5001, attempts: 5, read: { ConsistentRead: true }, sizeError: unverified, incompleteError: unverified,
  });
  const byId = new Map(current.map(loan => [loan.id, loan]));
  for (const id of matchedIds) {
    const loan = byId.get(id);
    if (!loan || loan.accountId !== accountId) throw unverified();
    if (hasPremiumCommitment(loan)) {
      throw new GroupedDraftBillingBlocked('This premium is covered by an existing financing agreement or payment in progress. Review the agreement before billing.');
    }
  }
}
