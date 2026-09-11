import ServiceDelivery from "./ServiceDelivery";
import BusinessDraftButton from "./BusinessDraftButton";
import ConversationContext from "./ConversationContext";
import NextYearControl from "./NextYearControl";
import { leadActionGuidance } from "../../../shared/leadActionGuidance";
import CommunicationAccountSummary from "./CommunicationAccountSummary";
import { CallOutcome, SidebarActivityLinker } from "./CommunicationReview";
import { useEffect, useState, useRef } from "react";
import { communicationRequest as request, type WorkflowContext, type TeamEligibility } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDateTime, fmtProviderPhone } from "../lib/client";
import { compactDateTime, communicationChannelLabels } from "../lib/communicationLabels";

const EMPTY: WorkflowContext = { workflow: null, tasks: [], communications: [], team: [], issues: [] };
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
  const [leadStatus, setLeadStatus] = useState("LOST");
  const noteId = useRef(crypto.randomUUID());
  const [mergeIds, setMergeIds] = useState<string[]>([]), [mergeReason, setMergeReason] = useState("");
  const [channel, setChannel] = useState("ALL");
  const [note, setNote] = useState(""), [publish, setPublish] = useState(false);
  const resource = useAsyncResource(() => request<WorkflowContext>("context", { accountId, conversationId }), [accountId, conversationId, revision], { initialData: EMPTY, errorMessage: "Could not load lead follow-up" });
  const { workflow, tasks, communications, team, issues } = resource.data;
  useEffect(() => {
    if (!compact || busy || editingTeam || note.trim() || resource.loading) return;
    const refresh = () => { if (document.visibilityState === "visible") void resource.refetch(); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [compact, busy, editingTeam, note, resource.loading, resource.refetch]);
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
  const clientWork = workflow.disposition === "BOUND" && !workflow.openLeadQuoteIds?.length;
  const teamName = (id?: string) => team.find(t => t.userId === id)?.name ?? "Needs assignment";
  const nextActions = <section className={compact ? "front-next-actions" : undefined} aria-label="Next actions">
    <div className="toolbar"><h3>{compact ? "Next action" : "Next actions"}</h3></div>
    {!openTasks.length && <p className="muted">{workflow.disposition === "ACTIVE" ? "Email, call, or text the prospect. Follow-up is tracked automatically." : `Lead outcome: ${workflow.disposition.toLowerCase()}`}</p>}
    {openTasks.sort((a,b) => a.dueAt.localeCompare(b.dueAt)).map(t => {
      const guidance = leadActionGuidance(t, communications);
      return <article key={t.id} className={`workflow-task${t.dueAt < new Date().toISOString() ? " is-overdue" : ""}`}>
        <p className="workflow-why"><span>{t.escalatedAt ? "Why this was escalated" : t.notifiedAt ? "Why this is back" : "Why this needs attention"}</span>{guidance.why}</p>
        {guidance.preview && <blockquote className="workflow-request"><span>Original request</span>{guidance.preview}</blockquote>}
        <strong className="workflow-task-title">{guidance.action}</strong>
        <div className="small workflow-task-meta">{t.specialistId ? `Specialist: ${teamName(t.specialistId)}` : t.helperId ? `Helping: ${teamName(t.helperId)}` : t.role === "CHAMPION" ? "Deal champion" : "Salesperson"} · Due {compact ? compactDateTime(t.dueAt) : fmtDateTime(t.dueAt)}{t.dueAt < new Date().toISOString() ? " · Overdue" : ""}</div>
        <p className="workflow-next-help">{guidance.after}</p>
        {compact && t.kind === "QUOTE_PRESENTATION" && t.quoteId && conversationId && <BusinessDraftButton accountId={workflow.accountId} conversationId={conversationId} kind="QUOTE" recordId={t.quoteId} label="Prepare quote email" />}
        {compact && t.serviceType && t.serviceType !== "GENERAL" && conversationId && <ServiceDelivery task={t} conversationId={conversationId} onPrepare={() => open(`${window.location.origin}/accounts/${workflow.accountId}?tab=${t.serviceType === "CERTIFICATE" ? "certificates" : "documents"}&request=${encodeURIComponent(t.sourceIds?.[0] ?? "")}`)} />}
        {!compact && t.serviceType === "DOCUMENT" && <button className="secondary" onClick={() => open(`${window.location.origin}/accounts/${workflow.accountId}?tab=documents&request=${encodeURIComponent(t.sourceIds?.[0] ?? "")}`)}>Prepare requested document</button>}
        {!compact && t.serviceType === "CERTIFICATE" && <button className="secondary" onClick={() => open(`${window.location.origin}/accounts/${workflow.accountId}?tab=certificates&request=${encodeURIComponent(t.sourceIds?.[0] ?? "")}`)}>Prepare certificate</button>}
        {t.milestone && !t.serviceType && <button className="secondary" onClick={() => open(`${window.location.origin}/accounts/${workflow.accountId}${t.quoteId ? "?tab=quotes" : t.policyId ? "?tab=policies" : ""}`)}>Open {t.quoteId ? "quote" : t.policyId ? "policy" : "account"}</button>}
        {resource.data.actorId === workflow.salespersonId && workflow.championId !== workflow.salespersonId && !t.helperId && t.role === "SALESPERSON" && <button className="link" disabled={busy} onClick={() => void run("requestChampionHelp", { taskId: t.id, version: t.version })}>Ask champion to help</button>}
        {resource.data.actorId === workflow.championId && t.kind === "CARRIER" && (t.context ?? "LEAD") === "LEAD" && <button className="link" disabled={busy} onClick={() => void run("requestProspectInformation", { taskId: t.id, version: t.version })}>Ask sales to obtain this information</button>}
        {resource.data.actorId === workflow.championId && t.context === "SERVICE" && <details><summary>Coordinate with a specialist</summary><label className="field">Responsible specialist<select value={t.specialistId ?? ""} disabled={busy} onChange={e => { if (e.target.value) void run("delegateService", { taskId: t.id, version: t.version, specialistId: e.target.value }); }}><option value="">Choose teammate</option>{team.filter(m => m.enabled).map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></label><p className="muted small">The champion remains the client's main contact. The deadline stays the same.</p></details>}
        {["RESPONSE", "CALLBACK"].includes(t.kind) && openTasks.filter(task => ["RESPONSE", "CALLBACK"].includes(task.kind)).length > 1 && <details className="workflow-related"><summary>Related requests</summary><label className="small"><input type="checkbox" aria-label={`Combine ${t.title}`} checked={mergeIds.includes(t.id)} onChange={e => setMergeIds(ids => e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} /> Same request as another activity</label></details>}
      </article>;
    })}
    {mergeIds.length >= 2 && <div className="workflow-editor"><label className="field">Why these contacts concern the same request<input value={mergeReason} onChange={e => setMergeReason(e.target.value)} /></label><button disabled={busy || !mergeReason.trim()} onClick={async () => { if (await run("mergeTasks", { accountId: workflow.accountId, tasks: openTasks.filter(t => mergeIds.includes(t.id)).map(t => ({ id: t.id, version: t.version })), reason: mergeReason })) { setMergeIds([]); setMergeReason(""); } }}>Combine and keep the earliest deadline</button></div>}
    {compact && <p className="front-deadline-note">Reminders arrive at 9 a.m. Eastern. Snoozing never changes the due date.</p>}
  </section>;
  const history = <>
    <div className="toolbar">{!compact && <h3>Communication history</h3>}<select aria-label="Communication channel" value={channel} onChange={e => setChannel(e.target.value)}>{["ALL", "EMAIL", "CALL", "SMS", "NOTE"].map(c => <option key={c} value={c}>{communicationChannelLabels[c]}</option>)}</select></div>
    {!communications.length && <p className="muted">No linked communication yet.</p>}
    {communications.filter(c => channel === "ALL" || c.channel === channel).map(c => <details key={c.id} className="workflow-task"><summary><span className="workflow-activity-title">{c.subject || c.summary?.slice(0, 70) || (c.channel === "SMS" ? c.text?.slice(0, 70) : undefined) || (c.channel === "CALL" ? "Phone call" : c.channel === "NOTE" ? "Internal note" : "Message")}</span><span className="workflow-activity-meta">{c.channel === "CALL" ? "Call" : c.channel === "SMS" ? "Text" : c.channel === "NOTE" ? "Note" : "Email"} · {compact ? compactDateTime(c.at) : fmtDateTime(c.at)}</span></summary>
      <p className="small">{c.direction.toLowerCase()} · {c.status.toLowerCase()}{c.from ? ` · ${c.channel === "SMS" || c.channel === "CALL" ? fmtProviderPhone(c.from) : c.from}` : ""}</p>
      {c.to?.length && <p className="small">To: {c.to.map(to => c.channel === "SMS" || c.channel === "CALL" ? fmtProviderPhone(to) : to).join(", ")}</p>}{c.actorId && (c.direction === "OUTBOUND" || team.some(t => t.frontId === c.actorId || t.dialpadId === c.actorId || t.userId === c.actorId)) && <p className="small">Handled by: {c.actorId === "crm:initial-ai" ? "Brian Cole (initial AI email)" : team.find(t => t.frontId === c.actorId || t.dialpadId === c.actorId || t.userId === c.actorId)?.name ?? "Unmapped teammate"}</p>}
      {c.channel === "CALL" && <><p className="muted small">{c.enrichment}</p><CallOutcome communication={c} /></>}
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
    {(conversationId ?? workflow.conversationId) && <ConversationContext accountId={workflow.accountId} conversationId={(conversationId ?? workflow.conversationId)!} bound={workflow.disposition === "BOUND"} saved={resource.data.frontContext} onSaved={() => void resource.refetch()} />}
    <NextYearControl workflow={workflow} onSaved={() => void resource.refetch()} />
    {workflow.disposition !== "BOUND" && <details className="front-disclosure"><summary>Lead status</summary>
      {workflow.disposition === "ACTIVE" ? <><label className="field">Status<select value={leadStatus} onChange={e => setLeadStatus(e.target.value)}><option value="LOST">Lost</option><option value="DISQUALIFIED">Not a fit</option></select></label><button className="secondary" disabled={busy} onClick={() => void run("setLeadDisposition", { accountId: workflow.accountId, version: workflow.version, disposition: leadStatus })}>Update lead status</button></>
        : <button className="secondary" disabled={busy} onClick={() => void run("setLeadDisposition", { accountId: workflow.accountId, version: workflow.version, disposition: "ACTIVE" })}>Reopen lead</button>}
    </details>}

    {!workflow.humanTakeover && <div className="front-tool-action"><button className="secondary" disabled={busy} onClick={() => void run("cancelAi", { accountId: workflow.accountId, version: workflow.version })}>{compact ? "Handle personally" : "Handle personally / cancel pending AI reply"}</button>{compact && <p className="muted small">Cancels an AI reply that has not been sent.</p>}</div>}
    {workflow.conversationId && <>
      <div className="front-tool-action"><button className="secondary" disabled={busy} onClick={() => void run("archive", { accountId: workflow.accountId, conversationId: conversationId ?? workflow.conversationId, version: workflow.version })}>{compact ? "Tidy this conversation" : "Clean up inbox when ready"}</button>{compact && <p className="muted small">Archives only when the lead's work is safely tracked.</p>}</div>
      {compact && <h3>Assign Front conversation to</h3>}
      <div className="toolbar">{["SALESPERSON", "CHAMPION"].map(role => <button className={compact ? "secondary" : "link"} key={role} disabled={busy} onClick={() => void run("routeConversation", { conversationId: conversationId ?? workflow.conversationId, role })}>{compact ? role === "CHAMPION" ? "Deal champion" : "Salesperson" : `Use ${role === "CHAMPION" ? "deal champion" : "salesperson"} as Front handler`}</button>)}</div>
    </>}
    {compact && conversationId && <SidebarActivityLinker accountId={workflow.accountId} conversationId={conversationId} onSaved={() => void resource.refetch()} />}
  </>;
  return <section className="card lead-workflow" aria-label="Lead responsibilities and follow-up">
    <div className="toolbar workflow-heading"><h2>{clientWork ? "Client workspace" : compact ? "Lead workspace" : "Lead follow-up"}</h2><div className="grow" /><button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>{resource.loading ? "Refreshing…" : "Refresh"}</button></div>
    {onOpen && <CommunicationAccountSummary accountId={workflow.accountId} open={open} />}
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    {error && <p className="error-text workflow-notice" role="alert">{error}</p>}
    {workflow.assignmentIssue && <p className="error-text workflow-notice">{workflow.assignmentIssue}</p>}
    {issues.length > 0 && <details open className="front-disclosure"><summary>Needs attention <span className="front-count">{issues.length}</span></summary>{issues.map(i => <div key={i.id}><p className="error-text small">{i.message}</p></div>)}</details>}
    {workflow.deferredUntil && <p className="workflow-notice">Next renewal opportunity · Returns {fmtDateTime(workflow.deferredUntil)}. New requests remain tracked.</p>}
    {compact && nextActions}
    <section className={compact ? "front-team" : undefined} aria-label="Lead team">
      {compact && <div className="toolbar"><h3>{clientWork ? "Client team" : "Lead team"}</h3><div className="grow" />{!editingTeam && <button className="link" onClick={() => setEditingTeam(true)}>Edit team</button>}</div>}
      {compact && !editingTeam ? <dl className="front-team-list">{!clientWork && <div><dt>Salesperson</dt><dd>{teamName(workflow.salespersonId)}</dd></div>}<div><dt>{clientWork ? "Main contact" : "Deal champion"}</dt><dd>{teamName(workflow.championId)}</dd></div></dl> : <>
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
