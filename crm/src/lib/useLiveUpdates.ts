import { useEffect, useLayoutEffect, useRef } from 'react';
import { liveUpdates, type LiveRefreshOptions } from './liveUpdates';
export type { LiveTopic, LiveRefreshOptions } from './liveUpdates';

/** Register a read, never a command. Draft/write locks defer its application. */
export function useLiveRefresh(callback: () => void | boolean | Promise<void | boolean>, options: LiveRefreshOptions = {}) {
  const current = useRef({ callback, options }); current.current = { callback, options };
  useEffect(() => liveUpdates.register(() => current.current.callback(), () => current.current.options), []);
  useEffect(() => { liveUpdates.wake(); });
}
export function useLiveUpdateBlock(active: boolean, kind: 'edit' | 'write' = 'edit') {
  useLayoutEffect(() => active ? liveUpdates.acquireBlock(kind) : undefined, [active, kind]);
}
