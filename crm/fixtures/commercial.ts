import { account, carrier, contact, policy, quote } from './builders';
import { emptyCommercialPlan, packageTerms, type CommercialPlan } from '../../shared/quotePackages';
import type { TeamEligibility } from '../../shared/leadWorkflow';
import type { Quote } from '../src/lib/client';

export function reviewedCommercialOption(id: string, quoteIds: string[], quotes: Quote[]) {
  return { id, name: id === 'bundle' ? 'One bundled policy' : 'Separate property and D&O', quoteIds: [...quoteIds],
    reviewed: { at: '2026-09-14T13:00:00Z', by: 'champ', terms: Object.fromEntries(quoteIds.map(id => {
      const source = quotes.find(row => row.id === id);
      if (!source) throw new Error(`Missing fictional quote: ${id}`);
      return [id, packageTerms(source)];
    })) } };
}

/** Each caller owns all nested records. No module state, URL, clock or auth. */
export function createCommercialScenario() {
  const accounts = [
    account({ id: 'willow', name: 'Willow Court Condominium', city: 'Boston', state: 'MA', source: 'website-quote', leadSource: 'GOOGLE_AD_WEBSITE', createdAt: '2026-09-01T13:00:00Z', currentPolicyExpiration: '2026-10-01', unitCount: 24, totalInsuredValue: 4_000_000 }),
    account({ id: 'pine', name: 'Pine Grove Association', city: 'Providence', state: 'RI', source: 'website-ho6:pine', leadSource: 'ORGANIC_WEBSITE', createdAt: '2026-09-04T13:00:00Z', currentPolicyExpiration: '2026-11-01', unitCount: 12 }),
    account({ id: 'cedar', name: 'Cedar House — partially bound', stage: 'CLIENT', city: 'Worcester', state: 'MA', source: 'website-contact', leadSource: 'ORGANIC_WEBSITE', createdAt: '2026-08-01T13:00:00Z', currentPolicyExpiration: '2026-10-01', unitCount: 18 }),
  ];
  const priced = (accountId: string, id: string, lines: string[], premium: number, bound = false) => quote({
    id, accountId, carrierId: id, lines, premium, status: bound ? 'BOUND' : 'QUOTED', commissionPct: 10,
    effectiveDate: '2026-10-01', expirationDate: '2027-10-01', offerExpiresAt: '2026-09-30',
  });
  const quotes = [priced('willow', 'bundle', ['Property', 'D&O'], 15_000), priced('willow', 'property', ['Property'], 11_000),
    priced('willow', 'do', ['D&O'], 2_500), priced('cedar', 'cedar-property', ['Property'], 11_000, true), priced('cedar', 'cedar-do', ['D&O'], 2_500)];
  const names = ['Harbor Mutual', 'Pine Insurance', 'Summit Specialty', 'Cedar Mutual', 'Cedar Specialty'];
  const carriers = quotes.map((row, index) => carrier({ id: row.id, name: names[index] }));
  const option = (id: string, quoteIds: string[]) => reviewedCommercialOption(id, quoteIds, quotes);
  const plans: Record<string, CommercialPlan> = {
    willow: { ...emptyCommercialPlan('willow'), version: 1, estimatedCents: 180_000, requiredLines: ['Property', 'D&O'], options: [option('bundle', ['bundle']), option('separate', ['property', 'do'])] },
    pine: emptyCommercialPlan('pine'),
    cedar: { ...emptyCommercialPlan('cedar'), version: 1, estimatedCents: 160_000, requiredLines: ['Property', 'D&O'], options: [option('cedar', ['cedar-property', 'cedar-do'])], selectedOptionId: 'cedar', selectedTerms: option('cedar', ['cedar-property', 'cedar-do']).reviewed.terms },
  };
  const contacts = accounts.map(row => contact({ id: `contact-${row.id}`, accountId: row.id, name: 'Jane Smith', email: 'jane@example.test', isPrimary: true }));
  const policies = [policy({ id: 'cedar-policy', accountId: 'cedar', expirationDate: '2027-10-01' })];
  const team: TeamEligibility[] = [
    { userId: 'sales', name: 'Avery Brooks', email: 'avery@example.test', salesperson: true, enabled: true, available: true, version: 0 },
    { userId: 'champ', name: 'Morgan Lane', email: 'morgan@example.test', salesperson: false, enabled: true, version: 0 },
  ];
  return { accounts, quotes, carriers, contacts, policies, plans, team };
}
