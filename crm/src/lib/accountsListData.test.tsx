import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import type { Account } from './client';
import type { CommercialData } from './commercial';

const h = vi.hoisted(() => ({ accounts: vi.fn(), contacts: vi.fn(), policies: vi.fn(), quotes: vi.fn(), commercial: vi.fn(), isAdmin: true }));
vi.mock('./client', async () => ({
  ...(await import('./pagination')),
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  client: { models: { Account: { list: h.accounts }, Contact: { list: h.contacts }, Policy: { list: h.policies }, Quote: { list: h.quotes } } },
}));
vi.mock('./commercial', () => ({ loadCommercial: h.commercial }));
vi.mock('./auth', () => ({ useIsAdmin: () => h.isAdmin }));
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
  vi.restoreAllMocks();
  vi.resetAllMocks();
  h.isAdmin = true;
  h.accounts.mockResolvedValue({ data: [account('a')] });
  h.contacts.mockResolvedValue({ data: [] });
  h.policies.mockResolvedValue({ data: [] });
  h.quotes.mockResolvedValue({ data: [] });
  h.commercial.mockImplementation(async (ids: string[]) => commercial(ids));
});

it('shows admin cache immediately while revalidating details on route return', async () => {
  const app = render(<App />);
  await settled();
  app.rerender(<App show={false} />);
  app.rerender(<App />);
  expect(latest.loaded).toBe(true);
  expect(latest.loading).toBe(true);
  expect(latest.data.accounts.map(row => row.name)).toEqual(['a']);
  await settled();
  expect(h.accounts).toHaveBeenCalledTimes(2);
  expect(h.contacts).toHaveBeenCalledTimes(2);
  expect(h.quotes).toHaveBeenCalledTimes(2);
  expect(h.commercial).toHaveBeenCalledTimes(2);
  await act(async () => { await latest.refetch(); });
  expect(h.accounts).toHaveBeenCalledTimes(3);
  expect(h.contacts).toHaveBeenCalledTimes(3);
  expect(h.quotes).toHaveBeenCalledTimes(3);
  expect(h.commercial).toHaveBeenCalledTimes(3);
});

