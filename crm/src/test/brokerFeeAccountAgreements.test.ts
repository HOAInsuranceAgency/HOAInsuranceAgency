import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountAgreements, db } from '../../amplify/functions/broker-fees/store';

const agreement = (id: string, fields: Record<string, unknown> = {}) => ({ id, kind: 'AGREEMENT', accountId: 'a',
  quotes: [{ id: 'q', accountId: 'a' }], signature: { signedAt: '2026-11-04T15:00:00Z' }, ...fields });
beforeEach(() => { vi.stubEnv('BROKER_FEE_TABLE', 'Fees'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('account signed-agreement discovery', () => {
  it('performs no strong-read batch when discovery finds no agreement for this fee-free quote', async () => {
    const send = vi.spyOn(db, 'send').mockResolvedValue({ Items: [] } as never);
    expect(await accountAgreements('a', 'uncovered-quote')).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].constructor.name).toBe('QueryCommand');
  });

  it('continues past empty filtered pages and consistently batches current quote agreements without trusting index signature state', async () => {
    const send = vi.spyOn(db, 'send').mockImplementation(async (command: any) => {
      const input = command.input;
      if (command.constructor.name === 'QueryCommand') return input.ExclusiveStartKey
        ? { Items: [{ id: 'bfa_first', signature: undefined }, { id: 'bfa_second' }] }
        : { Items: [], LastEvaluatedKey: { id: 'cursor' } };
      expect(command.constructor.name).toBe('BatchGetCommand');
      expect(input.RequestItems.Fees).toEqual({ Keys: [{ id: 'bfa_first' }, { id: 'bfa_second' }], ConsistentRead: true });
      return { Responses: { Fees: [agreement('bfa_second'), agreement('bfa_first')] } };
    });
    const rows = await accountAgreements('a', 'q');
    expect(rows.map(row => row.id).sort()).toEqual(['bfa_first', 'bfa_second']);
    expect(rows.every(row => row.signature?.signedAt)).toBe(true);
    const commands = send.mock.calls.map(([command]) => command as any);
    const queries = commands.filter(command => command.constructor.name === 'QueryCommand');
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.input).toMatchObject({
        TableName: 'Fees', IndexName: 'account', KeyConditionExpression: 'accountId = :account AND begins_with(id, :agreement)',
        ExpressionAttributeNames: { '#kind': 'kind', '#quotes': 'quotes', '#id': 'id' },
        ExpressionAttributeValues: { ':account': 'a', ':agreement': 'bfa_', ':kind': 'AGREEMENT', ':quote': 'q' },
        ProjectionExpression: 'id', Limit: 100,
      });
      expect(query.input.FilterExpression).toContain('#kind = :kind');
      expect(query.input.FilterExpression).toContain('#quotes[0].#id = :quote');
      expect(query.input.FilterExpression).toContain('#quotes[24].#id = :quote');
    }
    expect(queries[1].input.ExclusiveStartKey).toEqual({ id: 'cursor' });
    expect(commands.filter(command => command.constructor.name === 'BatchGetCommand')).toHaveLength(1);
    expect(commands.some(command => command.constructor.name === 'GetCommand')).toBe(false);
  });

  it('chunks more than 100 matching agreements into legal strongly consistent batches', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `bfa_${index}`);
    const send = vi.spyOn(db, 'send').mockImplementation(async (command: any) => {
      if (command.constructor.name === 'QueryCommand') {
        const offset = Number(command.input.ExclusiveStartKey?.offset ?? 0);
        return { Items: ids.slice(offset, offset + 100).map(id => ({ id })),
          ...(offset + 100 < ids.length ? { LastEvaluatedKey: { offset: offset + 100 } } : {}) };
      }
      expect(command.constructor.name).toBe('BatchGetCommand');
      expect(command.input.RequestItems.Fees.ConsistentRead).toBe(true);
      return { Responses: { Fees: command.input.RequestItems.Fees.Keys.map((key: { id: string }) => agreement(key.id)) } };
    });
    expect(await accountAgreements('a', 'q')).toHaveLength(205);
    const batchSizes = send.mock.calls.map(([command]) => command as any)
      .filter(command => command.constructor.name === 'BatchGetCommand').map(command => command.input.RequestItems.Fees.Keys.length);
    expect(batchSizes).toEqual([100, 100, 5]);
  });

  it('retries only unprocessed keys and retains already-read agreements', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(db, 'send')
      .mockResolvedValueOnce({ Items: [{ id: 'bfa_first' }, { id: 'bfa_second' }] } as never)
      .mockResolvedValueOnce({ Responses: { Fees: [agreement('bfa_first')] }, UnprocessedKeys: { Fees: { Keys: [{ id: 'bfa_second' }] } } } as never)
      .mockResolvedValueOnce({ Responses: { Fees: [agreement('bfa_second')] } } as never);
    const pending = accountAgreements('a', 'q');
    await vi.runAllTimersAsync();
    expect((await pending).map(row => row.id)).toEqual(['bfa_first', 'bfa_second']);
    expect((send.mock.calls[2][0] as any).input.RequestItems.Fees).toEqual({ Keys: [{ id: 'bfa_second' }], ConsistentRead: true });
  });

  it('fails after bounded unprocessed-key retries instead of returning partial evidence', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(db, 'send').mockImplementation(async (command: any) => command.constructor.name === 'QueryCommand'
      ? { Items: [{ id: 'bfa_first' }, { id: 'bfa_pending' }] }
      : { Responses: { Fees: command.input.RequestItems.Fees.Keys.some((key: { id: string }) => key.id === 'bfa_first') ? [agreement('bfa_first')] : [] },
          UnprocessedKeys: { Fees: { Keys: [{ id: 'bfa_pending' }] } } });
    const failure = expect(accountAgreements('a', 'q')).rejects.toThrow('could not be loaded completely');
    await vi.runAllTimersAsync();
    await failure;
    expect(send.mock.calls.filter(([command]) => command.constructor.name === 'BatchGetCommand')).toHaveLength(5);
  });

  it('strongly verifies account, kind, requested key and quote association after the eventual index query', async () => {
    const ids = ['bfa_foreign', 'bfa_wrong-kind', 'bfa_wrong-quote', 'bfa_foreign-quote', 'bfa_deleted'];
    vi.spyOn(db, 'send').mockImplementation(async (command: any) => command.constructor.name === 'QueryCommand'
      ? { Items: ids.map(id => ({ id })) }
      : { Responses: { Fees: [agreement('bfa_foreign', { accountId: 'other' }), agreement('bfa_wrong-kind', { kind: 'FEE' }),
          agreement('bfa_wrong-quote', { quotes: [{ id: 'another', accountId: 'a' }] }),
          agreement('bfa_foreign-quote', { quotes: [{ id: 'q', accountId: 'other' }] }), agreement('not-requested')] } });
    expect(await accountAgreements('a', 'q')).toEqual([]);
  });

  it('fails instead of returning a partial list when a later index page is unavailable', async () => {
    vi.spyOn(db, 'send')
      .mockResolvedValueOnce({ Items: [{ id: 'bfa_first' }], LastEvaluatedKey: { id: 'cursor' } } as never)
      .mockRejectedValueOnce(new Error('Temporary index failure'));
    await expect(accountAgreements('a', 'q')).rejects.toThrow('Temporary index failure');
  });

  it('bounds pagination and never treats a truncated index as an empty agreement list', async () => {
    const send = vi.spyOn(db, 'send').mockResolvedValue({ Items: [], LastEvaluatedKey: { id: 'cursor' } } as never);
    await expect(accountAgreements('a', 'q')).rejects.toThrow('could not be loaded completely');
    expect(send).toHaveBeenCalledTimes(100);
  });
});
