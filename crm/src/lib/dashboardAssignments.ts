import { emptyCommercialPlan } from '../../../shared/quotePackages';
import { communicationRequest, type TeamEligibility } from './communications';
import type { CommercialData, CommercialEntry } from './commercial';

export interface ReportAccount { id: string; name: string; leadSource?: string | null; source?: string | null }
export interface AssignmentData extends CommercialData { accounts: ReportAccount[] }

/** Only request accounts represented in this report, without quote packages.
 * Four bounded requests can run together; one failure rejects the snapshot. */
export async function loadAssignments(ids: string[]): Promise<AssignmentData> {
  const accounts = [...new Set(ids)].sort();
  const roster = await communicationRequest<{ team: TeamEligibility[] }>('team');
  if (!Array.isArray(roster.team)) throw new Error('Could not load teammates');
  const entries: Record<string, CommercialEntry> = {}, reportAccounts: ReportAccount[] = [];
  for (let offset = 0; offset < accounts.length; offset += 2000) {
    const results = await Promise.allSettled(Array.from({ length: Math.ceil(Math.min(2000, accounts.length - offset) / 500) }, async (_, batchIndex) => {
      const batch = accounts.slice(offset + batchIndex * 500, offset + (batchIndex + 1) * 500);
      const result = await communicationRequest<{ items: Omit<CommercialEntry, 'plan'>[]; accounts: ReportAccount[] }>('dashboardAssignments', { accountIds: batch });
      if (!Array.isArray(result.items) || result.items.length !== batch.length || batch.some(id => !result.items.some(item => item.accountId === id)) || !Array.isArray(result.accounts)) {
        throw new Error('Report assignments are incomplete. Refresh to try again.');
      }
      return result;
    }));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      for (const item of result.value.items) entries[item.accountId] = { ...item, plan: emptyCommercialPlan(item.accountId) };
      reportAccounts.push(...result.value.accounts);
    }
  }
  return { entries, team: roster.team, accounts: reportAccounts };
}
