import { useEffect, useRef } from 'react';
import { liveUpdates } from './liveUpdates';
import { fetchUserGroups } from './auth';
import { isAuthorizationError } from '../../../shared/authorizationError';
import { useLiveRefresh } from './useLiveUpdates';

/** Refresh claims without remounting the shell when membership is unchanged.
 * Remote role changes/revocation must take effect even with an open draft. */
export function useLiveMembership(options: { enabled: boolean; groups: readonly string[]; onChanged(): void; onDenied(error: unknown): void }) {
  const latest = useRef(options); latest.current = options;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useLiveRefresh(async () => {
    if (!active.current || !latest.current.enabled) return;
    const fence = liveUpdates.getSnapshot();
    const key = (groups: readonly string[]) => JSON.stringify([...new Set(groups)].sort());
    const startingGroups = key(latest.current.groups);
    const sameSession = () => active.current && latest.current.enabled
      && fence.session === liveUpdates.getSnapshot().session && startingGroups === key(latest.current.groups);
    try {
      const groups = await fetchUserGroups(true);
      if (!sameSession() || !liveUpdates.canPublish(fence, false)) return false;
      const before = [...new Set(latest.current.groups)].sort();
      const after = [...new Set(groups)].sort();
      if (before.length !== after.length || before.some((group, index) => group !== after[index])) latest.current.onChanged();
    } catch (error) {
      if (!sameSession()) return false;
      if (isAuthorizationError(error)) latest.current.onDenied(error);
      // Ordinary refresh outages preserve claims, the shell, and drafts. The
      // next push/focus/fallback retries; business reads still enforce access.
    }
  }, { enabled: options.enabled, topics: ['PERSONAL'], protectEdits: false, intervalMs: 60_000,
    onDenied: error => { if (active.current && latest.current.enabled) latest.current.onDenied(error); },
  });
}
