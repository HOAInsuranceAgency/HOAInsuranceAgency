import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ accounts: vi.fn(), quotes: vi.fn(), policies: vi.fn(), request: vi.fn(), assignments: vi.fn() }));
vi.mock('./client', async original => ({
  ...await original<typeof import('./client')>(),
  client: { models: { Account: { listAccountByStageAndName: h.accounts }, Quote: { list: h.quotes }, Policy: { list: h.policies } } },
}));
vi.mock('./communications', () => ({ communicationRequest: h.request }));
vi.mock('./dashboardAssignments', () => ({ loadAssignments: h.assignments }));
import { loadDashboardAccountQuotes, loadDashboardLeadSelections, loadDashboardQuoteStates, loadLeadsDashboard, type CompactQuote } from './dashboardLeadData';
import type { DashboardLeadSelection } from '../../../shared/dashboardLeadSelection';

function serve({ plans = [], quotes = [], policies = [] }: { plans?: DashboardLeadSelection[]; quotes?: CompactQuote[]; policies?: { id: string; accountId: string; datePolicyBound: string }[] } = {}) {
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'dashboardLeadPlansPage') return { items: plans };
    if (operation === 'dashboardOpenQuotesPage') return { items: quotes.filter(quote => quote.status === input.status) };
    if (operation === 'dashboardBoundPoliciesPage') return { items: policies };
    if (operation === 'dashboardQuotesPage') return { items: quotes.filter(quote => input.accountIds.includes(quote.accountId)) };
    if (operation === 'dashboardQuoteStates') return { items: quotes.filter(quote => input.quoteIds.includes(quote.id)), missingIds: input.quoteIds.filter((id: string) => !quotes.some(quote => quote.id === id)) };
    throw new Error(`Unexpected report operation ${operation}`);
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T16:00:00Z'));
  h.accounts.mockResolvedValue({ data: [] });
  h.assignments.mockResolvedValue({ entries: {}, team: [], accounts: [] });
  serve();
});
afterEach(() => vi.useRealTimers());

it('reads only open quotes, current-lead history and selected references while preserving a missing selected quote', async () => {
  const clients = [
    ...Array.from({ length: 1500 }, (_, index) => ({ id: `old-${index}`, stage: 'CLIENT', createdAt: '2020-01-01T00:00:00Z', convertedAt: '2020-02-01T00:00:00Z' })),
    { id: 'partial', stage: 'CLIENT' }, { id: 'recent', stage: 'CLIENT', createdAt: '2026-09-15T00:00:00Z', convertedAt: '2026-09-20T00:00:00Z' },
  ];
  h.accounts.mockImplementation(({ stage }) => Promise.resolve({ data: stage === 'LEAD' ? [{ id: 'lead', stage: 'LEAD' }] : clients }));
  serve({ plans: [
    { accountId: 'partial', selectedQuoteIds: ['bound', 'missing'], alternativeQuoteIds: [] },
    { accountId: 'old-0', selectedQuoteIds: ['done'], alternativeQuoteIds: ['alternate'] },
  ], quotes: [
    { id: 'bound', accountId: 'partial', status: 'BOUND' }, { id: 'done', accountId: 'old-0', status: 'BOUND' },
    { id: 'alternate', accountId: 'old-0', status: 'PRESENTED' }, { id: 'renewal', accountId: 'old-1', status: 'PRESENTED' },
    { id: 'declined', accountId: 'lead', status: 'DECLINED' }, { id: 'old-history', accountId: 'old-3', status: 'DECLINED' },
  ], policies: [{ id: 'p', accountId: 'old-2', datePolicyBound: '2026-09-20T00:00:00Z' }] });
  const data = await loadLeadsDashboard();
  expect([...h.assignments.mock.calls[0][0]].sort()).toEqual(['lead', 'old-1', 'old-2', 'partial', 'recent']);
  expect(data.selections.partial.selectedQuoteIds).toEqual(['bound', 'missing']);
  expect(data.quotes.map(quote => quote.id).sort()).toEqual(['alternate', 'bound', 'declined', 'done', 'renewal']);
  expect(h.request.mock.calls.filter(([op]) => op === 'dashboardQuotesPage')).toEqual([['dashboardQuotesPage', { accountIds: ['lead'] }]]);
  expect(h.request).toHaveBeenCalledWith('dashboardQuoteStates', { quoteIds: ['bound', 'done', 'missing'] });
  expect(h.request).toHaveBeenCalledWith('dashboardBoundPoliciesPage', { from: '2026-08-31T16:00:00.000Z', to: '2026-09-30T16:00:00.000Z' });
  expect(h.request.mock.calls.filter(([op]) => op === 'dashboardOpenQuotesPage')).toHaveLength(4);
  expect(h.quotes).not.toHaveBeenCalled(); expect(h.policies).not.toHaveBeenCalled();
});

