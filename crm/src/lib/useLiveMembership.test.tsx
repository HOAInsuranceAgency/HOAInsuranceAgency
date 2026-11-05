import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ groups: vi.fn() }));
vi.mock('./auth', () => ({ fetchUserGroups: h.groups }));
import { liveUpdates, type LiveTopic } from './liveUpdates';
import { useLiveMembership } from './useLiveMembership';

let stop: (() => void) | undefined;
const release: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  h.groups.mockReset().mockResolvedValue(['ADMIN']);
  stop = liveUpdates.start('membership-test:ADMIN');
});
afterEach(() => {
  cleanup(); stop?.(); release.splice(0).forEach(fn => fn());
  vi.useRealTimers(); vi.restoreAllMocks();
});
const tick = async (ms = 1_100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function push(topics: readonly LiveTopic[] = ['PERSONAL']) {
  act(() => liveUpdates.invalidate(topics)); await tick();
}
function pending() {
  let resolve!: (groups: string[]) => void, reject!: (error: unknown) => void;
  const promise = new Promise<string[]>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function setup(groups: readonly string[] = ['ADMIN'], enabled = true) {
  const onChanged = vi.fn(), onDenied = vi.fn();
  const hook = renderHook(({ current, allowed }) => useLiveMembership({ enabled: allowed, groups: current, onChanged, onDenied }),
    { initialProps: { current: groups, allowed: enabled } });
  return { ...hook, onChanged, onDenied };
}

it('quietly refreshes unchanged claim sets, ignoring ordering and duplicates', async () => {
  h.groups.mockResolvedValue(['PRODUCER', 'ADMIN', 'ADMIN']);
  const hook = setup(['ADMIN', 'PRODUCER']);
  await push(['CRM']);
  expect(h.groups).not.toHaveBeenCalled();
  await push();
  expect(h.groups).toHaveBeenCalledExactlyOnceWith(true);
  expect(hook.onChanged).not.toHaveBeenCalled();
  expect(hook.onDenied).not.toHaveBeenCalled();
});

it('checks actual membership changes through an editor lock', async () => {
  const hook = setup();
  release.push(liveUpdates.acquireBlock());
  h.groups.mockResolvedValue(['PRODUCER']);
  await push();
  expect(hook.onChanged).toHaveBeenCalledTimes(1);
  expect(hook.onDenied).not.toHaveBeenCalled();
});

it('defers new membership requests through a write barrier and resumes afterward', async () => {
  const hook = setup();
  const unlock = liveUpdates.acquireBlock('write'); release.push(unlock);
  await push();
  expect(h.groups).not.toHaveBeenCalled();
  act(unlock); await tick();
  expect(h.groups).toHaveBeenCalledTimes(1);
  expect(hook.onChanged).not.toHaveBeenCalled();
});

it('rechecks on focus while unchanged membership leaves the shell alone', async () => {
  const hook = setup();
  act(() => window.dispatchEvent(new Event('focus'))); await tick();
  expect(h.groups).toHaveBeenCalledExactlyOnceWith(true);
  expect(hook.onChanged).not.toHaveBeenCalled();
});

it('ignores a transient token outage and recovers on the next notification', async () => {
  const hook = setup();
  h.groups.mockRejectedValueOnce(new Error('Temporary network outage'));
  await push();
  expect(hook.onChanged).not.toHaveBeenCalled(); expect(hook.onDenied).not.toHaveBeenCalled();
  h.groups.mockResolvedValue(['STAFF']); await push();
  expect(hook.onChanged).toHaveBeenCalledTimes(1);
});

it('clears actual authorization loss even when editing and a write began during the request', async () => {
  const request = pending(); h.groups.mockReturnValueOnce(request.promise);
  const hook = setup(); await push();
  release.push(liveUpdates.acquireBlock(), liveUpdates.acquireBlock('write'));
  const error = Object.assign(new Error('Your membership is inactive'), { name: 'NotAuthorizedException' });
  await act(async () => request.reject(error));
  expect(hook.onDenied).toHaveBeenCalledExactlyOnceWith(error);
  expect(hook.onChanged).not.toHaveBeenCalled();
});

it('forwards current transport denial immediately, including through a dirty lock', () => {
  const hook = setup(); release.push(liveUpdates.acquireBlock());
  const error = Object.assign(new Error('Subscription access is inactive'), { name: 'Unauthorized' });
  act(() => liveUpdates.deny(error));
  expect(hook.onDenied).toHaveBeenCalledExactlyOnceWith(error);
  expect(h.groups).not.toHaveBeenCalled();
  hook.rerender({ current: ['ADMIN'], allowed: false });
  act(() => liveUpdates.deny(error));
  expect(hook.onDenied).toHaveBeenCalledTimes(1);
});

it.each(['success', 'denial'] as const)('drops a late %s after newer membership was verified', async outcome => {
  const request = pending(); h.groups.mockReturnValueOnce(request.promise);
  const hook = setup(); await push();
  h.groups.mockResolvedValue(['STAFF']);
  hook.rerender({ current: ['STAFF'], allowed: true });
  await act(async () => {
    if (outcome === 'success') request.resolve(['ADMIN']);
    else request.reject(Object.assign(new Error('Old session denied'), { name: 'Unauthorized' }));
  });
  expect(hook.onChanged).not.toHaveBeenCalled(); expect(hook.onDenied).not.toHaveBeenCalled();
  await tick();
  expect(h.groups).toHaveBeenCalledTimes(2);
  expect(hook.onChanged).not.toHaveBeenCalled(); expect(hook.onDenied).not.toHaveBeenCalled();
});

it.each(['success', 'denial'] as const)('drops a late %s after a new session starts with the same scope', async outcome => {
  const request = pending(); h.groups.mockReturnValueOnce(request.promise);
  const hook = setup(); await push();
  stop = liveUpdates.start('membership-test:ADMIN');
  await act(async () => {
    if (outcome === 'success') request.resolve(['STAFF']);
    else request.reject(Object.assign(new Error('Prior connection denied'), { name: 'Unauthorized' }));
  });
  expect(hook.onChanged).not.toHaveBeenCalled(); expect(hook.onDenied).not.toHaveBeenCalled();
});

it('fences changed groups when a write starts during the read, then rechecks', async () => {
  const request = pending(); h.groups.mockReturnValueOnce(request.promise);
  const hook = setup(); await push();
  const unlock = liveUpdates.acquireBlock('write'); release.push(unlock);
  await act(async () => request.resolve(['STAFF']));
  expect(hook.onChanged).not.toHaveBeenCalled();
  act(unlock); await tick();
  expect(h.groups).toHaveBeenCalledTimes(2);
  expect(hook.onChanged).not.toHaveBeenCalled();
});

it('ignores a pending result after unmounting or disabling membership checks', async () => {
  const request = pending(); h.groups.mockReturnValueOnce(request.promise);
  const hook = setup(); await push();
  hook.rerender({ current: ['ADMIN'], allowed: false });
  await act(async () => request.resolve(['STAFF']));
  expect(hook.onChanged).not.toHaveBeenCalled(); expect(hook.onDenied).not.toHaveBeenCalled();
  hook.unmount(); await push(); expect(h.groups).toHaveBeenCalledTimes(1);
});
