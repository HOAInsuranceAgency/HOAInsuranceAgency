// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../amplify/functions/communications/store', () => ({ db: { send } }));
import { dashboardInterestPage, dashboardPolicyAnchors } from '../../amplify/functions/communications/dashboardFinanceRead';

const from = '2026-08-31T16:00:00.000Z', to = '2026-09-30T16:00:00.000Z';
beforeEach(() => {
  send.mockReset();
  vi.stubEnv('DASHBOARD_PAYMENT_TABLE', 'payments');
  vi.stubEnv('DASHBOARD_PAYMENT_INDEX', 'payments-by-date');
  vi.stubEnv('DASHBOARD_POLICY_TABLE', 'policies');
});

it('queries the indexed recent window in bounded pages and binds its cursor to the same window', async () => {
  const key = { id: 'receipt-1', __typename: 'PfLoanPayment', postedAt: from };
  send.mockResolvedValueOnce({ Items: [{ ...key, accountId: 'account-1', interest: 12.34, postedBy: 'private-user' }], LastEvaluatedKey: key });
  const first = await dashboardInterestPage({ from, to });
  expect(first.items).toEqual([{ id: 'receipt-1', accountId: 'account-1', postedAt: from, interest: 12.34 }]);
  expect(send.mock.calls[0][0].input).toEqual(expect.objectContaining({
    TableName: 'payments', IndexName: 'payments-by-date', Limit: 500,
    KeyConditionExpression: '#type = :type AND #posted BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':type': 'PfLoanPayment', ':from': from, ':to': to },
    ProjectionExpression: '#id, #account, #posted, #interest',
  }));
  send.mockResolvedValueOnce({ Items: [{ id: 'receipt-2', accountId: 'account-2', postedAt: to, interest: 4 }] });
  await dashboardInterestPage({ from, to, nextToken: first.nextToken });
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(key);
  await expect(dashboardInterestPage({ from: '2026-09-01T16:00:00.000Z', to, nextToken: first.nextToken })).rejects.toThrow('page token');
  expect(send).toHaveBeenCalledTimes(2);
});

it('refuses malformed/unbounded dates and cursors without issuing a read', async () => {
  for (const input of [
    { from: '2026-01-01T00:00:00.000Z', to },
    { from: to, to: from },
    { from: '2026-02-30T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    { from, to, nextToken: 'not-json' },
    { from, to, nextToken: Buffer.from(JSON.stringify({ version: 1, from, to, key: { id: 'r', __typename: 'DifferentModel', postedAt: from } })).toString('base64url') },
  ]) await expect(dashboardInterestPage(input)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it('propagates an unavailable index without a whole-history scan fallback', async () => {
  send.mockRejectedValue(new Error('Index is not active'));
  await expect(dashboardInterestPage({ from, to })).rejects.toThrow('Index is not active');
  expect(send).toHaveBeenCalledTimes(1);
});

it('retries unprocessed policy keys and returns only the referenced anchor fields', async () => {
  send.mockResolvedValueOnce({
    Responses: { policies: [{ id: 'p1', accountId: 'a', quoteId: 'q1', premium: 50000 }] },
    UnprocessedKeys: { policies: { Keys: [{ id: 'p2' }] } },
  }).mockResolvedValueOnce({ Responses: { policies: [{ id: 'p2', accountId: 'b' }] } });
  const result = await dashboardPolicyAnchors({ policyIds: ['p1', 'p2', 'missing', 'p1'] });
  expect(result).toEqual({ items: [{ id: 'p1', accountId: 'a', quoteId: 'q1' }, { id: 'p2', accountId: 'b' }], missingIds: ['missing'] });
  expect(send.mock.calls[0][0].input.RequestItems.policies.Keys).toEqual([{ id: 'p1' }, { id: 'p2' }, { id: 'missing' }]);
  expect(send.mock.calls[1][0].input.RequestItems.policies.Keys).toEqual([{ id: 'p2' }]);
});

it('never turns an exhausted policy read into missing/deleted anchors', async () => {
  send.mockResolvedValue({ UnprocessedKeys: { policies: { Keys: [{ id: 'p1' }] } } });
  await expect(dashboardPolicyAnchors({ policyIds: ['p1'] })).rejects.toThrow('incomplete');
  expect(send).toHaveBeenCalledTimes(4);
});

it('bounds policy batches before accessing storage', async () => {
  await expect(dashboardPolicyAnchors({ policyIds: Array.from({ length: 101 }, (_, n) => `p-${n}`) })).rejects.toThrow('100');
  expect(await dashboardPolicyAnchors({ policyIds: [] })).toEqual({ items: [], missingIds: [] });
  expect(send).not.toHaveBeenCalled();
});
