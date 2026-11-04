import { isOpenLead } from "../lib/dashboardLeads";
import { useIsAdmin } from "../lib/auth";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  fmtDate,
  fmtMoney,
  fmtNum,
  type Account,
  type Contact,
} from "../lib/client";
import { primaryContact } from "../lib/contacts";
import { useAccountsListData } from "../lib/accountsListData";
import { useSort, SortTh } from "../lib/useSort";
import { teammateName } from '../lib/commercial';
import { OpportunityEstimate } from '../components/OpportunityEstimate';
import { AccountSalespersonSelect } from '../components/AccountSalespersonSelect';
import { ReportDownload } from '../components/ReportDownload';
import { LeadSnoozeControl } from '../components/LeadSnoozeControl';
import { leadSnoozeStatus } from '../../../shared/leadSnooze';
import { useAgencyDay } from '../lib/useAgencyDay';
import { useRefreshOnReturn } from '../lib/useRefreshOnReturn';
import { acquisitionLabel, websiteFormLabel } from '../../../shared/leadSource';
import { formatCommission, pendingCommission } from '../../../shared/quotePackages';
import { accountStateCode, LEAD_VIEWS, US_STATE_NAMES, type AccountListStage, type AccountListView, type LeadView } from '../lib/accountListView';
import { useAccountListPosition, useAccountListView } from '../lib/useAccountListView';
import { MAX_NAMED_VIEWS, putNamedAccountView, readNamedAccountViews, writeNamedAccountViews, type NamedAccountView } from '../lib/namedAccountViews';

type AccountsListProps = { stage: 'LEAD' | 'CLIENT'; viewScope?: string };
export default function AccountsList(props: AccountsListProps) {
  const isAdmin = useIsAdmin();
  return <AccountList key={`${props.viewScope ?? 'session'}:${props.stage}:${isAdmin}`} {...props} />;
}

