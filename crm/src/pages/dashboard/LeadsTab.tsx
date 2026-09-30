import { ReportDownload } from "../../components/ReportDownload";
import { acquisitionLabel, websiteFormLabel } from "../../../../shared/leadSource";
import { loadCommercial, teammateName, type CommercialData } from '../../lib/commercial';
import { EMPTY_LEADS_DATA, loadDashboardAccountQuotes, loadLeadsDashboard, type CompactQuote } from '../../lib/dashboardLeadData';
import { unfinishedSelectedPackage } from '../../../../shared/dashboardLeadSelection';
import { salespersonKey, salespersonSeries } from '../../lib/dashboardPeople';
import { activeLeadQuotes, isOpenLead, leadPersonMetrics, PIPELINE_SERIES } from '../../lib/dashboardLeads';
import { StackedBars, type ChartRow, type ChartSeries } from '../../components/StackedBars';
import { OpportunityEstimate } from '../../components/OpportunityEstimate';
import { formatCommission, pendingCommission } from '../../../../shared/quotePackages';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { useLastContacts } from "../../lib/lastContact";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  daysUntil,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  type Quote,
} from "../../lib/client";
import {
  Badge,
  statusBadge,
  urgencyBadge,
  QUOTE_STATUS_BADGE,
  RENEWAL_HORIZON_SCALE,
} from "../../lib/badges";
import { useSort, SortTh } from "../../lib/useSort";
import { useAsyncResource } from "../../lib/useAsyncResource";
import {
  leadQuoteStanding,
  quoteStandingRank,
  type QuoteStanding,
} from "../../lib/dashboardStats";
import { TabFrame } from "./common";

interface LeadRow {
  id: string;
  name: string;
  source: string | null;
  lastContact: string | null;
  /** ISO datetime — when the lead entered the pipeline. */
  entered: string | null;
  /** Incumbent policy expiration, the sales clock for HOA business. */
  expires: string | null;
  days: number | null;
  standing: QuoteStanding | null;
  tiv: number | null;
  city: string | null; state: string | null; form: string;
  salespersonId?: string; salesperson: string;
  estimate: number | null; pending: number | null; basis: string; partiallyBound: boolean;
}

