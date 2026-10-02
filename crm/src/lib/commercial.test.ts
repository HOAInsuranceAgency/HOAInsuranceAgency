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
  expect(batches.every(([, input]) => !('snoozeAccountIds' in input))).toBe(true);
  request.mockImplementation(async operation => operation === 'team' ? { team: [] } : { items: [] });
  await expect(loadCommercial(['a'])).rejects.toThrow('incomplete');
});
it('does not turn a failed roster request into unassigned totals', async () => {
  request.mockRejectedValue(new Error('Roster unavailable'));
  await expect(loadCommercial(['a'])).rejects.toThrow('Roster unavailable');
});
it('requests follow-ups only for the opted-in accounts in each bounded batch', async () => {
  request.mockImplementation(async (operation, input) => operation === 'team' ? { team: [] } : { items: input.accountIds.map((accountId: string) => ({ accountId })) });
  const ids = Array.from({ length: 51 }, (_, i) => `account-${String(i).padStart(2, '0')}`);
  await loadCommercial([...ids, ids[0]], [ids[0], ids[24], ids[25], ids[49], ids[25], 'outside-current-accounts']);
  const batches = request.mock.calls.filter(([operation]) => operation === 'commercialTable');
  expect(batches.map(([, input]) => input.accountIds.length)).toEqual([25, 25, 1]);
  expect(batches[0][1]).toEqual({ accountIds: ids.slice(0, 25), snoozeAccountIds: [ids[0], ids[24]] });
  expect(batches[1][1]).toEqual({ accountIds: ids.slice(25, 50), snoozeAccountIds: [ids[25], ids[49]] });
  expect(batches[2][1]).toEqual({ accountIds: [ids[50]] });
});
