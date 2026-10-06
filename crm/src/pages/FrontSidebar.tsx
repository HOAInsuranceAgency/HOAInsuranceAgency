import { useEffect, useState, useRef } from "react";
import Front from "@frontapp/plugin-sdk";
import LeadWorkflowPanel from "../components/LeadWorkflowPanel";
import { client, friendlyError } from "../lib/client";
import { communicationRequest as request } from "../lib/communications";
import { listAllPages } from "../lib/pagination";

export default function FrontSidebar() {
  const activeId = useRef<string | null>(null);
  const searchVersion = useRef(0);
  const scope = useRef(0), smsFlight = useRef<object | null>(null), linkFlight = useRef<object | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [smsTo, setSmsTo] = useState(""), [smsBody, setSmsBody] = useState(""), [smsBusy, setSmsBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null), [status, setStatus] = useState("Select one conversation in Front.");
  const [search, setSearch] = useState(""), [matches, setMatches] = useState<{ id: string; name: string }[]>([]), [error, setError] = useState("");
  const [searchBusy, setSearchBusy] = useState(false), [searched, setSearched] = useState(false);
  const [revision, setRevision] = useState(0), [purpose, setPurpose] = useState("PROSPECT");
  useEffect(() => {
    const subscription = Front.contextUpdates.subscribe(context => {
      const id = "conversation" in context && context.conversation ? context.conversation.id : null;
      if (id === activeId.current) return;
      scope.current++; smsFlight.current = null; linkFlight.current = null; setLinkBusy(false);
      searchVersion.current++; setSearchBusy(false); setSearched(false);
      setPurpose("PROSPECT"); setSmsBusy(false);
      activeId.current = id; setConversationId(id); setSmsTo(""); setSmsBody(""); setStatus(id ? "" : "Select one conversation in Front."); setSearch(""); setMatches([]); setError("");
    });
    return () => { scope.current++; searchVersion.current++; smsFlight.current = null; linkFlight.current = null; subscription.unsubscribe(); };
  }, []);
  const open = (url: string) => { void Front.openUrl(url); };
  return <main className="front-crm-sidebar">{status && <div className="card front-empty"><h1>Your lead workspace</h1><p>{status}</p><p className="muted small">Contact details, communication history, and the account salesperson will appear here.</p></div>}
    {error && <p role="alert" className="error-text workflow-notice">{friendlyError(error, "Could not complete that action. Please try again.")}</p>}
    {conversationId && <><LeadWorkflowPanel key={`${conversationId}:${revision}`} conversationId={conversationId} onOpen={open} />
      <div key={conversationId} className="front-extra-tools"><details className="front-disclosure"><summary>Send a text <span className="front-summary-hint">From the shared main line</span></summary><p className="muted small">Prepare a draft, then review and send it in Front.</p>
      <form onSubmit={async e => {
        e.preventDefault();
        if (smsFlight.current) return;
        const attempt = {}, captured = scope.current;
        smsFlight.current = attempt; setSmsBusy(true); setError("");
        const current = () => captured === scope.current && smsFlight.current === attempt;
        try {
          const setup = await request<{ channelId: string; sender: string }>("smsComposer");
          if (!current()) return;
          await Front.createDraft({ channelId: setup.channelId as Parameters<typeof Front.createDraft>[0]["channelId"], to: [smsTo.trim()], content: { body: smsBody, type: "text" } });
        } catch(e) { if (current()) setError(`Could not open the text draft: ${String(e)}. Use Front's native composer and select the shared main line.`); }
        finally { if (current()) { smsFlight.current = null; setSmsBusy(false); } }
      }}>
      <label className="field">Prospect number<input required type="tel" value={smsTo} onChange={e => setSmsTo(e.target.value)} placeholder="(617) 555-0123" /></label><label className="field">Message<textarea required rows={3} value={smsBody} onChange={e => setSmsBody(e.target.value)} placeholder="Write your message…" /></label><button disabled={smsBusy || !smsTo.trim() || !smsBody.trim()}>Open draft in Front</button></form></details>
      <details className="front-disclosure"><summary>Find or link a lead <span className="front-summary-hint">Choose the right CRM account</span></summary><form onSubmit={async e => { e.preventDefault(); const captured = conversationId, version = ++searchVersion.current, term = search.trim().toLocaleLowerCase(); setError(""); setMatches([]); setSearched(false); setSearchBusy(true); try {
        // DynamoDB's limit applies before filtering. Search every page, and
        // compare locally so capitalization cannot hide an existing account.
        const accounts = await listAllPages(async nextToken => {
          const p = await client.models.Account.list({ nextToken, limit: 200, selectionSet: ["id", "name"] });
          if (p.errors?.length) throw new Error(p.errors[0].message);
          return p;
        });
        if (captured === activeId.current && version === searchVersion.current) {
          setMatches(accounts.filter(a => a.name.toLocaleLowerCase().includes(term)).map(a => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)));
          setSearched(true);
        }
      } catch(e) { if (captured === activeId.current && version === searchVersion.current) setError(String(e)); }
      finally { if (captured === activeId.current && version === searchVersion.current) setSearchBusy(false); }
      }}><label className="field">Association or client name<input required value={search} onChange={e => { setSearch(e.target.value); searchVersion.current++; setMatches([]); setSearched(false); setSearchBusy(false); }} placeholder="Search by name" /></label><button disabled={searchBusy || !search.trim()}>{searchBusy ? "Searching…" : "Search CRM"}</button></form>
      {searched && !matches.length && <p role="status" className="muted small">No matching CRM leads or clients. Try another part of the name.</p>}
      <label className="field">Conversation purpose<select value={purpose} onChange={e => setPurpose(e.target.value)}><option value="PROSPECT">Prospect</option><option value="CARRIER">Carrier</option></select></label>
      {matches.map(m => <p key={m.id}><button className="link" disabled={linkBusy} onClick={async () => {
        if (linkFlight.current) return;
        const attempt = {}, captured = scope.current, searchAtStart = searchVersion.current;
        linkFlight.current = attempt; setLinkBusy(true); setError("");
        const current = () => captured === scope.current && linkFlight.current === attempt;
        try {
          await request("linkConversation", { accountId: m.id, conversationId, purpose }, true);
          if (current()) { setRevision(n => n + 1); if (searchAtStart === searchVersion.current) setMatches([]); }
        } catch(e) { if (current()) setError(String(e)); }
        finally { if (current()) { linkFlight.current = null; setLinkBusy(false); } }
      }}>{m.name}</button></p>)}
      </details></div></>}
  </main>;
}
