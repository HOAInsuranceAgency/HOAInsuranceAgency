import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('./communications', () => ({ communicationRequest: request }));
import { useWorkItems } from './communicationWork';

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
