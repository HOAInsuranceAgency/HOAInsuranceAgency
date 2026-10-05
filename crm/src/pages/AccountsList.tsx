import { useIsAdmin } from "../lib/auth";
import { useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { LeadSalespersonSelect } from '../components/LeadSalespersonSelect';
import { ReportDownload } from '../components/ReportDownload';
import { LeadSnoozeControl } from '../components/LeadSnoozeControl';
import { leadSnoozeStatus, type LeadSnooze } from '../../../shared/leadSnooze';
import { useAgencyDay } from '../lib/useAgencyDay';
import { useRefreshOnReturn } from '../lib/useRefreshOnReturn';
import { acquisitionLabel, websiteFormLabel } from '../../../shared/leadSource';
import { formatCommission, pendingCommission } from '../../../shared/quotePackages';
import type { Quote } from '../lib/client';

const LEAD_VIEWS = ['Active', 'Snoozed', 'Follow-up due', 'All leads'] as const;
type LeadView = typeof LEAD_VIEWS[number];

export default function AccountsList({ stage }: { stage: "LEAD" | "CLIENT" }) {
  const isAdmin = useIsAdmin();
  const [salesperson, setSalesperson] = useState('');
  const [leadView, setLeadView] = useState<LeadView>('Active');
  const [savedSnoozes, setSavedSnoozes] = useState<Record<string, LeadSnooze>>({});
  const [notice, setNotice] = useState('');
  const viewId = useId();
  const [savedAssignments, setSavedAssignments] = useState<Record<string, { salespersonId?: string; workflowVersion: number }>>({});
  const navigate = useNavigate();

  const {
    data: accounts,
    loading,
    error,
    refetch: refetchAccounts,
  } = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Account.list({ nextToken })
      ),
    [stage],
    { initialData: [] as Account[], errorMessage: "Failed to load accounts" }
  );
  const commercial = useCommercial(accounts.map(a => a.id), accounts, stage === 'LEAD' ? accounts.filter(a => a.stage === 'LEAD').map(a => a.id) : []);
  // Successful account reloads change the revision above and reload commercial
  // data too, including current ownership, snoozes and newly visible accounts.
  const onInteractionChange = useRefreshOnReturn(refetchAccounts, stage === 'LEAD', loading || commercial.loading);
  const quoteResource = useAsyncResource(() => stage === 'LEAD' ? listAllPages(nextToken => client.models.Quote.list({ nextToken })) : Promise.resolve([]), [stage], { initialData: [] as Quote[], errorMessage: 'Could not load quoted commissions' });
  const today = useAgencyDay();
  const snoozeOf = (a: Account) => {
    const fetched = commercial.data.entries[a.id]?.snooze, saved = savedSnoozes[a.id];
    return saved && saved.version > (fetched?.version ?? -1) ? saved : fetched;
  };
  const snoozeStatus = (a: Account) => a.stage === 'LEAD' ? leadSnoozeStatus(snoozeOf(a), today) : 'ACTIVE';
  const forecastOf = (a: Account) => { const plan = commercial.data.entries[a.id]?.plan; return plan ? pendingCommission(plan, quoteResource.data.filter(q => q.accountId === a.id), today) : null; };
  // A refresh from another row may have started before an assignment saved.
  // Keep the newest confirmed owner even when those responses arrive out of order.
  const assignmentOf = (a: Account) => {
    const entry = commercial.data.entries[a.id], saved = savedAssignments[a.id];
    return saved && saved.workflowVersion > (entry?.workflowVersion ?? -1) ? saved : entry;
  };
  const assignee = (a: Account, role: 'salespersonId') => teammateName(assignmentOf(a)?.[role], commercial.data.team);

  // Renewal dates only. A failure here costs the "Renewal" column its dates
  // and nothing else, so it stays out of the page-level error — the accounts
  // table is still worth showing without it.
  const { data: policies } = useAsyncResource(
    () => listAllPages(nextToken => client.models.Policy.list({ nextToken })),
    [],
    { initialData: [] as Policy[] }
  );

  // The contact column, which used to be two Account columns. Same shape as
  // the policies read above and for the same reason: it is a lookup table, its
  // failure costs one column and nothing else, so it stays out of the
  // page-level error rather than blanking a table that is still worth showing.
  const { data: contacts } = useAsyncResource(
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

  const matching = accounts.filter(a => (a.stage === stage || stage === 'LEAD' && a.stage === 'CLIENT' && forecastOf(a)?.unfinished)
    && (!isAdmin || !salesperson || assignmentOf(a)?.salespersonId === salesperson));
  const inView = (a: Account, view: LeadView) => view === 'All leads' || (view === 'Snoozed' ? snoozeStatus(a) === 'SNOOZED' : view === 'Follow-up due' ? snoozeStatus(a) === 'DUE' : snoozeStatus(a) !== 'SNOOZED');
  const visible = stage === 'LEAD' ? matching.filter(a => inView(a, leadView)) : matching;
  const dueCount = matching.filter(a => snoozeStatus(a) === 'DUE').length;

  // Default: policy end date ascending — next up / expired at the top,
  // accounts without a date after, alphabetically.
  const { sorted, sortKey, dir, toggle } = useSort(
    visible,
    {
      name: (a) => a.name,
      type: (a) => a.type,
      contact: (a) => contactOf(a)?.name ?? null,
      city: (a) => a.city,
      state: (a) => a.state,
      salesperson: (a) => assignee(a, 'salespersonId'),
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
      followUp: (a) => a.stage === 'LEAD' ? snoozeOf(a)?.followUpOn : null,
    },
    "renewal"
  );

  const label = stage === "LEAD" ? "Leads" : "Clients";

  return (
    <>
      <h1 style={{ marginBottom: 20 }}>{label}</h1>

      {stage === 'LEAD' && <div className="tabs" role="tablist" aria-label="Lead views">
        {LEAD_VIEWS.map((view, index) => <button key={view} id={`${viewId}-${index}`} role="tab" aria-selected={leadView === view} aria-controls={`${viewId}-panel`} tabIndex={leadView === view ? 0 : -1} className={leadView === view ? 'active' : ''}
          onClick={() => setLeadView(view)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % LEAD_VIEWS.length : event.key === 'ArrowLeft' ? (index + LEAD_VIEWS.length - 1) % LEAD_VIEWS.length : event.key === 'Home' ? 0 : event.key === 'End' ? LEAD_VIEWS.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); setLeadView(LEAD_VIEWS[next]);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}>{view}{!loading && !commercial.loading && !commercial.error && <span aria-hidden="true"> ({matching.filter(a => inView(a, view)).length})</span>}</button>)}
      </div>}

      {stage === 'LEAD' && !commercial.loading && !commercial.error && dueCount > 0 && <div className="lead-follow-up-notice" role="status">
        <p><strong>{dueCount} follow-up{dueCount === 1 ? '' : 's'} due</strong> — ready to contact again.</p>
        {leadView !== 'Follow-up due' && <button className="link" onClick={() => setLeadView('Follow-up due')}>View due leads</button>}
      </div>}
      {stage === 'LEAD' && notice && <p className="muted small" role="status">{notice}</p>}

      <div className="toolbar">
        {isAdmin && <label className="field">Salesperson<select value={salesperson} onChange={e => setSalesperson(e.target.value)}><option value="">All salespeople</option>{commercial.data.team.filter(t => t.salesperson).map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label>}
        <ReportDownload disabled={loading || !!error || commercial.loading || !!commercial.error || stage === 'LEAD' && (quoteResource.loading || !!quoteResource.error)} report={{ title: label, filters: [isAdmin ? `Salesperson: ${commercial.data.team.find(t => t.userId === salesperson)?.name ?? 'All'}` : 'All displayed data', ...(stage === 'LEAD' ? [`View: ${leadView}`] : [])].join(' · '), sections: [{ title: label, columns: ['Name', 'Type', 'Contact', 'City', 'State', ...(isAdmin ? ['Salesperson'] : []), ...(stage === 'LEAD' ? [ 'Lead source', 'Website form', 'Estimated opportunity (USD)', 'Pending commission (USD)', 'Commission basis', 'Entered', 'Follow-up date', 'Follow-up note'] : []), 'Units', 'TIV (USD)', stage === 'LEAD' ? 'Incumbent expires' : 'Renewal'], rows: sorted.map(a => { const f = forecastOf(a), estimate = commercial.data.entries[a.id]?.plan.estimatedCents; return [a.name, a.type, contactOf(a)?.name, a.city, a.state, ...(isAdmin ? [assignee(a, 'salespersonId')] : []), ...(stage === 'LEAD' ? [ acquisitionLabel(a.leadSource, a.source), websiteFormLabel(a.source), estimate == null ? null : estimate / 100, f?.cents == null ? null : f.cents / 100, f?.label, a.createdAt?.slice(0,10), a.stage === 'LEAD' ? snoozeOf(a)?.followUpOn : null, a.stage === 'LEAD' ? snoozeOf(a)?.note : null] : []), a.unitCount, a.totalInsuredValue, renewalOf(a)]; }) }] }} />
        {stage === "LEAD" && (
          <Link to="/leads/new">
            <button className="primary">+ New lead</button>
          </Link>
        )}
      </div>

      <div className="card" id={stage === 'LEAD' ? `${viewId}-panel` : undefined} role={stage === 'LEAD' ? 'tabpanel' : undefined} aria-labelledby={stage === 'LEAD' ? `${viewId}-${LEAD_VIEWS.indexOf(leadView)}` : undefined}>
        {commercial.error && <p className="error-text" role="alert">{commercial.error} <button onClick={() => void commercial.refetch()}>Retry</button></p>}
        {stage === 'LEAD' && quoteResource.error && <p className="error-text" role="alert">{quoteResource.error} <button onClick={() => void quoteResource.refetch()}>Retry</button></p>}
        {stage === 'LEAD' && <p className="muted small">Commission estimates are for the agency. Client accounts with a selected package still being bound remain here until the package is finished.</p>}
        {loading || stage === 'LEAD' && commercial.loading ? (
          <p className="muted small">Loading…</p>
        ) : error ? (
          <p className="error-text" role="alert">{error} <button onClick={() => void refetchAccounts()}>Retry</button></p>
        ) : stage === 'LEAD' && commercial.error ? (
          <p className="muted small">Retry above to load your leads and follow-up dates.</p>
        ) : sorted.length === 0 ? (
          <p className="muted small">No {label.toLowerCase()} found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Type" colKey="type" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Contact" colKey="contact" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="City" colKey="city" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="State" colKey="state" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  {isAdmin && <SortTh label="Salesperson" colKey="salesperson" sortKey={sortKey} dir={dir} onToggle={toggle} />}
                  {stage === 'LEAD' && <SortTh label="Follow-up" colKey="followUp" sortKey={sortKey} dir={dir} onToggle={toggle} />}
                  {stage === 'LEAD' && <>{[['Lead source','source'],['Website form','form'],['Estimated opportunity','estimate'],['Pending commission','pending']].map(([label,key]) => <SortTh key={key} label={label} colKey={key} sortKey={sortKey} dir={dir} onToggle={toggle} />)}</>}
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
                {sorted.map((a) => {
                  const renewal = renewalOf(a);
                  const contact = contactOf(a);
                  const snooze = snoozeOf(a);
                  const assignment = assignmentOf(a);
                  return (
                    <tr
                      key={a.id}
                      className="clickable"
                      onClick={() => navigate(`/accounts/${a.id}`)}
                    >
                      <td>
                        <strong>{a.name}</strong>
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
                      {isAdmin && <td>{commercial.loading ? 'Loading…' : commercial.error ? 'Unavailable' : stage === 'LEAD' && assignment?.workflowVersion != null ? (
                        <LeadSalespersonSelect
                          onInteractionChange={onInteractionChange}
                          accountId={a.id}
                          accountName={a.name}
                          salespersonId={assignment.salespersonId}
                          workflowVersion={assignment.workflowVersion}
                          team={commercial.data.team}
                          onSaved={workflow => setSavedAssignments(current => (current[a.id]?.workflowVersion ?? -1) >= workflow.version ? current : { ...current, [a.id]: { salespersonId: workflow.salespersonId, workflowVersion: workflow.version } })}
                          onRefresh={commercial.refetch}
                        />
                      ) : assignee(a, 'salespersonId')}</td>}
                      {stage === 'LEAD' && <td>{a.stage === 'LEAD' && snooze ? <LeadSnoozeControl onInteractionChange={onInteractionChange} accountName={a.name} snooze={snooze} today={today} onRefresh={commercial.refetch} onSaved={saved => {
                        setSavedSnoozes(current => (current[a.id]?.version ?? -1) >= saved.version ? current : { ...current, [a.id]: saved });
                        setNotice(saved.followUpOn ? `${a.name} snoozed until ${fmtDate(saved.followUpOn)}.` : `${a.name} is back in Active.`);
                      }} /> : '—'}</td>}
                      {stage === 'LEAD' && <><td>{acquisitionLabel(a.leadSource, a.source)}</td><td>{websiteFormLabel(a.source)}</td><td>{commercial.data.entries[a.id] && !commercial.error ? <OpportunityEstimate onInteractionChange={onInteractionChange} plan={commercial.data.entries[a.id].plan} onSaved={plan => commercial.setData(data => ({ ...data, entries: { ...data.entries, [a.id]: { ...data.entries[a.id], plan } } }))} /> : commercial.error ? 'Unavailable' : 'Loading…'}</td><td>{commercial.loading || quoteResource.loading ? 'Loading…' : commercial.error || quoteResource.error ? 'Unavailable' : <><strong>{forecastOf(a)?.cents == null ? '—' : formatCommission(forecastOf(a)!.cents!)}</strong><div className="muted small">{forecastOf(a)?.label}</div></>}</td></>}
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
            </table>
          </div>
        )}
      </div>
    </>
  );
}
