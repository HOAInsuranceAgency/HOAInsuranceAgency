import { Link, useLocation } from "react-router-dom";
import { client, fmtDate, fmtMoney, listAllPages, type Account, type Contact, type Policy } from "../lib/client";
import { primaryContact } from "../lib/contacts";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function AccountSummary({ account }: { account: Account }) {
  const { state } = useLocation();
  const contacts = useAsyncResource(() => listAllPages(nextToken => client.models.Contact.list({ filter: { accountId: { eq: account.id } }, nextToken })), [account.id], { initialData: [] as Contact[], errorMessage: "Could not load the primary contact" });
  const contact = primaryContact(contacts.data);
  const coverage = useAsyncResource(() => account.stage === "CLIENT" ? listAllPages(nextToken => client.models.Policy.list({ filter: { accountId: { eq: account.id } }, nextToken })) : Promise.resolve([]), [account.id, account.stage], { initialData: [] as Policy[], errorMessage: "Could not load active policy dates" });
  const activePolicies = coverage.data.filter(p => p.status === "ACTIVE");
  const renewal = activePolicies.map(p => p.expirationDate).filter(Boolean).sort()[0];
  return <section className="card" aria-label="Account summary"><dl className="summary-grid">
    <div><dt>Primary contact</dt><dd>{contacts.loading ? "Loading…" : contacts.error ? "Unavailable" : contact?.name || "Not recorded"}{contact?.email && <div><a href={`mailto:${contact.email}`}>{contact.email}</a></div>}{contact?.phone && <div><a href={`tel:${contact.phone}`}>{contact.phone}</a></div>}</dd></div>
    <div><dt>Property</dt><dd>{[account.address, account.city, account.state, account.zip].filter(Boolean).join(", ") || "Address not recorded"}</dd></div>
    <div><dt>{account.stage === "CLIENT" ? "Next policy renewal" : "Recorded incumbent expiration"}</dt><dd>{account.stage === "CLIENT" ? coverage.loading ? "Loading…" : coverage.error ? "Unavailable" : renewal ? fmtDate(renewal) : "No active policy dates" : account.currentPolicyExpiration ? fmtDate(account.currentPolicyExpiration) : "Not recorded"}{account.stage === "CLIENT" && <div><Link state={state} to="?tab=policies">Review policies</Link></div>}</dd></div>
    <div><dt>Total insured value</dt><dd>{account.totalInsuredValue == null ? "Not recorded" : fmtMoney(account.totalInsuredValue)}</dd></div>
  </dl>{contacts.error && <p role="alert">{contacts.error} <button className="link" onClick={() => void contacts.refetch()}>Retry</button></p>}
  {coverage.error && <p role="alert">{coverage.error} <button className="link" onClick={() => void coverage.refetch()}>Retry policies</button></p>}
  <div className="summary-actions"><Link state={state} to="?tab=contacts">Manage contacts</Link><Link state={state} to="?tab=documents">Find a document</Link><Link state={state} to="?tab=quotes">Review coverage &amp; markets</Link></div></section>;
}
