import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePagedList } from './usePagedList';
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
