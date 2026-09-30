import type { ChartRow, ChartSeries } from '../components/StackedBars';
import type { CommercialEntry } from './commercial';
import { isInLast30Days, salespersonKey } from './dashboardPeople';
import { leadQuoteStanding } from './dashboardStats';
import { isOpenQuoteStatus } from './quoteStatus';
import { alternativeQuoteIds } from '../../../shared/quotePackages';
import type { DashboardLeadSelection } from '../../../shared/dashboardLeadSelection';

interface LeadAccount {
  id: string;
  stage?: string | null;
  createdAt?: string | null;
  convertedAt?: string | null;
}
interface LeadQuote { id?: string; accountId: string; status?: string | null }
interface BoundPolicy { accountId: string; datePolicyBound?: string | null }

export const PIPELINE_SERIES: ChartSeries[] = [
  { key: 'unworked', label: 'No quotes', color: '#64748b' },
  { key: 'marketing', label: 'Draft / submitted', color: '#6366f1' },
  { key: 'presented', label: 'Quoted / presented', color: '#0891b2' },
  { key: 'binding', label: 'Binding in progress', color: '#059669' },
  { key: 'closed', label: 'Closed quotes', color: '#d97706' },
  { key: 'other', label: 'Other quote status', color: '#a855f7' },
];

export function isOpenLead(account: LeadAccount, entries: Record<string, CommercialEntry>) {
  const disposition = entries[account.id]?.disposition;
  return account.stage === 'LEAD' && !['LOST', 'DISQUALIFIED', 'BOUND'].includes(disposition ?? '');
}

/** Selecting a package retires its alternative quotes from current work.
 * Bound quotes remain historical facts, matching the account-work workflow. */
export function activeLeadQuotes<T extends LeadQuote>(quotes: readonly T[], entries: Record<string, CommercialEntry>, selections?: Readonly<Record<string, DashboardLeadSelection>>): T[] {
  const alternatives = new Map<string, Set<string>>();
  return quotes.filter(quote => {
    if (!alternatives.has(quote.accountId)) alternatives.set(quote.accountId, new Set(selections ? selections[quote.accountId]?.alternativeQuoteIds ?? [] : alternativeQuoteIds(entries[quote.accountId]?.plan)));
    return quote.status === 'BOUND' || !alternatives.get(quote.accountId)!.has(quote.id ?? '');
  });
}

/** Current account assignment is used for every series, even for past events. */
export function leadPersonMetrics({ accounts, quotes, policies, pipelineAccounts, entries, series, now, selections }: {
  accounts: readonly LeadAccount[];
  quotes: readonly LeadQuote[];
  policies: readonly BoundPolicy[];
  pipelineAccounts: readonly LeadAccount[];
  entries: Record<string, CommercialEntry>;
  series: ChartSeries[];
  now: Date;
  selections?: Readonly<Record<string, DashboardLeadSelection>>;
}) {
  const counters = new Map(series.map(person => [person.key, { open: 0, quotes: 0, created: 0, binds: 0 }]));
  const increment = (accountId: string, metric: 'open' | 'quotes' | 'created' | 'binds') => {
    const key = salespersonKey(accountId, entries);
    const values = counters.get(key);
    if (values) values[metric] += 1;
  };
  for (const account of accounts) {
    if (isOpenLead(account, entries)) increment(account.id, 'open');
    // Directly entered clients are not new leads. Converted clients remain in
    // this metric so a successful bind does not erase their lead arrival.
    if ((account.stage === 'LEAD' || account.convertedAt) && isInLast30Days(account.createdAt, now)) increment(account.id, 'created');
  }
  const activeQuotes = activeLeadQuotes(quotes, entries, selections);
  for (const quote of activeQuotes) {
    if (isOpenQuoteStatus(quote.status) && !['LOST', 'DISQUALIFIED'].includes(entries[quote.accountId]?.disposition ?? '')) increment(quote.accountId, 'quotes');
  }
  for (const policy of policies) {
    // Effective dates and account conversion dates cannot stand in for the
    // actual bind timestamp. Older undated policies are deliberately omitted.
    if (isInLast30Days(policy.datePolicyBound, now)) increment(policy.accountId, 'binds');
  }
  const rows = (metric: 'open' | 'quotes' | 'created' | 'binds'): ChartRow[] => series.map(person => ({
    key: person.key, label: person.label, values: { [person.key]: counters.get(person.key)?.[metric] ?? 0 },
  }));
  const pipeline: ChartRow[] = series.map(person => ({ key: person.key, label: person.label, values: Object.fromEntries(PIPELINE_SERIES.map(stage => [stage.key, 0])) }));
  const pipelineByPerson = new Map(pipeline.map(row => [row.key, row]));
  const quotesByAccount = new Map<string, LeadQuote[]>();
  for (const quote of activeQuotes) {
    const current = quotesByAccount.get(quote.accountId) ?? [];
    current.push(quote);
    quotesByAccount.set(quote.accountId, current);
  }
  for (const account of pipelineAccounts) {
    const accountQuotes = quotesByAccount.get(account.id) ?? [];
    const standing = leadQuoteStanding(accountQuotes);
    const stage = account.stage === 'CLIENT' || standing?.status === 'BOUND' ? 'binding'
      : !accountQuotes.length ? 'unworked'
      : standing?.status === 'DRAFT' || standing?.status === 'SUBMITTED' ? 'marketing'
      : standing?.status === 'QUOTED' || standing?.status === 'PRESENTED' ? 'presented'
      : standing?.status === 'DECLINED' || standing?.status === 'LOST' ? 'closed' : 'other';
    const row = pipelineByPerson.get(salespersonKey(account.id, entries));
    if (row) row.values[stage] += 1;
  }
  return { open: rows('open'), quotes: rows('quotes'), created: rows('created'), binds: rows('binds'), pipeline };
}
