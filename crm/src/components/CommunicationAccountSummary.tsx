import { Button } from "./ui/Button";
import { acquisitionLabel } from "../../../shared/leadSource";
import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDate, fmtProviderPhone } from "../lib/client";
import { leadSourceLabel } from "../lib/communicationLabels";
import ContactActions from "./ContactActions";
type Summary = { name: string; source?: string; leadSource?: string; notes?: string; currentPolicyExpiration?: string; url: string; more: boolean;
  contacts: { id: string; name?: string; email?: string; phone?: string }[]; quotes: { id: string; status: string; lines?: string[] }[]; documents: { id: string; name: string; status?: string }[] };
export default function CommunicationAccountSummary({ accountId, open }: { accountId: string; open: (url: string) => void }) {
  const resource = useAsyncResource(() => request<{ summary: Summary }>("accountSummary", { accountId }), [accountId], { initialData: null, errorMessage: "Account details are temporarily unavailable" });
  if (!resource.data) return <div className="front-lead-summary"><p className="muted small">{resource.error || "Loading account details…"}</p>{resource.error && <Button variant="secondary"  onClick={() => void resource.refetch()}>Retry account details</Button>}</div>;
  const s = resource.data.summary;
  return <section className="front-lead-summary" aria-label="Lead summary">
    <p className="front-eyebrow">{s.leadSource ? acquisitionLabel(s.leadSource) : leadSourceLabel(s.source)}</p><h1>{s.name}</h1>
    {s.contacts.map(c => <div className="front-contact" key={c.id}>
      {c.name && c.name !== s.name && <strong>{c.name}</strong>}
      {c.email && <ContactActions kind="email" value={c.email} contactName={c.name} />}
      {c.phone && <ContactActions kind="phone" value={c.phone} display={fmtProviderPhone(c.phone)} contactName={c.name} />}
    </div>)}
    <Button variant="secondary" className="front-open-account" onClick={() => open(s.url)}>Open CRM account <span aria-hidden="true">↗</span></Button>
    <details className="front-account-details"><summary>Account details <span className="front-summary-hint">Notes, quotes & documents</span></summary>
      {s.currentPolicyExpiration && <p className="small">Policy expires <strong>{fmtDate(s.currentPolicyExpiration)}</strong></p>}
      {s.notes && <details className="front-subdetails"><summary>Lead notes</summary><p className="small front-preserve-lines">{s.notes}</p></details>}
      <div className="front-detail-group"><h3>Quotes</h3>
        {s.quotes.length ? s.quotes.map(q => <p className="small" key={q.id}>{q.status.toLowerCase().replaceAll("_", " ")}{q.lines?.length ? ` · ${q.lines.join(", ")}` : ""}</p>) : <p className="muted small">No quotes shown yet.</p>}
        <Button variant="link"  onClick={() => open(`${s.url}?tab=quotes`)}>View quotes & bind</Button>
      </div>
      <div className="front-detail-group"><h3>Documents</h3>
        {s.documents.length ? s.documents.map(d => <p className="small" key={d.id}><strong>{d.name}</strong><br /><span className="muted">{d.status?.toLowerCase().replaceAll("_", " ") ?? "uploaded"}</span></p>) : <p className="muted small">No documents shown yet.</p>}
        <Button variant="link"  onClick={() => open(`${s.url}?tab=documents`)}>View all documents</Button>
      </div>
      {s.more && <p className="muted small">More account details are available in the CRM.</p>}
    </details>
  </section>;
}