function AccountList({ stage, viewScope }: AccountsListProps) {
  const isAdmin = useIsAdmin();
  const view = useAccountListView(stage, isAdmin, viewScope);
  const { leadView } = view;
  const setLeadView = (leadView: LeadView) => view.update({ leadView });
  const setSalesperson = (salesperson: string) => view.update({ salesperson });
  const [notice, setNotice] = useState('');
  const viewId = useId();
  const navigate = useNavigate();

  const resource = useAccountsListData(stage);
  const { accounts, contacts, policies } = resource.data;
  const { loading, loaded, error, refreshError, refetch: refetchAccounts } = resource;
  const commercial = {
    data: resource.data.commercial,
    refetch: resource.refreshCommercial,
    setData: resource.setCommercial,
  };
  const quoteResource = { data: resource.data.quotes, error: resource.data.quoteError };
  const salespersonAvailable = !loaded || loading || !!error || commercial.data.team.some(teammate => teammate.salesperson && teammate.userId === view.salesperson);
  // A stale shared filter must not leave a hidden selection or an empty work list.
  const salesperson = salespersonAvailable ? view.salesperson : '';
  useEffect(() => {
    if (!salespersonAvailable && view.salesperson) view.update({ salesperson: '' });
  }, [salespersonAvailable, view.salesperson]);
  const currentView = { leadView, salesperson, state: view.state, sortKey: view.sortKey, dir: view.dir };
  useAccountListPosition(view.storageKey, currentView, loaded && !error);
  // Keep authorized rows on screen while checking for changes.
  // Native selects and other row editors still defer focus-triggered refreshes.
  const onInteractionChange = useRefreshOnReturn(refetchAccounts, true, loading);
  const today = useAgencyDay();
  const snoozeOf = (a: Account) => commercial.data.entries[a.id]?.snooze;
  const snoozeStatus = (a: Account) => a.stage === 'LEAD' ? leadSnoozeStatus(snoozeOf(a), today) : 'ACTIVE';
  const forecastOf = (a: Account) => { const plan = commercial.data.entries[a.id]?.plan; return plan ? pendingCommission(plan, quoteResource.data.filter(q => q.accountId === a.id), today) : null; };
  const assignmentOf = (a: Account) => commercial.data.entries[a.id];
  const assignee = (a: Account, role: 'salespersonId') => teammateName(assignmentOf(a)?.[role], commercial.data.team);

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
    && (!isAdmin || !salesperson || assignmentOf(a)?.salespersonId === salesperson)
    && (!view.state || accountStateCode(a.state) === view.state));
  const inView = (a: Account, view: LeadView) => view === 'All leads' || (a.stage === 'CLIENT' || isOpenLead(a, commercial.data.entries)) && (view === 'Snoozed' ? snoozeStatus(a) === 'SNOOZED' : view === 'Follow-up due' ? snoozeStatus(a) === 'DUE' : snoozeStatus(a) !== 'SNOOZED');
  const visible = stage === 'LEAD' ? matching.filter(a => inView(a, leadView)) : matching;
  const dueCount = matching.filter(a => isOpenLead(a, commercial.data.entries) && snoozeStatus(a) === 'DUE').length;

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
    "renewal", "asc", { sortKey: view.sortKey, dir: view.dir, onChange: (sortKey, dir) => view.update({ sortKey, dir }) },
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
          }}>{view}{loaded && !error && <span aria-hidden="true"> ({matching.filter(a => inView(a, view)).length})</span>}</button>)}
      </div>}

      {stage === 'LEAD' && loaded && !error && dueCount > 0 && <div className="lead-follow-up-notice" role="status">
        <p><strong>{dueCount} follow-up{dueCount === 1 ? '' : 's'} due</strong> — ready to contact again.</p>
        {leadView !== 'Follow-up due' && <button className="link" onClick={() => setLeadView('Follow-up due')}>View due leads</button>}
      </div>}
      {stage === 'LEAD' && notice && <p className="muted small" role="status">{notice}</p>}

      <AccountSavedViews storageKey={view.storageKey} current={currentView} stage={stage} admin={isAdmin} onApply={view.update} onReset={view.reset} />

      <div className="toolbar">
        <button className="secondary" disabled={loading} onClick={() => void refetchAccounts()} aria-label={`Refresh ${label.toLowerCase()}`}>{loading && loaded ? 'Refreshing…' : 'Refresh'}</button>
        <label className="field">State<select value={view.state} onChange={event => view.update({ state: event.target.value })}><option value="">All states</option>{Object.entries(US_STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}</select></label>
        {isAdmin && <label className="field">Salesperson<select value={salesperson} onChange={e => setSalesperson(e.target.value)}><option value="">All salespeople</option>{commercial.data.team.filter(t => t.salesperson).map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label>}
        <ReportDownload disabled={loading || !loaded || !!error || !!refreshError || stage === 'LEAD' && !!quoteResource.error} report={{ title: label, filters: [isAdmin ? `Salesperson: ${commercial.data.team.find(t => t.userId === salesperson)?.name ?? 'All'}` : 'All displayed data', ...(stage === 'LEAD' ? [`View: ${leadView}`] : []), ...(view.state ? [`State: ${US_STATE_NAMES[view.state]}`] : [])].join(' · '), sections: [{ title: label, columns: ['Name', 'Type', 'Contact', 'City', 'State', ...(isAdmin ? ['Salesperson'] : []), ...(stage === 'LEAD' ? [ 'Lead source', 'Website form', 'Estimated opportunity (USD)', 'Pending commission (USD)', 'Commission basis', 'Entered', 'Follow-up date', 'Follow-up note'] : []), 'Units', 'TIV (USD)', stage === 'LEAD' ? 'Incumbent expires' : 'Renewal'], rows: sorted.map(a => { const f = forecastOf(a), estimate = commercial.data.entries[a.id]?.plan.estimatedCents; return [a.name, a.type, contactOf(a)?.name, a.city, a.state, ...(isAdmin ? [assignee(a, 'salespersonId')] : []), ...(stage === 'LEAD' ? [ acquisitionLabel(a.leadSource, a.source), websiteFormLabel(a.source), estimate == null ? null : estimate / 100, f?.cents == null ? null : f.cents / 100, f?.label, a.createdAt?.slice(0,10), a.stage === 'LEAD' ? snoozeOf(a)?.followUpOn : null, a.stage === 'LEAD' ? snoozeOf(a)?.note : null] : []), a.unitCount, a.totalInsuredValue, renewalOf(a)]; }) }] }} />
        {stage === "LEAD" && (
          <Link to="/leads/new">
            <button className="primary">+ New lead</button>
          </Link>
        )}
      </div>

      <div className="card" id={stage === 'LEAD' ? `${viewId}-panel` : undefined} role={stage === 'LEAD' ? 'tabpanel' : undefined} aria-labelledby={stage === 'LEAD' ? `${viewId}-${LEAD_VIEWS.indexOf(leadView)}` : undefined}>
        {refreshError && <p className="error-text" role="alert">Some details may be out of date. {refreshError} <button disabled={loading} onClick={() => void refetchAccounts()}>Retry</button></p>}
        {stage === 'LEAD' && quoteResource.error && !refreshError && <p className="error-text" role="alert">{quoteResource.error} <button onClick={() => void refetchAccounts()}>Retry</button></p>}
        {stage === 'LEAD' && <p className="muted small">Commission estimates are for the agency. Client accounts with a selected package still being bound remain here until the package is finished.</p>}
        {!loaded && loading ? (
          <p className="muted small">Loading…</p>
        ) : error ? (
          <p className="error-text" role="alert">{error} <button onClick={() => void refetchAccounts()}>Retry</button></p>
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
                      {isAdmin && <td>{assignment?.workflowVersion != null ? (
                        <AccountSalespersonSelect
                          onInteractionChange={onInteractionChange}
                          accountId={a.id}
                          accountName={a.name}
                          salespersonId={assignment.salespersonId}
                          workflowVersion={assignment.workflowVersion}
                          team={commercial.data.team}
                          onSaved={workflow => commercial.setData(current => {
                            const entry = current.entries[a.id];
                            if (!entry || (entry.workflowVersion ?? -1) >= workflow.version) return current;
                            return { ...current, entries: { ...current.entries, [a.id]: { ...entry, salespersonId: workflow.salespersonId, workflowVersion: workflow.version } } };
                          })}
                          onRefresh={commercial.refetch}
                        />
                      ) : assignee(a, 'salespersonId')}</td>}
                      {stage === 'LEAD' && <td>{a.stage === 'LEAD' && snooze ? <LeadSnoozeControl onInteractionChange={onInteractionChange} accountName={a.name} snooze={snooze} today={today} onRefresh={commercial.refetch} onSaved={saved => {
                        commercial.setData(current => {
                          const entry = current.entries[a.id];
                          if (!entry || (entry.snooze?.version ?? -1) >= saved.version) return current;
                          return { ...current, entries: { ...current.entries, [a.id]: { ...entry, snooze: saved } } };
                        });
                        setNotice(saved.followUpOn ? `${a.name} snoozed until ${fmtDate(saved.followUpOn)}.` : `${a.name} is back in Active.`);
                      }} /> : '—'}</td>}
                      {stage === 'LEAD' && <><td>{acquisitionLabel(a.leadSource, a.source)}</td><td>{websiteFormLabel(a.source)}</td><td>{commercial.data.entries[a.id] ? <OpportunityEstimate onInteractionChange={onInteractionChange} plan={commercial.data.entries[a.id].plan} onSaved={plan => commercial.setData(data => {
                        const entry = data.entries[a.id];
                        if (!entry || entry.plan.version >= plan.version) return data;
                        return { ...data, entries: { ...data.entries, [a.id]: { ...entry, plan } } };
                      })} /> : 'Unavailable'}</td><td>{quoteResource.error ? 'Unavailable' : <><strong>{forecastOf(a)?.cents == null ? '—' : formatCommission(forecastOf(a)!.cents!)}</strong><div className="muted small">{forecastOf(a)?.label}</div></>}</td></>}
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

function AccountSavedViews({ storageKey, current, stage, admin, onApply, onReset }: {
  storageKey: string | null; current: AccountListView; stage: AccountListStage; admin: boolean;
  onApply: (view: AccountListView) => void; onReset: () => void;
}) {
  const [initial] = useState(() => readNamedAccountViews(storageKey, stage, admin));
  const [views, setViews] = useState(initial.views);
  const [selectedId, setSelectedId] = useState(() => initial.views.find(item => JSON.stringify(item.view) === JSON.stringify(current))?.id ?? '');
  const [mode, setMode] = useState<'new' | 'rename' | ''>('');
  const [name, setName] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const selected = views.find(item => item.id === selectedId);
  const modified = !!selected && JSON.stringify(selected.view) !== JSON.stringify(current);
  const custom = current.leadView !== 'Active' || current.salesperson || current.state || current.sortKey !== 'renewal' || current.dir !== 'asc';
  function persist(change: (latest: NamedAccountView[]) => NamedAccountView[]) {
    setError(''); setMessage('');
    try {
      const latest = readNamedAccountViews(storageKey, stage, admin);
      if (!latest.available) throw new Error('Saved views are unavailable in this browser. Your current filters still work in the URL.');
      const next = change(latest.views);
      writeNamedAccountViews(storageKey, next, stage, admin);
      setViews(next);
      return next;
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this view.'); return null; }
  }
  return <section aria-label="Saved account views">
    <div className="toolbar">
      <label className="field">Saved view<select value={selected?.id ?? ''} disabled={!initial.available} onChange={event => {
        const item = views.find(candidate => candidate.id === event.target.value);
        setSelectedId(item?.id ?? ''); setMode(''); setError(''); setMessage('');
        if (item) onApply(item.view);
      }}><option value="">Current view</option>{views.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === selectedId && modified ? ' (modified)' : ''}</option>)}</select></label>
      <button type="button" className="secondary" disabled={!initial.available || views.length >= MAX_NAMED_VIEWS} onClick={() => { setMode('new'); setName(''); setError(''); setMessage(''); }}>Save current view</button>
      {selected && <>
        {modified && <button type="button" className="secondary" onClick={() => {
          if (persist(latest => putNamedAccountView(latest, { id: selected.id, name: latest.find(item => item.id === selected.id)?.name ?? selected.name, view: current }, stage, admin))) setMessage('Saved view updated.');
        }}>Update saved view</button>}
        <button type="button" className="secondary" onClick={() => { setMode('rename'); setName(selected.name); setError(''); setMessage(''); }}>Rename view</button>
        <button type="button" className="secondary" onClick={() => {
          if (persist(latest => latest.filter(item => item.id !== selected.id))) { setSelectedId(''); setMode(''); setMessage('Saved view deleted.'); }
        }}>Delete view</button>
      </>}
      {(custom || selected) && <button type="button" className="secondary" onClick={() => { setSelectedId(''); setMode(''); setError(''); setMessage(''); onReset(); }}>Reset view</button>}
    </div>
    {mode && <form className="toolbar" aria-label={mode === 'rename' ? 'Rename saved view' : 'Save current view'} onSubmit={event => {
      event.preventDefault();
      const next = persist(latest => putNamedAccountView(latest, { ...(mode === 'rename' && selected ? { id: selected.id } : {}), name, view: mode === 'rename' && selected ? latest.find(item => item.id === selected.id)?.view ?? selected.view : current }, stage, admin));
      if (!next) return;
      setSelectedId(mode === 'rename' && selected ? selected.id : next[next.length - 1].id);
      setMode(''); setName(''); setMessage(mode === 'rename' ? 'Saved view renamed.' : 'View saved in this browser.');
    }}>
      <label className="field">View name<input value={name} maxLength={80} onChange={event => { setName(event.target.value); setError(''); }} autoFocus /></label>
      <button type="submit" className="primary">{mode === 'rename' ? 'Save name' : 'Save view'}</button>
      <button type="button" className="secondary" onClick={() => { setMode(''); setError(''); }}>Cancel naming</button>
    </form>}
    {!initial.available && <p className="muted small">Saved views are unavailable in this browser. Current filters still work in the URL.</p>}
    {initial.available && <p className="muted small">Saved views stay in this browser for your current role.{views.length >= MAX_NAMED_VIEWS ? ` You have ${MAX_NAMED_VIEWS} saved views; delete one to add another.` : ''}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {message && <p className="muted small" role="status">{message}</p>}
  </section>;
}
