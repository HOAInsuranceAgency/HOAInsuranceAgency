import type { CommissionPolicy } from '../../../../shared/commissions';
import { receiptEarningId, type CommissionEarning, type CommissionAdjustment } from '../../../../shared/commissionExceptions';
import * as store from './store';

/** Read exact immutable receipt identities from the authoritative policy snapshot.
 * No eventually consistent index or unrelated agency-wide earnings history.
 * Policy version conditions on posting protect the snapshot from concurrent receipts.
 */
export async function policyReceiptEarnings(policies: CommissionPolicy[]): Promise<CommissionEarning[]> {
  const result: CommissionEarning[] = [];
  for (const policy of new Map(policies.map(p => [p.id, p])).values()) {
    const refs = policy.entries.flatMap(entry => {
      if (!entry.allocationId) return [];
      const allocation = policy.allocations?.find(a => a.id === entry.allocationId);
      if (!allocation) throw new Error('The receipt’s approved shared allocation is missing.');
      return allocation.participants.map(p => ({kind:'EARNING', id:receiptEarningId(policy.id, entry.id, p.producerId)}));
    });
    if (!refs.length) continue;
    const records = await store.getMany<CommissionEarning>(refs);
    const found = new Set(records.map(e => e.id));
    if (refs.some(ref => !found.has(ref.id))) throw new Error('The policy’s shared earnings history is incomplete. Review it before posting.');
    result.push(...records);
  }
  return result;
}

/** Complete financial snapshot assembled from bounded policy histories and approved
 * adjustment identities. Never scan the agency-wide EARNING partition. Display
 * pagination must not truncate this snapshot or change payroll/ledger totals.
 */
export async function workspaceEarnings(policies?: CommissionPolicy[], adjustments?: CommissionAdjustment[]) {
  const sources = policies ?? await store.list<CommissionPolicy>('POLICY');
  const corrections = adjustments ?? await store.list<CommissionAdjustment>('ADJUSTMENT');
  const receipts = await policyReceiptEarnings(sources);
  const refs = corrections.filter(a => a.status === 'APPROVED').map(a => ({kind:'EARNING', id:'adjustment:' + a.id}));
  const earnings = refs.length ? await store.getMany<CommissionEarning>(refs) : [];
  const found = new Set(earnings.map(e => e.id));
  if (refs.some(ref => !found.has(ref.id))) throw new Error('Approved compensation earnings are incomplete. Refresh before proceeding.');
  return [...receipts, ...earnings];
}
