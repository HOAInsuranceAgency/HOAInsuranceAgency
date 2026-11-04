import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import type { AccountListCounts, AccountListItem, AccountListPage, AccountListRequest } from '../../../shared/accountList';
const h = vi.hoisted(() => ({ request: vi.fn(), legacyAccounts: vi.fn(), legacyContacts: vi.fn(), legacyQuotes: vi.fn(), legacyPolicies: vi.fn(), commercial: vi.fn() }));
vi.mock('./communications', () => ({ communicationRequest: h.request }));
vi.mock('./client', async () => ({ ...(await import('./pagination')), friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  client: { models: { Account: { list: h.legacyAccounts }, Contact: { list: h.legacyContacts }, Quote: { list: h.legacyQuotes }, Policy: { list: h.legacyPolicies } } } }));
vi.mock('./commercial', () => ({ loadCommercial: h.commercial }));
import { PagedAccountListProvider, usePagedAccountsListData } from './pagedAccountsListData';
import { AdminContext } from './auth';
import { AccountsListDataProvider, useAccountsListData } from './accountsListData';

const input: AccountListRequest = { stage: 'LEAD', view: 'active', sort: 'renewal', dir: 'asc', limit: 25 };
const item = (id: string): AccountListItem => ({ account: { id, name: id, stage: 'LEAD', type: 'ASSOCIATION' },
  renewalDate: null, commercial: { accountId: id, plan: emptyCommercialPlan(id) },
  forecast: { cents: null, label: 'No package options', unfinished: false } });
const page = (id: string, nextToken?: string): AccountListPage => ({ ready: true, items: [item(id)], nextToken });
const totals: AccountListCounts = { ready: true, counts: { active: 1, snoozed: 0, due: 0, all: 1 } };
const denied = () => Object.assign(new Error('Your access is inactive.'), { name: 'Unauthorized' });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let latest: ReturnType<typeof usePagedAccountsListData>;
function Probe({ request = input }: { request?: AccountListRequest }) { latest = usePagedAccountsListData(request); return null; }
beforeEach(() => {
  h.request.mockReset();
  h.request.mockImplementation(async operation => operation === 'accountListPage' ? page('a') : operation === 'accountListCounts' ? totals : { team: [] });
  h.legacyAccounts.mockReset().mockResolvedValue({ data: [{ id: 'legacy', name: 'Legacy authorized row', stage: 'LEAD', type: 'ASSOCIATION' }] });
  for (const list of [h.legacyContacts, h.legacyQuotes, h.legacyPolicies]) list.mockReset().mockResolvedValue({ data: [] });
  h.commercial.mockReset().mockImplementation(async (ids: string[]) => ({ team: [], entries: Object.fromEntries(ids.map(id => [id, { accountId: id, plan: emptyCommercialPlan(id) }])) }));
});

it('publishes authorized rows before slow directory names or totals finish', async () => {
  const names = deferred<{ team: [] }>(), counts = deferred<AccountListCounts>();
  h.request.mockImplementation(operation => operation === 'team' ? names.promise : operation === 'accountListCounts' ? counts.promise : Promise.resolve(page('a')));
  render(<Probe />);
  await waitFor(() => expect(latest.loaded).toBe(true));
  expect(latest.data.accounts.map(a => a.id)).toEqual(['a']);
  expect(latest.loading).toBe(false); expect(latest.teamLoading).toBe(true); expect(latest.countsLoaded).toBe(false);
  await act(async () => { counts.resolve(totals); names.resolve({ team: [] }); });
  await waitFor(() => expect(latest.countsLoaded).toBe(true));
});

it('hides the previous view immediately and ignores its late totals', async () => {
  const counts = deferred<AccountListCounts>(), replacement = deferred<AccountListPage>();
  h.request.mockImplementation((operation, request) => operation === 'team' ? Promise.resolve({ team: [] })
    : operation === 'accountListCounts' ? counts.promise : request.state ? replacement.promise : Promise.resolve(page('a')));
  const view = render(<Probe />); await waitFor(() => expect(latest.loaded).toBe(true));
  view.rerender(<Probe request={{ ...input, state: 'FL' }} />);
  expect(latest.data.accounts).toEqual([]); expect(latest.loaded).toBe(false);
  await act(async () => { counts.resolve(totals); });
  expect(latest.data.accounts).toEqual([]); expect(latest.countsLoaded).toBe(false);
  await act(async () => { replacement.resolve(page('florida')); });
  await waitFor(() => expect(latest.data.accounts[0]?.id).toBe('florida'));
});

