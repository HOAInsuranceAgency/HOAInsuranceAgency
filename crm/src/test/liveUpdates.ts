import { act } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { liveUpdates, type LiveTopic } from '../lib/liveUpdates';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

/** Isolated consumer tests stay inert until they explicitly model a live event. */
export function enableLiveUpdates() {
  if (!stop && !liveUpdates.getSnapshot().active) stop = liveUpdates.start('consumer-test');
}
export async function invalidateLiveUpdates(topics?: readonly LiveTopic[]) {
  enableLiveUpdates();
  await act(async () => {
    liveUpdates.invalidate(topics);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1_100);
    else await new Promise(resolve => setTimeout(resolve, 1_100));
  });
}
