import { useState } from "react";
import { Link } from "react-router-dom";
import { ActivityReview, ReviewAction } from "./CommunicationReview";
import { useWorkItems } from "../lib/communicationWork";
import { fmtDateTime, fmtProviderPhone } from "../lib/client";

export function WorkPagination({ work }: { work: ReturnType<typeof useWorkItems> }) {
  return <>{work.pageError && <p role="alert" className="error-text">{work.pageError}</p>}
    {work.data.nextToken && !work.error && <button className="secondary" disabled={work.loading || work.loadingMore} onClick={() => void work.loadMore()}>{work.loadingMore ? "Loading…" : work.data.items.length ? "Load more" : "Continue searching"}</button>}
  </>;
}
export function SharedLeadAttention({ onChanged }: { onChanged: () => void }) {
  return <section className="lead-work-shared" aria-label="Shared team items">
    <h2>Help the team get started</h2><p className="muted small">Unassigned leads and unlinked activity are shared team items, including when My leads is selected.</p>
    <div className="lead-work-shared-grid"><SharedItems kind="WORKFLOW" onChanged={onChanged} /><SharedItems kind="TRIAGE" onChanged={onChanged} /></div>
  </section>;
}
function SharedItems({ kind, onChanged }: { kind: "WORKFLOW" | "TRIAGE"; onChanged: () => void }) {
  const work = useWorkItems(kind), [reviewId, setReviewId] = useState<string | null>(null);
  function saved() { setReviewId(null); void work.refresh(); onChanged(); }
  return <section className="card lead-work-shared-card" aria-label={kind === "WORKFLOW" ? "Assign a teammate" : "Link a call or text"}>
    <h3>{kind === "WORKFLOW" ? "Assign a teammate" : "Link a call or text"}</h3>
    {work.error && <p role="alert" className="error-text">{work.error} <button className="link" onClick={() => void work.refresh()}>Retry</button></p>}
    {work.loading ? <p className="muted">Checking…</p> : work.error ? null : !work.data.items.length && <p className="muted small">{work.data.nextToken ? "More items remain to be checked." : kind === "WORKFLOW" ? "No leads need assignment." : "No activity needs linking."}</p>}
    {!work.loading && !work.error && work.data.items.map(item => <div key={item.id} className="lead-work-shared-item">
      {kind === "WORKFLOW" ? <>
        <strong>{item.name || "Lead needs assignment"}</strong><p className="small muted">Choose {item.salespersonId && !item.assignmentIssue ? "a deal champion" : item.championId && !item.assignmentIssue ? "a salesperson" : "a salesperson and deal champion"}.</p>
        {item.accountId && <Link to={`/accounts/${item.accountId}`}>Open lead to assign</Link>}
      </> : <>
        <strong>{item.phone ? fmtProviderPhone(item.phone) : "Unknown contact"}</strong><p className="small muted">{fmtDateTime(item.at)} · Choose the right lead for this activity.</p>
        {item.communicationId && <button className="link" onClick={() => setReviewId(item.communicationId!)}>Choose lead</button>}
        <ReviewAction id={item.id} version={item.version} onSaved={saved} />
      </>}
    </div>)}
    {reviewId && <><ActivityReview key={reviewId} id={reviewId} onSaved={saved} /><button className="secondary" onClick={() => setReviewId(null)}>Cancel linking</button></>}
    <WorkPagination work={work} />
  </section>;
}
export function LeadReminders() {
  const work = useWorkItems("NOTIFICATION");
  return <div className="lead-work-reminder-list">
    <p className="muted small">Reminders sent to you about open lead actions.</p>
    <button className="secondary" disabled={work.loading} onClick={() => void work.refresh()}>Refresh reminders</button>
    {work.error && <p role="alert" className="error-text">{work.error}</p>}
    {work.loading ? <p>Loading reminders…</p> : !work.error && !work.data.items.length && <p className="muted">{work.data.nextToken ? "More reminders remain to be checked." : "You're up to date."}</p>}
    {!work.loading && !work.error && work.data.items.map(item => <div className="lead-work-shared-item" key={item.id}>
      {item.accountId && <Link to={`/accounts/${item.accountId}`}>{item.name || "Open lead"}</Link>}
      <p>{item.title}</p><p className="small muted">{item.urgency === "ESCALATED" ? "Escalated to you" : "Action due"} · {fmtDateTime(item.at)}</p>
      <ReviewAction id={item.id} version={item.version} onSaved={() => void work.refresh()} />
    </div>)}
    <WorkPagination work={work} />
  </div>;
}
