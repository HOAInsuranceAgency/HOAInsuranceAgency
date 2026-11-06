import { describe, expect, it, vi } from 'vitest';
import type { Account, Contact, Policy, Quote } from './client';
import type { AccountsListData } from './accountsListData';
import type { CommercialData } from './commercial';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import { createAccountListRefreshCycle } from './accountsListRefresh';

type Page<T> = { data: T[]; nextToken?: string | null; errors?: readonly unknown[] };
const account = (id: string, stage: 'LEAD' | 'CLIENT' = 'LEAD') => ({ id, name: id, stage }) as Account;
const commercial = (ids: string[]): CommercialData => ({ team: [], entries: Object.fromEntries(ids.map(id => [id, { accountId: id, plan: emptyCommercialPlan(id), workflowVersion: 1 }])) });
const previous = (ids: string[] = []): AccountsListData => ({ accounts: ids.map(id => account(id)), contacts: [], policies: [], quotes: [], commercial: commercial(ids), quoteError: '' });
function loaders() {
  return {
    accounts: vi.fn(async (_token?: string): Promise<Page<Account>> => ({ data: [account('a')] })),
    contacts: vi.fn(async (_token?: string): Promise<Page<Contact>> => ({ data: [] })),
    policies: vi.fn(async (_token?: string): Promise<Page<Policy>> => ({ data: [] })),
    quotes: vi.fn(async (_token?: string): Promise<Page<Quote>> => ({ data: [] })),
    commercial: vi.fn(async (ids: string[], _snoozeIds: string[]) => commercial(ids)),
  };
}

