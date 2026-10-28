/** Local fictional fixtures. No AWS, customer messages, or persistent mutations. */
export { listAllPages } from '../../src/lib/pagination';
export const currentActor = async () => 'alice';
export const useIsAdmin = () => true;
export const friendlyError = (e: unknown) => e instanceof Error ? e.message : 'Please try again.';
export const fmtDate = (v?: string | null) => v ? v.slice(0, 10) : '—';
const parties: any[] = [
  { id: 'apex', kind: 'ORGANIZATION', name: 'Apex Community Management', category: 'Property management', email: 'hello@apex.example.test', phone: '(617) 555-0100', ownerId: 'alice', revision: 1, notes: 'Regional property manager. Alex coordinates insurance renewals.' },
  { id: 'new', kind: 'ORGANIZATION', name: 'Harbor Property Group', category: 'Property management', email: 'service@harbor.example.test', ownerId: 'alice', revision: 1 },
  { id: 'alex', kind: 'PERSON', name: 'Alex Taylor', category: 'Property management', email: 'alex@apex.example.test', ownerId: 'alice', revision: 1 },
  { id: 'jordan', kind: 'PERSON', name: 'Jordan Ellis', category: 'Landlord', email: 'jordan@example.test', ownerId: 'alice', revision: 1 },
];
const accounts = [{ id: 'willow', name: 'Willow Court Condominium', stage: 'CLIENT' }];
const links: any[] = [{ id: 'first', accountId: 'willow', partyId: 'apex', role: 'MANAGER', validFrom: '2024-01-01', revision: 1, contactIds: ['old'] }, { id: 'referrer', accountId: 'willow', partyId: 'jordan', role: 'REFERRER', revision: 1 }];
const contacts: any[] = [{ id: 'old', accountId: 'willow', name: 'Alex Taylor', email: 'alex@apex.example.test', partyId: 'alex', relationshipId: 'first', isPrimary: true, validFrom: '2024-01-01' }, { id: 'board', accountId: 'willow', name: 'Riley Chen (board president)', email: 'riley@example.test' }];
const affiliations: any[] = [{ id: 'employment', personId: 'alex', organizationId: 'apex', title: 'Property manager', validFrom: '2024-01-01', revision: 1 }];
const data = (rows: any[]) => ({ data: structuredClone(rows) });
export const client = { models: {
  Party: { list: async () => data(parties), get: async ({ id }: any) => ({ data: parties.find(p => p.id === id) }) },
  Account: { list: async () => data(accounts), get: async ({ id }: any) => ({ data: accounts.find(p => p.id === id) }) },
  Contact: { list: async () => data(contacts) },
  AccountRelationship: { listAccountRelationshipByPartyId: async ({ partyId }: any) => data(links.filter(l => l.partyId === partyId)) },
  PartyAffiliation: {
    listPartyAffiliationByPersonId: async ({ personId }: any) => data(affiliations.filter(a => a.personId === personId)),
    listPartyAffiliationByOrganizationId: async ({ organizationId }: any) => data(affiliations.filter(a => a.organizationId === organizationId)),
  },
} };
let version = 1;
let selfManagedFrom: string | undefined;
export async function communicationRequest(op: string, input: any = {}) {
  if (op === 'relationshipSearch') return { items: parties.filter(p => (input.archived || !p.archived) && (!input.kind || p.kind === input.kind) && [p.name, p.email, p.phone, p.category].some(v => v?.toLowerCase().includes((input.query || '').toLowerCase()))) };
  if (op === 'relationshipProfiles') return { items: parties.filter(p => input.ids.includes(p.id)) };
  if (op === 'relationshipPortfolio') return { items: links.filter(l => l.partyId === input.partyId).map(relationship => ({ id: relationship.id, relationship, account: accounts.find(a => a.id === relationship.accountId) })) };
  if (op === 'relationshipAffiliations') return { items: affiliations.filter(a => a.personId === input.partyId || a.organizationId === input.partyId).map(a => ({ ...a, relatedName: parties.find(p => p.id === (a.personId === input.partyId ? a.organizationId : a.personId))?.name })) };
  if (op === 'relationshipLegacyCandidates') return { items: [] };
  if (op === 'searchAccounts') return { items: accounts.filter(a => a.name.toLowerCase().includes(input.query.toLowerCase())) };
  if (op === 'team') return { team: [{ userId: 'alice', name: 'Avery Brooks', available: true }] };
  if (op === 'relationshipContext') return { relationships: structuredClone(links), version, selfManagedFrom };
  if (op === 'relationshipSaveParty') { const party = { ...input, id: input.id || crypto.randomUUID(), ownerId: 'alice', revision: input.revision + 1 }; const index = parties.findIndex(p => p.id === party.id); if (index < 0) parties.push(party); else parties[index] = party; return { party }; }
  if (op === 'relationshipChangeManagement') {
    if (input.version !== version) throw new Error('Refresh before saving.');
    for (const link of links.filter(l => l.role === 'MANAGER' && !l.validUntil)) link.validUntil = input.effectiveOn;
    for (const contact of contacts.filter(c => c.relationshipId || input.retireContactIds?.includes(c.id))) contact.validUntil = input.effectiveOn;
    if (input.partyId) links.push({ id: crypto.randomUUID(), accountId: 'willow', partyId: input.partyId, role: 'MANAGER', validFrom: input.effectiveOn, revision: 1 });
    selfManagedFrom = input.partyId ? undefined : input.effectiveOn;
    return { version: ++version };
  }
  if (op === 'relationshipLink') { const relationship = { ...input, id: crypto.randomUUID(), revision: 1 }; links.push(relationship); return { relationship }; }
  throw new Error('This action is outside the local preview.');
}
