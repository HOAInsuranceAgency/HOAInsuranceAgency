import { useEffect, useRef, useState } from "react";
import { communicationRequest } from "./communications";
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
  const [state, setState] = useState<{ key: string; contacts: Record<string, ContactStamp | null>; loading: boolean; error: string }>({ key: "", contacts: {}, loading: false, error: "" });
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current, active = () => generation.current === current;
    setState({ key, contacts: {}, loading: !!key, error: "" });
    if (key) void loadLastContacts(key.split(","), active).then(contacts => { if (active()) setState({ key, contacts, loading: false, error: "" }); }, () => { if (active()) setState({ key, contacts: {}, loading: false, error: "Could not load last contact. Refresh to try again." }); });
    return () => { generation.current++; };
  }, [key, revision]);
  return state.key === key ? state : { contacts: {} as Record<string, ContactStamp | null>, loading: !!key, error: "" };
}
