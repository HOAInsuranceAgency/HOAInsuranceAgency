import { useState, useEffect } from "react";
import { client } from "../lib/client";
import { listAllPages } from "../lib/pagination";
import { useAsyncResource } from "../lib/useAsyncResource";
import { communicationRequest as request } from "../lib/communications";

/** Set the business context once per conversation, never on each message. */
export default function ConversationContext({ accountId, conversationId, bound, saved, onSaved }: { accountId: string; conversationId: string; bound: boolean; saved?: { purpose?: string; context?: string; policyId?: string }; onSaved: () => void }) {
  const policies = useAsyncResource(() => listAllPages(token => client.models.Policy.list({ filter: { accountId: { eq: accountId } }, nextToken: token })), [accountId], { initialData: [] });
  const [context, setContext] = useState(bound ? "SERVICE" : "LEAD"), [purpose, setPurpose] = useState("PROSPECT"), [policyId, setPolicyId] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setContext(saved?.context ?? (bound ? "SERVICE" : "LEAD")); setPurpose(saved?.purpose ?? "PROSPECT"); setPolicyId(saved?.policyId ?? ""); }, [saved?.context, saved?.purpose, saved?.policyId, bound, conversationId]);
  return <details className="front-disclosure"><summary>Conversation context</summary><p className="muted small">Choose once when linking a renewal or carrier thread. Future messages inherit this context.</p>
    <label className="field">Correspondence with<select value={purpose} onChange={e => setPurpose(e.target.value)}><option value="PROSPECT">Prospect or client</option><option value="CARRIER">Carrier</option></select></label>
    <label className="field">This conversation concerns<select value={context} onChange={e => setContext(e.target.value)}><option value="LEAD">New business</option><option value="RENEWAL">Renewal</option><option value="SERVICE">Client service</option></select></label>
    {context === "RENEWAL" && <label className="field">Renewing policy<select value={policyId} onChange={e => setPolicyId(e.target.value)}><option value="">Choose policy</option>{policies.data.map(p => <option key={p.id} value={p.id}>{p.policyNumber || "Policy"} · {p.lines?.filter(Boolean).join(", ")} · expires {p.expirationDate}</option>)}</select></label>}
    {(error || policies.error) && <p role="alert" className="error-text">{error || policies.error}</p>}
    <button className="secondary" disabled={busy || context === "RENEWAL" && !policyId} onClick={async () => { setBusy(true); setError(""); try { await request("linkConversation", { accountId, conversationId, purpose, context, policyId: context === "RENEWAL" ? policyId : undefined }, true); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save context"); } finally { setBusy(false); } }}>Save conversation context</button>
  </details>;
}
