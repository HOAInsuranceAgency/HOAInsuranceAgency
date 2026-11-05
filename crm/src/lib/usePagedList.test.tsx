import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePagedList } from './usePagedList';
import { invalidateLiveUpdates } from '../test/liveUpdates';
import { liveUpdates } from './liveUpdates';
it('does not drain continuations automatically and discards responses for a previous query', async () => {
  let late!: (page: any) => void;
  const fetch = vi.fn((query: string, token?: string) => query === 'old' ? new Promise<any>(resolve => { late = resolve; }) : Promise.resolve({ items: [{ id: token ? 'second' : 'first' }], nextToken: token ? undefined : 'next' }));
  const { result, rerender } = renderHook(({ query }) => usePagedList(token => fetch(query, token), [query]), { initialProps: { query: 'old' } });
  rerender({ query: 'new' });
  await waitFor(() => expect(result.current.items).toEqual([{ id: 'first' }]));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => late({ items: [{ id: 'stale' }] }));
  expect(result.current.items).toEqual([{ id: 'first' }]);
  await act(async () => { await result.current.more(); });
  expect(result.current.items).toEqual([{ id: 'first' }, { id: 'second' }]);
});
it('clears loaded records if the next page reports lost authorization', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ items: [{ id: 'restricted' }], nextToken: 'next' }).mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { name: 'Unauthorized' }));
  const { result } = renderHook(() => usePagedList(fetch, []));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  await act(async () => { await result.current.more(); });
  expect(result.current.items).toEqual([]);
  expect(result.current.nextToken).toBeUndefined();
});

it('refreshes every loaded page while retaining rows and never loading unopened history', async () => {
  let fresh = false;
  const fetch = vi.fn(async (token?: string) => ({
    items: [{ id: token ? 'second' : 'first', name: fresh ? 'updated' : 'old' }],
    nextToken: token ? 'unopened-third' : 'second-page',
  }));
  const { result } = renderHook(() => usePagedList(fetch, []));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  await act(async () => result.current.more());
  fresh = true;
  await invalidateLiveUpdates();
  expect(result.current.items).toEqual([{ id: 'first', name: 'updated' }, { id: 'second', name: 'updated' }]);
  expect(fetch.mock.calls.map(call => call[0])).toEqual([undefined, 'second-page', undefined, 'second-page']);
  expect(result.current.nextToken).toBe('unopened-third');
});

it('discards a background result if editing starts during its request and retries once the editor closes', async () => {
  let finish!: (page: { items: { id: string }[] }) => void;
  const fetch = vi.fn().mockResolvedValueOnce({ items: [{ id: 'original' }] })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ items: [{ id: 'fresh' }] });
  const { result } = renderHook(() => usePagedList(fetch, []));
  await waitFor(() => expect(result.current.items).toEqual([{ id: 'original' }]));
  await invalidateLiveUpdates();
  let release!: () => void;
  act(() => { release = liveUpdates.acquireBlock(); });
  await act(async () => finish({ items: [{ id: 'stale' }] }));
  expect(result.current.items).toEqual([{ id: 'original' }]);
  act(() => release());
  await waitFor(() => expect(result.current.items).toEqual([{ id: 'fresh' }]));
});

it('retains the last successful snapshot on background failure but clears it immediately on denial', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ items: [{ id: 'private' }] }).mockRejectedValueOnce(new Error('Connection lost'));
  const { result } = renderHook(() => usePagedList(fetch, []));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  await invalidateLiveUpdates();
  expect(result.current.items).toEqual([{ id: 'private' }]);
  expect(result.current.error).toBe(''); expect(result.current.refreshError).toBe('Connection lost');
  fetch.mockRejectedValueOnce(Object.assign(new Error('Access denied'), { name: 'Unauthorized' }));
  await invalidateLiveUpdates();
  expect(result.current.items).toEqual([]); expect(result.current.error).toBe('Access denied');
});
