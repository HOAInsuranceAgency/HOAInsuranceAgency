import { beforeEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('./communications', () => ({ communicationRequest: request }));
import { loadCommercial } from './commercial';
beforeEach(() => { request.mockReset(); });
it('loads deduplicated assignments in bounded batches and fails an incomplete snapshot', async () => {
  request.mockImplementation(async (operation, input) => operation === 'team' ? { team: [] } : { items: input.accountIds.map((accountId: string) => ({ accountId, salespersonId: 'a' })) });
  const ids = Array.from({ length: 26 }, (_, i) => `account-${i}`);
  const result = await loadCommercial([...ids, ids[0]]);
  expect(Object.keys(result.entries)).toHaveLength(26);
  const batches = request.mock.calls.filter(([operation]) => operation === 'commercialTable');
  expect(batches.map(([, input]) => input.accountIds.length)).toEqual([25, 1]);
  request.mockImplementation(async operation => operation === 'team' ? { team: [] } : { items: [] });
  await expect(loadCommercial(['a'])).rejects.toThrow('incomplete');
});
it('does not turn a failed roster request into unassigned totals', async () => {
  request.mockRejectedValue(new Error('Roster unavailable'));
  await expect(loadCommercial(['a'])).rejects.toThrow('Roster unavailable');
});
