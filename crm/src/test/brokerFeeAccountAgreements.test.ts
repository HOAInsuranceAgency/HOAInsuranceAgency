import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountAgreements, db } from '../../amplify/functions/broker-fees/store';

beforeEach(() => { vi.stubEnv('BROKER_FEE_TABLE', 'Fees'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('account signed-agreement discovery', () => {
  it('paginates only account agreement keys and consistently rereads signed state instead of trusting the index projection', async () => {
    const send = vi.spyOn(db, 'send').mockImplementation(async (command: any) => {
      const input = command.input;
      if (command.constructor.name === 'QueryCommand') return input.ExclusiveStartKey
        ? { Items: [{ id: 'bfa_second' }], LastEvaluatedKey: undefined }
        : { Items: [{ id: 'bfa_first', signature: undefined }], LastEvaluatedKey: { id: 'cursor' } };
      expect(input.ConsistentRead).toBe(true);
      return { Item: { id: input.Key.id, kind: 'AGREEMENT', accountId: 'a', signature: { signedAt: '2026-11-04T15:00:00Z' } } };
    });
    const rows = await accountAgreements('a');
    expect(rows.map(row => row.id)).toEqual(['bfa_first', 'bfa_second']);
    expect(rows.every(row => row.signature?.signedAt)).toBe(true);
    const queries = send.mock.calls.map(([command]) => command as any).filter(command => command.constructor.name === 'QueryCommand');
    expect(queries).toHaveLength(2);
    for (const query of queries) expect(query.input).toMatchObject({
      TableName: 'Fees', IndexName: 'account', KeyConditionExpression: 'accountId = :account AND begins_with(id, :agreement)',
      ExpressionAttributeValues: { ':account': 'a', ':agreement': 'bfa_' }, ProjectionExpression: 'id', Limit: 100,
    });
    expect(queries[1].input.ExclusiveStartKey).toEqual({ id: 'cursor' });
  });

  it('does not return deleted, foreign-account, or non-agreement rows from consistent rereads', async () => {
    vi.spyOn(db, 'send').mockImplementation(async (command: any) => command.constructor.name === 'QueryCommand'
      ? { Items: [{ id: 'bfa_deleted' }, { id: 'bfa_foreign' }, { id: 'bfa_wrong-kind' }] }
      : { Item: command.input.Key.id === 'bfa_deleted' ? undefined : { id: command.input.Key.id, kind: command.input.Key.id === 'bfa_foreign' ? 'AGREEMENT' : 'FEE', accountId: command.input.Key.id === 'bfa_foreign' ? 'other' : 'a' } });
    expect(await accountAgreements('a')).toEqual([]);
  });

  it('fails instead of returning a partial list when a later index page is unavailable', async () => {
    vi.spyOn(db, 'send')
      .mockResolvedValueOnce({ Items: [{ id: 'bfa_first' }], LastEvaluatedKey: { id: 'cursor' } } as never)
      .mockRejectedValueOnce(new Error('Temporary index failure'));
    await expect(accountAgreements('a')).rejects.toThrow('Temporary index failure');
  });

  it('bounds pagination and never treats a truncated index as an empty agreement list', async () => {
    const send = vi.spyOn(db, 'send').mockResolvedValue({ Items: [], LastEvaluatedKey: { id: 'cursor' } } as never);
    await expect(accountAgreements('a')).rejects.toThrow('could not be loaded completely');
    expect(send).toHaveBeenCalledTimes(100);
  });
});
