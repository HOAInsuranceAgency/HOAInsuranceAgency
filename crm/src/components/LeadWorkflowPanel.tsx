import { followUpDeadline } from "../../../shared/leadWorkflow";
import { leadActionGuidance } from "../../../shared/leadActionGuidance";
import CommunicationAccountSummary from "./CommunicationAccountSummary";
import { CallOutcome, SidebarActivityLinker } from "./CommunicationReview";
import { useEffect, useState, useRef } from "react";
import { communicationRequest as request, type WorkflowContext, type LeadTask, type TeamEligibility } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDateTime, fmtProviderPhone } from "../lib/client";
import { compactDateTime, communicationChannelLabels } from "../lib/communicationLabels";

const EMPTY: WorkflowContext = { workflow: null, tasks: [], communications: [], team: [], issues: [] };
const localDate = (value: string) => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
export function ResponsibilitySelect({ label, value, team, kind, onChange, disabled = false }: {
  label: string; value: string; team: TeamEligibility[]; kind: "salesperson" | "champion"; onChange: (value: string) => void; disabled?: boolean;
}) {
  const eligible = team.filter(t => t.enabled && t[kind]);
  return <label className="field">{label}<select aria-label={label} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
    <option value="">Choose teammate</option>
    {value && !eligible.some(t => t.userId === value) && <option value={value}>{team.find(t => t.userId === value)?.name ?? "Assigned teammate"} (needs review)</option>}
    {eligible.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}
  </select></label>;
}
export default function LeadWorkflowPanel({ accountId, conversationId, onOpen }: { accountId?: string; conversationId?: string; onOpen?: (url: string) => void }) {
  const compact = !!onOpen;
  const [editingTeam, setEditingTeam] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [salesperson, setSalesperson] = useState(""), [champion, setChampion] = useState("");
  const [editing, setEditing] = useState<LeadTask | "new" | null>(null), [completing, setCompleting] = useState<LeadTask | null>(null);
  const noteId = useRef(crypto.randomUUID());
  const [mergeIds, setMergeIds] = useState<string[]>([]), [mergeReason, setMergeReason] = useState("");
  const [channel, setChannel] = useState("ALL");
  const [note, setNote] = useState(""), [publish, setPublish] = useState(false);
  const resource = useAsyncResource(() => request<WorkflowContext>("context", { accountId, conversationId }), [accountId, conversationId, revision], { initialData: EMPTY, errorMessage: "Could not load lead follow-up" });
  const { workflow, tasks, communications, team, issues } = resource.data;
  useEffect(() => { setSalesperson(workflow?.salespersonId ?? ""); setChampion(workflow?.championId ?? ""); }, [workflow?.salespersonId, workflow?.championId]);
  // The parent keys the panel by conversation/account, so unsaved edits never
  // become writes against the newly selected lead in Front.
  const run = async (op: string, input: unknown) => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await request<{ notice?: string }>(op, input, true); if (result.notice) setNotice(result.notice); setRevision(n => n + 1); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save"); return false; }
    finally { setBusy(false); }
  };
  function open(url: string) { if (onOpen) onOpen(url); else window.open(url, "_blank", "noopener,noreferrer"); }
  if (resource.loading && !workflow) return <div className="card" aria-busy="true">Loading lead follow-up…</div>;
  if (resource.error) return <div className="card"><p className="error-text">{resource.error}</p><button onClick={() => void resource.refetch()}>Retry</button></div>;
  if (!workflow) return <div className="card"><h2>Lead follow-up</h2><p>{accountId ? "Set up responsibilities and follow-up for this account." : "Link this conversation to its CRM lead to see responsibilities and next actions."}</p>
    {accountId && <button disabled={busy} onClick={() => void run("initializeLead", { accountId })}>Set up lead follow-up</button>}{error && <p role="alert">{error}</p>}</div>;
  const openTasks = tasks.filter(t => t.status === "OPEN");
  const teamName = (id?: string) => team.find(t => t.userId === id)?.name ?? "Needs assignment";
  const nextActions = <section className={compact ? "front-next-actions" : undefined} aria-label="Next actions">
    <div className="toolbar"><h3>{compact ? "Next action" : "Next actions"}</h3><div className="grow" />{workflow.disposition === "ACTIVE" && <button className="secondary" onClick={() => setEditing("new")}>Add action</button>}</div>
    {["LOST", "DISQUALIFIED"].includes(workflow.disposition) && <button className="secondary" onClick={() => setEditing("new")}>Reopen lead with a next action</button>}
    {!openTasks.length && <p className="muted">{workflow.disposition === "ACTIVE" ? "No next action recorded. Add a commitment so this lead stays visible." : `Lead outcome: ${workflow.disposition.toLowerCase()}`}</p>}
    {openTasks.sort((a,b) => a.dueAt.localeCompare(b.dueAt)).map(t => {
      const guidance = leadActionGuidance(t, communications);
      return <article key={t.id} className={`workflow-task${t.dueAt < new Date().toISOString() ? " is-overdue" : ""}`}>
        <p className="workflow-why"><span>{t.escalatedAt ? "Why this was escalated" : t.notifiedAt ? "Why this is back" : "Why this needs attention"}</span>{guidance.why}</p>
        {guidance.preview && <blockquote className="workflow-request"><span>Original request</span>{guidance.preview}</blockquote>}
        <strong className="workflow-task-title">{guidance.action}</strong>
        <div className="small workflow-task-meta">{t.role === "CHAMPION" || t.escalatedAt ? "Deal champion" : "Salesperson"} · Due {compact ? compactDateTime(t.dueAt) : fmtDateTime(t.dueAt)}{t.dueAt < new Date().toISOString() ? " · Overdue" : ""}</div>
        <p className="workflow-next-help">{guidance.after}</p>
        <div className="toolbar"><button className="primary" onClick={() => setCompleting(t)}>Record outcome</button><button className="link" onClick={() => setEditing(t)}>Edit action</button></div>
        {["RESPONSE", "CALLBACK"].includes(t.kind) && openTasks.filter(task => ["RESPONSE", "CALLBACK"].includes(task.kind)).length > 1 && <details className="workflow-related"><summary>Related requests</summary><label className="small"><input type="checkbox" aria-label={`Combine ${t.title}`} checked={mergeIds.includes(t.id)} onChange={e => setMergeIds(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} /> Same request as another activity</label></details>}
      </article>;
    })}
    {mergeIds.length >= 2 && <div className="workflow-editor"><label className="field">Why these contacts concern the same request<input value={mergeReason} onChange={e => setMergeReason(e.target.value)} /></label><button disabled={busy || !mergeReason.trim()} onClick={async () => { if (await run("mergeTasks", { accountId: workflow.accountId, tasks: openTasks.filter(t => mergeIds.includes(t.id)).map(t => ({ id: t.id, version: t.version })), reason: mergeReason })) { setMergeIds([]); setMergeReason(""); } }}>Combine and keep the earliest deadline</button></div>}
    {editing && <TaskEditor key={editing === "new" ? "new" : editing.id} task={editing === "new" ? undefined : editing} busy={busy} onCancel={() => setEditing(null)}
      onSave={async value => { if (await run(workflow.disposition === "ACTIVE" ? "saveTask" : "reopenLead", { ...value as Record<string, unknown>, accountId: workflow.accountId, ...(workflow.disposition === "ACTIVE" ? {} : { version: workflow.version }) })) setEditing(null); }} />}
    {completing && <CompletionEditor task={completing} busy={busy} onCancel={() => setCompleting(null)} onSave={async value => { if (await run("completeTask", value)) setCompleting(null); }} />}
    {compact && <p className="front-deadline-note">Reminders arrive at 9 a.m. Eastern. Snoozing never changes the due date.</p>}
  </section>;
  const history = <>
    <div className="toolbar">{!compact && <h3>Communication history</h3>}<select aria-label="Communication channel" value={channel} onChange={e => setChannel(e.target.value)}>{["ALL", "EMAIL", "CALL", "SMS", "NOTE"].map(c => <option key={c} value={c}>{communicationChannelLabels[c]}</option>)}</select></div>
    {!communications.length && <p className="muted">No linked communication yet.</p>}
    {communications.filter(c => channel === "ALL" || c.channel === channel).map(c => <details key={c.id} className="workflow-task"><summary><span className="workflow-activity-title">{c.subject || c.summary?.slice(0, 70) || (c.channel === "SMS" ? c.text?.slice(0, 70) : undefined) || (c.channel === "CALL" ? "Phone call" : c.channel === "NOTE" ? "Internal note" : "Message")}</span><span className="workflow-activity-meta">{c.channel === "CALL" ? "Call" : c.channel === "SMS" ? "Text" : c.channel === "NOTE" ? "Note" : "Email"} · {compact ? compactDateTime(c.at) : fmtDateTime(c.at)}</span></summary>
      <p className="small">{c.direction.toLowerCase()} · {c.status.toLowerCase()}{c.from ? ` · ${c.channel === "SMS" || c.channel === "CALL" ? fmtProviderPhone(c.from) : c.from}` : ""}</p>
      {c.to?.length && <p className="small">To: {c.to.map(to => c.channel === "SMS" || c.channel === "CALL" ? fmtProviderPhone(to) : to).join(", ")}</p>}{c.actorId && (c.direction === "OUTBOUND" || team.some(t => t.frontId === c.actorId || t.dialpadId === c.actorId || t.userId === c.actorId)) && <p className="small">Handled by: {c.actorId === "crm:initial-ai" ? "Brian Cole (initial AI email)" : team.find(t => t.frontId === c.actorId || t.dialpadId === c.actorId || t.userId === c.actorId)?.name ?? "Unmapped teammate"}</p>}
      {c.channel === "CALL" && <><p className="muted small">{c.enrichment}</p><CallOutcome communication={c} tasks={tasks} onSaved={() => void resource.refetch()} /></>}
      {c.summary && <p>{c.summary}</p>}<p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text || "Content is unavailable. Open the source for details."}</p>
      {c.channel === "EMAIL" && c.direction === "OUTBOUND" && <p className="muted small">{c.seenAt ? `Seen signal: ${fmtDateTime(c.seenAt)}` : c.seenCheckedAt ? "No Seen signal returned" : "Seen status not checked yet"}{c.seenCheckedAt && ` · Checked ${fmtDateTime(c.seenCheckedAt)}`}. An email-open signal does not prove it was read.</p>}
      {c.provider === "front" && c.channel === "EMAIL" && c.direction === "OUTBOUND" && <button className="link" disabled={busy} onClick={() => void run("refreshSeen", { id: c.id })}>Refresh Seen status{c.seenRequestedAt ? " (queued)" : ""}</button>}
      {c.attachments?.map(a => <p key={a.id}>{a.filename} · {Math.ceil(a.size / 1024)} KB <button className="link" disabled={busy} onClick={() => void run("saveAttachment", { communicationId: c.id, attachmentId: a.id })}>Save to CRM documents</button></p>)}
      {c.seenError && <p className="error-text small">Seen status unavailable: {c.seenError}</p>}
      {c.provider === "front" && <button className="link" onClick={() => open(`https://app.frontapp.com/open/${c.providerId}`)}>Open message</button>}
    </details>)}
    {resource.data.communicationNextToken && <button onClick={async () => { try { const more = await request<WorkflowContext>("context", { accountId: workflow.accountId, nextToken: resource.data.communicationNextToken }); resource.setData(current => ({ ...current, communications: [...current.communications, ...more.communications], communicationNextToken: more.communicationNextToken })); } catch(e) { setError(String(e)); } }}>Load older activity</button>}
  </>;
  const noteEditor = <>
    {!compact && <h3>Add an internal note</h3>}<textarea aria-label="Internal note" value={note} onChange={e => setNote(e.target.value)} rows={3} />
    <label className="workflow-note-publish"><input type="checkbox" checked={publish} onChange={e => setPublish(e.target.checked)} /> Also post as a Front comment</label>
    <div className="toolbar"><button disabled={busy || !note.trim()} onClick={async () => { if (await run("addNote", { accountId: workflow.accountId, text: note, publishToFront: publish, requestId: noteId.current })) { setNote(""); noteId.current = crypto.randomUUID(); } }}>Save note</button></div>  </>;
  const conversationTools = <>
    {!workflow.humanTakeover && <div className="front-tool-action"><button className="secondary" disabled={busy} onClick={() => void run("cancelAi", { accountId: workflow.accountId, version: workflow.version })}>{compact ? "Handle personally" : "Handle personally / cancel pending AI reply"}</button>{compact && <p className="muted small">Cancels an AI reply that has not been sent.</p>}</div>}
    {workflow.conversationId && <>
      <div className="front-tool-action"><button className="secondary" disabled={busy} onClick={() => void run("archive", { accountId: workflow.accountId, conversationId: conversationId ?? workflow.conversationId, version: workflow.version })}>{compact ? "Tidy this conversation" : "Clean up inbox when ready"}</button>{compact && <p className="muted small">Archives only when the lead's work is safely tracked.</p>}</div>
      {compact && <h3>Assign Front conversation to</h3>}
      <div className="toolbar">{["SALESPERSON", "CHAMPION"].map(role => <button className={compact ? "secondary" : "link"} key={role} disabled={busy} onClick={() => void run("routeConversation", { conversationId: conversationId ?? workflow.conversationId, role })}>{compact ? role === "CHAMPION" ? "Deal champion" : "Salesperson" : `Use ${role === "CHAMPION" ? "deal champion" : "salesperson"} as Front handler`}</button>)}</div>
    </>}
    {compact && conversationId && <SidebarActivityLinker accountId={workflow.accountId} conversationId={conversationId} onSaved={() => void resource.refetch()} />}
  </>;
  return <section className="card lead-workflow" aria-label="Lead responsibilities and follow-up">
    <div className="toolbar workflow-heading"><h2>{compact ? "Lead workspace" : "Lead follow-up"}</h2><div className="grow" /><button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>{resource.loading ? "Refreshing…" : "Refresh"}</button></div>
    {onOpen && <CommunicationAccountSummary accountId={workflow.accountId} open={open} />}
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    {error && <p className="error-text workflow-notice" role="alert">{error}</p>}
    {workflow.assignmentIssue && <p className="error-text workflow-notice">{workflow.assignmentIssue}</p>}
    {issues.length > 0 && <details open className="front-disclosure"><summary>Needs attention <span className="front-count">{issues.length}</span></summary>{issues.map(i => <div key={i.id}><p className="error-text small">{i.message}</p></div>)}</details>}
    {compact && nextActions}
    <section className={compact ? "front-team" : undefined} aria-label="Lead team">
      {compact && <div className="toolbar"><h3>Lead team</h3><div className="grow" />{!editingTeam && <button className="link" onClick={() => setEditingTeam(true)}>Edit team</button>}</div>}
      {compact && !editingTeam ? <dl className="front-team-list"><div><dt>Salesperson</dt><dd>{teamName(workflow.salespersonId)}</dd></div><div><dt>Deal champion</dt><dd>{teamName(workflow.championId)}</dd></div></dl> : <>
        <div className="form-grid">
          <ResponsibilitySelect label="Salesperson" value={salesperson} team={team} kind="salesperson" onChange={setSalesperson} disabled={busy} />
          <ResponsibilitySelect label="Deal champion" value={champion} team={team} kind="champion" onChange={setChampion} disabled={busy} />
        </div>
        <div className="toolbar">
          <button className="primary" disabled={busy || !salesperson || !champion || salesperson === workflow.salespersonId && champion === workflow.championId}
            onClick={async () => { if (await run("setResponsibilities", { accountId: workflow.accountId, salespersonId: salesperson, championId: champion, version: workflow.version })) setEditingTeam(false); }}>Save responsibilities</button>
          {compact && <button className="secondary" disabled={busy} onClick={() => { setSalesperson(workflow.salespersonId ?? ""); setChampion(workflow.championId ?? ""); setEditingTeam(false); }}>Cancel</button>}
        </div>
      </>}
      {resource.data.frontContext && <p className="muted small front-handler">In Front: {team.find(t => t.frontId === resource.data.frontContext?.assigneeId)?.name ?? (resource.data.frontContext.assigneeId ? "Unmapped teammate" : "Unassigned")}<span>{resource.data.frontContext.routing === "MANUAL" ? "Manually assigned" : "Follows the lead role"}</span></p>}
    </section>
    {!compact && <><div className="toolbar">{workflow.conversationId && <button className="secondary" onClick={() => open(`https://app.frontapp.com/open/${workflow.conversationId}`)}>Open in Front</button>}</div>{conversationTools}<p className="muted small">Archiving or snoozing in Front does not change these deadlines.</p>{nextActions}</>}
    {compact ? <>
      <details className="front-disclosure"><summary>Recent activity <span className="front-count">{communications.length}{resource.data.communicationNextToken ? "+" : ""}</span></summary>{history}</details>
      <details className="front-disclosure"><summary>Add a note <span className="front-summary-hint">Internal to your team</span></summary>{noteEditor}</details>
      <details className="front-disclosure"><summary>Conversation tools <span className="front-summary-hint">Routing, cleanup & linked activity</span></summary>{conversationTools}</details>
    </> : <>{history}{noteEditor}</>}
  </section>;
}
function TaskEditor({ task, busy, onSave, onCancel }: { task?: LeadTask; busy: boolean; onSave: (value: unknown) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(task?.title ?? ""), [due, setDue] = useState(localDate(task?.dueAt ?? followUpDeadline(new Date().toISOString(), 1)));
  const [role, setRole] = useState(task?.role ?? "SALESPERSON"), [kind, setKind] = useState(task?.kind ?? "FOLLOW_UP"), [reason, setReason] = useState("");
  return <form className="workflow-editor" onSubmit={e => { e.preventDefault(); void onSave({ id: task?.id, version: task?.version, title, dueAt: new Date(due).toISOString(), role, kind, reason }); }}>
    <h3>{task ? "Change next action" : "New next action"}</h3><label className="field">Action<input required value={title} onChange={e => setTitle(e.target.value)} /></label>
    <div className="form-grid"><label className="field">Due date and time<input required type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
    <label className="field">Responsible role<select value={role} onChange={e => setRole(e.target.value as LeadTask["role"])}><option value="SALESPERSON">Salesperson</option><option value="CHAMPION">Deal champion</option></select></label>
    <label className="field">Type<select value={kind} onChange={e => setKind(e.target.value as LeadTask["kind"])}>{["FOLLOW_UP", "RESPONSE", "CALLBACK", "CARRIER", "DOCUMENTS", "CORRECTION"].map(v => <option key={v} value={v}>{v.replaceAll("_", " ").toLowerCase()}</option>)}</select></label></div>
    <label className="field">Reason<input required value={reason} onChange={e => setReason(e.target.value)} placeholder="For example: prospect requested Friday" /></label>
    <div className="toolbar"><button disabled={busy}>Save action</button><button type="button" className="secondary" onClick={onCancel}>Cancel</button></div>
  </form>;
}
function CompletionEditor({ task, busy, onSave, onCancel }: { task: LeadTask; busy: boolean; onSave: (value: unknown) => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState(""), [next, setNext] = useState(""), [due, setDue] = useState(localDate(followUpDeadline(new Date().toISOString(), 1)));
  const [outcome, setOutcome] = useState(task.role === "CHAMPION" ? "DONE" : "NEXT");
  return <form className="workflow-editor" onSubmit={e => { e.preventDefault(); void onSave({ id: task.id, version: task.version, reason,
    successor: outcome === "NEXT" ? { title: next, dueAt: new Date(due).toISOString(), role: task.role, kind: "FOLLOW_UP" } : undefined,
    outcome: ["LOST", "DISQUALIFIED"].includes(outcome) ? outcome : undefined }); }}>
    <h3>Record outcome</h3><p className="muted small">Record what happened and the next step. Sending a message alone does not close this action.</p><label className="field">What happened?<textarea placeholder="For example: answered their question and requested the current policy." required value={reason} onChange={e => setReason(e.target.value)} /></label>
    <label className="field">Next step<select value={outcome} onChange={e => setOutcome(e.target.value)}><option value="NEXT">Set the next follow-up</option>{task.role === "CHAMPION" && <option value="DONE">This carrier/champion task is complete</option>}<option value="LOST">Lead lost</option><option value="DISQUALIFIED">Lead disqualified</option></select></label>
    {outcome === "NEXT" && <><label className="field">Next action<input required value={next} onChange={e => setNext(e.target.value)} /></label><label className="field">Due<input required type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label></>}
    <div className="toolbar"><button disabled={busy}>Save outcome</button><button type="button" className="secondary" onClick={onCancel}>Cancel</button></div>
  </form>;
}
