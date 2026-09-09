import { ActivityReview, DeliveryReview, ReviewAction } from "../components/CommunicationReview";
import { useIsAdmin } from "../lib/auth";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { communicationRequest as request, type LeadTask, type LeadWorkflow } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDateTime, type UserProfile } from "../lib/client";

type WorkItem = Partial<LeadTask & LeadWorkflow> & { id: string; version: number; resolved?: boolean; processedAt?: string; message?: string; title?: string; at?: string; recipient?: string; state?: string; error?: string; communicationId?: string; accountId?: string };
const VIEWS = ["Needs response", "Due today", "Overdue", "Waiting on prospect", "Champion work", "Needs assignment", "Communication issues", "Unlinked activity", "Notifications", "Delivery queue", "Event processing"];
export default function LeadWork(_props: { profile: UserProfile }) {
  const admin = useIsAdmin();
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [view, setView] = useState(VIEWS[0]), [mine, setMine] = useState(false), [moreError, setMoreError] = useState("");
  const kind = view === "Event processing" ? "EVENT" : view === "Delivery queue" ? "OPERATION" : view === "Needs assignment" ? "WORKFLOW" : view === "Communication issues" ? "ISSUE" : view === "Unlinked activity" ? "TRIAGE" : view === "Notifications" ? "NOTIFICATION" : "TASK";
  const scope = `${kind}:${view}:${mine}`, activeScope = useRef(scope); activeScope.current = scope;
  const resource = useAsyncResource(() => request<{ items: WorkItem[]; nextToken?: string }>("work", { kind, view, mine }), [kind, view, mine], { initialData: { items: [] }, errorMessage: "Could not load lead work" });
  const now = new Date().toISOString();
  const rows = resource.data.items;
  return <><h1>Lead follow-up</h1><p className="sub">Team commitments across email, phone and text</p><div className="toolbar"><label>View <select value={view} onChange={e => { setView(e.target.value); setReviewId(null); }}>{VIEWS.map(v => <option key={v}>{v}</option>)}</select></label><label><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> My leads</label><div className="grow"/><button className="secondary" onClick={() => void resource.refetch()}>Refresh</button></div>
    {(resource.error || moreError) && <p className="error-text">{resource.error || moreError}</p>}
    <div className="card">{resource.loading ? <p>Loading…</p> : !rows.length ? <p className="muted">{resource.data.nextToken ? "More records remain to be searched. Continue to find matching work." : "No matching work."}</p> : <div className="table-wrap"><table><thead><tr><th>Lead / action</th><th>Responsible role</th><th>Due</th><th>Status</th><th>Review</th></tr></thead><tbody>{rows.map(t => <tr key={t.id}><td>{t.accountId ? <Link to={`/accounts/${t.accountId}`}>{t.name ?? "Open lead"}</Link> : "Needs linking"}<div>{t.title ?? t.message ?? t.error ?? t.communicationId ?? t.assignmentIssue}</div></td><td>{t.role === "CHAMPION" ? "Deal champion" : t.role === "SALESPERSON" ? "Salesperson" : "Team"}</td><td>{fmtDateTime(t.dueAt ?? t.at)}</td><td>{t.escalatedAt ? "Escalated" : t.dueAt && t.dueAt < now ? "Overdue" : t.state ?? t.status?.toLowerCase() ?? "Needs review"}</td><td>
      {kind === "TRIAGE" && t.communicationId && <button className="link" onClick={() => setReviewId(t.communicationId!)}>Link activity</button>}
      {["ISSUE", "TRIAGE", "NOTIFICATION"].includes(kind) && <ReviewAction id={t.id} version={t.version} onSaved={() => void resource.refetch()} />}
      {kind === "EVENT" && admin && <ReviewAction id={t.id} version={t.version} event onSaved={() => void resource.refetch()} />}
      {kind === "OPERATION" && admin && <DeliveryReview item={t} onSaved={() => void resource.refetch()} />}
    </td></tr>)}</tbody></table></div>}
    {reviewId && <ActivityReview key={reviewId} id={reviewId} onSaved={() => { setReviewId(null); void resource.refetch(); }} />}
    {resource.data.nextToken && <button onClick={async () => { try { const page = await request<{ items: WorkItem[]; nextToken?: string }>("work", { kind, view, mine, nextToken: resource.data.nextToken }); if (activeScope.current !== scope) return; resource.setData(p => ({ items: [...p.items, ...page.items], nextToken: page.nextToken })); } catch(e) { setMoreError(String(e)); } }}>{rows.length ? "Load more" : "Continue searching"}</button>}</div></>;
}