it('discards in-flight results when the authenticated role scope remounts', async () => {
  const admin = deferred<AccountListPage>(), producer = deferred<AccountListPage>(); let reads = 0;
  h.request.mockImplementation(operation => operation === 'accountListPage' ? (++reads === 1 ? admin.promise : producer.promise)
    : Promise.resolve(operation === 'accountListCounts' ? totals : { team: [] }));
  const view = render(<Probe key="alice:ADMIN" />);
  view.rerender(<Probe key="alice:PRODUCER" />);
  await act(async () => { admin.resolve(page('foreign-admin-row')); });
  expect(latest.data.accounts).toEqual([]); expect(latest.loaded).toBe(false);
  await act(async () => { producer.resolve(page('own-row')); });
  await waitFor(() => expect(latest.data.accounts.map(a => a.id)).toEqual(['own-row']));
});

it('purges visible data on refresh authorization denial without entering rollout fallback', async () => {
  render(<Probe />); await waitFor(() => expect(latest.loaded).toBe(true));
  h.request.mockImplementation(operation => operation === 'accountListPage' ? Promise.reject(denied()) : Promise.resolve({ team: [] }));
  await act(async () => { await latest.refetch(); });
  expect(latest.data.accounts).toEqual([]); expect(latest.error).toContain('inactive'); expect(latest.fallback).toBe(false);
});

it('does not let a late next-page response restore rows after totals report deactivation', async () => {
  const counts = deferred<AccountListCounts>(), more = deferred<AccountListPage>();
  h.request.mockImplementation((operation, request) => operation === 'accountListCounts' ? counts.promise
    : operation === 'accountListPage' ? request.nextToken ? more.promise : Promise.resolve(page('a', 'two')) : Promise.resolve({ team: [] }));
  render(<Probe />); await waitFor(() => expect(latest.loaded).toBe(true));
  let loading!: Promise<void>;
  act(() => { loading = latest.loadMore(); });
  await act(async () => { counts.reject(denied()); });
  await waitFor(() => expect(latest.error).toContain('inactive'));
  expect(latest.data.accounts).toEqual([]);
  await act(async () => { more.resolve(page('late-row')); await loading; });
  expect(latest.data.accounts).toEqual([]); expect(latest.error).toContain('inactive');
});

it('rejects an export that completes after its original role scope unmounts', async () => {
  render(<Probe />); await waitFor(() => expect(latest.loaded).toBe(true));
  const exporting = deferred<AccountListPage>();
  h.request.mockImplementation(operation => operation === 'accountListPage' ? exporting.promise : Promise.resolve({ team: [] }));
  const result = latest.exportAll(); const rejected = expect(result).rejects.toThrow('view changed');
  const { cleanup } = await import('@testing-library/react'); cleanup();
  exporting.resolve(page('late-export'));
  await rejected;
});

it('rejects a pending export when another request revokes the current access generation', async () => {
  const counts = deferred<AccountListCounts>(), exporting = deferred<AccountListPage>();
  h.request.mockImplementation((operation, request) => operation === 'accountListCounts' ? counts.promise
    : operation === 'accountListPage' ? request.limit === 50 ? exporting.promise : Promise.resolve(page('a')) : Promise.resolve({ team: [] }));
  render(<Probe />); await waitFor(() => expect(latest.loaded).toBe(true));
  const result = latest.exportAll(), rejected = expect(result).rejects.toThrow('view changed');
  await act(async () => { counts.reject(denied()); });
  await waitFor(() => expect(latest.error).toContain('inactive'));
  exporting.resolve(page('late-export'));
  await rejected;
  expect(latest.data.accounts).toEqual([]);
});

it.each([true, false])('preserves the existing Admin warm cache while requiring fresh scoped access (admin=%s)', async admin => {
  function App({ show = true }: { show?: boolean }) {
    return <AdminContext.Provider value={admin}><PagedAccountListProvider>{show && <Probe />}</PagedAccountListProvider></AdminContext.Provider>;
  }
  const view = render(<App />); await waitFor(() => expect(latest.loaded).toBe(true));
  view.rerender(<App show={false} />);
  const pending = deferred<AccountListPage>();
  h.request.mockImplementation(operation => operation === 'accountListPage' ? pending.promise : Promise.resolve(operation === 'accountListCounts' ? totals : { team: [] }));
  view.rerender(<App />);
  expect(latest.data.accounts.map(a => a.id)).toEqual(admin ? ['a'] : []);
  expect(latest.loaded).toBe(admin);
  await act(async () => { pending.resolve(page('new-current-owner')); });
  await waitFor(() => expect(latest.data.accounts.map(a => a.id)).toEqual(['new-current-owner']));
});

