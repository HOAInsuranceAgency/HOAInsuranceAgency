import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { accountModels, db, modelTable } from './broker-fees/store';

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
  if (!matchedIds.size) return;
  const unverified = () => new LegacyPremiumBillingBlocked('The existing premium financing could not be verified. Review this policy before billing.');
  const table = modelTable('PfLoan');
  const current: LegacyLoan[] = [];
  const ids = [...matchedIds];
  for (let offset = 0; offset < ids.length; offset += 100) {
    let pending = ids.slice(offset, offset + 100).map(id => ({ id }));
    for (let attempt = 0; pending.length > 0; attempt++) {
      const result = await db.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending, ConsistentRead: true } } }));
      current.push(...(result.Responses?.[table] ?? []) as LegacyLoan[]);
      pending = (result.UnprocessedKeys?.[table]?.Keys ?? []).map(key => ({ id: String(key.id) }));
      if (pending.length) {
        if (attempt === 4) throw unverified();
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 200)));
      }
    }
  }
  const byId = new Map(current.map(loan => [loan.id, loan]));
  for (const id of matchedIds) {
    const loan = byId.get(id);
    if (!loan || loan.accountId !== accountId) throw unverified();
    if (hasPremiumCommitment(loan)) {
      throw new LegacyPremiumBillingBlocked('This premium is covered by an existing financing agreement or payment in progress. Review the agreement before billing.');
    }
  }
}
