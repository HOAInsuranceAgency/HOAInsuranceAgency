import { useWorkItems } from "../lib/communicationWork";

export function WorkPagination({ work }: { work: ReturnType<typeof useWorkItems> }) {
  return <>{work.pageError && <p role="alert" className="error-text">{work.pageError}</p>}
    {work.data.nextToken && !work.error && <button className="secondary" disabled={work.loading || work.loadingMore} onClick={() => void work.loadMore()}>{work.loadingMore ? "Loading…" : work.data.items.length ? "Load more" : "Continue searching"}</button>}
  </>;
}
