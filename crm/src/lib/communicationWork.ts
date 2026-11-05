import { useEffect, useRef, useState } from "react";
import { communicationRequest as request, type LeadTask, type LeadWorkflow } from "./communications";
import { useAsyncResource } from "./useAsyncResource";
import { isAuthorizationError } from './authorizationError';
import { readLoadedPages } from './usePagedList';
import { liveUpdates } from './liveUpdates';

export type WorkItem = Partial<LeadTask & LeadWorkflow> & {
  id: string; version: number; message?: string; at?: string; state?: string; error?: string;
  communicationId?: string; phone?: string; urgency?: string; why?: string; instruction?: string; provider?: string; type?: string;
};
type WorkPage = { items: WorkItem[]; nextToken?: string };
export function useWorkItems(kind: string, filters: { view?: string; mine?: boolean } = {}) {
  const { view = "", mine = false } = filters;
  const scope = JSON.stringify([kind, view, mine]);
  const current = useRef(scope); current.current = scope;
  const pageDepth = useRef(1), pageScope = useRef(scope);
  if (pageScope.current !== scope) { pageScope.current = scope; pageDepth.current = 1; }
  const generation = useRef(0), paging = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false), [pageError, setPageError] = useState("");
  const resource = useAsyncResource<WorkPage>(async () => {
    const page = await readLoadedPages(token => request<WorkPage>("work", { kind, view, mine, ...(token ? { nextToken: token } : {}) }), pageDepth.current);
    if (!page) throw new Error('Could not refresh the loaded work.');
    return { items: page.items, nextToken: page.nextToken };
  }, [scope], {
    initialData: { items: [] }, errorMessage: "Could not load this work. Please refresh.", clearDataOnError: isAuthorizationError,
    live: { paused: loadingMore, onDenied: () => {
      generation.current++; paging.current = false; setLoadingMore(false); setPageError('');
    } },
  });
  useEffect(() => {
    setPageError(""); setLoadingMore(false); paging.current = false;
    return () => { generation.current++; };
  }, [scope]);
  async function refresh() {
    pageDepth.current = 1;
    generation.current++; paging.current = false; setLoadingMore(false); setPageError("");
    await resource.refetch();
  }
  async function loadMore() {
    const cursor = resource.data.nextToken;
    if (!cursor || paging.current || resource.loading) return;
    liveUpdates.touchEdit();
    const ticket = generation.current;
    paging.current = true; setLoadingMore(true); setPageError("");
    try {
      const page = await request<WorkPage>("work", { kind, view, mine, nextToken: cursor });
      if (ticket !== generation.current || current.current !== scope) return;
      if (page.nextToken === cursor) throw new Error("More work could not be loaded. Refresh and try again.");
      pageDepth.current++;
      resource.setData(previous => ({ ...page, items: [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()] }));
    } catch (e) {
      if (ticket === generation.current && current.current === scope) {
        if (isAuthorizationError(e)) resource.invalidate(e);
        else setPageError(e instanceof Error ? e.message : "Could not load more work.");
      }
    } finally {
      if (ticket === generation.current && current.current === scope) { paging.current = false; setLoadingMore(false); }
    }
  }
  return { ...resource, refetch: refresh, refresh, loadMore, loadingMore, pageError: pageError || resource.refreshError || '' };
}
