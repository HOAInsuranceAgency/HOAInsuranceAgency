import { accountModels, getModel } from './broker-fees/store';

export class LegacyPremiumBillingBlocked extends Error {}

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
      throw new LegacyPremiumBillingBlocked('The existing premium financing could not be verified. Review this policy before billing.');
    }
    if (hasPremiumCommitment(loan)) {
      throw new LegacyPremiumBillingBlocked('This premium is covered by an existing financing agreement or payment in progress. Review the agreement before billing.');
    }
  }
}