it.each([
  { stage: 'LEAD' as const, isAdmin: true },
  { stage: 'LEAD' as const, isAdmin: false },
  { stage: 'CLIENT' as const, isAdmin: true },
  { stage: 'CLIENT' as const, isAdmin: false },
])('revalidates separately saved details without an account timestamp change ($stage, admin=$isAdmin)', async ({ stage, isAdmin }) => {
  h.isAdmin = isAdmin;
  // Returning in the same instant must still pick up writes to other models.
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  h.accounts.mockResolvedValue({ data: [{ ...account('a', 'A', stage), updatedAt: '2026-10-01T00:00:00Z' }] });
  h.contacts.mockResolvedValue({ data: [{ id: 'ca', accountId: 'a', name: 'Before' }] });
  h.quotes.mockResolvedValue({ data: [{ id: 'qa', accountId: 'a', premium: 100 }] });
  h.policies.mockResolvedValue({ data: [{ id: 'pa', accountId: 'a', expirationDate: '2026-11-01' }] });
  const app = render(<App stage={stage} />);
  await settled();
  app.rerender(<App stage={stage} show={false} />);
  h.contacts.mockResolvedValue({ data: [{ id: 'ca', accountId: 'a', name: 'After' }] });
  h.quotes.mockResolvedValue({ data: [{ id: 'qa', accountId: 'a', premium: 250 }] });
  h.policies.mockResolvedValue({ data: [{ id: 'pa', accountId: 'a', expirationDate: '2027-11-01' }] });
  const pending = deferred<CommercialData>();
  h.commercial.mockReturnValue(pending.promise);
  app.rerender(<App stage={stage} />);
  await waitFor(() => expect(h.commercial).toHaveBeenCalledTimes(2));
  expect(latest.loaded).toBe(true);
  expect(latest.loading).toBe(true);
  expect(latest.data.accounts.map(row => row.id)).toEqual(['a']);
  expect(latest.data.contacts[0].name).toBe('Before');
  const updated = commercial(['a'], 2);
  updated.entries.a.snooze = { accountId: 'a', version: 2, followUpOn: '2026-12-01', note: 'Call in December' };
  await act(async () => { pending.resolve(updated); });
  await settled();
  expect(latest.data.contacts[0].name).toBe('After');
  if (stage === 'LEAD') expect(latest.data.quotes[0].premium).toBe(250);
  else expect(latest.data.policies[0].expirationDate).toBe('2027-11-01');
  expect(latest.data.commercial.entries.a).toMatchObject({
    salespersonId: 'owner-2', workflowVersion: 2,
    snooze: { followUpOn: '2026-12-01', note: 'Call in December' },
  });
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

it('hides non-admin cache until access validation and prunes revoked dependents during revalidation', async () => {
  h.isAdmin = false;
  h.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
  h.contacts.mockResolvedValue({ data: [{ id: 'ca', accountId: 'a' }, { id: 'cb', accountId: 'b' }] });
  h.quotes.mockResolvedValue({ data: [{ id: 'qa', accountId: 'a' }, { id: 'qb', accountId: 'b' }] });
  const app = render(<App />);
  await settled();
  app.rerender(<App show={false} />);
  const access = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValue(access.promise);
  app.rerender(<App />);
  expect(latest.loaded).toBe(false);
  expect(latest.data.accounts).toEqual([]);
  expect(latest.data.contacts).toEqual([]);
  expect(latest.data.quotes).toEqual([]);
  expect(latest.data.commercial.entries).toEqual({});
  await act(async () => { access.resolve({ data: [account('b')] }); });
  await settled();
  expect(latest.data.accounts.map(row => row.id)).toEqual(['b']);
  expect(latest.data.contacts.map(row => row.id)).toEqual(['cb']);
  expect(latest.data.quotes.map(row => row.id)).toEqual(['qb']);
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['b']);
  expect(h.accounts).toHaveBeenCalledTimes(2);
  expect(h.contacts).toHaveBeenCalledTimes(2);
  expect(h.quotes).toHaveBeenCalledTimes(2);
  expect(h.commercial).toHaveBeenCalledTimes(2);
});

it('prunes revoked rows before slow details settle and retains surviving contacts/policies on failure', async () => {
  h.isAdmin = false;
  h.accounts.mockResolvedValue({ data: [account('a'), account('b', 'Bound client', 'CLIENT')] });
  h.contacts.mockResolvedValue({ data: [{ id: 'ca', accountId: 'a' }, { id: 'cb', accountId: 'b' }] });
  h.policies.mockResolvedValue({ data: [{ id: 'pa', accountId: 'a' }, { id: 'pb', accountId: 'b' }] });
  render(<App stage="CLIENT" />);
  await settled();
  const details = deferred<CommercialData>();
  h.accounts.mockResolvedValue({ data: [account('b', 'Still authorized', 'CLIENT')] });
  h.commercial.mockReturnValue(details.promise);
  h.contacts.mockRejectedValue(new Error('Contacts unavailable'));
  h.policies.mockRejectedValue(new Error('Policies unavailable'));
  let refresh!: Promise<void>;
  act(() => { refresh = latest.refetch(); });
  await waitFor(() => expect(h.commercial).toHaveBeenCalledTimes(2));
  expect(latest.loading).toBe(true);
  expect(latest.data.accounts.map(row => row.id)).toEqual(['b']);
  expect(latest.data.contacts.map(row => row.id)).toEqual(['cb']);
  expect(latest.data.policies.map(row => row.id)).toEqual(['pb']);
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['b']);
  await act(async () => { details.resolve(commercial(['a', 'b'])); await refresh; });
  expect(latest.error).toBe('');
  expect(latest.refreshError).toContain('Contacts unavailable');
  expect(latest.refreshError).toContain('Policies unavailable');
  expect(latest.data.contacts.map(row => row.id)).toEqual(['cb']);
  expect(latest.data.policies.map(row => row.id)).toEqual(['pb']);
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['b']);
});

it('preserves authorized rows on commercial failure but keeps initial failure fatal', async () => {
  const app = render(<App />);
  await settled();
  h.commercial.mockRejectedValue(new Error('Follow-ups unavailable'));
  await act(async () => { await latest.refetch(); });
  expect(latest.data.accounts[0].id).toBe('a');
  expect(latest.data.commercial.entries.a.snooze?.version).toBe(1);
  expect(latest.error).toBe('');
  expect(latest.refreshError).toBe('Follow-ups unavailable');
  app.rerender(<App session="another-user" />);
  await settled();
  expect(latest.data.accounts).toEqual([]);
  expect(latest.error).toBe('Follow-ups unavailable');
});

