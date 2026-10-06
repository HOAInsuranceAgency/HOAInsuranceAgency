import { useState, useEffect, useRef } from "react";
import { client } from "../lib/client";
import { listAllPages } from "../lib/pagination";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useFormState } from "../lib/useFormState";
import { communicationRequest as request } from "../lib/communications";

type Props = { accountId: string; conversationId: string; bound: boolean; saved?: { purpose?: string; context?: string; policyId?: string }; onSaved: () => void };
/** Set the business context once per conversation, never on each message. */
export default function ConversationContext(props: Props) {
  return <ContextEditor key={`${props.accountId}:${props.conversationId}`} {...props} />;
}
function ContextEditor({ accountId, conversationId, bound, saved, onSaved }: Props) {
  const policies = useAsyncResource(() => listAllPages(token => client.models.Policy.list({ filter: { accountId: { eq: accountId } }, nextToken: token })), [accountId], { initialData: [] });
  const initial = { context: saved?.context ?? (bound ? "SERVICE" : "LEAD"), purpose: saved?.purpose ?? "PROSPECT", policyId: saved?.policyId ?? "" };
  const editor = useFormState(initial);
  const { context, purpose, policyId } = editor.form;
  const dirty = useRef(editor.dirty); dirty.current = editor.dirty;
  const pending = useRef(false), mounted = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty.current && !pending.current) editor.reset(initial);
    // Refreshed server context can update a clean editor, never an open draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.context, saved?.purpose, saved?.policyId, bound]);
  return <details className="front-disclosure"><summary>Conversation context</summary><p className="muted small">Choose once when linking a renewal or carrier thread. Future messages inherit this context.</p>
    <label className="field">Correspondence with<select disabled={busy} value={purpose} onChange={e => editor.setF("purpose", e.target.value)}><option value="PROSPECT">Prospect or client</option><option value="CARRIER">Carrier</option></select></label>
    <label className="field">This conversation concerns<select disabled={busy} value={context} onChange={e => editor.setF("context", e.target.value)}><option value="LEAD">New business</option><option value="RENEWAL">Renewal</option><option value="SERVICE">Client service</option></select></label>
    {context === "RENEWAL" && <label className="field">Renewing policy<select disabled={busy} value={policyId} onChange={e => editor.setF("policyId", e.target.value)}><option value="">Choose policy</option>{policies.data.map(p => <option key={p.id} value={p.id}>{p.policyNumber || "Policy"} · {p.lines?.filter(Boolean).join(", ")} · expires {p.expirationDate}</option>)}</select></label>}
    {(error || policies.error) && <p role="alert" className="error-text">{error || policies.error}</p>}
    <button className="secondary" disabled={busy || context === "RENEWAL" && !policyId} onClick={async () => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError("");
      const submitted = editor.form;
      try {
        await request("linkConversation", { accountId, conversationId, purpose, context, policyId: context === "RENEWAL" ? policyId : undefined }, true);
        if (mounted.current) { editor.markSaved(submitted); onSaved(); }
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Could not save context"); }
      finally { pending.current = false; if (mounted.current) setBusy(false); }
    }}>Save conversation context</button>
  </details>;
}
