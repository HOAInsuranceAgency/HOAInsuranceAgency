import { useEffect, useRef, useState } from "react";
import { client, fmtProviderPhone } from "../lib/client";
import { communicationRequest as request, type Communication } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { listAllPages } from "../lib/pagination";

function useReviewMutation() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(action: () => Promise<unknown>, onSaved: () => void) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); if (mounted.current) onSaved(); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return { busy, error, run };
}

type ActivityProps = { id: string; onSaved: () => void; accountId?: string; conversationId?: string };
export function ActivityReview(props: ActivityProps) {
  return <ActivityEditor key={`${props.id}:${props.accountId ?? ""}:${props.conversationId ?? ""}`} {...props} />;
}
function ActivityEditor({ id, onSaved, accountId, conversationId }: ActivityProps) {
  const resource = useAsyncResource(() => request<{ communication: Communication }>("activity", { id }), [id], { initialData: null });
  const [name, setName] = useState(""), [matches, setMatches] = useState<{ id: string; name: string }[]>([]), [purpose, setPurpose] = useState("PROSPECT");
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState(""), [searched, setSearched] = useState(false);
  const searchVersion = useRef(0);
  const mutation = useReviewMutation();
  useEffect(() => () => { searchVersion.current++; }, []);
  const link = (target: string, selectedConversation?: string) => mutation.run(() => request("linkActivity", { id, accountId: target, conversationId: selectedConversation, version: resource.data!.communication.version, purpose }, true), onSaved);
  return <div className="workflow-editor"><h3>Link communication to an association</h3>
    {resource.data && <p>{fmtProviderPhone(resource.data.communication.from)} · {resource.data.communication.status}<br />{resource.data.communication.text?.slice(0, 500)}</p>}
    {(mutation.error || searchError || resource.error) && <p role="alert" className="error-text">{mutation.error || searchError || resource.error}</p>}
    {accountId && <button disabled={mutation.busy || !resource.data} onClick={() => void link(accountId, conversationId)}>Link this activity to the selected lead and Front conversation</button>}
    <form onSubmit={async e => {
      e.preventDefault(); if (mutation.busy || searching || !name.trim()) return;
      const version = ++searchVersion.current, term = name.trim().toLocaleLowerCase();
      setSearchError(""); setSearching(true); setSearched(false); setMatches([]);
      try {
        const accounts = await listAllPages(async nextToken => {
          const page = await client.models.Account.list({ nextToken, limit: 200, selectionSet: ["id", "name"] });
          if (page.errors?.length) throw new Error(page.errors[0].message);
          return page;
        });
        if (version === searchVersion.current) { setMatches(accounts.filter(account => account.name.toLocaleLowerCase().includes(term)).map(account => ({ id: account.id, name: account.name }))); setSearched(true); }
      } catch(e) { if (version === searchVersion.current) setSearchError(String(e)); }
      finally { if (version === searchVersion.current) setSearching(false); }
    }}>
      <label className="field">Association name<input required disabled={mutation.busy} value={name} onChange={e => { searchVersion.current++; setName(e.target.value); setMatches([]); setSearching(false); setSearched(false); setSearchError(""); }} /></label><button disabled={mutation.busy || searching || !name.trim()}>{searching ? "Searching…" : "Find lead or client"}</button>
    </form>
    {searched && !matches.length && <p role="status">No matching leads or clients.</p>}
    <label className="field">Purpose<select disabled={mutation.busy} value={purpose} onChange={e => setPurpose(e.target.value)}><option value="PROSPECT">Prospect or client</option><option value="CARRIER">Carrier</option></select></label>
    <p className="muted small">Only this activity is linked. A property manager's other associations remain separate.</p>
    {matches.map(m => <p key={m.id}><button className="link" disabled={mutation.busy || !resource.data} onClick={() => void link(m.id)}>{m.name}</button></p>)}
  </div>;
}
export function ReviewAction({ id, version, onSaved, event = false }: { id: string; version: number; onSaved: () => void; event?: boolean }) {
  const [reason, setReason] = useState("");
  const [reviewedVersion, setReviewedVersion] = useState(version);
  const { busy, error, run } = useReviewMutation();
  useEffect(() => { if (!reason && !busy) setReviewedVersion(version); }, [version, reason, busy]);
  return <details><summary>{event ? "Repair processing" : "Record review"}</summary><form onSubmit={e => { e.preventDefault(); void run(() => request("reviewIssue", { id, version: reviewedVersion, reason, replay: event }, true), onSaved); }}><label className="field">{event ? "What was fixed?" : "Resolution or reason this is unrelated"}<input required disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></label>
    {version !== reviewedVersion && <p role="status">This item changed during your review. <button type="button" disabled={busy} onClick={() => setReviewedVersion(version)}>Review updated item</button></p>}
    <button disabled={busy || version !== reviewedVersion}>{event ? "Replay saved event" : "Mark reviewed"}</button>{error && <p className="error-text">{error}</p>}</form></details>;
}
export function DeliveryReview({ item, onSaved }: { item: { id: string; version: number; state?: string }; onSaved: () => void }) {
  const [action, setAction] = useState("resolve"), [uid, setUid] = useState(""), [reason, setReason] = useState(""), [checked, setChecked] = useState(false);
  const [reviewed, setReviewed] = useState({ version: item.version, state: item.state });
  const { busy, error, run } = useReviewMutation();
  const changed = item.version !== reviewed.version || item.state !== reviewed.state;
  useEffect(() => { if (!uid && !reason && !checked && action === "resolve" && !busy) setReviewed({ version: item.version, state: item.state }); }, [item.version, item.state, uid, reason, checked, action, busy]);
  return <details><summary>Review delivery</summary><form onSubmit={e => { e.preventDefault(); if (changed || action === "retry" && !checked) return; void run(() => request("reviewOperation", { ...item, version: reviewed.version, action, uid, reason, verifiedNotSent: checked }, true), onSaved); }}>
    <label className="field">Action<select disabled={busy} value={action} onChange={e => setAction(e.target.value)}><option value="resolve">Link verified Front delivery</option><option value="retry">Retry delivery</option><option value="suppress">Cancel pending delivery</option></select></label>
    {action === "resolve" && <label className="field">Front message UID<input required disabled={busy} value={uid} onChange={e => setUid(e.target.value)} /></label>}
    {action === "retry" && <label><input required disabled={busy} type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> I checked the source and confirmed this message was not sent.</label>}
    <label className="field">Review notes<input required disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></label>
    {changed && <p role="status">This delivery changed during your review. <button type="button" disabled={busy} onClick={() => { setChecked(false); setReviewed({ version: item.version, state: item.state }); }}>Review updated delivery</button></p>}
    <button disabled={busy || changed || action === "retry" && !checked}>Save review</button>{error && <p className="error-text">{error}</p>}
  </form></details>;
}
/** Dialpad activity is the record; no second outcome form or note is required. */
export function CallOutcome({ communication: c }: { communication: Communication }) {
  return <p className="muted small">{c.status === "CONNECTED" ? c.endedAt ? "Completed call · logged automatically" : "Call in progress"
    : c.status === "MISSED" ? c.direction === "OUTBOUND" ? "No answer · logged automatically" : "Missed call · logged automatically"
    : "Call activity is recorded automatically"}</p>;
}

