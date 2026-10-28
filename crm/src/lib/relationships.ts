import { client, listAllPages, currentActor } from './client';
import { communicationRequest } from './communications';
import type {
  PartyRecord,
  AccountRelationshipRecord,
  AffiliationRecord,
} from '../../../shared/relationships';
export type { PartyRecord, AccountRelationshipRecord, AffiliationRecord };
export async function loadParties(): Promise<PartyRecord[]> {
  return (await listAllPages((token) => client.models.Party.list({ nextToken: token }))) as PartyRecord[];
}
export async function loadAccountRelationships(accountId: string) {
  return communicationRequest<{
    relationships: AccountRelationshipRecord[];
    version: number;
    selfManagedFrom?: string;
  }>('relationshipContext', { accountId });
}
export async function loadPartyProfile(id: string) {
  const [party, links, asPerson, asOrganization, actor] = await Promise.all([
    client.models.Party.get({ id }),
    listAllPages((nextToken) =>
      client.models.AccountRelationship.listAccountRelationshipByPartyId({ partyId: id }, { nextToken }),
    ),
    listAllPages((nextToken) =>
      client.models.PartyAffiliation.listPartyAffiliationByPersonId({ personId: id }, { nextToken }),
    ),
    listAllPages((nextToken) =>
      client.models.PartyAffiliation.listPartyAffiliationByOrganizationId(
        { organizationId: id },
        { nextToken },
      ),
    ),
    currentActor(),
  ]);
  if (party.errors?.length || !party.data) throw new Error('Could not load this relationship.');
  // Account reads are authorized independently, even after a portfolio index read.
  const accounts = await Promise.all(
    [...new Set(links.map((l) => l.accountId))].map(async (accountId) => {
      const result = await client.models.Account.get({ id: accountId });
      if (result.errors?.length) throw new Error('Account access changed. Refresh the profile.');
      return result.data;
    }),
  );
  const names = new Map(accounts.filter((a) => a != null).map((a) => [a!.id, a!]));
  return {
    party: party.data as PartyRecord,
    links: (links as AccountRelationshipRecord[]).filter((l) => names.has(l.accountId)),
    accounts: names,
    affiliations: [...asPerson, ...asOrganization] as AffiliationRecord[],
    actor,
  };
}
