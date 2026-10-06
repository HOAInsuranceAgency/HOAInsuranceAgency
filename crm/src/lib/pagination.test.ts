import { expect, it, vi } from 'vitest';
import { listAllPages } from './pagination';
import { isAuthorizationError } from './authorizationError';

it('rejects GraphQL failure on the first page instead of returning an empty list', async () => {
  await expect(listAllPages(async () => ({ data: [], errors: [{ message: 'Service unavailable' }] })))
    .rejects.toThrow('Service unavailable');
});

it('rejects a failed later page rather than publishing a partial result', async () => {
  const fetchPage = vi.fn()
    .mockResolvedValueOnce({ data: ['one'], nextToken: 'next' })
    .mockResolvedValueOnce({ data: ['partial'], errors: [{ message: 'Read failed' }] });
  await expect(listAllPages(fetchPage)).rejects.toThrow('Read failed');
  expect(fetchPage).toHaveBeenNthCalledWith(2, 'next');
});

it('preserves authorization failures even when a transient error appears first', async () => {
  const error = await listAllPages(async () => ({ data: [], errors: [
    { message: 'Temporary issue' }, { message: 'Denied by resolver', errorType: 'Unauthorized' },
  ] })).catch(error => error);
  expect(isAuthorizationError(error)).toBe(true);
  expect(error.message).toBe('Denied by resolver');
});

it('continues through empty filtered pages and respects explicit page limits', async () => {
  const fetchPage = vi.fn()
    .mockResolvedValueOnce({ data: [], nextToken: 'two' })
    .mockResolvedValueOnce({ data: ['match'], nextToken: 'three' });
  await expect(listAllPages(fetchPage, { maxPages: 2 })).resolves.toEqual(['match']);
  expect(fetchPage).toHaveBeenCalledTimes(2);
});
