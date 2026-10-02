import { useCallback, useEffect, useRef, useState } from 'react';

export type InteractionChange = (key: string, active: boolean) => void;

/** Defer background list reloads until every row editor and save has finished. */
export function useRefreshOnReturn(refresh: () => Promise<void>, enabled: boolean, loading: boolean) {
  const [interactions, setInteractions] = useState<Set<string>>(() => new Set());
  const pending = useRef(false);
  const blocked = loading || interactions.size > 0;
  const onInteractionChange = useCallback<InteractionChange>((key, active) => {
    setInteractions(current => {
      if (current.has(key) === active) return current;
      const next = new Set(current);
      if (active) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) { pending.current = false; return; }
    let timer: number | undefined;
    const schedule = () => {
      if (blocked || timer !== undefined || document.visibilityState !== 'visible') return;
      // Focus and visibility usually arrive together; load one fresh snapshot.
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!pending.current || document.visibilityState !== 'visible') return;
        pending.current = false;
        void refresh();
      }, 100);
    };
    const request = () => {
      if (document.visibilityState !== 'visible') return;
      pending.current = true;
      schedule();
    };
    if (pending.current) schedule();
    window.addEventListener('focus', request);
    document.addEventListener('visibilitychange', request);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', request);
      document.removeEventListener('visibilitychange', request);
    };
  }, [enabled, blocked, refresh]);

  return onInteractionChange;
}

export function useRowInteraction(key: string, active: boolean, report?: InteractionChange) {
  useEffect(() => {
    report?.(key, active);
    return () => report?.(key, false);
  }, [key, active, report]);
}
