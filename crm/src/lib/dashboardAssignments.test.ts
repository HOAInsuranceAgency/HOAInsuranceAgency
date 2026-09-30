import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./communications', () => ({ communicationRequest: h.request }));
import { loadAssignments } from './dashboardAssignments';
beforeEach(() => { h.request.mockReset(); });
it('loads a large scoped report in bounded requests without fetching commercial plans', async () => {
  let active = 0, maxActive = 0;
  h.request.mockImplementation(async (operation, input) => {
    if (operation === 'team') return { team: [{ userId: 'sales', name: 'Sales', salesperson: true }] };
    expect(operation).toBe('dashboardAssignments');
    active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve(); active--;
    return { items: input.accountIds.map((accountId: string) => ({ accountId, salespersonId: 'sales' })), accounts: input.accountIds.map((id: string) => ({ id, name: id })) };
  });
  const ids = Array.from({ length: 2301 }, (_, i) => `a${i}`);
  const result = await loadAssignments([...ids, ids[0]]);
  expect(Object.keys(result.entries)).toHaveLength(2301);
  expect(result.accounts).toHaveLength(2301);
  expect(h.request.mock.calls.filter(([op]) => op === 'dashboardAssignments').map(([, input]) => input.accountIds.length)).toEqual([500, 500, 500, 500, 301]);
  expect(maxActive).toBe(4);
});
it('retains the team when a selected window has no production', async () => {
  h.request.mockResolvedValue({ team: [{ userId: 'sales' }] });
  expect(await loadAssignments([])).toMatchObject({ entries: {}, accounts: [], team: [{ userId: 'sales' }] });
  expect(h.request).toHaveBeenCalledTimes(1);
});
it('rejects partial assignment results instead of publishing missing owners', async () => {
  h.request.mockImplementation(async operation => operation === 'team' ? { team: [] } : { items: [], accounts: [] });
  await expect(loadAssignments(['a'])).rejects.toThrow('incomplete');
});
