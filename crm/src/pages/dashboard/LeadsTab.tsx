import { Pagination } from "../../components/ui/kit";
import { useListPage } from "../../lib/useListPage";
import { ReportDownload } from "../../components/ReportDownload";
import { acquisitionLabel, websiteFormLabel } from "../../../../shared/leadSource";
import { useCommercial, teammateName } from '../../lib/commercial';
import { OpportunityEstimate } from '../../components/OpportunityEstimate';
import { formatCommission, pendingCommission } from '../../../../shared/quotePackages';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { useLastContacts } from "../../lib/lastContact";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  listAllPages,
  type Account,
  type Quote,
} from "../../lib/client";
import {
  Badge,
  statusBadge,
  urgencyBadge,
  QUOTE_STATUS_BADGE,
  RENEWAL_HORIZON_SCALE,
} from "../../lib/badges";
import { isOpenQuoteStatus } from "../../lib/quoteStatus";
import { useSort, SortTh } from "../../lib/useSort";
import { useAsyncResource } from "../../lib/useAsyncResource";
import {
  leadFunnel,
  leadQuoteStanding,
  leadStats,
  quoteStandingRank,
  type QuoteStanding,
} from "../../lib/dashboardStats";
import { TabFrame, Tile } from "./common";

interface LeadsData {
  leads: Account[];
  clients: Account[];
  quotes: Quote[];
}

const EMPTY: LeadsData = { leads: [], clients: [], quotes: [] };

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
  salespersonId?: string; championId?: string; salesperson: string; champion: string;
  estimate: number | null; pending: number | null; basis: string; partiallyBound: boolean;
}

