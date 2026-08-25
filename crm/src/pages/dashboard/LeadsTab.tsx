import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
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
  /** ISO datetime — when the lead entered the pipeline. */
  entered: string | null;
  /** Incumbent policy expiration, the sales clock for HOA business. */
  expires: string | null;
  days: number | null;
  standing: QuoteStanding | null;
  tiv: number | null;
}

export default function LeadsTab() {
  const navigate = useNavigate();

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
    { initialData: EMPTY, errorMessage: "Failed to load the lead pipeline" }
  );
  const { leads, clients, quotes } = res.data;

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
      leads.map((l) => ({
        id: l.id,
        name: l.name,
        source: l.source ?? null,
        entered: l.createdAt ?? null,
        expires: l.currentPolicyExpiration ?? null,
        days: l.currentPolicyExpiration ? daysUntil(l.currentPolicyExpiration) : null,
        standing: leadQuoteStanding(quotesByLead.get(l.id) ?? []),
        tiv: l.totalInsuredValue ?? null,
      })),
    [leads, quotesByLead]
  );

  // Soonest incumbent expiration first: the lead about to renew with someone
  // else is the one to call today.
  const { sorted, sortKey, dir, toggle } = useSort(
    rows,
    {
      lead: (r) => r.name,
      source: (r) => r.source,
      entered: (r) => r.entered,
      expires: (r) => r.expires,
      // Ranked, not alphabetized: this column encodes a progression, and
      // "DECLINED between BOUND and DRAFT" is what sorting the raw status
      // strings would say.
      pipeline: (r) => quoteStandingRank(r.standing),
      tiv: (r) => r.tiv,
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
    ["Unworked · no quotes", funnel.unworked],
    ["Marketing · draft/submitted", funnel.marketing],
    ["Presented", funnel.presented],
    ["Bound · last 30d", funnel.bound30d],
  ];

  return (
    <TabFrame res={res}>
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
          <span className="muted small">sorted by incumbent expiration</span>
        </div>
        {rows.length === 0 ? (
          <p className="muted small">
            No open leads. New leads land here from the website form or New
            lead.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Lead" colKey="lead" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Source" colKey="source" sortKey={sortKey} dir={dir} onToggle={toggle} />
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
                    </td>
                    <td>{r.source || "—"}</td>
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

