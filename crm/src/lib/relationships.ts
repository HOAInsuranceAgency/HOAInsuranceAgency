import { assertGraphqlErrors } from './apiResponse';
import { client, currentActor } from './client';
import { communicationRequest } from './communications';
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
) => communicationRequest('relationshipSearch', { query, ...options, nextToken });
export async function loadPartyIds(ids: string[]): Promise<PartyRecord[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  if (unique.length > 100) throw new Error('Load fewer profiles at a time.');
  return (await communicationRequest('relationshipProfiles', { ids: unique })).items;
}
export async function loadAccountRelationships(accountId: string, nextToken?: string) {
  return communicationRequest('relationshipContext', { accountId, nextToken });
}
export async function loadPartyProfile(id: string) {
  const [party, actor] = await Promise.all([client.models.Party.get({ id }), currentActor()]);
  assertGraphqlErrors(party);
  if (!party.data) throw new Error('Could not load this relationship.');
  return { party: party.data as PartyRecord, actor };
}
export interface PortfolioItem {
  id: string;
  relationship: AccountRelationshipRecord;
  account: { id: string; name: string; stage: string };
}
export const loadPortfolio = (partyId: string, nextToken?: string) =>
  communicationRequest('relationshipPortfolio', { partyId, nextToken });
export const loadAffiliations = (partyId: string, nextToken?: string) =>
  communicationRequest('relationshipAffiliations', {
    partyId,
    nextToken,
  });