it('retains a mounted authorized view on transient account failure but not on a failed route-entry check', async () => {
  h.isAdmin = false;
  const app = render(<App />);
  await settled();
  h.accounts.mockRejectedValue(new Error('Connection lost'));
  await act(async () => { await latest.refetch(); });
  expect(latest.data.accounts[0].id).toBe('a');
  expect(latest.error).toBe('');
  expect(latest.refreshError).toBe('Connection lost');
  app.rerender(<App show={false} />);
  app.rerender(<App />);
  await settled();
  expect(latest.data.accounts).toEqual([]);
  expect(latest.data.commercial.entries).toEqual({});
  expect(latest.error).toBe('Connection lost');
  expect(h.contacts).toHaveBeenCalledTimes(1);
});

it('hydrates newly accessible accounts on consecutive route returns', async () => {
  h.isAdmin = false;
  const app = render(<App />);
  await settled();
  app.rerender(<App show={false} />);
  app.rerender(<App />);
  await settled();
  expect(h.contacts).toHaveBeenCalledTimes(2);
  expect(h.commercial).toHaveBeenCalledTimes(2);
  app.rerender(<App show={false} />);
  h.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
  app.rerender(<App />);
  await settled();
  expect(h.contacts).toHaveBeenCalledTimes(3);
  expect(h.commercial).toHaveBeenCalledTimes(3);
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['a', 'b']);
});

it('commercial-only refresh revalidates access even when superseding a full refresh', async () => {
  h.isAdmin = false;
  h.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
  render(<App />);
  await settled();
  const older = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ data: [account('b')] });
  let full!: Promise<void>;
  act(() => { full = latest.refetch(); });
  await act(async () => { await latest.refreshCommercial(); });
  await act(async () => { older.resolve({ data: [account('a')] }); await full; });
  expect(latest.data.accounts.map(row => row.id)).toEqual(['b']);
  expect(Object.keys(latest.data.commercial.entries)).toEqual(['b']);
  expect(h.accounts).toHaveBeenCalledTimes(3);
  expect(h.contacts).toHaveBeenCalledTimes(1);
  expect(h.quotes).toHaveBeenCalledTimes(1);
});

it('clears all rows for an authorization failure alongside transient detail failures', async () => {
  render(<App />);
  await settled();
  h.contacts.mockRejectedValue(new Error('Temporary lookup failure'));
  h.commercial.mockRejectedValue(Object.assign(new Error('Access denied'), { name: 'Unauthorized' }));
  await act(async () => { await latest.refetch(); });
  expect(latest.data.accounts).toEqual([]);
  expect(latest.data.contacts).toEqual([]);
  expect(latest.data.commercial.entries).toEqual({});
  expect(latest.error).toBe('Access denied');
  expect(latest.refreshError).toBe('');
});

it('does not expose the admin cache when switching to a scoped role without a provider remount', async () => {
  const app = render(<App />);
  await settled();
  h.isAdmin = false;
  h.accounts.mockReturnValue(deferred<{ data: Account[] }>().promise);
  app.rerender(<App />);
  expect(latest.data.accounts).toEqual([]);
  expect(latest.loaded).toBe(false);
});

it('preserves inline saves confirmed while account-access validation is still pending', async () => {
  h.isAdmin = false;
  render(<App />);
  await settled();
  const access = deferred<{ data: Account[] }>();
  h.accounts.mockReturnValue(access.promise);
  let refresh!: Promise<void>;
  act(() => { refresh = latest.refetch(); });
  act(() => latest.setCommercial(commercial(['a'], 5)));
  await act(async () => { access.resolve({ data: [account('a')] }); await refresh; });
  expect(latest.data.commercial.entries.a).toMatchObject({ workflowVersion: 5, salespersonId: 'owner-5', plan: { version: 5 }, snooze: { version: 5 } });
});

it('invalidates related data when a freshly authorized account has changed since caching', async () => {
  h.isAdmin = false;
  h.accounts.mockResolvedValue({ data: [{ ...account('a'), updatedAt: '2026-10-01T00:00:00Z' }] });
  const app = render(<App />);
  await settled();
  app.rerender(<App show={false} />);
  h.accounts.mockResolvedValue({ data: [{ ...account('a'), updatedAt: '2026-10-02T00:00:00Z' }] });
  app.rerender(<App />);
  await settled();
  expect(h.contacts).toHaveBeenCalledTimes(2);
  expect(h.commercial).toHaveBeenCalledTimes(2);
});

