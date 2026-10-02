import ConversationContext from "./ConversationContext";
import CommunicationAccountSummary from "./CommunicationAccountSummary";
import { CallOutcome, SidebarActivityLinker } from "./CommunicationReview";
import { useEffect, useState, useRef } from "react";
import { communicationRequest as request, type WorkflowContext, type TeamEligibility } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDateTime, fmtProviderPhone, friendlyError } from "../lib/client";
import { compactDateTime, communicationChannelLabels } from "../lib/communicationLabels";
import { isAssignableSalesperson } from "../../../shared/salespersonOwnership";
import "./LeadWorkflowPanel.css";

const EMPTY: WorkflowContext = { workflow: null, tasks: [], communications: [], team: [], issues: [] };
export function ResponsibilitySelect({ label, value, team, onChange, disabled = false }: {
  label: string; value: string; team: TeamEligibility[]; onChange: (value: string) => void; disabled?: boolean;
}) {
  const eligible = team.filter(isAssignableSalesperson);
  return <label className="field">{label}<select aria-label={label} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
    <option value="">Choose teammate</option>
    {value && !eligible.some(t => t.userId === value) && <option value={value} disabled>{team.find(t => t.userId === value)?.name ?? "Assigned teammate"} (needs review)</option>}
    {eligible.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}
  </select></label>;
}
export default function LeadWorkflowPanel({ accountId, conversationId, onOpen }: { accountId?: string; conversationId?: string; onOpen?: (url: string) => void }) {
  const compact = !!onOpen;
  const [editingTeam, setEditingTeam] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [salesperson, setSalesperson] = useState("");
  const [leadStatus, setLeadStatus] = useState("LOST");
  const noteId = useRef(crypto.randomUUID());
  const [channel, setChannel] = useState("ALL");
  const [note, setNote] = useState(""), [publish, setPublish] = useState(false);
  const resource = useAsyncResource(() => request<WorkflowContext>("context", { accountId, conversationId }), [accountId, conversationId, revision], { initialData: EMPTY, errorMessage: "Could not load account communications" });
  const { workflow, communications, team, issues } = resource.data;
  useEffect(() => {
    if (!compact || busy || editingTeam || note.trim() || resource.loading) return;
    const refresh = () => { if (document.visibilityState === "visible") void resource.refetch(); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [compact, busy, editingTeam, note, resource.loading, resource.refetch]);
  useEffect(() => { setSalesperson(workflow?.salespersonId ?? ""); }, [workflow?.salespersonId]);
  // The parent keys the panel by conversation/account, so unsaved edits never
  // become writes against the newly selected lead in Front.
  const run = async (op: string, input: unknown) => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await request<{ notice?: string }>(op, input, true); if (result.notice) setNotice(result.notice); setRevision(n => n + 1); return true; }
    catch (e) { setError(friendlyError(e, "Could not save")); return false; }
    finally { setBusy(false); }
  };
  function open(url: string) { if (onOpen) onOpen(url); else window.open(url, "_blank", "noopener,noreferrer"); }
  if (resource.loading && !workflow) return <div className="card" role="status" aria-busy="true">Loading account communications…</div>;
  if (resource.error) return <div className="card"><p className="error-text" role="alert">{resource.error}</p><button className="secondary" onClick={() => void resource.refetch()}>Retry</button></div>;
  if (!workflow) return <div className="card"><h2>Account communications</h2><p>{accountId ? "Set up the account salesperson and linked communications." : "Link this conversation to its CRM account to see its salesperson and communication history."}</p>
    {accountId && <button className="primary" disabled={busy} onClick={() => void run("initializeLead", { accountId })}>Set up account communications</button>}{error && <p role="alert">{error}</p>}</div>;
  const clientWork = workflow.disposition === "BOUND";
  const teamName = (id?: string) => team.find(t => t.userId === id)?.name ?? "Needs assignment";
  const visibleCommunications = communications.filter(c => channel === "ALL" || c.channel === channel);
  const history = <>
    <div className="toolbar activity-history-heading">{!compact && <h3>Communication history <span className="activity-history-count">{communications.length}{resource.data.communicationNextToken ? "+" : ""}</span></h3>}<select aria-label="Communication channel" value={channel} onChange={e => setChannel(e.target.value)}>{["ALL", "EMAIL", "CALL", "SMS", "NOTE"].map(c => <option key={c} value={c}>{communicationChannelLabels[c]}</option>)}</select></div>
    {!visibleCommunications.length && <div className={compact ? "muted" : "activity-empty"}>{!communications.length ? <><strong>No linked communication yet.</strong>{!compact && <p>Emails, calls, texts, and internal notes will appear here.</p>}</> : <p>No {communicationChannelLabels[channel].toLowerCase()} in the loaded activity.{resource.data.communicationNextToken ? " Load older activity to check earlier records." : ""}</p>}</div>}
    {visibleCommunications.map(c => <details key={c.id} className="workflow-task"><summary><span className="workflow-activity-title">{c.subject || c.summary?.slice(0, 70) || (["SMS", "NOTE"].includes(c.channel) ? c.text?.slice(0, 70) : undefined) || (c.channel === "CALL" ? "Phone call" : c.channel === "NOTE" ? "Internal note" : "Message")}</span><span className="workflow-activity-meta">{c.channel === "CALL" ? "Call" : c.channel === "SMS" ? "Text" : c.channel === "NOTE" ? "Note" : "Email"} · {compact ? compactDateTime(c.at) : fmtDateTime(c.at)}</span></summary>
      <div className="activity-message-body">
      <p className="small">{c.direction.toLowerCase()} · {c.status.toLowerCase()}{c.from ? ` · ${c.channel === "SMS" || c.channel === "CALL" ? fmtProviderPhone(c.from) : c.from}` : ""}</p>
      {c.to?.length && <p className="small">To: {c.to.map(to => c.channel === "SMS" || c.channel === "CALL" ? fmtProviderPhone(to) : to).join(", ")}</p>}{c.actorId && (c.direction === "OUTBOUND" || team.some(t => t.frontId === c.actorId || t.dialpadId === c.actorId || t.userId === c.actorId)) && <p className="small">Handled by: {c.actorId === "crm:initial-ai" ? "Brian Cole (initial AI email)" : team.find(t => t.frontId === c.actorId || t.dialpadId === c.actorId || t.userId === c.actorId)?.name ?? "Unmapped teammate"}</p>}
      {c.channel === "CALL" && <><p className="muted small">{c.enrichment}</p><CallOutcome communication={c} /></>}
      {c.summary && <p>{c.summary}</p>}<p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text || "Content is unavailable. Open the source for details."}</p>
      {c.channel === "EMAIL" && c.direction === "OUTBOUND" && <p className="muted small">{c.seenAt ? `Seen signal: ${fmtDateTime(c.seenAt)}` : c.seenCheckedAt ? "No Seen signal returned" : "Seen status not checked yet"}{c.seenCheckedAt && ` · Checked ${fmtDateTime(c.seenCheckedAt)}`}. An email-open signal does not prove it was read.</p>}
      {c.provider === "front" && c.channel === "EMAIL" && c.direction === "OUTBOUND" && <button className="link" disabled={busy} onClick={() => void run("refreshSeen", { id: c.id })}>Refresh Seen status{c.seenRequestedAt ? " (queued)" : ""}</button>}
      {c.attachments?.map(a => <p key={a.id}>{a.filename} · {Math.ceil(a.size / 1024)} KB <button className="link" disabled={busy} onClick={() => void run("saveAttachment", { communicationId: c.id, attachmentId: a.id })}>Save to CRM documents</button></p>)}
      {c.seenError && <p className="error-text small">Seen status unavailable: {c.seenError}</p>}
      {c.provider === "front" && <button className="link" onClick={() => open(`https://app.frontapp.com/open/${c.providerId}`)}>Open message</button>}
      </div>
    </details>)}
    {resource.data.communicationNextToken && <button className="secondary activity-load-more" onClick={async () => { try { const more = await request<WorkflowContext>("context", { accountId: workflow.accountId, nextToken: resource.data.communicationNextToken }); resource.setData(current => ({ ...current, communications: [...current.communications, ...more.communications], communicationNextToken: more.communicationNextToken })); } catch(e) { setError(String(e)); } }}>Load older activity</button>}
  </>;
  const noteEditor = <>
    {!compact && <h3>Add an internal note</h3>}<div className="field"><textarea aria-label="Internal note" placeholder="Add a note for your team…" value={note} onChange={e => setNote(e.target.value)} rows={3} /></div>
    <div className="activity-note-actions">
    <label className="workflow-note-publish"><input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)} /> Also post as a Front comment</label>
    <div className="toolbar"><button className="primary" disabled={busy || !note.trim()} onClick={async () => { if (await run("addNote", { accountId: workflow.accountId, text: note, publishToFront: publish, requestId: noteId.current })) { setNote(""); noteId.current = crypto.randomUUID(); } }}>Save note</button></div></div>  </>;
  const conversationTools = <>
    {(conversationId ?? workflow.conversationId) && <ConversationContext accountId={workflow.accountId} conversationId={(conversationId ?? workflow.conversationId)!} bound={workflow.disposition === "BOUND"} saved={resource.data.frontContext} onSaved={() => void resource.refetch()} />}
    {workflow.disposition !== "BOUND" && <details className="front-disclosure"><summary>Lead status</summary>
      {workflow.disposition === "ACTIVE" ? <><label className="field">Status<select value={leadStatus} onChange={e => setLeadStatus(e.target.value)}><option value="LOST">Lost</option><option value="DISQUALIFIED">Not a fit</option></select></label><button className="secondary" disabled={busy} onClick={() => void run("setLeadDisposition", { accountId: workflow.accountId, version: workflow.version, disposition: leadStatus })}>Update lead status</button></>
        : <button className="secondary" disabled={busy} onClick={() => void run("setLeadDisposition", { accountId: workflow.accountId, version: workflow.version, disposition: "ACTIVE" })}>Reopen lead</button>}
    </details>}

    {!workflow.humanTakeover && <div className="front-tool-action"><button className="secondary" disabled={busy} onClick={() => void run("cancelAi", { accountId: workflow.accountId, version: workflow.version })}>{compact ? "Handle personally" : "Handle personally / cancel pending AI reply"}</button>{compact && <p className="muted small">Cancels an AI reply that has not been sent.</p>}</div>}
    {workflow.conversationId && <>
      {compact && <h3>Assign Front conversation to</h3>}
      <div className="toolbar"><button className={compact ? "secondary" : "link"} disabled={busy} onClick={() => void run("routeConversation", { conversationId: conversationId ?? workflow.conversationId, role: "SALESPERSON" })}>Use salesperson as Front handler</button></div>
    </>}
    {compact && conversationId && <SidebarActivityLinker accountId={workflow.accountId} conversationId={conversationId} onSaved={() => void resource.refetch()} />}
  </>;
  const owner = <section className={compact ? "front-team" : "activity-owner"} aria-label="Account owner">
      <div className="toolbar"><h3>Account owner</h3><div className="grow" />{!editingTeam && <button className="link" onClick={() => setEditingTeam(true)}>Edit salesperson</button>}</div>
      {!editingTeam ? <dl className="front-team-list"><div><dt>Salesperson</dt><dd>{teamName(workflow.salespersonId)}</dd></div></dl> : <>
        <div className="form-grid">
          <ResponsibilitySelect label="Salesperson" value={salesperson} team={team} onChange={setSalesperson} disabled={busy} />
        </div>
        <div className="toolbar">
          <button className="primary" disabled={busy || !salesperson || salesperson === workflow.salespersonId}
            onClick={async () => { if (await run("setResponsibilities", { accountId: workflow.accountId, salespersonId: salesperson, version: workflow.version })) setEditingTeam(false); }}>Save salesperson</button>
          <button className="secondary" disabled={busy} onClick={() => { setSalesperson(workflow.salespersonId ?? ""); setEditingTeam(false); }}>Cancel</button>
        </div>
      </>}
      {resource.data.frontContext && <p className="muted small front-handler">In Front: {team.find(t => t.frontId === resource.data.frontContext?.assigneeId)?.name ?? (resource.data.frontContext.assigneeId ? "Unmapped teammate" : "Unassigned")}<span>{resource.data.frontContext.routing === "MANUAL" ? "Manually assigned" : "Follows the account salesperson"}</span></p>}
    </section>;
  return <section className={`card lead-workflow${compact ? "" : " activity-workspace"}`} aria-label="Account communications">
    <div className="toolbar workflow-heading"><div><h2>{clientWork ? "Client workspace" : "Account communications"}</h2>{!compact && <p className="muted small">Communication history, team notes, and account controls.</p>}</div><div className="grow" /><button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>{resource.loading ? "Refreshing…" : "Refresh"}</button></div>
    {onOpen && <CommunicationAccountSummary accountId={workflow.accountId} open={open} />}
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    {error && <p className="error-text workflow-notice" role="alert">{error}</p>}
    {workflow.assignmentIssue && <p className="error-text workflow-notice">{workflow.assignmentIssue}</p>}
    {issues.length > 0 && <details open className="front-disclosure activity-attention"><summary>Needs attention <span className="front-count">{issues.length}</span></summary>{issues.map(i => <div key={i.id}><p className="error-text small">{i.message}</p></div>)}</details>}
    {compact ? <>
      {owner}
      <details className="front-disclosure"><summary>Recent activity <span className="front-count">{communications.length}{resource.data.communicationNextToken ? "+" : ""}</span></summary>{history}</details>
      <details className="front-disclosure"><summary>Add a note <span className="front-summary-hint">Internal to your team</span></summary>{noteEditor}</details>
      <details className="front-disclosure"><summary>Conversation tools <span className="front-summary-hint">Routing and linked activity</span></summary>{conversationTools}</details>
    </> : <div className="activity-workspace-grid">
      <div className="activity-content">
        <section className="activity-history" aria-label="Communication history">{history}</section>
        <section className="activity-note-editor" aria-label="Add an internal note">{noteEditor}</section>
      </div>
      <aside className="activity-controls" aria-label="Account controls">
        {owner}
        <section className="activity-tools" aria-label="Account tools">
          <div className="toolbar"><h3>Account tools</h3>{workflow.conversationId && <button className="secondary" onClick={() => open(`https://app.frontapp.com/open/${workflow.conversationId}`)}>Open in Front</button>}</div>
          {conversationTools}
        </section>
      </aside>
    </div>}
  </section>;
}
