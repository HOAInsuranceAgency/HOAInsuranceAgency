// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../amplify/functions/communications/store', () => ({ db: { send } }));
import { reportIndexPage } from '../../amplify/functions/communications/reportIndexPage';

const options = { table: 'InvoiceLine-test', index: 'crmBy_invoiceId', partition: 'invoiceId', fields: ['id', 'invoiceId', 'policyId'], values: ['invoice-b', 'invoice-a'] };
beforeEach(() => { send.mockReset(); });

it('reads several indexed partitions in one parameterized statement and pages the same scope', async () => {
  send.mockResolvedValueOnce({ Items: [{ id: 'line-1', invoiceId: 'invoice-a' }], NextToken: 'aws-page-2' })
    .mockResolvedValueOnce({ Items: [{ id: 'line-2', invoiceId: 'invoice-b', policyId: 'p' }] });
  const first = await reportIndexPage(options);
  expect(send.mock.calls[0][0].input).toEqual({
    Statement: 'SELECT "id", "invoiceId", "policyId" FROM "InvoiceLine-test"."crmBy_invoiceId" WHERE "invoiceId" IN [?, ?]',
    Parameters: ['invoice-a', 'invoice-b'], Limit: 500,
  });
  const second = await reportIndexPage({ ...options, values: ['invoice-a', 'invoice-b', 'invoice-a'], nextToken: first.nextToken });
  expect(send.mock.calls[1][0].input.NextToken).toBe('aws-page-2');
  expect(first.items).toHaveLength(1);
  expect(second.items).toEqual([{ id: 'line-2', invoiceId: 'invoice-b', policyId: 'p' }]);
  expect(second.nextToken).toBeUndefined();
});

it('binds a page cursor to the values, index and projection, and rejects invalid inputs before reading', async () => {
  send.mockResolvedValue({ Items: [], NextToken: 'next-page' });
  const first = await reportIndexPage(options);
  send.mockClear();
  for (const change of [{ values: ['invoice-other'] }, { index: 'other-index' }, { fields: '*' as const }, { nextToken: 'malformed' }]) {
    await expect(reportIndexPage({ ...options, nextToken: first.nextToken, ...change })).rejects.toThrow('page token');
  }
  await expect(reportIndexPage({ ...options, values: Array.from({ length: 26 }, (_, n) => `invoice-${n}`) })).rejects.toThrow('25');
  await expect(reportIndexPage({ ...options, values: ["invalid' OR true"] })).rejects.toThrow('valid report');
  await expect(reportIndexPage({ ...options, partition: 'invoiceId OR true' })).rejects.toThrow('not configured');
  expect(send).not.toHaveBeenCalled();
});

it('keeps full-row reads small and scoped, and returns empty without a read for no partitions', async () => {
  send.mockResolvedValue({ Items: [] });
  await reportIndexPage({ ...options, fields: '*', pageSize: 20 });
  expect(send.mock.calls[0][0].input.Statement).toBe('SELECT * FROM "InvoiceLine-test"."crmBy_invoiceId" WHERE "invoiceId" IN [?, ?]');
  expect(send.mock.calls[0][0].input.Limit).toBe(20);
  expect(await reportIndexPage({ ...options, values: [] })).toEqual({ items: [], nextToken: undefined });
  for (const pageSize of [0, 501, 1.5, NaN]) await expect(reportIndexPage({ ...options, pageSize })).rejects.toThrow('page size');
  expect(send).toHaveBeenCalledTimes(1);
});

it('does not treat a truncated or failed read as a complete report or fall back to scans', async () => {
  send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: 'line-1' } });
  await expect(reportIndexPage(options)).rejects.toThrow('incomplete');
  send.mockResolvedValueOnce({ Items: [], NextToken: 'same-page' });
  const first = await reportIndexPage(options);
  send.mockResolvedValueOnce({ Items: [], NextToken: 'same-page' });
  await expect(reportIndexPage({ ...options, nextToken: first.nextToken })).rejects.toThrow('did not advance');
  send.mockRejectedValueOnce(new Error('Index unavailable'));
  await expect(reportIndexPage(options)).rejects.toThrow('Index unavailable');
  expect(send).toHaveBeenCalledTimes(4);
});
