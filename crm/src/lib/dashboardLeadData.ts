import { client, listAllPages, type Account, type Policy, type Quote } from './client';
import { communicationRequest } from './communications';
import { loadAssignments } from './dashboardAssignments';
import type { CommercialData } from './commercial';
import { activeLeadQuotes } from './dashboardLeads';
import { isInLast30Days } from './dashboardPeople';
import { isOpenQuoteStatus } from './quoteStatus';
import { unfinishedSelectedPackage, type DashboardLeadSelection } from '../../../shared/dashboardLeadSelection';

const ACCOUNT_FIELDS = ['id', 'name', 'stage', 'leadSource', 'source', 'createdAt', 'convertedAt', 'currentPolicyExpiration', 'totalInsuredValue', 'city', 'state'] as const;
export type DashboardLeadAccount = Pick<Account, typeof ACCOUNT_FIELDS[number]>;
type DashboardBoundPolicy = Pick<Policy, 'id' | 'accountId' | 'datePolicyBound'>;
export interface LeadsData {
  leads: DashboardLeadAccount[];
  clients: DashboardLeadAccount[];
  quotes: Quote[];
  policies: DashboardBoundPolicy[];
  commercial: CommercialData;
  selections: Record<string, DashboardLeadSelection>;
  asOf: string;
}
export const EMPTY_LEADS_DATA: LeadsData = { leads: [], clients: [], quotes: [], policies: [], commercial: { entries: {}, team: [] }, selections: {}, asOf: '' };

export async function loadDashboardLeadSelections() {
  const selections: Record<string, DashboardLeadSelection> = {}, seen = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await communicationRequest<{ items: DashboardLeadSelection[]; nextToken?: string }>('dashboardLeadPlansPage', { nextToken });
    if (!Array.isArray(page.items) || page.items.some(item => !item || typeof item.accountId !== 'string' || !Array.isArray(item.selectedQuoteIds) || !Array.isArray(item.alternativeQuoteIds) || [...item.selectedQuoteIds, ...item.alternativeQuoteIds].some(id => typeof id !== 'string'))) throw new Error('Selected package details are incomplete. Refresh to try again.');
    for (const selection of page.items) selections[selection.accountId] = selection;
    nextToken = page.nextToken;
    if (nextToken && (typeof nextToken !== 'string' || seen.has(nextToken))) throw new Error('Selected package details could not finish loading. Refresh to try again.');
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return selections;
}

export async function loadLeadsDashboard(): Promise<LeadsData> {
  const asOf = new Date().toISOString(), now = new Date(asOf);
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [leads, clients, quotes, policies, selections] = await Promise.all([
    listAllPages(nextToken => client.models.Account.listAccountByStageAndName({ stage: 'LEAD' }, { nextToken, selectionSet: [...ACCOUNT_FIELDS] })),
    listAllPages(nextToken => client.models.Account.listAccountByStageAndName({ stage: 'CLIENT' }, { nextToken, selectionSet: [...ACCOUNT_FIELDS] })),
    listAllPages(nextToken => client.models.Quote.list({ nextToken })),
    listAllPages(nextToken => client.models.Policy.list({ nextToken, filter: { datePolicyBound: { between: [since, asOf] } }, selectionSet: ['id', 'accountId', 'datePolicyBound'] })),
    loadDashboardLeadSelections(),
  ]);
  const quotesByAccount = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const current = quotesByAccount.get(quote.accountId) ?? [];
    current.push(quote); quotesByAccount.set(quote.accountId, current);
  }
  // Only accounts contributing to a chart need current attribution. Historic
  // clients with fully bound packages do not trigger per-account plan reads.
  const ids = new Set(leads.map(account => account.id));
  for (const quote of activeLeadQuotes(quotes, {}, selections)) if (isOpenQuoteStatus(quote.status)) ids.add(quote.accountId);
  for (const account of clients) if (
    account.convertedAt && isInLast30Days(account.createdAt, now) ||
    unfinishedSelectedPackage(selections[account.id], quotesByAccount.get(account.id) ?? [])
  ) ids.add(account.id);
  for (const policy of policies) if (isInLast30Days(policy.datePolicyBound, now)) ids.add(policy.accountId);
  const commercial = await loadAssignments([...ids]);
  return { leads, clients, quotes, policies, selections, commercial, asOf };
}
