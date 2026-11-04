import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
const h = vi.hoisted(() => ({ project: vi.fn(), scan: vi.fn(), controls: new Map<string, unknown>(), queue: vi.fn(), drain: vi.fn() }));
vi.mock('../../amplify/functions/account-list/store', () => ({
  db: { send: h.scan }, projectAccount: h.project, projectionTable: () => 'index', sourceTables: () => ({ Account: 'accounts', Contact: 'contacts', UserProfile: 'profiles', Communication: 'comms' }),
  readOne: async (_table: string, key: { sk: string }) => h.controls.get(key.sk),
  writeControl: async (sk: string, fields: unknown) => { h.controls.set(sk, structuredClone(fields)); }, queueNameRefresh: h.queue, drainNameRefresh: h.drain,
}));
import { handleAccountListStream, handler, repairAccountList } from '../../amplify/functions/account-list/handler';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-11-04T15:00:00.000Z'); vi.clearAllMocks(); h.controls.clear(); h.project.mockResolvedValue({ changed: true }); h.scan.mockResolvedValue({ Items: [] }); h.queue.mockResolvedValue(undefined); h.drain.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const streamRecord = (model: string, before?: Record<string, unknown>, after?: Record<string, unknown>) => ({ eventID: 'event', eventSourceARN: `arn:aws:dynamodb:us-east-1:1:table/${model}/stream/time`, dynamodb: { SequenceNumber: 'sequence', OldImage: before && marshall(before), NewImage: after && marshall(after) } });

it('checkpoints only complete pages and withholds readiness until a daily sweep finishes', async () => {
  h.controls.set('READY', { version: 1, complete: true, day: '2026-11-03' });
  h.controls.set('BUILD', { day: '2026-11-03', cursor: { id: 'old' }, complete: false });
  h.scan.mockResolvedValueOnce({ Items: [{ id: 'a' }], LastEvaluatedKey: { id: 'a' } }).mockResolvedValueOnce({ Items: [{ id: 'b' }] });
  await repairAccountList({ maxPages: 1 });
  expect(h.scan.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
  expect(h.controls.get('READY')).toEqual({ version: 1, complete: false, day: '2026-11-04' });
  expect(h.controls.get('BUILD')).toMatchObject({ day: '2026-11-04', cursor: { id: 'a' }, complete: false, processed: 1 });
  await repairAccountList({ maxPages: 1 });
  expect(h.scan.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ id: 'a' });
  expect(h.controls.get('READY')).toMatchObject({ version: 1, complete: true, day: '2026-11-04', processed: 2 });
  expect(h.project.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
});
it('repeats an interrupted page and never checkpoints or publishes partial backfill', async () => {
  h.scan.mockResolvedValue({ Items: [{ id: 'a' }, { id: 'b' }], LastEvaluatedKey: { id: 'b' } });
  h.project.mockResolvedValueOnce({ changed: true }).mockRejectedValueOnce(new Error('Source unavailable'));
  await expect(repairAccountList()).rejects.toThrow('Source unavailable');
  expect(h.controls.has('BUILD')).toBe(false);
  expect(h.controls.get('READY')).toMatchObject({ complete: false });
  h.project.mockResolvedValue({ changed: true });
  await repairAccountList({ maxPages: 1 });
  expect(h.scan.mock.calls[1][0].input.ExclusiveStartKey).toBeUndefined();
  expect(h.project.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a', 'b']);
});
it('reprojects both sides of moved children using current-source hints and handles deletions', async () => {
  expect(await handleAccountListStream({ Records: [streamRecord('contacts', { id: 'c', accountId: 'old' }, { id: 'c', accountId: 'new' })] } as never)).toEqual({ batchItemFailures: [] });
  expect(h.project.mock.calls.map(([id]) => id)).toEqual(['old', 'new']);
  expect(h.project.mock.calls.every(([, , , hints]) => hints.Contact.includes('c'))).toBe(true);
  h.project.mockClear();
  await handleAccountListStream({ Records: [streamRecord('accounts', { id: 'gone' })] } as never);
  expect(h.project.mock.calls[0][0]).toBe('gone');
});
it('refreshes indexed assignments when profile names or materialized eligibility change, ignoring unrelated communication records', async () => {
  await handleAccountListStream({ Records: [streamRecord('profiles', { id: 'profile', userId: 'sales', firstName: 'Old' }, { id: 'profile', userId: 'sales', firstName: 'New' }), streamRecord('comms', undefined, { id: 'message', kind: 'COMMUNICATION', accountId: 'a' })] } as never);
  expect(h.queue).toHaveBeenCalledExactlyOnceWith('sales', ['profile', 'profile']);
  expect(h.project).not.toHaveBeenCalled();
});
it('invalidates readiness, resets repair cursor and retries failures instead of silently serving incomplete results', async () => {
  h.controls.set('READY', { version: 1, complete: true, day: '2026-11-04' });
  h.controls.set('BUILD', { day: '2026-11-04', cursor: { id: 'later' } });
  h.project.mockRejectedValue(new Error('Source unavailable'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await handleAccountListStream({ Records: [streamRecord('accounts', undefined, { id: 'a' })] } as never)).toEqual({ batchItemFailures: [{ itemIdentifier: 'sequence' }] });
  expect(h.controls.get('READY')).toMatchObject({ complete: false });
  expect(h.controls.get('BUILD')).toEqual({ day: '2026-11-04', complete: false, processed: 0 });
  logged.mockRestore();
});
it('keeps the migration preview inert', async () => {
  vi.stubEnv('HOA_MIGRATION_PREVIEW', 'true');
  await handler({ Records: [streamRecord('accounts', undefined, { id: 'a' })] } as never);
  await handler({});
  expect(h.scan).not.toHaveBeenCalled(); expect(h.project).not.toHaveBeenCalled();
});

it('throttles complete same-day sweeps so source streams keep the worker between repairs', async () => {
  h.scan.mockResolvedValue({ Items: [{ id: 'a' }] });
  await repairAccountList();
  await repairAccountList();
  expect(h.project).toHaveBeenCalledTimes(1);
  vi.setSystemTime('2026-11-04T15:16:00.000Z');
  await repairAccountList();
  expect(h.project).toHaveBeenCalledTimes(2);
});

it('persists partial-page progress so a slow page cannot repeat its completed prefix forever', async () => {
  h.scan.mockResolvedValue({ Items: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}` })) });
  h.project.mockImplementation(async () => { vi.setSystemTime(Date.now() + 100); return { changed: true }; });
  await repairAccountList({ budgetMs: 200 });
  expect(h.project.mock.calls.map(([id]) => id)).toEqual(['a0', 'a1', 'a2', 'a3']);
  expect(h.controls.get('BUILD')).toMatchObject({ pendingIds: ['a4', 'a5', 'a6', 'a7', 'a8'], processed: 4 });
  await repairAccountList({ budgetMs: 200 });
  await repairAccountList({ budgetMs: 200 });
  expect(h.project.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 9 }, (_, i) => `a${i}`));
  expect(h.controls.get('READY')).toMatchObject({ complete: true, processed: 9 });
  expect(h.scan).toHaveBeenCalledTimes(1);
});