it('retains a loaded 50-row window during warm refresh and replaces it only when both fresh pages arrive', async () => {
  const first = Array.from({ length: 25 }, (_, i) => item(`a${i}`)), second = Array.from({ length: 25 }, (_, i) => item(`b${i}`));
  h.request.mockImplementation((operation, request) => Promise.resolve(operation === 'accountListPage'
    ? { ready: true, items: request.nextToken ? second : first, nextToken: request.nextToken ? 'third' : 'second' }
    : operation === 'accountListCounts' ? totals : { team: [] }));
  function App({ show = true }: { show?: boolean }) {
    return <AdminContext.Provider value><PagedAccountListProvider>{show && <Probe />}</PagedAccountListProvider></AdminContext.Provider>;
  }
  const view = render(<App />); await waitFor(() => expect(latest.data.accounts).toHaveLength(25));
  await act(async () => { await latest.loadMore(); });
  expect(latest.data.accounts).toHaveLength(50);
  view.rerender(<App show={false} />);
  const freshFirst = deferred<AccountListPage>(), freshSecond = deferred<AccountListPage>();
  h.request.mockImplementation((operation, request) => operation === 'accountListPage'
    ? request.nextToken ? freshSecond.promise : freshFirst.promise
    : Promise.resolve(operation === 'accountListCounts' ? totals : { team: [] }));
  view.rerender(<App />);
  expect(latest.data.accounts).toHaveLength(50);
  await act(async () => { freshFirst.resolve({ ready: true, items: first.map(row => ({ ...row, account: { ...row.account, name: 'Refreshed' } })), nextToken: 'fresh-second' }); });
  expect(latest.data.accounts).toHaveLength(50);
  expect(latest.data.accounts[0].name).toBe('a0');
  expect(h.request).toHaveBeenCalledWith('accountListPage', expect.objectContaining({ nextToken: 'fresh-second' }));
  await act(async () => { freshSecond.resolve({ ready: true, items: second, nextToken: 'fresh-third' }); });
  await waitFor(() => expect(latest.data.accounts[0].name).toBe('Refreshed'));
  expect(latest.data.accounts).toHaveLength(50); expect(latest.nextToken).toBe('fresh-third');
});

it('exports one latest row per account when a concurrent edit moves an account across the cursor', async () => {
  render(<Probe />); await waitFor(() => expect(latest.loaded).toBe(true));
  const updated = { ...item('a'), account: { ...item('a').account, name: 'Updated after reindex' } };
  h.request.mockImplementation((operation, request) => Promise.resolve(operation === 'accountListPage'
    ? request.nextToken ? { ready: true, items: [updated, item('b')] } : { ready: true, items: [item('a')], nextToken: 'after-edit' }
    : operation === 'accountListCounts' ? totals : { team: [] }));
  const rows = await latest.exportAll();
  expect(rows.map(row => row.account.id)).toEqual(['a', 'b']);
  expect(rows[0].account.name).toBe('Updated after reindex');
});

it('explicit refresh probes the projected path again while keeping the authorized legacy fallback visible', async () => {
  let projected = false;
  const fresh = deferred<AccountListPage>();
  h.request.mockImplementation(operation => operation === 'accountListPage'
    ? projected ? fresh.promise : Promise.resolve({ ready: false, items: [] })
    : Promise.resolve(operation === 'accountListCounts' ? totals : { team: [] }));
  let combined!: ReturnType<typeof useAccountsListData>;
  function Combined() { combined = useAccountsListData('LEAD', input); return null; }
  render(<AdminContext.Provider value><AccountsListDataProvider><Combined /></AccountsListDataProvider></AdminContext.Provider>);
  await waitFor(() => expect(combined.loaded).toBe(true));
  expect(combined.paged).toBe(false); expect(combined.data.accounts[0].id).toBe('legacy');
  projected = true; let refreshing!: Promise<void>;
  act(() => { refreshing = combined.refetch(); });
  await waitFor(() => expect(h.legacyAccounts).toHaveBeenCalledTimes(2));
  expect(combined.paged).toBe(false); expect(combined.data.accounts[0].id).toBe('legacy');
  await act(async () => { fresh.resolve(page('fresh-projection')); await refreshing; });
  await waitFor(() => expect(combined.paged).toBe(true));
  expect(combined.data.accounts[0].id).toBe('fresh-projection');
});
