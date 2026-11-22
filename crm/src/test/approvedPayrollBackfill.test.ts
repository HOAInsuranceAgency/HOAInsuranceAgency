// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { backfillApprovedPayroll } from '../../amplify/functions/commissions/approved-payroll-backfill';
import { APPROVED_PAYROLL_INDEX_STATE, APPROVED_PAYROLL_KIND } from '../../amplify/functions/commissions/payroll-index';

const cycle = (id: string, status = 'APPROVED') => ({ id, status, version: 1 });
function ledger(cycles: ReturnType<typeof cycle>[]) {
  const source = new Map(cycles.map(c => [c.id, c]));
  const refs = new Set<string>();
  const state = { ready: false, interruptAt: '', payDuringBackfill: '', concurrentMarker: false };
  const send = vi.fn(async (command: GetCommand | PutCommand | QueryCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key!;
      return { Item: key.kind === 'INDEX_STATE' ? (state.ready ? key : undefined) : source.get(key.id) };
    }
    if (command instanceof QueryCommand) {
      const q = command.input;
      expect(q).toMatchObject({ ConsistentRead: true, FilterExpression: '#status = :approved' });
      const start = q.ExclusiveStartKey?.offset ?? 0;
      const page = cycles.slice(start, start + q.Limit!);
      const next = start + page.length;
      return { ScannedCount: page.length, Items: page.filter(c => c.status === 'APPROVED').map(c => ({ ...c })),
        LastEvaluatedKey: next < cycles.length ? { offset: next } : undefined };
    }
    if (command instanceof PutCommand) {
      expect(command.input.Item).toMatchObject({ kind: 'INDEX_STATE', id: APPROVED_PAYROLL_INDEX_STATE });
      expect(command.input.ConditionExpression).toBe('attribute_not_exists(id)');
      state.ready = true;
      if (state.concurrentMarker) throw Object.assign(new Error('Another runner finished.'), { name: 'ConditionalCheckFailedException' });
      return {};
    }
    const [guard, ref] = command.input.TransactItems!;
    const id = guard.ConditionCheck!.Key!.id as string;
    expect(guard.ConditionCheck).toMatchObject({ Key: { kind: 'PAYROLL_CYCLE', id },
      ConditionExpression: '#version = :version AND #status = :approved' });
    expect(ref.Put?.Item).toEqual({ kind: APPROVED_PAYROLL_KIND, id });
    if (id === state.interruptAt) throw new Error('Interrupted');
    if (id === state.payDuringBackfill) {
      const row = source.get(id)!;
      row.status = 'PAID';
      row.version++;
      throw Object.assign(new Error('Concurrent payment.'), { name: 'TransactionCanceledException' });
    }
    expect(source.get(id)).toMatchObject({ status: 'APPROVED', version: guard.ConditionCheck!.ExpressionAttributeValues![':version'] });
    refs.add(id);
    return {};
  });
  const db = { send: send as unknown as DynamoDBDocumentClient['send'] };
  return { source, refs, state, send, run: (apply = false) => backfillApprovedPayroll(db, 'fictional-ledger', apply) };
}

it('passes empty filtered pages, projects only current approvals and makes every rerun read-only once ready', async () => {
  const history = Array.from({ length: 5100 }, (_, i) => cycle('closed-' + i, i % 2 ? 'PAID' : 'CANCELLED'));
  const l = ledger([cycle('approved-1'), ...history, cycle('approved-2')]);
  const originals = JSON.stringify([...l.source]);
  expect(await l.run()).toEqual({ ready: false, examined: 5102, approved: 2, applied: false });
  expect(l.refs.size).toBe(0);
  expect(l.state.ready).toBe(false);
  expect(await l.run(true)).toEqual({ ready: true, examined: 5102, approved: 2, applied: true });
  expect([...l.refs]).toEqual(['approved-1', 'approved-2']);
  expect(JSON.stringify([...l.source])).toBe(originals);
  l.send.mockClear();
  expect(await l.run(true)).toEqual({ ready: true, examined: 0, approved: 0, applied: false });
  expect(l.send).toHaveBeenCalledTimes(1);
});

it('recovers from interruption and a concurrent cycle payment without publishing a stale reference', async () => {
  const l = ledger([cycle('a'), cycle('b'), cycle('c')]);
  l.state.interruptAt = 'b';
  await expect(l.run(true)).rejects.toThrow('Interrupted');
  expect(l.state.ready).toBe(false);
  expect([...l.refs]).toEqual(['a']);
  l.state.interruptAt = '';
  l.state.payDuringBackfill = 'b';
  expect(await l.run(true)).toMatchObject({ ready: true });
  expect([...l.refs]).toEqual(['a', 'c']);
  expect(l.source.get('b')).toMatchObject({ status: 'PAID', version: 2 });
});

it('marks an empty ledger ready when another maintenance runner wins the marker write', async () => {
  const l = ledger([]);
  l.state.concurrentMarker = true;
  expect(await l.run(true)).toEqual({ ready: true, examined: 0, approved: 0, applied: true });
  expect(l.refs.size).toBe(0);
});
