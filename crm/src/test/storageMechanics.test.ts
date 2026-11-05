// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { batchGetComplete, ReadDeadlineExceeded } from '../../amplify/functions/storage/batchGet';
import { collectCompletePages, type ReadBudget } from '../../amplify/functions/storage/pages';
import { conditionalConflict, retryableStorageFailure } from '../../amplify/functions/storage/errors';
import { assertTransactionEnvelope } from '../../amplify/functions/storage/transactions';
import { resolveModelTable, modelKey, storedModel } from '../../amplify/functions/storage/models';
const error = () => new Error('incomplete');
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('deduplicates keys, chunks 100 and keeps consistency/projection through unprocessed-key retries', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementation(async command => {
    const request = command.input.RequestItems.T;
    if (send.mock.calls.length === 1) return { Responses: { T: request.Keys.slice(1) }, UnprocessedKeys: { T: { Keys: request.Keys.slice(0, 1) } } };
    return { Responses: { T: request.Keys } };
  });
  const keys = Array.from({ length: 201 }, (_, id) => ({ id }));
  const pending = batchGetComplete({ send, table: 'T', keys: [...keys, keys[0]], maxKeys: 201, attempts: 4,
    read: { ConsistentRead: true, ProjectionExpression: '#id', ExpressionAttributeNames: { '#id': 'id' } }, sizeError: error, incompleteError: error });
  await vi.runAllTimersAsync();
  expect(await pending).toHaveLength(201);
  expect(send.mock.calls.map(([c]) => c.input.RequestItems.T.Keys.length)).toEqual([100, 1, 100, 1]);
  expect(send.mock.calls.every(([c]) => c.input.RequestItems.T.ConsistentRead && c.input.RequestItems.T.ProjectionExpression === '#id')).toBe(true);
});
it.each([4, 5])('fails a %s-attempt exhausted read without returning partial financial rows', async attempts => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementation(async command => ({ Responses: { T: [{ id: 'partial' }] }, UnprocessedKeys: command.input.RequestItems }));
  const failure = expect(batchGetComplete({ send, table: 'T', keys: [{ id: 'missing' }], maxKeys: 1, attempts, sizeError: error, incompleteError: error })).rejects.toThrow('incomplete');
  await vi.runAllTimersAsync(); await failure;
  expect(send).toHaveBeenCalledTimes(attempts);
});
it('settles a four-batch wave before rejecting and does not launch a fifth batch', async () => {
  const finish: (() => void)[] = [];
  const send = vi.fn().mockImplementation(command => new Promise((resolve, reject) => finish.push(() => finish.length === 4 && command.input.RequestItems.T.Keys[0].id === 0
    ? reject(new Error('read failed')) : resolve({ Responses: { T: command.input.RequestItems.T.Keys } }))));
  const pending = batchGetComplete({ send, table: 'T', keys: Array.from({ length: 401 }, (_, id) => ({ id })), maxKeys: 500, attempts: 4, concurrency: 4, sizeError: error, incompleteError: error });
  const settled = vi.fn(); void pending.then(settled, settled);
  expect(send).toHaveBeenCalledTimes(4);
  finish[0](); finish[1](); finish[2](); await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  finish[3](); await expect(pending).rejects.toThrow('read failed');
  expect(send).toHaveBeenCalledTimes(4);
});
it('does not turn a deadline-expired migration read into missing records', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  const send = vi.fn().mockResolvedValue({});
  await expect(batchGetComplete({ send, table: 'T', keys: [{ id: 'a' }], maxKeys: 1, attempts: 4, deadline: 100, sizeError: error, incompleteError: error })).rejects.toBeInstanceOf(ReadDeadlineExceeded);
  expect(send).not.toHaveBeenCalled();
});
it('checks request bounds before any IO and skips empty reads', async () => {
  const send = vi.fn();
  const options = { send, table: 'T', maxKeys: 1, attempts: 4, sizeError: error, incompleteError: error };
  await expect(batchGetComplete({ ...options, keys: [{ id: 'a' }, { id: 'b' }] })).rejects.toThrow('incomplete');
  expect(await batchGetComplete({ ...options, keys: [] })).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});
