import { useEffect, useRef, useState } from "react";
import { communicationRequest as request, type LeadTask, type LeadWorkflow } from "./communications";
import { useAsyncResource } from "./useAsyncResource";

export type WorkItem = Partial<LeadTask & LeadWorkflow> & {
  id: string; version: number; message?: string; at?: string; state?: string; error?: string;
  communicationId?: string; phone?: string; urgency?: string; provider?: string; type?: string;
};
type WorkPage = { items: WorkItem[]; nextToken?: string };
export function useWorkItems(kind: string, filters: { view?: string; mine?: boolean; responsibility?: string } = {}) {
  const { view = "", mine = false, responsibility = "" } = filters;
  const scope = JSON.stringify([kind, view, mine, responsibility]);
  const current = useRef(scope); current.current = scope;
  const generation = useRef(0), paging = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false), [pageError, setPageError] = useState("");
  const resource = useAsyncResource(() => request<WorkPage>("work", { kind, view, mine, responsibility }), [scope], {
    initialData: { items: [] }, errorMessage: "Could not load this work. Please refresh.",
  });
  useEffect(() => {
    setPageError(""); setLoadingMore(false); paging.current = false;
    return () => { generation.current++; };
  }, [scope]);
  async function refresh() {
    generation.current++; paging.current = false; setLoadingMore(false); setPageError("");
    await resource.refetch();
  }
  async function loadMore() {
    const cursor = resource.data.nextToken;
    if (!cursor || paging.current || resource.loading) return;
    const ticket = generation.current;
    paging.current = true; setLoadingMore(true); setPageError("");
    try {
      const page = await request<WorkPage>("work", { kind, view, mine, responsibility, nextToken: cursor });
      if (ticket !== generation.current || current.current !== scope) return;
      if (page.nextToken === cursor) throw new Error("More work could not be loaded. Refresh and try again.");
      resource.setData(previous => ({ ...page, items: [...new Map([...previous.items, ...page.items].map(item => [item.id, item])).values()] }));
    } catch (e) {
      if (ticket === generation.current && current.current === scope) setPageError(e instanceof Error ? e.message : "Could not load more work.");
    } finally {
      if (ticket === generation.current && current.current === scope) { paging.current = false; setLoadingMore(false); }
    }
  }
  return { ...resource, refresh, loadMore, loadingMore, pageError };
}