type LinkerProps = { accountId: string; conversationId: string; onSaved: () => void };
export function SidebarActivityLinker(props: LinkerProps) {
  return <ActivityLinker key={`${props.accountId}:${props.conversationId}`} {...props} />;
}
function ActivityLinker({ accountId, conversationId, onSaved }: LinkerProps) {
  const [id, setId] = useState(""), [error, setError] = useState(""), [loadingMore, setLoadingMore] = useState(false);
  const rows = useAsyncResource(() => request<{ items: { id: string; communicationId: string; phone?: string; at?: string; resolved?: boolean }[]; nextToken?: string }>("work", { kind: "TRIAGE" }), [accountId, conversationId], { initialData: { items: [] } });
  const currentRows = useRef(rows.data); currentRows.current = rows.data;
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <details><summary>Link a call or text to this conversation</summary><p className="muted small">Review the source before choosing its association.</p>
    {rows.data.items.filter(r => !r.resolved).map(r => <p key={r.id}><button className="link" onClick={() => setId(r.communicationId)}>{r.phone ? fmtProviderPhone(r.phone) : "Unknown contact"} · {r.at ? new Date(r.at).toLocaleString() : "Time unavailable"}</button></p>)}
    {rows.data.nextToken && <button className="link" disabled={loadingMore || rows.loading} onClick={async () => {
      if (pending.current) return;
      pending.current = true; setLoadingMore(true); setError("");
      const captured = rows.data;
      try {
        const page = await request<typeof rows.data>("work", { kind: "TRIAGE", nextToken: captured.nextToken });
        if (mounted.current && currentRows.current === captured) rows.setData(current => current === captured ? { ...page, items: [...new Map([...current.items, ...page.items].map(item => [item.id, item])).values()] } : current);
      } catch(e) { if (mounted.current) setError(String(e)); }
      finally { pending.current = false; if (mounted.current) setLoadingMore(false); }
    }}>{loadingMore ? "Loading activity…" : "More activity"}</button>}
    {(error || rows.error) && <p className="error-text">{error || rows.error}</p>}
    {id && <ActivityReview key={id} id={id} accountId={accountId} conversationId={conversationId} onSaved={() => { setId(""); void rows.refetch(); onSaved(); }} />}
  </details>;
}