it('uses authoritative selected states over stale open-index results, including confirmed deletion', async () => {
  h.accounts.mockResolvedValue({ data: [] });
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'dashboardLeadPlansPage') return { items: [{ accountId: 'client', selectedQuoteIds: ['bound', 'deleted'], alternativeQuoteIds: [] }] };
    if (operation === 'dashboardOpenQuotesPage' && input.status === 'PRESENTED') return { items: [{ id: 'bound', accountId: 'client', status: 'PRESENTED' }, { id: 'deleted', accountId: 'client', status: 'PRESENTED' }] };
    if (operation === 'dashboardQuoteStates') return { items: [{ id: 'bound', accountId: 'client', status: 'BOUND' }], missingIds: ['deleted'] };
    return { items: [] };
  });
  const data = await loadLeadsDashboard();
  expect(data.quotes).toEqual([{ id: 'bound', accountId: 'client', status: 'BOUND' }]);
});

it('does not truncate compact plan pagination at an empty page', async () => {
  h.request.mockResolvedValueOnce({ items: [], nextToken: 'next' }).mockResolvedValueOnce({ items: [
    { accountId: 'a', selectedQuoteIds: ['q'], alternativeQuoteIds: [] },
  ] });
  expect(await loadDashboardLeadSelections()).toEqual({ a: { accountId: 'a', selectedQuoteIds: ['q'], alternativeQuoteIds: [] } });
  expect(h.request).toHaveBeenNthCalledWith(2, 'dashboardLeadPlansPage', { nextToken: 'next' });
});

it('refuses repeated plan cursors and incomplete selection metadata', async () => {
  h.request.mockResolvedValue({ items: [], nextToken: 'same' });
  await expect(loadDashboardLeadSelections()).rejects.toThrow('could not finish loading');
  h.request.mockResolvedValue({ items: [{ accountId: 'a', selectedQuoteIds: ['q'] }] });
  await expect(loadDashboardLeadSelections()).rejects.toThrow('incomplete');
});

it('batches current-account quote histories with at most four concurrent requests and no details by default', async () => {
  let concurrent = 0, maximum = 0;
  h.request.mockImplementation(async (_operation, input) => {
    maximum = Math.max(maximum, ++concurrent);
    await Promise.resolve(); concurrent--;
    return { items: input.accountIds.map((id: string) => ({ id: `quote-${id}`, accountId: id, status: 'DECLINED' })) };
  });
  const accounts = Array.from({ length: 127 }, (_, index) => `a-${index}`);
  const result = await loadDashboardAccountQuotes([...accounts, accounts[0]]);
  expect(result).toHaveLength(127); expect(maximum).toBe(4);
  expect(h.request).toHaveBeenCalledTimes(6);
  for (const [operation, input] of h.request.mock.calls) {
    expect(operation).toBe('dashboardQuotesPage'); expect(input.accountIds.length).toBeLessThanOrEqual(25); expect(input.details).toBeUndefined();
  }
});

it('finishes selected-account quote pages before returning full terms and rejects escaping rows or stalled cursors', async () => {
  const quote = { id: 'q', accountId: 'a', status: 'QUOTED', premium: 1234, commissionPct: 15 };
  h.request.mockResolvedValueOnce({ items: [], nextToken: 'page2' }).mockResolvedValueOnce({ items: [quote] });
  expect(await loadDashboardAccountQuotes(['a'], true)).toEqual([quote]);
  expect(h.request).toHaveBeenLastCalledWith('dashboardQuotesPage', { accountIds: ['a'], details: true, nextToken: 'page2' });
  h.request.mockResolvedValue({ items: [{ ...quote, accountId: 'unrequested' }] });
  await expect(loadDashboardAccountQuotes(['a'])).rejects.toThrow('incomplete');
  h.request.mockResolvedValue({ items: [], nextToken: 'same' });
  await expect(loadDashboardAccountQuotes(['a'])).rejects.toThrow('could not finish loading');
});

it('batches selected states and requires each reference to be returned or explicitly missing exactly once', async () => {
  const ids = Array.from({ length: 502 }, (_, index) => `q-${index}`);
  h.request.mockImplementation(async (_operation, { quoteIds }) => ({ items: [], missingIds: quoteIds }));
  expect((await loadDashboardQuoteStates(ids)).missingIds).toHaveLength(502);
  expect(h.request.mock.calls.map(([, input]) => input.quoteIds.length)).toEqual([500, 2]);
  for (const result of [
    { items: [], missingIds: [] },
    { items: [{ id: 'q', accountId: 'a', status: 'BOUND' }], missingIds: ['q'] },
    { items: [], missingIds: ['another'] },
  ]) {
    h.request.mockResolvedValue(result);
    await expect(loadDashboardQuoteStates(['q'])).rejects.toThrow('Selected quote states are incomplete');
  }
});

it('fails the entire snapshot if a selected quote read is incomplete instead of inventing unfinished clients', async () => {
  h.request.mockImplementation(async operation => operation === 'dashboardLeadPlansPage'
    ? { items: [{ accountId: 'client', selectedQuoteIds: ['q'], alternativeQuoteIds: [] }] }
    : { items: [], missingIds: [] });
  await expect(loadLeadsDashboard()).rejects.toThrow('Selected quote states are incomplete');
  expect(h.assignments).not.toHaveBeenCalled();
});