it('follows empty filtered pages and treats an empty DynamoDB key as completion', async () => {
  const read = vi.fn().mockResolvedValueOnce({ items: [], next: { id: 'cursor' } }).mockResolvedValueOnce({ items: ['complete'], next: {} });
  expect(await collectCompletePages(read, { maxPages: 2, error })).toEqual(['complete']);
  expect(read).toHaveBeenLastCalledWith({ id: 'cursor' });
});
it('detects cursor cycles despite reordered composite key fields', async () => {
  const read = vi.fn().mockResolvedValueOnce({ items: [1], next: { id: 'same', kind: 'K' } }).mockResolvedValueOnce({ items: [2], next: { kind: 'K', id: 'same' } });
  await expect(collectCompletePages(read, { maxPages: 100, error })).rejects.toThrow('incomplete');
  expect(read).toHaveBeenCalledTimes(2);
});
it('never returns a truncated result when its page or row budget is exhausted', async () => {
  const read = vi.fn().mockResolvedValue({ items: [1], next: 'more' });
  await expect(collectCompletePages(read, { maxPages: 1, error })).rejects.toThrow('incomplete');
  expect(read).toHaveBeenCalledTimes(1);
  await expect(collectCompletePages(async () => ({ items: [1, 2] }), { maxPages: 1, maxRows: 1, error })).rejects.toThrow('incomplete');
});
it('shares report collection budgets across sources and measures UTF-8 bytes', async () => {
  const budget: ReadBudget = { pages: 0, rows: 0, bytes: 0 };
  expect(await collectCompletePages(async () => ({ items: ['é'] }), { maxPages: 2, maxBytes: 6, budget, error })).toEqual(['é']);
  await expect(collectCompletePages(async () => ({ items: ['é'] }), { maxPages: 2, maxBytes: 6, budget, error })).rejects.toThrow('incomplete');
  expect(budget).toEqual({ pages: 2, rows: 2, bytes: 12 });
});
it('stops before fetching a report whose deadline has expired', async () => {
  const read = vi.fn();
  await expect(collectCompletePages(read, { maxPages: 1, budget: { pages: 0, rows: 0, bytes: 0, deadline: 0 }, error })).rejects.toThrow('incomplete');
  expect(read).not.toHaveBeenCalled();
});
it.each([
  ['ConditionalCheckFailedException', undefined, true, false],
  ['TransactionCanceledException', [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }], true, false],
  ['TransactionCanceledException', [{ Code: 'ConditionalCheckFailed' }, { Code: 'ThrottlingError' }], false, true],
  ['TransactionCanceledException', undefined, false, true],
  ['TransactionCanceledException', [{ Code: 'ValidationError' }], false, false],
  ['ThrottlingException', undefined, false, true],
])('classifies %s without retrying a financial command', (name, CancellationReasons, conditional, retryable) => {
  const failure = Object.assign(new Error('safe'), { name, CancellationReasons });
  expect(conditionalConflict(failure)).toBe(conditional);
  expect(retryableStorageFailure(failure)).toBe(retryable);
});
it('rejects oversize UTF-8 envelopes and duplicate keyed transaction targets', () => {
  const put = { Put: { TableName: 'T', Item: { id: 'a', text: 'é'.repeat(10) } } };
  expect(() => assertTransactionEnvelope([put], { maxBytes: JSON.stringify([put]).length, error })).toThrow('incomplete');
  const check = { ConditionCheck: { TableName: 'T', Key: { id: 'a', kind: 'K' }, ConditionExpression: 'attribute_exists(id)' } };
  const update = { Update: { TableName: 'T', Key: { kind: 'K', id: 'a' }, UpdateExpression: 'SET n = :n' } };
  expect(() => assertTransactionEnvelope([check, update], { error })).toThrow('incomplete');
  expect(() => assertTransactionEnvelope([check, { ...update, Update: { ...update.Update, TableName: 'Other' } }], { error })).not.toThrow();
  expect(() => assertTransactionEnvelope([put, { ConditionCheck: { TableName: 'T', Key: { id: 'a' }, ConditionExpression: 'attribute_exists(id)' } }],
    { keyFields: () => ['id'], error })).toThrow('incomplete');
});
it('does not impose JSON encoding on a count-only transaction guard', () => {
  expect(() => assertTransactionEnvelope([{ Put: { TableName: 'T', Item: { id: 'a', n: 1n } } }], { error })).not.toThrow();
});
it('preserves table-map, caller-specific environment and retained API namespace precedence', () => {
  const environment = { ACCESS_TABLES: '{"Policy":"explicit-policy"}', ACCESS_API_ID: 'retained-api', POLICY_TABLE: 'environment-policy' };
  expect(resolveModelTable('Policy', { environment, envNames: ['POLICY_TABLE'], error })).toBe('explicit-policy');
  expect(resolveModelTable('Policy', { environment, envNames: ['POLICY_TABLE'], useTableMap: false, error })).toBe('environment-policy');
  expect(resolveModelTable('Quote', { environment, error })).toBe('Quote-retained-api-NONE');
  expect(() => resolveModelTable('Communication', { environment, error })).toThrow('incomplete');
  expect(resolveModelTable('Communication', { environment: { ...environment, COMMUNICATION_TABLE: 'private-communications' }, error })).toBe('private-communications');
});
it('rejects unknown storage models and keeps the schema custom account identifiers', () => {
  expect(() => storedModel('Unclassified', error)).toThrow('incomplete');
  expect(modelKey(storedModel('GlApplication', error), 'account')).toEqual({ accountId: 'account' });
  expect(modelKey('DoApplication', 'account')).toEqual({ accountId: 'account' });
  expect(modelKey('Policy', 'policy')).toEqual({ id: 'policy' });
});
