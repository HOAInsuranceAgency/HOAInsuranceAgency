import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import type { CommercialData } from './commercial';

const h = vi.hoisted(() => ({ accounts: vi.fn(), contacts: vi.fn(), policies: vi.fn(), quotes: vi.fn(), commercial: vi.fn() }));
vi.mock('./client', async () => ({
  ...(await import('../../../shared/pagination')),
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  client: { models: { Account: { list: h.accounts }, Contact: { list: h.contacts }, Policy: { list: h.policies }, Quote: { list: h.quotes } } },
}));
vi.mock('./commercial', () => ({ loadCommercial: h.commercial }));
vi.mock('./auth', () => ({ useIsAdmin: () => true }));
import { AccountsListDataProvider, useAccountsListData } from './accountsListData';
import { liveUpdates } from './liveUpdates';

interface PageInput { nextToken?: string; limit?: number }
type Row = { id: string; accountId?: string; name: string; stage?: string; updatedAt: string };
let phase: 'initial' | 'background', count: number, label: string, stop: (() => void) | undefined;
const calls: { model: string; token?: string; limit?: number }[] = [];
const batches: string[][] = [];
function rows(model: string): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: model === 'Account' ? `a${i}` : `${model}${i}`,
    ...(model === 'Account' ? { stage: 'LEAD' } : { accountId: `a${i}` }), name: `${label}${i}`,
    updatedAt: phase === 'initial' ? '2026-11-01T00:00:00Z' : '2026-11-02T00:00:00Z' }));
}
function page(model: string, input: PageInput) {
  if (phase === 'background') calls.push({ model, token: input.nextToken, limit: input.limit });
  const offset = Number(input.nextToken ?? 0), size = input.limit ?? 100;
  return { data: rows(model).slice(offset, offset + size), nextToken: offset + size < count ? String(offset + size) : null };
}
function wrapper({ children }: { children: ReactNode }) { return <AccountsListDataProvider>{children}</AccountsListDataProvider>; }
async function advance(ms = 1_000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  vi.clearAllMocks(); phase = 'initial'; count = 101; label = 'Old'; calls.length = 0; batches.length = 0;
  h.accounts.mockImplementation(async input => page('Account', input));
  h.contacts.mockImplementation(async input => page('Contact', input));
  h.quotes.mockImplementation(async input => page('Quote', input));
  h.policies.mockResolvedValue({ data: [] });
  h.commercial.mockImplementation(async (ids: string[]): Promise<CommercialData> => {
    if (phase === 'background') batches.push([...ids]);
    return { team: [], entries: Object.fromEntries(ids.map(id => [id, {
      accountId: id, workflowVersion: 1, plan: emptyCommercialPlan(id),
    }])) };
  });
});
afterEach(() => { cleanup(); stop?.(); stop = undefined; vi.useRealTimers(); });

it('coalesces a 201-account cycle into bounded turns and publishes only the complete book', async () => {
  const { result } = renderHook(() => useAccountsListData('LEAD'), { wrapper });
  await act(async () => {});
  expect(result.current.loaded).toBe(true);
  expect(result.current.data.accounts).toHaveLength(101);
  // The complete initial read is unchanged; only automatic work is incremental.
  expect(h.commercial).toHaveBeenCalledWith(Array.from({ length: 101 }, (_, i) => `a${i}`), expect.any(Array));
  phase = 'background'; count = 201; label = 'New';
  act(() => { stop = liveUpdates.start('account-cycle-test'); liveUpdates.invalidate(['OWNER', 'PERSONAL']); });
  await advance(100);
  expect(calls).toEqual([]);
  act(() => liveUpdates.invalidate(['CRM']));
  await advance(100);
  expect(calls).toEqual([{ model: 'Account', token: undefined, limit: 100 }]);
  expect(result.current.refreshing).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.data.accounts).toHaveLength(101);
  expect(result.current.data.accounts[0].name).toBe('Old0');
  for (let turn = 0; turn < 10; turn++) {
    const before = calls.length, beforeBatches = batches.length;
    act(() => { for (let n = 0; n < 30; n++) liveUpdates.invalidate(); });
    await advance();
    const added = calls.slice(before);
    for (const model of ['Account', 'Contact', 'Quote']) expect(added.filter(call => call.model === model).length).toBeLessThanOrEqual(1);
    expect(batches.length - beforeBatches).toBeLessThanOrEqual(1);
    if (turn < 9) {
      expect(result.current.refreshing).toBe(true);
      expect(result.current.data.accounts).toHaveLength(101);
      expect(result.current.data.accounts[0].name).toBe('Old0');
      expect(result.current.data.contacts).toHaveLength(101);
    }
  }
  expect(calls.filter(call => call.model === 'Account').map(call => call.token)).toEqual([undefined, '100', '200']);
  expect(calls.every(call => call.limit === 100)).toBe(true);
  expect(batches.map(batch => batch.length)).toEqual([25, 25, 25, 25, 25, 25, 25, 25, 1]);
  expect(batches.flat()).toEqual(Array.from({ length: 201 }, (_, i) => `a${i}`));
  expect(result.current.refreshing).toBe(false);
  expect(result.current.data.accounts).toHaveLength(201);
  expect(result.current.data.contacts).toHaveLength(201);
  expect(result.current.data.quotes).toHaveLength(201);
  expect(result.current.data.accounts.every(account => account.name?.startsWith('New'))).toBe(true);
  const completedCalls = calls.length;
  act(() => { for (let n = 0; n < 100; n++) liveUpdates.invalidate(); });
  await advance(59_000);
  expect(calls).toHaveLength(completedCalls);
  await advance();
  expect(calls.slice(completedCalls)).toEqual([{ model: 'Account', token: undefined, limit: 100 }]);
});

it('discards candidate pages after editing and restarts immediately without the completed-cycle delay', async () => {
  const { result } = renderHook(() => useAccountsListData('LEAD'), { wrapper });
  await act(async () => {});
  phase = 'background'; count = 201; label = 'BeforeEdit';
  act(() => { stop = liveUpdates.start('account-cycle-edit-test'); liveUpdates.invalidate(); });
  await advance(100);
  expect(result.current.refreshing).toBe(true);
  let release!: () => void;
  act(() => { release = liveUpdates.acquireBlock(); });
  await advance(5_000);
  expect(calls).toHaveLength(1);
  label = 'AfterEdit';
  act(() => release());
  await advance(1);
  expect(calls.filter(call => call.model === 'Account').map(call => call.token)).toEqual([undefined, undefined]);
  expect(result.current.data.accounts[0].name).toBe('Old0');
  await advance(10_000);
  expect(result.current.refreshing).toBe(false);
  expect(result.current.data.accounts).toHaveLength(201);
  expect(result.current.data.accounts.every(account => account.name?.startsWith('AfterEdit'))).toBe(true);
});
