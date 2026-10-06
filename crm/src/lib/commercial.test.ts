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
it('loads at most four commercial batches at once while preserving sorted unique account ids', async () => {
  let active = 0, maxActive = 0;
  request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team: [{ userId: 'sales', name: 'Sales', salesperson: true }] };
    active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve(); active--;
    return { items: input.accountIds.map((accountId: string) => ({ accountId, salespersonId: 'sales' })) };
  });
  const ids = Array.from({ length: 126 }, (_, i) => `account-${String(i).padStart(3, '0')}`);
  const result = await loadCommercial([...ids].reverse().concat(ids[0]));
  const batches = request.mock.calls.filter(([operation]) => operation === 'commercialTable');
  expect(batches.map(([, input]) => input.accountIds.length)).toEqual([25, 25, 25, 25, 25, 1]);
  expect(batches.flatMap(([, input]) => input.accountIds)).toEqual(ids);
  expect(maxActive).toBe(4);
  expect(Object.keys(result.entries)).toEqual(ids);
  expect(result.team).toEqual([{ userId: 'sales', name: 'Sales', salesperson: true }]);
});
it('settles all in-flight batches and rejects the snapshot without launching further batches after a failure', async () => {
  const batches: { accountIds: string[]; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  request.mockImplementation((operation, input) => operation === 'team' ? { team: [] } : new Promise((resolve, reject) => {
    batches.push({ accountIds: input.accountIds, resolve, reject });
  }));
  const settled = vi.fn();
  const pending = loadCommercial(Array.from({ length: 101 }, (_, i) => `account-${i}`));
  void pending.then(settled, settled);
  await vi.waitFor(() => expect(batches).toHaveLength(4));
  batches[0].reject(new Error('First batch unavailable'));
  batches[1].reject(new Error('Second batch unavailable'));
  batches[2].resolve({ items: batches[2].accountIds.map(accountId => ({ accountId })) });
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  batches[3].resolve({ items: batches[3].accountIds.map(accountId => ({ accountId })) });
  await expect(pending).rejects.toThrow('First batch unavailable');
  expect(batches).toHaveLength(4);
});
it('rejects an incomplete later batch instead of returning an earlier successful wave', async () => {
  let batchCount = 0;
  request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team: [] };
    batchCount++;
    return { items: batchCount === 5 ? [] : input.accountIds.map((accountId: string) => ({ accountId })) };
  });
  await expect(loadCommercial(Array.from({ length: 101 }, (_, i) => `account-${i}`))).rejects.toThrow('incomplete');
  expect(batchCount).toBe(5);
});
it.each([0, 1])('prioritizes access denial over transient errors in concurrent batches (denied batch %s)', async deniedBatch => {
  const denied = Object.assign(new Error('This record is not available to your account'), { name: 'Unauthorized' });
  let batch = 0;
  request.mockImplementation(async operation => {
    if (operation === 'team') return { team: [] };
    throw batch++ === deniedBatch ? denied : new Error('Temporary service failure');
  });
  await expect(loadCommercial(Array.from({ length: 50 }, (_, i) => `account-${i}`))).rejects.toBe(denied);
  expect(batch).toBe(2);
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
