import { Pagination } from "../components/ui/kit";
import { communicationRequest, type LeadTask } from "../lib/communications";
import { workLink } from "../../../shared/leadActionGuidance";
import { useMemo } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  fmtNum,
  listAllPages,
  type Account,
  type Contact,
  type Policy,
} from "../lib/client";
import { primaryContact } from "../lib/contacts";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";
import { useCommercial, teammateName } from '../lib/commercial';
import { OpportunityEstimate } from '../components/OpportunityEstimate';
import { ReportDownload } from '../components/ReportDownload';
import { acquisitionLabel, websiteFormLabel } from '../../../shared/leadSource';
import { formatCommission, pendingCommission } from '../../../shared/quotePackages';
import { agencyDay } from '../../../shared/leadActionGuidance';
import type { Quote } from '../lib/client';

export default function AccountsList({ stage }: { stage: "LEAD" | "CLIENT" }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const search = params.get("q") || "", salesperson = params.get("owner") || "", champion = params.get("champion") || "";
  const reportView = params.get("view") === "report";
  const updateView = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); if (key !== "page") next.delete("page"); setParams(next, { replace: true }); };
  const setSearch = (value: string) => updateView("q", value), setSalesperson = (value: string) => updateView("owner", value), setChampion = (value: string) => updateView("champion", value);
  const back = location.pathname + location.search;

  const {
    data: accounts,
    loading,
    error,
  } = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Account.list({ nextToken })
      ),
    [stage],
    { initialData: [] as Account[], errorMessage: "Failed to load accounts" }
  );
  const commercial = useCommercial(accounts.map(a => a.id), accounts);
  const quoteResource = useAsyncResource(() => stage === 'LEAD' ? listAllPages(nextToken => client.models.Quote.list({ nextToken })) : Promise.resolve([]), [stage], { initialData: [] as Quote[], errorMessage: 'Could not load quoted commissions' });
  const today = agencyDay(new Date().toISOString());
  const forecastOf = (a: Account) => { const plan = commercial.data.entries[a.id]?.plan; return plan ? pendingCommission(plan, quoteResource.data.filter(q => q.accountId === a.id), today) : null; };
  const assignee = (a: Account, role: 'salespersonId' | 'championId') => teammateName(commercial.data.entries[a.id]?.[role], commercial.data.team);

  // Renewal dates only. A failure here costs the "Renewal" column its dates
  // and nothing else, so it stays out of the page-level error — the accounts
  // table is still worth showing without it.
  const { data: policies, error: policyError } = useAsyncResource(
    () => listAllPages(nextToken => client.models.Policy.list({ nextToken })),
    [],
    { initialData: [] as Policy[] }
  );

  // The contact column, which used to be two Account columns. Same shape as
  // the policies read above and for the same reason: it is a lookup table, its
  // failure costs one column and nothing else, so it stays out of the
  // page-level error rather than blanking a table that is still worth showing.
  const { data: contacts, error: contactError } = useAsyncResource(
    () => listAllPages((nextToken) => client.models.Contact.list({ nextToken })),
    [],
    { initialData: [] as Contact[] }
  );

  const contactsByAccount = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of contacts) {
      const list = map.get(c.accountId);
      if (list) list.push(c);
      else map.set(c.accountId, [c]);
    }
    return map;
  }, [contacts]);

  /** The one name shown per row — the same rule the ACORD insured block uses. */
  const contactOf = (a: Account) =>
    primaryContact(contactsByAccount.get(a.id) ?? []);

  // Renewal date: clients → earliest ACTIVE policy expiration;
  // leads → incumbent policy expiration.
  const renewalByAccount = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of policies) {
      if (p.status !== "ACTIVE" || !p.expirationDate) continue;
      const cur = map.get(p.accountId);
      if (!cur || p.expirationDate < cur) map.set(p.accountId, p.expirationDate);
    }
    return map;
  }, [policies]);

  const renewalOf = (a: Account): string | null =>
    stage === "CLIENT"
      ? renewalByAccount.get(a.id) ?? null
      : a.currentPolicyExpiration ?? null;

  const q = search.trim().toLowerCase();
  const visible = accounts.filter(a => (a.stage === stage || stage === 'LEAD' && a.stage === 'CLIENT' && forecastOf(a)?.unfinished)
    && (!salesperson || commercial.data.entries[a.id]?.salespersonId === salesperson)
    && (!champion || commercial.data.entries[a.id]?.championId === champion));
  const filtered = q
    ? visible.filter((a) =>
        [
          a.name,
          a.city,
          a.state,
          // Every contact, not just the primary one: searching for the board
          // president used to find nothing unless they happened to be the one
          // person the Account columns could hold.
          ...(contactsByAccount.get(a.id) ?? []).flatMap((c) => [c.name, c.email]),
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : visible;

  // Default: policy end date ascending — next up / expired at the top,
  // accounts without a date after, alphabetically.
  const { sorted, sortKey, dir, toggle: sortToggle } = useSort(
    filtered,
    {
      name: (a) => a.name,
      type: (a) => a.type,
      contact: (a) => contactOf(a)?.name ?? null,
      city: (a) => a.city,
      state: (a) => a.state,
      salesperson: (a) => assignee(a, 'salespersonId'),
      champion: (a) => assignee(a, 'championId'),
      source: (a) => acquisitionLabel(a.leadSource, a.source),
      form: (a) => websiteFormLabel(a.source),
      estimate: (a) => commercial.data.entries[a.id]?.plan.estimatedCents,
      pending: (a) => forecastOf(a)?.cents,
      units: (a) => a.unitCount,
      tiv: (a) => a.totalInsuredValue,
      // When the lead entered the pipeline — the row's own creation stamp,
      // which every intake path (form, web lead) shares.
      entered: (a) => a.createdAt,
      renewal: (a) => renewalOf(a),
    },
    "renewal", "asc", { key: params.get("sort") || "renewal", dir: params.get("dir") === "desc" ? "desc" : "asc" }
  );

  function toggle(key: string) { sortToggle(key); const next = new URLSearchParams(params); next.set("sort", key); next.set("dir", key === sortKey && dir === "asc" ? "desc" : "asc"); next.delete("page"); setParams(next, { replace: true }); }
  const page = Math.min(Math.max(1, Math.floor(Number(params.get("page"))) || 1), Math.max(1, Math.ceil(sorted.length / 25)));
  const pageRows = sorted.slice((page - 1) * 25, page * 25);
  const actionKey = pageRows.map(a => a.id).join(",");
  const actions = useAsyncResource(async () => {
    if (!actionKey) return { items: [] as { accountId: string; nextAction: LeadTask | null; actionCount: number }[] };
    return communicationRequest<{ items: { accountId: string; nextAction: LeadTask | null; actionCount: number }[] }>("commercialTable", { accountIds: actionKey.split(","), includeActions: true });
  }, [actionKey], { initialData: { items: [] }, errorMessage: "Could not load next actions" });
  const actionOf = (id: string) => actions.data.items.find(item => item.accountId === id)?.nextAction;
  const actionLink = (id: string) => { const task = actionOf(id); return task ? workLink(task) : null; };
  const actionCell = (id: string) => { const link = actionLink(id); return actions.loading ? "Loading…" : actions.error ? "Unavailable" : link ? link.path.startsWith("https://") ? <a href={link.path} target="_blank" rel="noreferrer">{actionOf(id)?.title} ↗</a> : <Link to={link.path} state={{ from: back }}>{actionOf(id)?.title}</Link> : "No open actions"; };
  const label = stage === "LEAD" ? "Leads" : "Clients";

  return (
    <>
      <div className="page-heading"><div><h1>Accounts</h1><p className="sub">Find an account, its owner, and what happens next.</p></div><Link className="button primary" to="/leads/new">New lead</Link></div>
      <nav className="subnav" aria-label="Account views"><Link aria-current={stage === "LEAD" ? "page" : undefined} to="/leads">Leads</Link><Link aria-current={stage === "CLIENT" ? "page" : undefined} to="/clients">Clients</Link><Link to="/quotes">Quotes</Link><Link to="/policies">Policies</Link></nav>
      <h2>{label}</h2>
      <p className="sub">
        {stage === "LEAD"
          ? "Prospects — converted to clients when a quote is bound"
          : "Bound accounts (created automatically from leads)"}
      </p>

      <div className="toolbar">
        <div className="field grow" style={{ maxWidth: 360 }}>
          <input
            aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {<><label className="field">Salesperson<select value={salesperson} onChange={e => setSalesperson(e.target.value)}><option value="">All salespeople</option>{commercial.data.team.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label><label className="field">Deal champion<select value={champion} onChange={e => setChampion(e.target.value)}><option value="">All champions</option>{commercial.data.team.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label></>}
        <label className="field">Columns<select value={reportView ? "report" : "work"} onChange={e => updateView("view", e.target.value)}><option value="work">Working view</option><option value="report">Full details &amp; reporting</option></select></label>
        <ReportDownload disabled={loading || !!error || stage === 'LEAD' && (commercial.loading || !!commercial.error || quoteResource.loading || !!quoteResource.error)} report={{ title: label, filters: `Search: ${search || 'All'}${stage === 'LEAD' ? ` · Salesperson: ${commercial.data.team.find(t => t.userId === salesperson)?.name ?? 'All'} · Deal champion: ${commercial.data.team.find(t => t.userId === champion)?.name ?? 'All'}` : ''}`, sections: [{ title: label, columns: ['Name', 'Type', 'Contact', 'City', 'State', ...(stage === 'LEAD' ? ['Salesperson', 'Deal champion', 'Lead source', 'Website form', 'Estimated opportunity (USD)', 'Pending commission (USD)', 'Commission basis', 'Entered'] : []), 'Units', 'TIV (USD)', stage === 'LEAD' ? 'Incumbent expires' : 'Renewal'], rows: sorted.map(a => { const f = forecastOf(a), estimate = commercial.data.entries[a.id]?.plan.estimatedCents; return [a.name, a.type, contactOf(a)?.name, a.city, a.state, ...(stage === 'LEAD' ? [assignee(a, 'salespersonId'), assignee(a, 'championId'), acquisitionLabel(a.leadSource, a.source), websiteFormLabel(a.source), estimate == null ? null : estimate / 100, f?.cents == null ? null : f.cents / 100, f?.label, a.createdAt?.slice(0,10)] : []), a.unitCount, a.totalInsuredValue, renewalOf(a)]; }) }] }} />

      </div>

      <div className="card">
        {contactError && <p role="alert">Contact details unavailable: {contactError}</p>}
        {policyError && <p role="alert">Renewal dates unavailable: {policyError}</p>}
        {actions.error && <p role="alert">{actions.error} <button className="link" onClick={() => void actions.refetch()}>Retry</button></p>}
        {commercial.error && <p className="error-text" role="alert">{commercial.error} <button onClick={() => void commercial.refetch()}>Retry</button></p>}
        {stage === 'LEAD' && quoteResource.error && <p className="error-text" role="alert">{quoteResource.error} <button onClick={() => void quoteResource.refetch()}>Retry</button></p>}
        {reportView && stage === 'LEAD' && <p className="muted small">Commission estimates are for the agency. Client accounts with a selected package still being bound remain here until the package is finished.</p>}
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : error ? (
          <p className="error-text">{error}</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No {label.toLowerCase()} found.</p>
        ) : (
          <><div className={reportView ? "table-wrap desktop-records" : "table-wrap desktop-records"}>
            {reportView ? <table>
              <thead>
                <tr>
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Type" colKey="type" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Contact" colKey="contact" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="City" colKey="city" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="State" colKey="state" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  {stage === 'LEAD' && <>{[['Salesperson','salesperson'],['Deal champion','champion'],['Lead source','source'],['Website form','form'],['Estimated opportunity','estimate'],['Pending commission','pending']].map(([label,key]) => <SortTh key={key} label={label} colKey={key} sortKey={sortKey} dir={dir} onToggle={toggle} />)}</>}
                  <SortTh label="Units" colKey="units" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="TIV" colKey="tiv" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  {stage === "LEAD" && (
                    <SortTh label="Entered" colKey="entered" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  )}
                  <SortTh
                    label={stage === "LEAD" ? "Incumbent expires" : "Renewal"}
                    colKey="renewal"
                    sortKey={sortKey}
                    dir={dir}
                    onToggle={toggle}
                  />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((a) => {
                  const renewal = renewalOf(a);
                  const contact = contactOf(a);
                  return (
                    <tr
                      key={a.id}

                    >
                      <td>
                        <Link to={`/accounts/${a.id}`} state={{ from: back }}><strong>{a.name}</strong></Link>
                        {stage === 'LEAD' && a.stage === 'CLIENT' && <div><span className="badge amber">Binding in progress</span></div>}
                      </td>
                      <td>
                        <span className="badge gray">{a.type}</span>
                      </td>
                      <td>
                        {contact?.name ?? "—"}
                        {contact?.email && (
                          <div className="muted small">{contact.email}</div>
                        )}
                      </td>
                      <td>{a.city || '—'}</td><td>{a.state || '—'}</td>
                      {stage === 'LEAD' && <><td>{commercial.loading ? 'Loading…' : commercial.error ? 'Unavailable' : assignee(a, 'salespersonId')}</td><td>{commercial.loading ? 'Loading…' : commercial.error ? 'Unavailable' : assignee(a, 'championId')}</td><td>{acquisitionLabel(a.leadSource, a.source)}</td><td>{websiteFormLabel(a.source)}</td><td>{commercial.data.entries[a.id] && !commercial.error ? <OpportunityEstimate plan={commercial.data.entries[a.id].plan} onSaved={plan => commercial.setData(data => ({ ...data, entries: { ...data.entries, [a.id]: { ...data.entries[a.id], plan } } }))} /> : commercial.error ? 'Unavailable' : 'Loading…'}</td><td>{commercial.loading || quoteResource.loading ? 'Loading…' : commercial.error || quoteResource.error ? 'Unavailable' : <><strong>{forecastOf(a)?.cents == null ? '—' : formatCommission(forecastOf(a)!.cents!)}</strong><div className="muted small">{forecastOf(a)?.label}</div></>}</td></>}
                      <td>{fmtNum(a.unitCount)}</td>
                      <td>{fmtMoney(a.totalInsuredValue)}</td>
                      {stage === "LEAD" && (
                        <td>{a.createdAt ? fmtDate(a.createdAt.slice(0, 10)) : "—"}</td>
                      )}
                      <td>{renewal ? fmtDate(renewal) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table> : <table className="account-list"><thead><tr><SortTh label="Account" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} /><th>Stage</th><SortTh label="Owner" colKey={stage === "LEAD" ? "salesperson" : "champion"} sortKey={sortKey} dir={dir} onToggle={toggle} /><th>Next action</th><th>Due</th><SortTh label="Renewal" colKey="renewal" sortKey={sortKey} dir={dir} onToggle={toggle} /></tr></thead><tbody>{pageRows.map(a => <tr key={a.id}>
              <td><Link to={`/accounts/${a.id}`} state={{ from: back }}><strong>{a.name}</strong></Link><div className="muted small">{contactOf(a)?.name || "No primary contact"} · {[a.city, a.state].filter(Boolean).join(", ")}</div></td>
              <td><span className="badge gray">{a.stage === "CLIENT" ? stage === "LEAD" ? "Binding in progress" : "Client" : "Lead"}</span></td><td>{commercial.loading ? "Loading…" : commercial.error ? "Unavailable" : assignee(a, stage === "LEAD" ? "salespersonId" : "championId")}</td>
              <td>{actionCell(a.id)}</td><td>{actionOf(a.id)?.dueAt ? fmtDate(actionOf(a.id)!.dueAt.slice(0,10)) : "—"}</td><td>{renewalOf(a) ? fmtDate(renewalOf(a)) : "Not recorded"}</td>
            </tr>)}</tbody></table>}
          </div><div className="mobile-records">{pageRows.map(a => <article className="record-card" key={a.id}><h3><Link to={`/accounts/${a.id}`} state={{ from: back }}>{a.name}</Link></h3><p className="record-meta">{contactOf(a)?.name || "No primary contact"} · {[a.city, a.state].filter(Boolean).join(", ")}</p><p className="small">Owner: {commercial.loading ? "Loading…" : commercial.error ? "Unavailable" : assignee(a, stage === "LEAD" ? "salespersonId" : "championId")}</p><p>{actionCell(a.id)}</p><p className="small muted">{actionOf(a.id)?.dueAt && `Due ${fmtDate(actionOf(a.id)!.dueAt.slice(0,10))} · `}Renewal: {renewalOf(a) ? fmtDate(renewalOf(a)) : "Not recorded"}</p></article>)}</div>
          <Pagination total={sorted.length} page={page} onPage={value => updateView("page", String(value))} noun={label.toLowerCase()} /></>
        )}
      </div>
    </>
  );
}
