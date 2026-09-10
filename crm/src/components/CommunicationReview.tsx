import { useState } from "react";
import { client, fmtProviderPhone } from "../lib/client";
import { communicationRequest as request, type Communication, type LeadTask } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";

export function ActivityReview({ id, onSaved, accountId, conversationId }: { id: string; onSaved: () => void; accountId?: string; conversationId?: string }) {
  const resource = useAsyncResource(() => request<{ communication: Communication }>("activity", { id }), [id], { initialData: null });
  const [name, setName] = useState(""), [matches, setMatches] = useState<{ id: string; name: string }[]>([]), [purpose, setPurpose] = useState("PROSPECT");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div className="workflow-editor"><h3>Link communication to an association</h3>
    {resource.data && <p>{fmtProviderPhone(resource.data.communication.from)} · {resource.data.communication.status}<br />{resource.data.communication.text?.slice(0, 500)}</p>}
    {(error || resource.error) && <p role="alert" className="error-text">{error || resource.error}</p>}
    {accountId && <button disabled={busy || !resource.data} onClick={async () => { setBusy(true); try { await request("linkActivity", { id, accountId, conversationId, version: resource.data!.communication.version, purpose }, true); onSaved(); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>Link this activity to the selected lead and Front conversation</button>}
    <form onSubmit={async e => { e.preventDefault(); setError(""); setBusy(true); try { const p = await client.models.Account.list({ filter: { name: { contains: name.trim() } }, limit: 50 }); if (p.errors?.length) throw new Error(p.errors[0].message); setMatches(p.data.map(a => ({ id: a.id, name: a.name }))); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>
      <label className="field">Association name<input required value={name} onChange={e => setName(e.target.value)} /></label><button disabled={busy}>Find lead or client</button>
    </form>
    <label className="field">Purpose<select value={purpose} onChange={e => setPurpose(e.target.value)}><option value="PROSPECT">Prospect or client</option><option value="CARRIER">Carrier</option></select></label>
    <p className="muted small">Only this activity is linked. A property manager's other associations remain separate.</p>
    {matches.map(m => <p key={m.id}><button className="link" disabled={busy || !resource.data} onClick={async () => { setBusy(true); try { await request("linkActivity", { id, accountId: m.id, version: resource.data!.communication.version, purpose }, true); onSaved(); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>{m.name}</button></p>)}
  </div>;
}
export function ReviewAction({ id, version, onSaved, event = false }: { id: string; version: number; onSaved: () => void; event?: boolean }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <details><summary>{event ? "Repair processing" : "Record review"}</summary><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await request("reviewIssue", { id, version, reason, replay: event }, true); onSaved(); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}><label className="field">{event ? "What was fixed?" : "Resolution or reason this is unrelated"}<input required value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy}>{event ? "Replay saved event" : "Mark reviewed"}</button>{error && <p className="error-text">{error}</p>}</form></details>;
}
export function DeliveryReview({ item, onSaved }: { item: { id: string; version: number; state?: string }; onSaved: () => void }) {
  const [action, setAction] = useState("resolve"), [uid, setUid] = useState(""), [reason, setReason] = useState(""), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <details><summary>Review delivery</summary><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await request("reviewOperation", { ...item, action, uid, reason, verifiedNotSent: checked }, true); onSaved(); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>
    <label className="field">Action<select value={action} onChange={e => setAction(e.target.value)}><option value="resolve">Link verified Front delivery</option><option value="retry">Retry delivery</option><option value="suppress">Cancel pending delivery</option></select></label>
    {action === "resolve" && <label className="field">Front message UID<input required value={uid} onChange={e => setUid(e.target.value)} /></label>}
    {action === "retry" && <label><input required type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> I checked the source and confirmed this message was not sent.</label>}
    <label className="field">Review notes<input required value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy}>Save review</button>{error && <p className="error-text">{error}</p>}
  </form></details>;
}
const tomorrow = () => { const d = new Date(Date.now() + 86400_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
export function CallOutcome({ communication: c, tasks, onSaved }: { communication: Communication; tasks: LeadTask[]; onSaved: () => void }) {
  const [outcome, setOutcome] = useState("HANDLED"), [note, setNote] = useState(""), [next, setNext] = useState(""), [due, setDue] = useState(tomorrow), [taskId, setTaskId] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const resolving = ["HANDLED", "FOLLOW_UP", "DOCUMENTS"].includes(outcome);
  return <details><summary>{c.outcome ? `Outcome: ${c.outcome.toLowerCase().replaceAll("_", " ")}` : "Record call outcome"}</summary>
    <form className="workflow-editor" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { const task = tasks.find(t => t.id === taskId); await request("recordCallOutcome", { id: c.id, version: c.version, outcome, note, nextAction: resolving ? { title: next, dueAt: new Date(due).toISOString() } : undefined, taskId: resolving ? task?.id : undefined, taskVersion: task?.version }, true); onSaved(); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>
      <label className="field">Outcome<select value={outcome} onChange={e => setOutcome(e.target.value)}>{[ ["HANDLED", "Request handled"], ["FOLLOW_UP", "Follow-up required"], ["DOCUMENTS", "Waiting on documents"], ["NO_ANSWER", "No answer / voicemail left"], ["WRONG_NUMBER", "Wrong number"], ["UNRELATED", "Unrelated / spam"] ].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="field">Notes<textarea required value={note} onChange={e => setNote(e.target.value)} /></label>
      {resolving && <><label className="field">Request this call resolved<select value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">No existing request</option>{tasks.filter(t => t.status === "OPEN").map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label className="field">Next action or waiting commitment<input required value={next} onChange={e => setNext(e.target.value)} /></label><label className="field">Due<input required type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label></>}
      <button disabled={busy}>Save call outcome</button>{error && <p className="error-text">{error}</p>}
    </form></details>;
}

export function SidebarActivityLinker({ accountId, conversationId, onSaved }: { accountId: string; conversationId: string; onSaved: () => void }) {
  const [id, setId] = useState(""), [error, setError] = useState("");
  const rows = useAsyncResource(() => request<{ items: { id: string; communicationId: string; phone?: string; at?: string; resolved?: boolean }[]; nextToken?: string }>("work", { kind: "TRIAGE" }), [accountId, conversationId], { initialData: { items: [] } });
  return <details><summary>Link a call or text to this conversation</summary><p className="muted small">Review the source before choosing its association.</p>
    {rows.data.items.filter(r => !r.resolved).map(r => <p key={r.id}><button className="link" onClick={() => setId(r.communicationId)}>{r.phone ? fmtProviderPhone(r.phone) : "Unknown contact"} · {r.at ? new Date(r.at).toLocaleString() : "Time unavailable"}</button></p>)}
    {rows.data.nextToken && <button className="link" onClick={async () => { try { const page = await request<typeof rows.data>("work", { kind: "TRIAGE", nextToken: rows.data.nextToken }); rows.setData(p => ({ ...page, items: [...p.items, ...page.items] })); } catch(e) { setError(String(e)); } }}>More activity</button>}
    {(error || rows.error) && <p className="error-text">{error || rows.error}</p>}
    {id && <ActivityReview key={id} id={id} accountId={accountId} conversationId={conversationId} onSaved={() => { setId(""); void rows.refetch(); onSaved(); }} />}
  </details>;
}
