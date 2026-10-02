import { useAsyncResource } from './useAsyncResource';
import { communicationRequest, type TeamEligibility } from './communications';
import type { CommercialPlan } from '../../../shared/quotePackages';
import type { LeadWorkflow } from '../../../shared/leadWorkflow';
import type { LeadSnooze } from '../../../shared/leadSnooze';
export interface CommercialEntry {
  accountId: string;
  plan: CommercialPlan;
  salespersonId?: string;
  snooze?: LeadSnooze;
  /** Optimistic-lock version for assignment edits; zero means no workflow yet. */
  workflowVersion?: number;
  disposition?: LeadWorkflow['disposition'];
}
export interface CommercialData {
  entries: Record<string, CommercialEntry>;
  team: TeamEligibility[];
}
/** Load attribution alongside report data so a failed assignment read cannot
 * silently turn an entire report into "Unassigned". */
export async function loadCommercial(ids: string[], snoozeAccountIds: string[] = []): Promise<CommercialData> {
  const accounts = [...new Set(ids)].sort();
  const snoozeIds = new Set(snoozeAccountIds);
  if (!accounts.length) return { entries: {}, team: [] };
  const roster = await communicationRequest<{ team: TeamEligibility[] }>('team', {});
  if (!Array.isArray(roster.team)) throw new Error('Could not load teammates');
  const entries: Record<string, CommercialEntry> = {};
  for (let i = 0; i < accounts.length; i += 25) {
    const batch = accounts.slice(i, i + 25);
    const followUps = batch.filter(id => snoozeIds.has(id));
    const result = await communicationRequest<{ items: CommercialEntry[] }>(
      'commercialTable', { accountIds: batch, ...(followUps.length ? { snoozeAccountIds: followUps } : {}) },
    );
    if (!Array.isArray(result.items) || result.items.length !== batch.length ||
      batch.some(id => !result.items.some(item => item.accountId === id))) {
      throw new Error('Account details are incomplete. Refresh to try again.');
    }
    for (const entry of result.items) entries[entry.accountId] = entry;
  }
  return { entries, team: roster.team };
}
export function useCommercial(ids: string[], revision?: unknown, snoozeAccountIds: string[] = []) {
  const key = [...new Set(ids)].sort().join(',');
  const snoozeKey = [...new Set(snoozeAccountIds)].sort().join(',');
  return useAsyncResource(
    () => loadCommercial(key ? key.split(',') : [], snoozeKey ? snoozeKey.split(',') : []),
    [key, revision, snoozeKey],
    {
      initialData: {
        entries: {} as Record<string, CommercialEntry>,
        team: [] as TeamEligibility[],
      },
      errorMessage: 'Could not load assignments and commission estimates',
    },
  );
}
export const teammateName = (
  id: string | undefined,
  team: TeamEligibility[],
) =>
  id
    ? (team.find((t) => t.userId === id)?.name ?? 'Unavailable teammate')
    : 'Unassigned';
