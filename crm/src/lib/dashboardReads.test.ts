// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { forEachReportPage, mapReportReads, reportBatches, reportCursorGuard } from './dashboardReads';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it('keeps four workers, fills a freed slot and returns input order despite out-of-order completion', async () => {
  const gates = Array.from({ length: 6 }, () => deferred<string>()), started: number[] = [];
  let active = 0, maximum = 0;
  const result = mapReportReads([0, 1, 2, 3, 4, 5], async index => {
    started.push(index); maximum = Math.max(maximum, ++active);
    const value = await gates[index].promise; active--; return value;
  });
  expect(started).toEqual([0, 1, 2, 3]);
  gates[3].resolve('three'); await flush();
  expect(started).toEqual([0, 1, 2, 3, 4]);
  gates[1].resolve('one'); await flush();
  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  for (const index of [5, 4, 2, 0]) gates[index].resolve(String(index));
  expect(await result).toEqual(['0', 'one', '2', 'three', '4', '5']);
  expect(maximum).toBe(4); expect(active).toBe(0);
});

it('settles every worker before preferring an authorization denial over an earlier transient error', async () => {
  const gates = Array.from({ length: 4 }, () => deferred<number>());
  const denied = Object.assign(new Error('Access revoked'), { name: 'Unauthorized' });
  const transient = new Error('Temporary read failure');
  let settled = false;
  const outcome = mapReportReads([0, 1, 2, 3], index => gates[index].promise)
    .then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  gates[0].reject(transient); await flush();
  expect(settled).toBe(false);
  gates[1].reject(denied); gates[2].resolve(2); await flush();
  expect(settled).toBe(false);
  gates[3].resolve(3);
  expect(await outcome).toBe(denied);
});

it('does no work for an empty report batch', async () => {
  const read = vi.fn();
  expect(await mapReportReads([], read)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it.each([25, 100, 500])('chunks at the caller-owned %s boundary without sorting or removing duplicates', size => {
  const ids = Array.from({ length: size }, (_, index) => `z-${index}`).concat('z-0');
  const original = [...ids], batches = reportBatches(ids, size);
  expect(batches.map(batch => batch.length)).toEqual([size, 1]);
  expect(batches.flat()).toEqual(original); expect(ids).toEqual(original);
});

it('consumes empty filtered pages and leaves row ordering/deduplication with the caller', async () => {
  type Row = { id: string; value: number };
  const read = vi.fn<(nextToken?: string) => Promise<{ items: Row[]; nextToken?: string }>>().mockResolvedValueOnce({ items: [], nextToken: 'second' })
    .mockResolvedValueOnce({ items: [{ id: 'same', value: 1 }], nextToken: 'third' })
    .mockResolvedValueOnce({ items: [{ id: 'same', value: 2 }] });
  const rows: Row[] = [];
  await forEachReportPage(read, page => { rows.push(...page.items); }, 'Pages stalled');
  expect(rows).toEqual([{ id: 'same', value: 1 }, { id: 'same', value: 2 }]);
  expect(read.mock.calls).toEqual([[undefined], ['second'], ['third']]);
});

it('rejects a repeated cursor after its second response without a third request', async () => {
  const read = vi.fn().mockResolvedValue({ items: [], nextToken: 'same' }), consume = vi.fn();
  await expect(forEachReportPage(read, consume, 'Pages stalled')).rejects.toThrow('Pages stalled');
  expect(read).toHaveBeenCalledTimes(2); expect(consume).toHaveBeenCalledTimes(2);
});

it('propagates a final-page read error without retrying or accepting the prior page as complete', async () => {
  const error = new Error('Final page unavailable'), consume = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({ items: [1], nextToken: 'final' }).mockRejectedValueOnce(error);
  await expect(forEachReportPage(read, consume, 'Pages stalled')).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(2); expect(consume).toHaveBeenCalledTimes(1);
});

it('keeps domain-validation failures and stops before the next page', async () => {
  const error = new Error('A row belongs to another account');
  const read = vi.fn().mockResolvedValue({ items: [{ accountId: 'foreign' }], nextToken: 'next' });
  await expect(forEachReportPage(read, () => { throw error; }, 'Pages stalled')).rejects.toBe(error);
  expect(read).toHaveBeenCalledOnce();
});

it.each([null, ''])('retains the existing terminal cursor behavior for %j', async nextToken => {
  const read = vi.fn().mockResolvedValue({ items: [], nextToken });
  await forEachReportPage(read, () => {}, 'Pages stalled');
  expect(read).toHaveBeenCalledOnce();
});

it('keeps cursor histories local to each collection and rejects malformed or repeated nonempty tokens', () => {
  const first = reportCursorGuard('First pages stalled'), second = reportCursorGuard('Second pages stalled');
  first(undefined); first('same'); second('same');
  expect(() => first('same')).toThrow('First pages stalled');
  expect(() => second({ cursor: 'next' })).toThrow('Second pages stalled');
});
