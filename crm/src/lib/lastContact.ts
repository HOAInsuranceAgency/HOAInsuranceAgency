import { useEffect, useMemo, useRef } from "react";
import { communicationRequest } from "./communications";
import { useAsyncResource } from './useAsyncResource';
export interface ContactStamp { at: string; channel: string; direction: string }
export async function loadLastContacts(ids: string[], active: () => boolean = () => true) {
  const contacts: Record<string, ContactStamp | null> = {};
  for (let start = 0; start < ids.length && active(); start += 10) {
    let pending = ids.slice(start, start + 10).map(accountId => ({ accountId, nextToken: undefined as string | undefined }));
    const seen = new Set<string>();
    while (pending.length && active()) {
      const result = await communicationRequest<{ items: { accountId: string; contact: ContactStamp | null; complete: boolean; nextToken?: string }[] }>("lastContacts", { accounts: pending });
      if (result.items.length !== pending.length) throw new Error("Contact history was incomplete. Refresh to try again.");
      pending = [];
      for (const item of result.items) {
        if (item.contact && (!contacts[item.accountId] || item.contact.at > contacts[item.accountId]!.at)) contacts[item.accountId] = item.contact;
        else contacts[item.accountId] ??= null;
        if (!item.complete) {
          const key = `${item.accountId}:${item.nextToken}`;
          if (!item.nextToken || seen.has(key)) throw new Error("Contact history could not finish loading. Refresh to try again.");
          seen.add(key); pending.push({ accountId: item.accountId, nextToken: item.nextToken });
        }
      }
    }
  }
  return contacts;
}
export function useLastContacts(ids: string[], revision: unknown) {
  const key = [...new Set(ids)].sort().join(",");
  const scope = useMemo(() => ({}), [key, revision]);
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const resource = useAsyncResource(
    () => loadLastContacts(key ? key.split(',') : [], () => mounted.current && current.current === scope),
    [scope],
    { initialData: {} as Record<string, ContactStamp | null>, manual: !key, live: !!key, errorMessage: 'Could not load last contact. Refresh to try again.' },
  );
  return { key, contacts: resource.data, loading: resource.loading, error: resource.error || resource.refreshError || '', refreshing: resource.refreshing };
}
