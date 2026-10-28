import { client, currentActor } from './client';
import { communicationRequest } from './communications';
import type { Page } from './usePagedList';
import type {
  PartyRecord,
  AccountRelationshipRecord,
  AffiliationRecord,
} from '../../../shared/relationships';
export type { PartyRecord, AccountRelationshipRecord, AffiliationRecord };
export const searchParties = (
  query = '',
  options: { kind?: string; archived?: boolean } = {},
  nextToken?: string,
) => communicationRequest<Page<PartyRecord>>('relationshipSearch', { query, ...options, nextToken });
export async function loadPartyIds(ids: string[]): Promise<PartyRecord[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  if (unique.length > 100) throw new Error('Load fewer profiles at a time.');
  return (await communicationRequest<Page<PartyRecord>>('relationshipProfiles', { ids: unique })).items;
}
export async function loadAccountRelationships(accountId: string, nextToken?: string) {
  return communicationRequest<{
    relationships: AccountRelationshipRecord[];
    version: number;
    selfManagedFrom?: string;
    nextToken?: string;
  }>('relationshipContext', { accountId, nextToken });
}
export async function loadPartyProfile(id: string) {
  const [party, actor] = await Promise.all([client.models.Party.get({ id }), currentActor()]);
  if (party.errors?.length || !party.data) throw new Error('Could not load this relationship.');
  return { party: party.data as PartyRecord, actor };
}
export interface PortfolioItem {
  id: string;
  relationship: AccountRelationshipRecord;
  account: { id: string; name: string; stage: string };
}
export const loadPortfolio = (partyId: string, nextToken?: string) =>
  communicationRequest<Page<PortfolioItem>>('relationshipPortfolio', { partyId, nextToken });
export const loadAffiliations = (partyId: string, nextToken?: string) =>
  communicationRequest<Page<AffiliationRecord & { relatedName: string }>>('relationshipAffiliations', {
    partyId,
    nextToken,
  });