export default function LeadsTab() {
  const navigate = useNavigate();
  const [salespersonFilter, setSalespersonFilter] = useState('');

  const res = useAsyncResource(loadLeadsDashboard, [], {
    initialData: EMPTY_LEADS_DATA, errorMessage: "Failed to load the lead pipeline",
  });
  const { leads, clients, quotes, policies, commercial, selections, asOf } = res.data;
  const now = useMemo(() => new Date(asOf || Date.now()), [asOf]);
  const today = agencyDay(now.toISOString());
  const people = useMemo(() => salespersonSeries(commercial), [commercial]);
  const salespersonSelection = people.some(person => person.key === salespersonFilter) ? salespersonFilter : '';

  const quotesByLead = useMemo(() => {
    const m = new Map<string, CompactQuote[]>();
    for (const q of quotes) {
      const list = m.get(q.accountId);
      if (list) list.push(q);
      else m.set(q.accountId, [q]);
    }
    return m;
  }, [quotes]);

  const activeLeads = useMemo(() => [
    ...leads.filter(account => isOpenLead(account, commercial.entries)),
    ...clients.filter(account => unfinishedSelectedPackage(selections[account.id], quotesByLead.get(account.id) ?? [])),
  ], [leads, clients, commercial, selections, quotesByLead]);
  const selectedLeads = useMemo(() => salespersonSelection
    ? activeLeads.filter(account => salespersonKey(account.id, commercial.entries) === salespersonSelection)
    : [], [activeLeads, commercial, salespersonSelection]);
  const worklistKey = `${asOf}:${salespersonSelection}:${selectedLeads.map(account => account.id).sort().join(',')}`;
  const worklist = useAsyncResource<{ key: string; snapshot: typeof res.data | null; commercial: CommercialData; quotes: Quote[] }>(async () => {
    if (!salespersonSelection) return { key: worklistKey, snapshot: res.data, commercial: { entries: {}, team: [] }, quotes: [] };
    const ids = selectedLeads.map(account => account.id);
    const [commercial, quotes] = await Promise.all([
      loadCommercial(ids), loadDashboardAccountQuotes(ids, true),
    ]);
    return { key: worklistKey, snapshot: res.data, commercial, quotes };
  }, [worklistKey, res.data], { initialData: { key: '', snapshot: null, commercial: { entries: {}, team: [] }, quotes: [] }, errorMessage: 'Could not load lead work details' });
  const worklistReady = worklist.loaded && worklist.data.key === worklistKey && worklist.data.snapshot === res.data && !worklist.error;
  const worklistLeads = useMemo(() => worklistReady ? selectedLeads.filter(account =>
    salespersonKey(account.id, worklist.data.commercial.entries) === salespersonSelection
  ) : [], [worklistReady, selectedLeads, worklist.data, salespersonSelection]);
  const worklistQuotes = useMemo(() => {
    const byAccount = new Map<string, Quote[]>();
    for (const quote of worklist.data.quotes) {
      const current = byAccount.get(quote.accountId) ?? [];
      current.push(quote); byAccount.set(quote.accountId, current);
    }
    return byAccount;
  }, [worklist.data.quotes]);
  const contactHistory = useLastContacts(worklistLeads.map(account => account.id), res.data);
  const metrics = useMemo(() => leadPersonMetrics({
    accounts: [...leads, ...clients], quotes, policies, pipelineAccounts: activeLeads,
    entries: commercial.entries, series: people, now, selections,
  }), [leads, clients, quotes, policies, activeLeads, commercial, people, now, selections]);

  const rows = useMemo<LeadRow[]>(
    () =>
      worklistLeads.map((l) => {
        const entry = worklist.data.commercial.entries[l.id], forecast = entry ? pendingCommission(entry.plan, worklistQuotes.get(l.id) ?? [], today) : null;
        return ({
        id: l.id,
        name: l.name,
        source: acquisitionLabel(l.leadSource, l.source),
        lastContact: contactHistory.contacts[l.id]?.at ?? null,
        entered: l.createdAt ?? null,
        expires: l.currentPolicyExpiration ?? null,
        days: l.currentPolicyExpiration ? daysUntil(l.currentPolicyExpiration) : null,
        standing: leadQuoteStanding(activeLeadQuotes(worklistQuotes.get(l.id) ?? [], worklist.data.commercial.entries)),
        tiv: l.totalInsuredValue ?? null,
        city: l.city ?? null, state: l.state ?? null, form: websiteFormLabel(l.source),
        salespersonId: entry?.salespersonId,
        salesperson: teammateName(entry?.salespersonId, worklist.data.commercial.team),
        estimate: entry?.plan.estimatedCents ?? null, pending: forecast?.cents ?? null, basis: forecast?.label ?? 'No package options', partiallyBound: l.stage === 'CLIENT',
      }); }),
    [worklistLeads, worklistQuotes, contactHistory.contacts, worklist.data, today]
  );

  // Soonest incumbent expiration first: the lead about to renew with someone
  // else is the one to call today.
  const { sorted, sortKey, dir, toggle } = useSort(
    rows,
    {
      lead: (r) => r.name,
      source: (r) => r.source,
      entered: (r) => r.entered,
      lastContact: (r) => r.lastContact,
      expires: (r) => r.expires,
      // Ranked, not alphabetized: this column encodes a progression, and
      // "DECLINED between BOUND and DRAFT" is what sorting the raw status
      // strings would say.
      pipeline: (r) => quoteStandingRank(r.standing),
      tiv: (r) => r.tiv,
      salesperson: r => r.salesperson, city: r => r.city, state: r => r.state, form: r => r.form, estimate: r => r.estimate, pending: r => r.pending,
    },
    "expires"
  );

  return (
    <TabFrame res={res}>
      <p className="muted small">Figures use each account's current salesperson. The last 30 days end at this refresh.</p>
      <div className="dashboard-chart-grid">
        <LeadChart title="Open leads per person" rows={metrics.open} series={people} note="Current leads, excluding lost, disqualified and bound accounts." />
        <LeadChart title="Quotes in flight per person" rows={metrics.quotes} series={people} note="Draft, submitted, quoted and presented quotes; excludes unselected package alternatives and lost or disqualified accounts." />
        <LeadChart title="New leads per person · last 30 days" rows={metrics.created} series={people} note="Based on account creation; includes current leads and clients with a recorded conversion." />
        <LeadChart title="Policies bound per person · last 30 days" rows={metrics.binds} series={people} note="Based on the recorded bind date. Policies without a bind date are excluded." />
      </div>
      <LeadChart title="Pipeline per person" rows={metrics.pipeline} series={PIPELINE_SERIES} note="Open leads and packages being bound, grouped by their most advanced open quote. Closed quotes remain visible until the lead is closed." />

      <div className="card">
        <div className="card-head">
          <h2>Lead work list</h2>
          <ReportDownload disabled={!salespersonSelection || !worklistReady || worklist.loading || contactHistory.loading || !!contactHistory.error} report={{ title: "Lead work list", filters: `Open leads and packages being bound · sorted by ${sortKey} (${dir}) · Salesperson: ${people.find(person => person.key === salespersonSelection)?.label ?? 'Choose a salesperson'}`, sections: [{ title: "Leads", columns: ["Lead", "Salesperson", "City", "State", "Lead source", "Website form", "Estimated opportunity (USD)", "Pending commission (USD)", "Commission basis", "Last contact (local)", "Entered", "Incumbent expires", "Pipeline", "Quote count", "TIV (USD)"], rows: sorted.map(r => [r.name, r.salesperson, r.city, r.state, r.source, r.form, r.estimate == null ? null : r.estimate / 100, r.pending == null ? null : r.pending / 100, r.basis, r.lastContact ? fmtDateTime(r.lastContact) : "No contact recorded", r.entered?.slice(0, 10), r.expires, r.standing?.status ?? "Unworked", r.standing?.count ?? 0, r.tiv]) }] }} />
          <span className="muted small">sorted by incumbent expiration</span>
        </div>
        <p className="muted small">Last contact includes prospect emails, calls and texts in either direction. Times are shown in your local time zone.</p>
        <div className="toolbar"><label className="field">Salesperson<select required value={salespersonSelection} onChange={e => setSalespersonFilter(e.target.value)}><option value="">Choose a salesperson</option>{people.map(person => <option key={person.key} value={person.key}>{person.label}</option>)}</select></label></div>
        {salespersonSelection && worklist.error && <p className="error-text" role="alert">{worklist.error} <button onClick={() => void worklist.refetch()}>Retry lead details</button></p>}
        {contactHistory.error && <p className="error-text">{contactHistory.error}</p>}
        {!salespersonSelection ? <p className="muted">Choose a salesperson to view their lead work list.</p> : !worklistReady ? <p className="muted small">{worklist.error ? "Lead details are unavailable." : "Loading lead details…"}</p> : rows.length === 0 ? (
          <p className="muted small">No open leads or packages being bound for this salesperson.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Lead" colKey="lead" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  {([['Salesperson','salesperson'],['City','city'],['State','state'],['Website form','form'],['Estimated opportunity','estimate'],['Pending commission','pending']] as const).map(([label,key]) => <SortTh key={key} label={label} colKey={key} sortKey={sortKey} dir={dir} onToggle={toggle} />)}
                  <SortTh label="Source" colKey="source" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Last contact" colKey="lastContact" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Entered" colKey="entered" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Incumbent expires" colKey="expires" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th></th>
                  <SortTh label="Pipeline" colKey="pipeline" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="TIV" colKey="tiv" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${r.id}`)}
                  >
                    <td>
                      <strong>{r.name}</strong>
                      {r.partiallyBound && <div><span className="badge amber">Binding in progress</span></div>}
                    </td>
                    <td>{r.salesperson}</td><td>{r.city || '—'}</td><td>{r.state || '—'}</td><td>{r.form}</td>
                    <td>{worklist.data.commercial.entries[r.id] ? <OpportunityEstimate plan={worklist.data.commercial.entries[r.id].plan} onSaved={plan => worklist.setData(data => ({ ...data, commercial: { ...data.commercial, entries: { ...data.commercial.entries, [r.id]: { ...data.commercial.entries[r.id], plan } } } }))} /> : 'Unavailable'}</td>
                    <td><strong>{r.pending == null ? '—' : formatCommission(r.pending)}</strong><div className="muted small">{r.basis}</div></td>
                    <td>{r.source || "—"}</td>
                    <td>{contactHistory.loading ? "Loading…" : contactHistory.error ? "Unavailable" : r.lastContact ? fmtDateTime(r.lastContact) : "No contact recorded"}</td>
                    <td>{fmtDate(r.entered?.slice(0, 10))}</td>
                    <td>{fmtDate(r.expires ?? undefined)}</td>
                    <td className="days-badge">
                      {r.expires && (
                        <Badge {...urgencyBadge(r.days, RENEWAL_HORIZON_SCALE)} />
                      )}
                    </td>
                    <td>
                      <StandingBadge standing={r.standing} />
                    </td>
                    <td>{r.tiv == null ? "—" : fmtMoney(r.tiv)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </TabFrame>
  );
}

/** The lead's quote standing as a pill, counted when more than one quote
 * sits at the top rung — "2 × SUBMITTED" is different news from one. */
function StandingBadge({ standing }: { standing: QuoteStanding | null }) {
  if (!standing) return <Badge cls="gray" label="No quotes" />;
  const spec = statusBadge(QUOTE_STATUS_BADGE, standing.status);
  return (
    <Badge
      cls={spec.cls}
      label={standing.count > 1 ? `${standing.count} × ${spec.label}` : spec.label}
    />
  );
}

function LeadChart({ title, rows, series, note }: { title: string; rows: ChartRow[]; series: ChartSeries[]; note: string }) {
  return <section className="card">
    <div className="card-head"><h2>{title}</h2><ReportDownload report={{ title, filters: note, sections: [{ title, columns: ['Salesperson', ...series.map(person => person.label)], rows: rows.map(row => [row.label, ...series.map(person => row.values[person.key] ?? 0)]) }] }} /></div>
    <p className="muted small">{note}</p>
    <StackedBars label={title} rows={rows} series={series} formatValue={value => value.toLocaleString()} />
  </section>;
}
