import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import type { Account } from './client';
import type { CommercialData } from './commercial';

const h = vi.hoisted(() => ({ accounts: vi.fn(), contacts: vi.fn(), policies: vi.fn(), quotes: vi.fn(), commercial: vi.fn() }));
vi.mock('./client', async () => ({
  ...(await import('./pagination')),
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  client: { models: { Account: { list: h.accounts }, Contact: { list: h.contacts }, Policy: { list: h.policies }, Quote: { list: h.quotes } } },
}));
vi.mock('./commercial', () => ({ loadCommercial: h.commercial }));
import { AccountsListDataProvider, useAccountsListData } from './accountsListData';

const account = (id: string, name = id, stage = 'LEAD') => ({ id, name, stage }) as Account;
const commercial = (ids: string[], version = 1): CommercialData => ({ team: [], entries: Object.fromEntries(ids.map(id => [id, {
  accountId: id, workflowVersion: version, salespersonId: `owner-${version}`,
  plan: { ...emptyCommercialPlan(id), version },
  snooze: { accountId: id, version, followUpOn: null, note: '' },
}])) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let latest: ReturnType<typeof useAccountsListData>;
function Probe({ stage }: { stage: 'LEAD' | 'CLIENT' }) { latest = useAccountsListData(stage); return null; }
function App({ show = true, stage = 'LEAD', session = 'one' }: { show?: boolean; stage?: 'LEAD' | 'CLIENT'; session?: string }) {
  return <AccountsListDataProvider key={session}>{show && <Probe stage={stage} />}</AccountsListDataProvider>;
}
async function settled() { await waitFor(() => expect(latest.loading).toBe(false)); }
beforeEach(() => {
  vi.resetAllMocks();
  h.accounts.mockResolvedValue({ data: [account('a')] });
  h.contacts.mockResolvedValue({ data: [] });
  h.policies.mockResolvedValue({ data: [] });
  h.quotes.mockResolvedValue({ data: [] });
  h.commercial.mockImplementation(async (ids: string[]) => commercial(ids));
});

it('shows a cached list immediately on route return and commits refreshed accounts and follow-ups together', async () => {
  const app = render(<App />);
  await settled();
  app.rerender(<App show={false} />);
  const accounts = deferred<{ data: Account[] }>();
  const details = deferred<CommercialData>();
  h.accounts.mockReturnValue(accounts.promise);
  h.commercial.mockReturnValue(details.promise);
  app.rerender(<App />);
  expect(latest.loaded).toBe(true);
  expect(latest.loading).toBe(true);
  expect(latest.data.accounts.map(row => row.name)).toEqual(['a']);
  await act(async () => { accounts.resolve({ data: [account('b', 'Newly accessible lead')] }); });
  expect(latest.data.accounts.map(row => row.name)).toEqual(['a']);
  await act(async () => { details.resolve(commercial(['b'])); });
  expect(latest.data.accounts.map(row => row.name)).toEqual(['Newly accessible lead']);
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['b']);
});

it('purges both stage caches on a GraphQL authorization error from an optional lookup', async () => {
  const app = render(<App />);
  await settled();
  app.rerender(<App stage="CLIENT" />);
  await settled();
  h.contacts.mockResolvedValue({ data: [], errors: [{ message: 'Temporary issue' }, { message: 'Access denied', errorType: 'Unauthorized' }] });
  await act(async () => { await latest.refetch(); });
  expect(latest.error).toBe('Access denied');
  expect(latest.data.accounts).toEqual([]);
  const pending = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValue(pending.promise);
  h.contacts.mockResolvedValue({ data: [] });
  app.rerender(<App />);
  expect(latest.loaded).toBe(false);
  expect(latest.data.accounts).toEqual([]);
  await act(async () => { pending.resolve({ data: [account('b')] }); });
});

it('keeps confirmed assignment, snooze, and estimate versions across an older refresh and route return', async () => {
  h.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
  const app = render(<App />);
  await settled();
  const pending = deferred<CommercialData>();
  h.accounts.mockResolvedValue({ data: [account('a')] });
  h.commercial.mockReturnValue(pending.promise);
  let refresh!: Promise<void>;
  act(() => { refresh = latest.refetch(); });
  await waitFor(() => expect(h.commercial).toHaveBeenCalledTimes(2));
  act(() => latest.setCommercial(old => ({ ...old, entries: { ...old.entries, a: {
    ...commercial(['a'], 3).entries.a,
    plan: { ...emptyCommercialPlan('a'), version: 3, estimatedCents: 12300 },
    snooze: { accountId: 'a', version: 3, followUpOn: '2026-10-20', note: 'Saved' },
  } } })));
  await act(async () => { pending.resolve(commercial(['a'])); await refresh; });
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['a']);
  expect(latest.data.commercial.entries.a).toMatchObject({ salespersonId: 'owner-3', workflowVersion: 3, snooze: { version: 3, note: 'Saved' }, plan: { version: 3, estimatedCents: 12300 } });
  app.rerender(<App show={false} />);
  const never = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValue(never.promise);
  app.rerender(<App />);
  expect(latest.data.commercial.entries.a.workflowVersion).toBe(3);
  expect(latest.data.commercial.entries.a.snooze?.note).toBe('Saved');
});

it('drops superseded requests and does not let an unmounted read overwrite a saved cache', async () => {
  const app = render(<App />);
  await settled();
  const old = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: [account('new')] });
  let first!: Promise<void>;
  act(() => { first = latest.refetch(); });
  await act(async () => { await latest.refetch(); });
  await act(async () => { old.resolve({ data: [account('old')] }); await first; });
  expect(latest.data.accounts[0].id).toBe('new');
  const leaving = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValueOnce(leaving.promise);
  let abandoned!: Promise<void>;
  act(() => { abandoned = latest.refetch(); });
  app.rerender(<App show={false} />);
  await act(async () => { leaving.resolve({ data: [account('unmounted')] }); await abandoned; });
  h.accounts.mockReturnValue(deferred<{ data: Account[] }>().promise);
  app.rerender(<App />);
  expect(latest.data.accounts[0].id).toBe('new');
});

it('does not share snapshots after the authenticated shell or active role remounts', async () => {
  const app = render(<App />);
  await settled();
  h.accounts.mockReturnValue(deferred<{ data: Account[] }>().promise);
  app.rerender(<App session="different-user-or-role" />);
  expect(latest.loaded).toBe(false);
  expect(latest.data.accounts).toEqual([]);
});

it('retains the account list on optional non-authorization failures and exposes quote failure', async () => {
  h.contacts.mockRejectedValue(new Error('Lookup temporarily unavailable'));
  h.quotes.mockResolvedValue({ data: [], errors: [{ message: 'Quote lookup unavailable' }] });
  render(<App />);
  await settled();
  expect(latest.error).toBe('');
  expect(latest.data.accounts[0].id).toBe('a');
  expect(latest.data.contacts).toEqual([]);
  expect(latest.data.quoteError).toBe('Quote lookup unavailable');
  expect(h.policies).not.toHaveBeenCalled();
});
