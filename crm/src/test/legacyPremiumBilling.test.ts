import { beforeEach, expect, it, vi } from 'vitest';
import { assertPremiumNotFinanced } from '../../amplify/functions/grouped-draft-billing';

const store = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/store', () => ({
  accountModels: store.list, modelTable: () => 'loans', db: { send: store.send },
}));
const closed = (id: string) => ({ id, accountId: 'account', status: 'CANCELLED' });
const check = (source?: string) => assertPremiumNotFinanced('account', ['policy'], 'quote', source);
beforeEach(() => { vi.resetAllMocks(); store.list.mockResolvedValue([]); });

it('reads distinct matching policies, package members, quotes and explicit sources in strongly consistent batches', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i), policyId: 'policy' }));
  store.list.mockResolvedValue([...rows, rows[0], { id: 'package', groupedPolicyIds: ['policy'] }, { id: 'quote-loan', quoteId: 'quote' }, { id: 'other', policyId: 'other' }]);
  store.send.mockImplementation(async ({ input }) => {
    const request = input.RequestItems.loans;
    expect(request.ConsistentRead).toBe(true);
    return { Responses: { loans: request.Keys.map(({ id }: { id: string }) => closed(id)).reverse() } };
  });
  await expect(check('source')).resolves.toBeUndefined();
  const requests = store.send.mock.calls.map(([command]) => command.input.RequestItems.loans.Keys.map(({ id }: { id: string }) => id));
  expect(requests.map(batch => batch.length)).toEqual([100, 4]);
  expect(requests.flat()).toEqual([...rows.map(row => row.id), 'package', 'quote-loan', 'source']);
});

it('retries only unprocessed IDs and blocks using the current primary records', async () => {
  store.list.mockResolvedValue([{ id: 'a', policyId: 'policy', status: 'CANCELLED' }]);
  store.send.mockResolvedValueOnce({ Responses: { loans: [closed('a')] }, UnprocessedKeys: { loans: { Keys: [{ id: 'source' }] } } })
    .mockResolvedValueOnce({ Responses: { loans: [{ ...closed('source'), status: 'ACTIVE' }] } });
  await expect(check('source')).rejects.toThrow('existing financing agreement');
  expect(store.send.mock.calls[1][0].input.RequestItems.loans).toEqual({ Keys: [{ id: 'source' }], ConsistentRead: true });
});

it.each([[], [{ ...closed('source'), accountId: 'wrong' }]])('requires the independently supplied source to exist on this account', async (...rows) => {
  store.send.mockResolvedValue({ Responses: { loans: rows } });
  await expect(check('source')).rejects.toThrow('could not be verified');
});

it('refuses to clear billing after repeated throttling and skips the batch when there are no candidates', async () => {
  await expect(check()).resolves.toBeUndefined();
  expect(store.send).not.toHaveBeenCalled();
  store.send.mockResolvedValue({ UnprocessedKeys: { loans: { Keys: [{ id: 'source' }] } } });
  await expect(check('source')).rejects.toThrow('could not be verified');
  expect(store.send).toHaveBeenCalledTimes(5);
});
