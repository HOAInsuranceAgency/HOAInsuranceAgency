import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ accounts: vi.fn(), quotes: vi.fn(), policies: vi.fn(), request: vi.fn(), assignments: vi.fn() }));
vi.mock('./client', async original => ({
  ...await original<typeof import('./client')>(),
  client: { models: { Account: { listAccountByStageAndName: h.accounts }, Quote: { list: h.quotes }, Policy: { list: h.policies } } },
}));
vi.mock('./communications', () => ({ communicationRequest: h.request }));
vi.mock('./dashboardAssignments', () => ({ loadAssignments: h.assignments }));
import { loadDashboardLeadSelections, loadLeadsDashboard } from './dashboardLeadData';

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T16:00:00Z'));
  h.request.mockResolvedValue({ items: [] });
  h.assignments.mockResolvedValue({ entries: {}, team: [], accounts: [] });
  h.quotes.mockResolvedValue({ data: [] }); h.policies.mockResolvedValue({ data: [] });
});
afterEach(() => vi.useRealTimers());

it('fetches attribution only for contributing records while preserving a missing selected quote on a partially bound client', async () => {
  const clients = [
    ...Array.from({ length: 1500 }, (_, index) => ({ id: `old-${index}`, stage: 'CLIENT', createdAt: '2020-01-01T00:00:00Z', convertedAt: '2020-02-01T00:00:00Z' })),
    { id: 'partial', stage: 'CLIENT' }, { id: 'recent', stage: 'CLIENT', createdAt: '2026-09-15T00:00:00Z', convertedAt: '2026-09-20T00:00:00Z' },
  ];
  h.accounts.mockImplementation(({ stage }) => Promise.resolve({ data: stage === 'LEAD' ? [{ id: 'lead', stage: 'LEAD' }] : clients }));
  h.request.mockResolvedValue({ items: [
    { accountId: 'partial', selectedQuoteIds: ['bound', 'missing'], alternativeQuoteIds: [] },
    { accountId: 'old-0', selectedQuoteIds: ['done'], alternativeQuoteIds: ['alternate'] },
  ] });
  h.quotes.mockResolvedValue({ data: [
    { id: 'bound', accountId: 'partial', status: 'BOUND' }, { id: 'done', accountId: 'old-0', status: 'BOUND' },
    { id: 'alternate', accountId: 'old-0', status: 'PRESENTED' }, { id: 'renewal', accountId: 'old-1', status: 'PRESENTED' },
  ] });
  h.policies.mockResolvedValue({ data: [{ id: 'p', accountId: 'old-2', datePolicyBound: '2026-09-20T00:00:00Z' }] });
  const data = await loadLeadsDashboard();
  expect([...h.assignments.mock.calls[0][0]].sort()).toEqual(['lead', 'old-1', 'old-2', 'partial', 'recent']);
  expect(data.selections.partial.selectedQuoteIds).toEqual(['bound', 'missing']);
  expect(h.request).toHaveBeenCalledExactlyOnceWith('dashboardLeadPlansPage', { nextToken: undefined });
});

it('does not truncate compact plan pagination at an empty page', async () => {
  h.request.mockResolvedValueOnce({ items: [], nextToken: 'next' }).mockResolvedValueOnce({ items: [
    { accountId: 'a', selectedQuoteIds: ['q'], alternativeQuoteIds: [] },
  ] });
  expect(await loadDashboardLeadSelections()).toEqual({ a: { accountId: 'a', selectedQuoteIds: ['q'], alternativeQuoteIds: [] } });
  expect(h.request).toHaveBeenNthCalledWith(2, 'dashboardLeadPlansPage', { nextToken: 'next' });
});

it('refuses repeated cursors and incomplete selection metadata', async () => {
  h.request.mockResolvedValue({ items: [], nextToken: 'same' });
  await expect(loadDashboardLeadSelections()).rejects.toThrow('could not finish loading');
  h.request.mockResolvedValue({ items: [{ accountId: 'a', selectedQuoteIds: ['q'] }] });
  await expect(loadDashboardLeadSelections()).rejects.toThrow('incomplete');
});
