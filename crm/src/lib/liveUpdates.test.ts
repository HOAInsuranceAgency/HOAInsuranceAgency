import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveUpdates } from './liveUpdates';
let stop: (() => void) | undefined;
let unregister: (() => void)[] = [];
const tick = async (ms = 100) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z')); stop = liveUpdates.start('user:STAFF'); });
afterEach(() => { unregister.forEach(fn => fn()); unregister = []; stop?.(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('live update coordination', () => {
  it('coalesces bursts, bounds read frequency, and keeps notification payloads out of reads', async () => {
    const read = vi.fn(); unregister.push(liveUpdates.register(read, () => ({})));
    for (let i = 0; i < 10; i++) liveUpdates.invalidate(['CRM']);
    await tick(); expect(read).toHaveBeenCalledTimes(1); expect(read.mock.calls[0]).toEqual([]);
    liveUpdates.invalidate(); await tick(); expect(read).toHaveBeenCalledTimes(1);
    await tick(900); expect(read).toHaveBeenCalledTimes(2);
  });
  it('defers source snapshots while editing, but allows read-only status; writes block both', async () => {
    const source = vi.fn(), status = vi.fn();
    unregister.push(liveUpdates.register(source, () => ({})), liveUpdates.register(status, () => ({ protectEdits: false })));
    const release = liveUpdates.acquireBlock(); liveUpdates.invalidate(); await tick();
    expect(source).not.toHaveBeenCalled(); expect(status).toHaveBeenCalledTimes(1);
    const commit = liveUpdates.acquireBlock('write'); release(); liveUpdates.invalidate(); await tick(1000);
    expect(source).not.toHaveBeenCalled(); expect(status).toHaveBeenCalledTimes(1);
    commit(); await tick(); expect(source).toHaveBeenCalledTimes(1); expect(status).toHaveBeenCalledTimes(2);
  });
  it('fences in-flight responses when a draft or write starts even after the lock releases', () => {
    const before = liveUpdates.getSnapshot(); const release = liveUpdates.acquireBlock(); release();
    expect(liveUpdates.canPublish(before)).toBe(false); expect(liveUpdates.canPublish(before, false)).toBe(true);
    const beforeWrite = liveUpdates.getSnapshot(); const commit = liveUpdates.acquireBlock('write'); commit();
    expect(liveUpdates.canPublish(beforeWrite, false)).toBe(false);
  });
  it('polls visible readers after a missed notification and resumes after being hidden', async () => {
    const read = vi.fn(); unregister.push(liveUpdates.register(read, () => ({})));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange')); await tick(120_000); expect(read).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); await tick(); expect(read).toHaveBeenCalledTimes(1);
    await tick(60_000); expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not read offline and revalidates on reconnect', async () => {
    const read = vi.fn(); unregister.push(liveUpdates.register(read, () => ({})));
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline')); liveUpdates.invalidate(); await tick(60_000); expect(read).not.toHaveBeenCalled();
    online.mockReturnValue(true); window.dispatchEvent(new Event('online')); await tick(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('filters audiences and ignores cross-role storage notifications', async () => {
    const read = vi.fn(); unregister.push(liveUpdates.register(read, () => ({ topics: ['OWNER'] })));
    liveUpdates.invalidate(['CRM']); await tick(); expect(read).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: 'crm-live-invalidation', newValue: JSON.stringify({ scope: 'other:OWNER' }) })); await tick(); expect(read).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: 'crm-live-invalidation', newValue: JSON.stringify({ scope: 'user:STAFF', topics: ['OWNER'] }) })); await tick(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('an obsolete cleanup cannot stop a newer session, including after publishing', async () => {
    const oldStop = stop!; stop = liveUpdates.start('new:PRODUCER'); liveUpdates.invalidate(); oldStop();
    expect(liveUpdates.getSnapshot().active).toBe(true); expect(liveUpdates.getSnapshot().scope).toBe('new:PRODUCER');
    stop(); expect(liveUpdates.getSnapshot().active).toBe(false);
  });
});
