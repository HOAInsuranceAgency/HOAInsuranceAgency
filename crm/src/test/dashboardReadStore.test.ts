import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../amplify/functions/communications/store', () => ({ db: { send: h.send }, table: () => 'communications' }));
import { reportBatchGet } from '../../amplify/functions/communications/dashboardStore';
import { dashboardAssignments } from '../../amplify/functions/communications/dashboardAssignments';
beforeEach(() => { h.send.mockReset(); process.env.ACCOUNT_TABLE = 'accounts'; });
it('projects only report fields, retries unprocessed records, and caps batches at 100', async () => {
  let retry = true;
  h.send.mockImplementation(async ({ input }) => {
    const [table, request] = Object.entries(input.RequestItems)[0] as [string, { Keys: { id: string }[]; ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> }];
    expect(request.Keys.length).toBeLessThanOrEqual(100);
    expect(Object.values(request.ExpressionAttributeNames)).toEqual(['id', 'name']);
    if (retry) { retry = false; return { Responses: { [table]: request.Keys.slice(1) }, UnprocessedKeys: { [table]: { Keys: request.Keys.slice(0, 1) } } }; }
    return { Responses: { [table]: request.Keys } };
  });
  const rows = await reportBatchGet('accounts', Array.from({ length: 250 }, (_, i) => `a${i}`), ['name']);
  expect(rows.size).toBe(250);
  expect(h.send).toHaveBeenCalledTimes(4);
});
it('does not turn persistently throttled keys into deleted accounts', async () => {
  h.send.mockImplementation(async ({ input }) => ({ UnprocessedKeys: input.RequestItems }));
  await expect(reportBatchGet('accounts', ['a'], ['name'])).rejects.toThrow('incomplete');
});
it('returns one attribution entry per requested account without package contents', async () => {
  h.send.mockImplementation(async ({ input }) => input.RequestItems.accounts
    ? { Responses: { accounts: [{ id: 'a', name: 'Elm HOA' }] } }
    : { Responses: { communications: [{ id: 'workflow:a', data: { salespersonId: 'sam', disposition: 'ACTIVE' } }] } });
  expect(await dashboardAssignments({ accountIds: ['a', 'deleted', 'a'] })).toEqual({
    items: [{ accountId: 'a', salespersonId: 'sam', disposition: 'ACTIVE' }, { accountId: 'deleted', salespersonId: undefined, disposition: undefined }], accounts: [{ id: 'a', name: 'Elm HOA' }],
  });
  await expect(dashboardAssignments({ accountIds: ['bad:id'] })).rejects.toThrow('valid report');
});
