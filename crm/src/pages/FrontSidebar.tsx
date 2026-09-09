import { useEffect, useState, useRef } from "react";
import Front from "@frontapp/plugin-sdk";
import LeadWorkflowPanel from "../components/LeadWorkflowPanel";
import { client } from "../lib/client";
import { communicationRequest as request } from "../lib/communications";

export default function FrontSidebar() {
  const activeId = useRef<string | null>(null);
  const [smsTo, setSmsTo] = useState(""), [smsBody, setSmsBody] = useState(""), [smsBusy, setSmsBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null), [status, setStatus] = useState("Select one conversation in Front.");
  const [search, setSearch] = useState(""), [matches, setMatches] = useState<{ id: string; name: string }[]>([]), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), [purpose, setPurpose] = useState("PROSPECT");
  useEffect(() => {
    const subscription = Front.contextUpdates.subscribe(context => {
      const id = "conversation" in context && context.conversation ? context.conversation.id : null;
      if (id === activeId.current) return;
      setPurpose("PROSPECT"); setSmsBusy(false);
      activeId.current = id; setConversationId(id); setSmsTo(""); setSmsBody(""); setStatus(id ? "" : "Select one conversation in Front."); setSearch(""); setMatches([]); setError("");
    });
    return () => subscription.unsubscribe();
  }, []);
  const open = (url: string) => { void Front.openUrl(url); };
  return <main className="front-crm-sidebar"><h1>HOA CRM</h1>{status && <p>{status}</p>}
    {conversationId && <><LeadWorkflowPanel key={`${conversationId}:${revision}`} conversationId={conversationId} onOpen={open} />
      <details className="card"><summary>Text from the shared main line</summary><p>From: (508) 233-2261</p>
      <form onSubmit={async e => { e.preventDefault(); const captured = activeId.current; setSmsBusy(true); setError(""); try {
        const setup = await request<{ channelId: string; sender: string }>("smsComposer");
        if (captured !== activeId.current) return;
        await Front.createDraft({ channelId: setup.channelId as Parameters<typeof Front.createDraft>[0]["channelId"], to: [smsTo.trim()], content: { body: smsBody, type: "text" } });
      } catch(e) { setError(`Could not open the text draft: ${String(e)}. Use Front's native composer and select the shared main line.`); } finally { setSmsBusy(false); } }}>
      <label className="field">Prospect number<input required type="tel" value={smsTo} onChange={e => setSmsTo(e.target.value)} placeholder="+1…" /></label><label className="field">Message<textarea required value={smsBody} onChange={e => setSmsBody(e.target.value)} /></label><button disabled={smsBusy}>Open draft in Front</button><p className="muted small">Review the sender and recipient, then send in Front.</p></form></details>
      <details className="card"><summary>Link to a CRM lead</summary><form onSubmit={async e => { e.preventDefault(); const captured = conversationId; setError(""); try {
        const p = await client.models.Account.list({ filter: { name: { contains: search.trim() } }, limit: 25 });
        if (p.errors?.length) throw new Error(p.errors[0].message); if (captured === activeId.current) setMatches(p.data.map(a => ({ id: a.id, name: a.name })));
      } catch(e) { setError(String(e)); } }}><label className="field">Association or client name<input required value={search} onChange={e => setSearch(e.target.value)} /></label><button>Search CRM</button></form>
      <label className="field">Conversation purpose<select value={purpose} onChange={e => setPurpose(e.target.value)}><option value="PROSPECT">Prospect</option><option value="CARRIER">Carrier</option></select></label>
      {matches.map(m => <p key={m.id}><button className="link" onClick={async () => { try { await request("linkConversation", { accountId: m.id, conversationId, purpose }, true); setRevision(n => n + 1); setMatches([]); } catch(e) { setError(String(e)); } }}>{m.name}</button></p>)}
      {error && <p role="alert" className="error-text">{error}</p>}</details></>}
  </main>;
}
