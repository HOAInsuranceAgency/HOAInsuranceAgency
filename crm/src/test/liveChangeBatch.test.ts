// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ pulse: vi.fn() }));
vi.mock('../../amplify/functions/live-changes', async () => {
  const { queueLiveChange } = await import('../../amplify/functions/live-change-context');
  const emit = async (channel: 'Crm' | 'Owner' | 'Personal', userId?: string) => {
    if (!queueLiveChange(channel, userId)) h.pulse(channel, userId);
  };
  return { publishCrmChange: () => emit('Crm'), publishOwnerChange: () => emit('Owner'), publishPersonalChange: (id: string) => emit('Personal', id) };
});
import { batchLiveChanges, sendCommissionWrite, sendCrmWrite } from '../../amplify/functions/live-write';

beforeEach(() => vi.clearAllMocks());

it('emits one trailing pulse per audience after every successful commit in an invocation', async () => {
  const result = await batchLiveChanges(async () => {
    await sendCrmWrite(Promise.resolve({ paid: true }));
    await sendCrmWrite(Promise.resolve({ linked: true }));
    await sendCommissionWrite(Promise.resolve(), ['producer', 'producer']);
    expect(h.pulse).not.toHaveBeenCalled();
    return { original: true };
  })();
  expect(result).toEqual({ original: true });
  expect(h.pulse.mock.calls).toEqual([['Crm', undefined], ['Owner', undefined], ['Personal', 'producer']]);
});

it('flushes committed changes preceding a later failure without masking the business failure', async () => {
  await expect(batchLiveChanges(async () => {
    await sendCrmWrite(Promise.resolve());
    await sendCrmWrite(Promise.reject(new Error('second commit failed')));
  })()).rejects.toThrow('second commit failed');
  expect(h.pulse.mock.calls).toEqual([['Crm', undefined]]);
});

it('never emits an event for a read-only or completely failed invocation', async () => {
  await batchLiveChanges(async () => ({ readOnly: true }))();
  await expect(batchLiveChanges(() => sendCrmWrite(Promise.reject(new Error('failed'))))()).rejects.toThrow('failed');
  expect(h.pulse).not.toHaveBeenCalled();
});

it('keeps concurrent invocations isolated and folds nested handlers into their existing scope', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = batchLiveChanges(async () => {
    await sendCommissionWrite(Promise.resolve(), ['producer-first']);
    await waiting;
    await batchLiveChanges(() => sendCrmWrite(Promise.resolve()))();
  })();
  await batchLiveChanges(() => sendCommissionWrite(Promise.resolve(), ['producer-second']))();
  expect(h.pulse.mock.calls).toEqual([['Owner', undefined], ['Personal', 'producer-second']]);
  release(); await first;
  expect(h.pulse.mock.calls.slice(2)).toEqual([['Crm', undefined], ['Owner', undefined], ['Personal', 'producer-first']]);
});

it('preserves a successful handler result when the final notification fails', async () => {
  h.pulse.mockImplementationOnce(() => { throw new Error('offline'); });
  expect(await batchLiveChanges(async () => { await sendCrmWrite(Promise.resolve()); return 'committed'; })()).toBe('committed');
});