describe('incremental account-list refresh', () => {
  it.each(['LEAD', 'CLIENT'] as const)('finishes a small %s book in one bounded turn without reading the other detail model', async stage => {
    const read = loaders(); read.accounts.mockResolvedValue({ data: [account('a', stage)] });
    const cycle = createAccountListRefreshCycle(stage, previous(), read);
    const result = await cycle.advance();
    expect(result.complete).toBe(true);
    expect(result.snapshot?.accounts.map(row => row.id)).toEqual(['a']);
    expect(read.accounts).toHaveBeenCalledTimes(1); expect(read.contacts).toHaveBeenCalledTimes(1);
    expect(read.quotes).toHaveBeenCalledTimes(stage === 'LEAD' ? 1 : 0);
    expect(read.policies).toHaveBeenCalledTimes(stage === 'CLIENT' ? 1 : 0);
    expect(read.commercial).toHaveBeenCalledWith(['a'], stage === 'LEAD' ? ['a'] : []);
    await cycle.advance();
    expect(read.accounts).toHaveBeenCalledTimes(1); expect(read.commercial).toHaveBeenCalledTimes(1);
  });

  it('advances account pages across turns, caps commercial hydration at25, and publishes only a complete global snapshot', async () => {
    const read = loaders();
    const first = Array.from({ length: 100 }, (_, i) => account(`a${String(i).padStart(3, '0')}`));
    const last = account('a100');
    read.accounts.mockImplementation(async token => token ? { data: [last] } : { data: first, nextToken: 'accounts-2' });
    const cycle = createAccountListRefreshCycle('LEAD', previous(['old']), read);
    const partial = await cycle.advance();
    expect(partial.complete).toBe(false); expect(partial.snapshot).toBeUndefined(); expect(partial.accounts).toBeUndefined();
    expect(read.accounts).toHaveBeenCalledTimes(1); expect(read.contacts).not.toHaveBeenCalled(); expect(read.commercial).not.toHaveBeenCalled();
    let final: Awaited<ReturnType<typeof cycle.advance>> | undefined;
    for (let turn = 0; turn < 8; turn++) {
      const counts = [read.accounts, read.contacts, read.quotes, read.policies, read.commercial].map(fn => fn.mock.calls.length);
      const step = await cycle.advance();
      for (const [index, fn] of [read.accounts, read.contacts, read.quotes, read.policies, read.commercial].entries()) {
        expect(fn.mock.calls.length - counts[index]).toBeLessThanOrEqual(1);
      }
      if (step.complete) { final = step; break; }
      expect(step.snapshot).toBeUndefined();
    }
    expect(read.accounts.mock.calls.map(args => args[0])).toEqual([undefined, 'accounts-2']);
    expect(read.commercial.mock.calls.map(args => args[0].length)).toEqual([25, 25, 25, 25, 1]);
    expect(final?.snapshot?.accounts.map(row => row.id)).toEqual([...first, last].map(row => row.id));
    expect(Object.keys(final?.snapshot?.commercial.entries ?? {})).toHaveLength(101);
  });

  it('retains all related pages atomically and drops rows outside the complete authorized account set', async () => {
    const read = loaders(); read.accounts.mockResolvedValue({ data: [account('a'), account('b')] });
    read.contacts.mockImplementation(async token => token ? { data: [{ id: 'cb', accountId: 'b' } as Contact] }
      : { data: [{ id: 'ca', accountId: 'a' }, { id: 'foreign', accountId: 'orphan' }] as Contact[], nextToken: 'contacts-2' });
    read.quotes.mockImplementation(async token => token ? { data: [{ id: 'qb', accountId: 'b' } as Quote] }
      : { data: [{ id: 'qa', accountId: 'a' }, { id: 'foreign', accountId: 'orphan' }] as Quote[], nextToken: 'quotes-2' });
    const cycle = createAccountListRefreshCycle('LEAD', previous(), read);
    const first = await cycle.advance();
    expect(first.complete).toBe(false); expect(first.snapshot).toBeUndefined();
    expect(read.contacts).toHaveBeenCalledTimes(1); expect(read.quotes).toHaveBeenCalledTimes(1);
    const second = await cycle.advance();
    expect(second.complete).toBe(true);
    expect(second.snapshot?.contacts.map(row => row.id)).toEqual(['ca', 'cb']);
    expect(second.snapshot?.quotes.map(row => row.id)).toEqual(['qa', 'qb']);
    expect(read.contacts.mock.calls.map(args => args[0])).toEqual([undefined, 'contacts-2']);
    expect(read.quotes.mock.calls.map(args => args[0])).toEqual([undefined, 'quotes-2']);
  });

  it('keeps the complete previous collection on a related failure, removes revoked rows, and reports a warning', async () => {
    const read = loaders(); const old = previous(['a', 'revoked']);
    old.contacts = [{ id: 'old-contact', accountId: 'a' }, { id: 'revoked-contact', accountId: 'revoked' }] as Contact[];
    read.accounts.mockResolvedValue({ data: [account('a'), account('new')] });
    read.contacts.mockRejectedValue(new Error('Contacts temporarily unavailable'));
    const result = await createAccountListRefreshCycle('LEAD', old, read).advance();
    expect(result.complete).toBe(true); expect(result.refreshError).toContain('Contacts temporarily unavailable');
    expect(result.snapshot?.accounts.map(row => row.id)).toEqual(['a', 'new']);
    expect(result.snapshot?.contacts.map(row => row.id)).toEqual(['old-contact']);
    expect(Object.keys(result.snapshot?.commercial.entries ?? {})).toEqual(['a', 'new']);
    expect(old.accounts.map(row => row.id)).toEqual(['a', 'revoked']);
  });

  it('discards a partial commercial refresh and withholds new accounts if a later batch fails', async () => {
    const read = loaders(); const old = previous(['a00', 'revoked']);
    const accounts = Array.from({ length: 26 }, (_, i) => account(`a${String(i).padStart(2, '0')}`));
    read.accounts.mockResolvedValue({ data: accounts });
    read.commercial.mockResolvedValueOnce(commercial(accounts.slice(0, 25).map(row => row.id)))
      .mockRejectedValueOnce(new Error('Assignment details temporarily unavailable'));
    const cycle = createAccountListRefreshCycle('LEAD', old, read);
    expect(await cycle.advance()).toMatchObject({ complete: false });
    const complete = await cycle.advance();
    expect(complete.complete).toBe(true); expect(complete.refreshError).toContain('Assignment details temporarily unavailable');
    expect(complete.snapshot?.accounts.map(row => row.id)).toEqual(['a00']);
    expect(complete.snapshot?.commercial.entries).toEqual({ a00: old.commercial.entries.a00 });
    expect(read.commercial.mock.calls.map(args => args[0].length)).toEqual([25, 1]);
  });

  it('lets authorization denial override a simultaneous transient detail failure before publishing any snapshot', async () => {
    const read = loaders(); const denied = Object.assign(new Error('Access denied'), { name: 'Unauthorized' });
    read.contacts.mockRejectedValue(new Error('Network temporarily unavailable'));
    read.quotes.mockResolvedValue({ data: [], errors: [{ message: 'Access denied', errorType: 'Unauthorized' }] });
    const onDenied = vi.fn();
    const cycle = createAccountListRefreshCycle('LEAD', previous(['a']), read, onDenied);
    await expect(cycle.advance()).rejects.toThrow('Access denied');
    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied.mock.calls[0][0]).toMatchObject({ name: denied.name });
  });

  it('signals revoked access immediately even when another related page has not settled', async () => {
    const read = loaders(); let finish!: (page: Page<Contact>) => void;
    read.contacts.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    read.quotes.mockRejectedValue(Object.assign(new Error('Access denied'), { name: 'Unauthorized' }));
    const onDenied = vi.fn();
    const work = createAccountListRefreshCycle('LEAD', previous(['a']), read, onDenied).advance();
    const rejected = expect(work).rejects.toThrow('Access denied');
    await vi.waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
    finish({ data: [] });
    await rejected;
  });

  it('rejects an oversized account page instead of processing an unbounded response', async () => {
    const read = loaders(); read.accounts.mockResolvedValue({ data: Array.from({ length: 101 }, (_, i) => account(String(i))) });
    await expect(createAccountListRefreshCycle('LEAD', previous(), read).advance()).rejects.toThrow();
    expect(read.contacts).not.toHaveBeenCalled(); expect(read.commercial).not.toHaveBeenCalled();
  });

  it('fails closed when an account continuation repeats instead of draining indefinitely', async () => {
    const read = loaders(); read.accounts.mockResolvedValue({ data: [], nextToken: 'repeated' });
    const cycle = createAccountListRefreshCycle('LEAD', previous(['a']), read);
    await expect(cycle.advance()).resolves.toMatchObject({ complete: false });
    await expect(cycle.advance()).rejects.toThrow();
    expect(read.accounts).toHaveBeenCalledTimes(2); expect(read.contacts).not.toHaveBeenCalled();
  });

  it('treats an oversized or repeating related page as unavailable rather than publishing partial columns', async () => {
    for (const oversized of [true, false]) {
      const read = loaders(); const old = previous(['a']); old.contacts = [{ id: 'saved', accountId: 'a' }] as Contact[];
      read.contacts.mockResolvedValue(oversized ? { data: Array.from({ length: 101 }, (_, i) => ({ id: String(i), accountId: 'a' } as Contact)) } : { data: [], nextToken: 'repeated' });
      const cycle = createAccountListRefreshCycle('LEAD', old, read);
      let result = await cycle.advance();
      if (!result.complete) result = await cycle.advance();
      expect(result.complete).toBe(true); expect(result.refreshError).toBeTruthy();
      expect(result.snapshot?.contacts.map(row => row.id)).toEqual(['saved']);
    }
  });
});
