import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('./communications', () => ({ communicationRequest: request }));
import { useWorkItems } from './communicationWork';
import { invalidateLiveUpdates } from '../test/liveUpdates';

it.each([true, false])('handles a later-page failure without retaining denied records (denial=%s)', async denied => {
  request.mockResolvedValueOnce({ items: [{ id: 'one', version: 1 }], nextToken: 'two' })
    .mockRejectedValueOnce(denied ? Object.assign(new Error('Access denied'), { name: 'Unauthorized' }) : new Error('Connection lost'));
  const { result } = renderHook(() => useWorkItems('ISSUE'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => { await result.current.loadMore(); });
  expect(result.current.data.items).toHaveLength(denied ? 0 : 1);
  expect(denied ? result.current.error : result.current.pageError).toBeTruthy();
  expect(result.current.loadingMore).toBe(false);
});

it('refreshes every opened work page without replacing the queue with only page one', async () => {
  request.mockReset();
  let version = 1;
  request.mockImplementation(async (_op, input) => ({ items: [{ id: input.nextToken ? 'two' : 'one', version }], nextToken: input.nextToken ? 'unopened' : 'two' }));
  const { result } = renderHook(() => useWorkItems('ISSUE'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => result.current.loadMore());
  version = 2;
  await invalidateLiveUpdates();
  expect(result.current.data.items).toEqual([{ id: 'one', version: 2 }, { id: 'two', version: 2 }]);
  expect(request.mock.calls.map(call => call[1].nextToken)).toEqual([undefined, 'two', undefined, 'two']);
});
