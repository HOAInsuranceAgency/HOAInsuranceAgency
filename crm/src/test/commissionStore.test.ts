import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async (original) => ({
  ...(await original<typeof import('@aws-sdk/lib-dynamodb')>()),
  DynamoDBDocumentClient: { from: () => ({ send: h.send }) },
}));
import { commit, list } from '../../amplify/functions/commissions/store';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('COMMISSION_TABLE', 'private');
});
it('conditionally posts immutable source locks, versioned changes, and private audit together', async () => {
  h.send.mockResolvedValue({});
  await commit(
    [
      {
        kind: 'STATEMENT',
        value: { id: 's', version: 2, status: 'POSTED' },
        previous: { id: 's', version: 2 },
      },
      { kind: 'CARRIER_TRANSACTION', value: { id: 'txn' } },
    ],
    'owner',
  );
  const command = h.send.mock.calls[0][0];
  expect(command.constructor.name).toBe('TransactWriteCommand');
  const items = command.input.TransactItems;
  expect(items).toHaveLength(3);
  expect(items.every((i: { Put: { TableName: string } }) => i.Put.TableName === 'private')).toBe(
    true,
  );
  expect(items[0].Put).toMatchObject({
    ConditionExpression: '#v = :v',
    ExpressionAttributeValues: { ':v': 2 },
    Item: { version: 3, updatedBy: 'owner' },
  });
  expect(items[1].Put.ConditionExpression).toBe('attribute_not_exists(id)');
  expect(items[2].Put.Item).toMatchObject({ kind: 'AUDIT', actor: 'owner' });
});
it('follows empty pages and refuses repeated cursors rather than returning incomplete totals', async () => {
  h.send
    .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: 'next' } })
    .mockResolvedValueOnce({ Items: [{ id: 's' }] });
  expect(await list('STATEMENT')).toEqual([{ id: 's' }]);
  expect(h.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ id: 'next' });
  h.send.mockResolvedValue({ Items: [], LastEvaluatedKey: { id: 'loop' } });
  await expect(list('POLICY')).rejects.toThrow(/completely loaded/);
});
it('uses only the authenticated producer partition for self-service discovery', async () => {
  h.send.mockResolvedValue({ Items: [] });
  await list('producer-id', true);
  expect(h.send.mock.calls[0][0].input).toMatchObject({
    IndexName: 'producer',
    ExpressionAttributeNames: { '#key': 'producerId' },
    ExpressionAttributeValues: { ':value': 'producer-id' },
  });
});