export default function LeadsTab() {
  const navigate = useNavigate();
  const [salespersonFilter, setSalespersonFilter] = useState(''), [championFilter, setChampionFilter] = useState('');

  const res = useAsyncResource<LeadsData>(
    async () => {
      // Quotes are read unfiltered, not just the open set: the standing
      // column must tell a declined-everywhere lead apart from an untouched
      // one, and DECLINED/LOST are exactly the rows an open-only filter drops.
      // No web-funnel reads here: LeadReply and UploadPortal rows carry the
      // bearer tokens behind the public upload mutations, and
      // uploadQuota.test.ts pins that no UI depends on reading them —
      // surfacing that activity needs a tokenless aggregate query first.
      const [leads, clients, quotes] = await Promise.all([
        listAllPages((nextToken) =>
          client.models.Account.list({
            filter: { stage: { eq: "LEAD" } },
            nextToken,
          })
        ),
        listAllPages((nextToken) =>
          client.models.Account.list({
            filter: { stage: { eq: "CLIENT" } },
            nextToken,
          })
        ),
        listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
      ]);
      return { leads, clients, quotes };
    },
    [],
    { cacheKey: "report:leads", initialData: EMPTY, errorMessage: "Failed to load the lead pipeline" }
  );
  const { leads, clients, quotes } = res.data;
  const commercial = useCommercial([...leads, ...clients].map(l => l.id), res.data);
  const today = agencyDay(new Date().toISOString());
  const activeLeads = useMemo(() => [...leads, ...clients.filter(l => { const plan = commercial.data.entries[l.id]?.plan; return plan && pendingCommission(plan, quotes.filter(q => q.accountId === l.id), today).unfinished; })], [leads, clients, quotes, commercial.data, today]);
  const contactHistory = useLastContacts(activeLeads.map(l => l.id), res.data);

  const stats = useMemo(
    () => leadStats(leads, clients, new Date()),
    [leads, clients]
  );
  const openQuoteCount = useMemo(
    () => quotes.filter((q) => isOpenQuoteStatus(q.status)).length,
    [quotes]
  );

  const quotesByLead = useMemo(() => {
    const m = new Map<string, Quote[]>();
    for (const q of quotes) {
      const list = m.get(q.accountId);
      if (list) list.push(q);
      else m.set(q.accountId, [q]);
    }
    return m;
  }, [quotes]);

  const funnel = useMemo(
    () => leadFunnel(leads, quotesByLead, clients, new Date()),
    [leads, quotesByLead, clients]
  );

  const rows = useMemo<LeadRow[]>(
    () =>
      activeLeads.map((l) => {
        const entry = commercial.data.entries[l.id], forecast = entry ? pendingCommission(entry.plan, quotesByLead.get(l.id) ?? [], today) : null;
        return ({
        id: l.id,
        name: l.name,
        source: acquisitionLabel(l.leadSource, l.source),
        lastContact: contactHistory.contacts[l.id]?.at ?? null,
        entered: l.createdAt ?? null,
        expires: l.currentPolicyExpiration ?? null,
        days: l.currentPolicyExpiration ? daysUntil(l.currentPolicyExpiration) : null,
        standing: leadQuoteStanding(quotesByLead.get(l.id) ?? []),
        tiv: l.totalInsuredValue ?? null,
        city: l.city ?? null, state: l.state ?? null, form: websiteFormLabel(l.source),
        salespersonId: entry?.salespersonId, championId: entry?.championId,
        salesperson: teammateName(entry?.salespersonId, commercial.data.team), champion: teammateName(entry?.championId, commercial.data.team),
        estimate: entry?.plan.estimatedCents ?? null, pending: forecast?.cents ?? null, basis: forecast?.label ?? 'No package options', partiallyBound: l.stage === 'CLIENT',
      }); }).filter(r => (!salespersonFilter || r.salespersonId === salespersonFilter) && (!championFilter || r.championId === championFilter)),
    [activeLeads, quotesByLead, contactHistory.contacts, commercial.data, today, salespersonFilter, championFilter]
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
      salesperson: r => r.salesperson, champion: r => r.champion, city: r => r.city, state: r => r.state, form: r => r.form, estimate: r => r.estimate, pending: r => r.pending,
    },
    "expires"
  );

  const stageMax = Math.max(
    1,
    funnel.unworked,
    funnel.marketing,
    funnel.presented,
    funnel.bound30d
  );
  const stages: [string, number][] = [
    ["No quotes yet", funnel.unworked],
    ["Marketing · draft/submitted", funnel.marketing],
    ["Presented", funnel.presented],
    ["Bound · last 30d", funnel.bound30d],
  ];

  const page = useListPage(sorted, `${salespersonFilter}:${championFilter}:${sortKey}:${dir}`);
  return (
    <TabFrame res={res}>
      <div className="report-actions"><ReportDownload report={{ title: "Lead summary", sections: [{ title: "Lead summary", columns: ["Measure", "Value"], rows: [["New this week", stats.newThisWeek], ["Open leads", leads.length], ["Quotes in flight", openQuoteCount], ["Converted this quarter", stats.convertedThisQuarter], ["Median days to convert", stats.medianDaysToConvert]] }] }} /></div>
      <div className="stat-row">
        <Tile n={stats.newThisWeek} label="New this week" />
        <Tile n={leads.length} label="Open leads" onClick={() => navigate("/leads")} />
        <Tile
          n={openQuoteCount}
          label="Quotes in flight"
          onClick={() => navigate("/quotes")}
        />
        <Tile n={stats.convertedThisQuarter} label="Converted this quarter" />
        <Tile
          n={stats.medianDaysToConvert == null ? "—" : `${stats.medianDaysToConvert}d`}
          label="Median days to convert"
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Pipeline</h2>
          <ReportDownload report={{ title: "Lead pipeline", filters: "Stage inferred from quotes; bound in the last 30 days", sections: [{ title: "Pipeline", columns: ["Stage", "Leads"], rows: stages }] }} />
          <span className="muted small">stage inferred from each lead's quotes</span>
        </div>
        <div className="funnel">
          {stages.map(([label, n]) => (
            <div className="stage" key={label}>
              <div className="n">{n}</div>
              <div className="l">{label}</div>
              <span
                className="fill"
                style={{ width: `${Math.max(4, (n / stageMax) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Lead work list</h2>
          <ReportDownload disabled={contactHistory.loading || !!contactHistory.error || commercial.loading || !!commercial.error} report={{ title: "Lead work list", filters: `Open leads and packages being bound · sorted by ${sortKey} (${dir}) · Salesperson: ${commercial.data.team.find(t => t.userId === salespersonFilter)?.name ?? 'All'} · Champion: ${commercial.data.team.find(t => t.userId === championFilter)?.name ?? 'All'}`, sections: [{ title: "Leads", columns: ["Lead", "Salesperson", "Deal champion", "City", "State", "Lead source", "Website form", "Estimated opportunity (USD)", "Pending commission (USD)", "Commission basis", "Last contact (local)", "Entered", "Incumbent expires", "Pipeline", "Quote count", "TIV (USD)"], rows: sorted.map(r => [r.name, r.salesperson, r.champion, r.city, r.state, r.source, r.form, r.estimate == null ? null : r.estimate / 100, r.pending == null ? null : r.pending / 100, r.basis, r.lastContact ? fmtDateTime(r.lastContact) : "No contact recorded", r.entered?.slice(0, 10), r.expires, r.standing?.status ?? "No quotes yet", r.standing?.count ?? 0, r.tiv]) }] }} />
          <span className="muted small">sorted by incumbent expiration</span>
        </div>
        <p className="muted small">Last contact includes prospect emails, calls and texts in either direction. Times are shown in your local time zone.</p>
        <div className="toolbar"><label className="field">Salesperson<select value={salespersonFilter} onChange={e => setSalespersonFilter(e.target.value)}><option value="">All salespeople</option>{commercial.data.team.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label><label className="field">Deal champion<select value={championFilter} onChange={e => setChampionFilter(e.target.value)}><option value="">All champions</option>{commercial.data.team.map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select></label></div>
        {commercial.error && <p className="error-text" role="alert">{commercial.error} <button onClick={() => void commercial.refetch()}>Retry</button></p>}
        {contactHistory.error && <p className="error-text">{contactHistory.error}</p>}
        {rows.length === 0 ? (
          <p className="muted small">
            No open leads. New leads land here from the website form or New
            lead.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <SortTh label="Lead" colKey="lead" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  {([['Salesperson','salesperson'],['Deal champion','champion'],['City','city'],['State','state'],['Website form','form'],['Estimated opportunity','estimate'],['Pending commission','pending']] as const).map(([label,key]) => <SortTh key={key} label={label} colKey={key} sortKey={sortKey} dir={dir} onToggle={toggle} />)}
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
                {page.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/accounts/${r.id}`}>{r.name}</Link>
                      {r.partiallyBound && <div><span className="badge amber">Binding in progress</span></div>}
                    </td>
                    <td>{commercial.loading ? 'Loading…' : commercial.error ? 'Unavailable' : r.salesperson}</td><td>{commercial.loading ? 'Loading…' : commercial.error ? 'Unavailable' : r.champion}</td><td>{r.city || '—'}</td><td>{r.state || '—'}</td><td>{r.form}</td>
                    <td>{commercial.data.entries[r.id] && !commercial.error ? <OpportunityEstimate plan={commercial.data.entries[r.id].plan} onSaved={plan => commercial.setData(data => ({ ...data, entries: { ...data.entries, [r.id]: { ...data.entries[r.id], plan } } }))} /> : commercial.error ? 'Unavailable' : 'Loading…'}</td>
                    <td>{commercial.loading ? 'Loading…' : commercial.error ? 'Unavailable' : <><strong>{r.pending == null ? '—' : formatCommission(r.pending)}</strong><div className="muted small">{r.basis}</div></>}</td>
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
            <Pagination total={sorted.length} page={page.page} onPage={page.setPage} noun="leads" />
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
