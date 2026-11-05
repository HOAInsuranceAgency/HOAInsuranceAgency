import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { Hub } from 'aws-amplify/utils';
import { client } from './client';
import { activeRoleHeaders } from './activeRole';
import { isAuthorizationError } from './authorizationError';
import { liveUpdates, type LiveTopic } from './liveUpdates';

/** Scoped transport only: notifications contain no records or financial data. */
export function LiveUpdatesProvider({ userId, role, children }: { userId: string; role: string; children: ReactNode }) {
  const scope = `${userId}:${role}`;
  useLayoutEffect(() => {
    const stop = liveUpdates.start(scope);
    // Fence in-flight reads at the event boundary, before a custom editor's
    // layout effect installs its lasting draft lock.
    const edit = () => liveUpdates.touchEdit();
    document.addEventListener('beforeinput', edit, true); document.addEventListener('input', edit, true); document.addEventListener('change', edit, true);
    return () => { stop(); document.removeEventListener('beforeinput', edit, true); document.removeEventListener('input', edit, true); document.removeEventListener('change', edit, true); };
  }, [scope]);
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let connection = 0;
    let broken = true;
    let subscriptions: { unsubscribe(): void }[] = [];
    const close = () => { subscriptions.forEach(s => s.unsubscribe()); subscriptions = []; };
    const connect = async () => {
      if (disposed || document.visibilityState === 'hidden' || navigator.onLine === false) return;
      const version = ++connection;
      close(); broken = false;
      const headers = await activeRoleHeaders();
      if (disposed || version !== connection) return;
      const failed = (error: unknown) => {
        if (disposed || version !== connection) return;
        broken = true; close();
        if (isAuthorizationError(error)) liveUpdates.deny(error);
        // SDK reconnects established sockets. Recreate a subscription which
        // terminated before establishment; polling still covers missed events.
        if (!retry) retry = setTimeout(() => { retry = undefined; void connect().catch(failed); }, 30_000);
      };
      const subscribe = (topic: LiveTopic, operation: (options: { headers: Record<string, string> }) => { subscribe(observer: { next(value: unknown): void; error(error: unknown): void }): { unsubscribe(): void } }) => {
        if (broken) return;
        try {
          const subscription = operation({ headers }).subscribe({ next: () => { if (!disposed && version === connection) liveUpdates.invalidate([topic]); }, error: failed });
          if (broken || disposed) subscription.unsubscribe(); else subscriptions.push(subscription);
        } catch (error) { failed(error); }
      };
      // Explicit role headers are captured per connection, not read later from
      // a mutable preference after the user switches roles.
      subscribe('CRM', options => client.subscriptions.onCrmChange(options));
      subscribe('PERSONAL', options => client.subscriptions.onPersonalChange(options));
      if (role === 'OWNER') subscribe('OWNER', options => client.subscriptions.onOwnerChange(options));
    };
    void connect().catch(() => { /* Fallback reads retain freshness if transport setup fails. */ });
    const resume = () => { if (broken || !subscriptions.length) void connect().catch(() => {}); };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume);
    const cancelHub = Hub.listen('api', ({ payload }) => {
      if (payload.event === 'ConnectionStateChange' && (payload.data as { connectionState?: unknown } | undefined)?.connectionState === 'Connected') liveUpdates.invalidate();
    });
    return () => { disposed = true; if (retry) clearTimeout(retry); close(); cancelHub(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }, [scope, role]);
  return children;
}
