import { useAsyncResource } from './useAsyncResource';
import { communicationRequest, type TeamEligibility } from './communications';
import type { CommercialPlan } from '../../../shared/quotePackages';
export interface CommercialEntry {
  accountId: string;
  plan: CommercialPlan;
  salespersonId?: string;
}
export function useCommercial(ids: string[], revision?: unknown) {
  const key = [...new Set(ids)].sort().join(',');
  return useAsyncResource(
    async () => {
      if (!key)
        return {
          entries: {} as Record<string, CommercialEntry>,
          team: [] as TeamEligibility[],
        };
      const team = await communicationRequest<{ team: TeamEligibility[] }>(
        'team',
        {},
      );
      if (!Array.isArray(team.team))
        throw new Error('Could not load teammates');
      const entries: Record<string, CommercialEntry> = {},
        accounts = key.split(',');
      for (let i = 0; i < accounts.length; i += 25) {
        const batch = accounts.slice(i, i + 25),
          result = await communicationRequest<{ items: CommercialEntry[] }>(
            'commercialTable',
            { accountIds: batch },
          );
        if (
          result.items.length !== batch.length ||
          batch.some(
            (id) => !result.items.some((item) => item.accountId === id),
          )
        )
          throw new Error(
            'Account details are incomplete. Refresh to try again.',
          );
        for (const entry of result.items) entries[entry.accountId] = entry;
      }
      return { entries, team: team.team };
    },
    [key, revision],
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