it.each([true, false])('rechecks failed contacts on commercial refresh, clearing incomplete status only after recovery (%s)', async recovered => {
  render(<App />);
  await settled();
  h.contacts.mockRejectedValue(new Error('Contacts unavailable'));
  await act(async () => { await latest.refetch(); });
  expect(latest.refreshError).toBe('Contacts unavailable');
  if (recovered) h.contacts.mockResolvedValue({ data: [{ id: 'contact', accountId: 'a' }] });
  await act(async () => { await latest.refreshCommercial(); });
  expect(h.contacts).toHaveBeenCalledTimes(3);
  expect(h.quotes).toHaveBeenCalledTimes(3);
  expect(latest.refreshError).toBe(recovered ? '' : 'Contacts unavailable');
  if (recovered) expect(latest.data.contacts[0].id).toBe('contact');
});

it('carries confirmed newer commercial versions across both stage caches before revalidation finishes', async () => {
  const app = render(<App />);
  await settled();
  app.rerender(<App stage="CLIENT" />);
  await settled();
  app.rerender(<App />);
  await settled();
  act(() => latest.setCommercial(commercial(['a'], 7)));
  h.accounts.mockReturnValue(deferred<{ data: Account[] }>().promise);
  app.rerender(<App stage="CLIENT" />);
  expect(latest.data.commercial.entries.a.workflowVersion).toBe(7);
  expect(latest.data.commercial.entries.a.plan.version).toBe(7);
  expect(h.commercial).toHaveBeenCalledTimes(3);
});

it.each(['new', 'stage-changed'])('withholds a %s snoozed lead until commercial hydration succeeds, including after failure', async change => {
  h.isAdmin = false;
  const initial = change === 'new' ? [account('a')] : [account('a'), account('b', 'B', 'CLIENT')];
  h.accounts.mockResolvedValue({ data: initial });
  render(<App />);
  await settled();
  h.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
  h.contacts.mockResolvedValue({ data: [{ id: 'new-contact', accountId: 'b' }] });
  const gate = deferred<void>();
  h.commercial.mockImplementation(() => gate.promise.then(() => { throw new Error('Snoozes unavailable'); }));
  let refresh!: Promise<void>;
  act(() => { refresh = latest.refetch(); });
  await waitFor(() => expect(h.commercial).toHaveBeenCalledTimes(2));
  expect(latest.data.accounts.map(row => row.id)).toEqual(['a']);
  expect(latest.data.commercial.entries).not.toHaveProperty('b');
  await act(async () => { gate.resolve(); await refresh; });
  expect(latest.refreshError).toBe('Snoozes unavailable');
  expect(latest.data.accounts.map(row => row.id)).toEqual(['a']);
  expect(latest.data.contacts).toEqual([]);
  expect(latest.data.commercial.entries).not.toHaveProperty('b');
  const hydrated = commercial(['a', 'b']);
  hydrated.entries.b.snooze = { accountId: 'b', version: 2, followUpOn: '2026-12-01', note: 'Wait until renewal' };
  h.commercial.mockResolvedValue(hydrated);
  h.contacts.mockRejectedValue(new Error('Contacts unavailable'));
  await act(async () => { await latest.refetch(); });
  expect(latest.data.accounts.map(row => row.id)).toEqual(['a', 'b']);
  expect(latest.data.commercial.entries.b.snooze?.followUpOn).toBe('2026-12-01');
  expect(latest.refreshError).toBe('Contacts unavailable');
});

it('does not insert newly discovered accounts into the other stage cache before it hydrates them', async () => {
  const app = render(<App />);
  await settled();
  app.rerender(<App stage="CLIENT" />);
  await settled();
  app.rerender(<App />);
  await settled();
  h.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
  const detail = deferred<CommercialData>();
  h.commercial.mockReturnValue(detail.promise);
  act(() => { void latest.refetch(); });
  await waitFor(() => expect(h.commercial).toHaveBeenCalledTimes(3));
  h.accounts.mockReturnValue(deferred<{ data: Account[] }>().promise);
  app.rerender(<App stage="CLIENT" />);
  expect(latest.data.accounts.map(row => row.id)).toEqual(['a']);
  expect(latest.data.commercial.entries).not.toHaveProperty('b');
});
