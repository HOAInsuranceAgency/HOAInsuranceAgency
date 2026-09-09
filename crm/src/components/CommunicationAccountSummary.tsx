import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
type Summary = { name: string; source?: string; notes?: string; currentPolicyExpiration?: string; url: string; more: boolean;
  contacts: { id: string; name?: string; email?: string; phone?: string }[]; quotes: { id: string; status: string; lines?: string[] }[]; documents: { id: string; name: string; status?: string }[] };
export default function CommunicationAccountSummary({ accountId, open }: { accountId: string; open: (url: string) => void }) {
  const resource = useAsyncResource(() => request<{ summary: Summary }>("accountSummary", { accountId }), [accountId], { initialData: null, errorMessage: "Account details are temporarily unavailable" });
  if (!resource.data) return <p className="muted small">{resource.error ?? "Loading account details…"}</p>;
  const s = resource.data.summary;
  return <details open><summary>{s.name}</summary><p className="small">Source: {s.source ?? "Not recorded"} · Incumbent expiry: {s.currentPolicyExpiration ?? "Not recorded"}</p>
    {s.contacts.map(c => <p className="small" key={c.id}>{c.name}<br />{c.email}{c.phone && ` · ${c.phone}`}</p>)}
    {s.notes && <details><summary>Lead context</summary><p className="small" style={{ whiteSpace: "pre-wrap" }}>{s.notes}</p></details>}
    <p className="small">Quotes: {s.quotes.length ? s.quotes.map(q => `${q.status.toLowerCase()} (${q.lines?.join(", ") || "coverage not recorded"})`).join("; ") : "None recorded"}</p>
    <details><summary>Documents ({s.documents.length}{s.more ? "+" : ""})</summary>{s.documents.map(d => <p className="small" key={d.id}>{d.name} · {d.status?.toLowerCase() ?? "uploaded"}</p>)}</details>
    <div className="toolbar"><button className="link" onClick={() => open(s.url)}>Open CRM account</button><button className="link" onClick={() => open(`${s.url}?tab=quotes`)}>Quotes / bind workflow</button><button className="link" onClick={() => open(`${s.url}?tab=documents`)}>All documents</button></div>
  </details>;
}
