import { client, listAllPages, type Account, type Policy, type Quote } from './client';
import { communicationRequest } from './communications';
import { loadAssignments } from './dashboardAssignments';
import type { CommercialData } from './commercial';
import { activeLeadQuotes } from './dashboardLeads';
import { isInLast30Days } from './dashboardPeople';
import { isOpenQuoteStatus, OPEN_QUOTE_STATUSES } from './quoteStatus';
import { unfinishedSelectedPackage, type DashboardLeadSelection } from '../../../shared/dashboardLeadSelection';

const ACCOUNT_FIELDS = ['id', 'name', 'stage', 'leadSource', 'source', 'createdAt', 'convertedAt', 'currentPolicyExpiration', 'totalInsuredValue', 'city', 'state'] as const;
export type DashboardLeadAccount = Pick<Account, typeof ACCOUNT_FIELDS[number]>;
type DashboardBoundPolicy = Pick<Policy, 'id' | 'accountId' | 'datePolicyBound'>;
export type CompactQuote = Pick<Quote, 'id' | 'accountId' | 'status'>;
export interface LeadsData {
  leads: DashboardLeadAccount[];
  clients: DashboardLeadAccount[];
  quotes: CompactQuote[];
  policies: DashboardBoundPolicy[];
  commercial: CommercialData;
  selections: Record<string, DashboardLeadSelection>;
  asOf: string;
}
export const EMPTY_LEADS_DATA: LeadsData = { leads: [], clients: [], quotes: [], policies: [], commercial: { entries: {}, team: [] }, selections: {}, asOf: '' };

async function mapLimited<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await read(items[index]); }
  }));
  return results;
}

function batches(ids: readonly string[], size: number) {
  const unique = [...new Set(ids)].sort(), result: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += size) result.push(unique.slice(offset, offset + size));
  return result;
}

function isCompactQuote(item: CompactQuote): boolean {
  return !!item && typeof item.id === 'string' && !!item.id && typeof item.accountId === 'string' && !!item.accountId && (item.status == null || typeof item.status === 'string');
}

async function reportPages<T extends { id: string }>(operation: string, input: Record<string, unknown>, valid: (item: T) => boolean): Promise<T[]> {
  const found = new Map<string, T>(), seen = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await communicationRequest<{ items: T[]; nextToken?: string }>(operation, { ...input, ...(nextToken ? { nextToken } : {}) });
    if (!Array.isArray(page.items) || page.items.some(item => !valid(item))) throw new Error('Lead report records are incomplete. Refresh to try again.');
    for (const item of page.items) found.set(item.id, item);
    nextToken = page.nextToken;
    if (nextToken && (typeof nextToken !== 'string' || seen.has(nextToken))) throw new Error('Lead report pages could not finish loading. Refresh to try again.');
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return [...found.values()];
}

/** Closed quote history is needed only for current leads and the explicitly
 * selected work list. Batch account partitions without unbounded fan-out. */
export function loadDashboardAccountQuotes(ids: readonly string[], details: true): Promise<Quote[]>;
export function loadDashboardAccountQuotes(ids: readonly string[], details?: false): Promise<CompactQuote[]>;
export async function loadDashboardAccountQuotes(ids: readonly string[], details = false): Promise<CompactQuote[]> {
  const pages = await mapLimited(batches(ids, 25), accountIds => {
    const requested = new Set(accountIds);
    return reportPages<CompactQuote>('dashboardQuotesPage', { accountIds, ...(details ? { details: true } : {}) },
      item => isCompactQuote(item) && requested.has(item.accountId));
  });
  return pages.flat();
}

/** An omitted response is not proof of deletion: every selected reference must
 * be returned or explicitly confirmed missing before classifying a package. */
export async function loadDashboardQuoteStates(ids: readonly string[]): Promise<{ items: CompactQuote[]; missingIds: string[] }> {
  const pages = await mapLimited(batches(ids, 500), async quoteIds => {
    const result = await communicationRequest<{ items: CompactQuote[]; missingIds: string[] }>('dashboardQuoteStates', { quoteIds });
    if (!Array.isArray(result.items) || !Array.isArray(result.missingIds) || result.items.some(item => !isCompactQuote(item)) || result.missingIds.some(id => typeof id !== 'string')) throw new Error('Selected quote states are incomplete. Refresh to try again.');
    const resolved = [...result.items.map(item => item.id), ...result.missingIds], unique = new Set(resolved);
    if (resolved.length !== quoteIds.length || unique.size !== quoteIds.length || quoteIds.some(id => !unique.has(id))) throw new Error('Selected quote states are incomplete. Refresh to try again.');
    return result;
  });
  return { items: pages.flatMap(page => page.items), missingIds: pages.flatMap(page => page.missingIds) };
}

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
  const leadsRequest = listAllPages(nextToken => client.models.Account.listAccountByStageAndName({ stage: 'LEAD' }, { nextToken, selectionSet: [...ACCOUNT_FIELDS] }));
  const selectionsRequest = loadDashboardLeadSelections();
  const [leads, clients, openQuotes, policies, selections, leadQuotes, selectedQuotes] = await Promise.all([
    leadsRequest,
    listAllPages(nextToken => client.models.Account.listAccountByStageAndName({ stage: 'CLIENT' }, { nextToken, selectionSet: [...ACCOUNT_FIELDS] })),
    Promise.all(OPEN_QUOTE_STATUSES.map(status => reportPages<CompactQuote>('dashboardOpenQuotesPage', { status }, item => isCompactQuote(item) && item.status === status))).then(pages => pages.flat()),
    reportPages<DashboardBoundPolicy>('dashboardBoundPoliciesPage', { from: since, to: asOf }, item => !!item && typeof item.id === 'string' && typeof item.accountId === 'string' && typeof item.datePolicyBound === 'string'),
    selectionsRequest,
    leadsRequest.then(accounts => loadDashboardAccountQuotes(accounts.map(account => account.id))),
    selectionsRequest.then(selected => loadDashboardQuoteStates(Object.values(selected).flatMap(selection => selection.selectedQuoteIds))),
  ]);
  // Newer direct selected-quote reads override index results, including explicit
  // deletion, so a stale open-index row cannot keep a completed package open.
  const byId = new Map([...openQuotes, ...leadQuotes, ...selectedQuotes.items].map(quote => [quote.id, quote]));
  for (const id of selectedQuotes.missingIds) byId.delete(id);
  const quotes = [...byId.values()], quotesByAccount = new Map<string, CompactQuote[]>();
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
