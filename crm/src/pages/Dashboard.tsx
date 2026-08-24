import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  daysUntil,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Carrier,
  type Policy,
  type Quote,
} from "../lib/client";
import {
  Badge,
  statusBadge,
  urgencyBadge,
  ACCOUNT_STAGE_BADGE,
  RENEWAL_HORIZON_SCALE,
} from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";
import { openQuoteStatusFilter } from "../lib/quoteStatus";
import { useAsyncResource } from "../lib/useAsyncResource";
import {
  commissionBySource,
  policyCommission,
  receivables,
  type Receivables,
} from "../lib/dashboardStats";
import type { Schema } from "../../amplify/data/resource";

type PfLoanRow = Schema["PfLoan"]["type"];
type InvoiceRow = Schema["Invoice"]["type"];

/** Every slice the dashboard renders, read in one pass. */
interface DashboardData {
  leads: Account[];
  clients: Account[];
  openQuotes: Quote[];
  policies: Policy[];
  carriers: Carrier[];
  openTasks: number;
  /** SENT + PROCESSING only — the A/R slice, org-wide. */
  openInvoices: InvoiceRow[];
  pfLoans: PfLoanRow[];
}

const EMPTY: DashboardData = {
  leads: [],
  clients: [],
  openQuotes: [],
  policies: [],
  carriers: [],
  openTasks: 0,
  openInvoices: [],
  pfLoans: [],
};

export default function Dashboard() {
  const navigate = useNavigate();

  /**
   * One resource, not six.
   *
   * These were six independent `.then(setX)` chains with no error state, so a
   * failed read left its slice at zero and the page rendered a complete,
   * plausible, all-zero dashboard — indistinguishable from a brand-new agency.
   * Every tile and both cards read from this one machine, so there is now
   * exactly one answer to "did the numbers arrive".
   *
   * `Promise.all` fails fast, so one bad query blanks the page rather than
   * showing the slices that worked. That is the trade: a partial dashboard
   * cannot say which half of itself is real.
   */
  const res = useAsyncResource<DashboardData>(
    async () => {
      const [leads, clients, openQuotes, policies, carriers, tasks, openInvoices, pfLoans] =
        await Promise.all([
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
          listAllPages((nextToken) =>
            client.models.Quote.list({
              filter: openQuoteStatusFilter(),
              nextToken,
            })
          ),
          // Paginated like everything else: a single page silently caps the
          // "policies bound" count and every chart at ~100 rows.
          listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
          listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
          listAllPages((nextToken) =>
            client.models.MarketingTask.list({
              filter: { status: { eq: "OPEN" } },
              limit: 500,
              nextToken,
            })
          ),
          // The A/R slice: money billed and not yet collected.
          listAllPages((nextToken) =>
            client.models.Invoice.list({
              filter: { or: [{ status: { eq: "SENT" } }, { status: { eq: "PROCESSING" } }] },
              nextToken,
            })
          ),
          listAllPages((nextToken) => client.models.PfLoan.list({ nextToken })),
        ]);
      return {
        leads,
        clients,
        openQuotes,
        policies,
        carriers,
        // Only the count is rendered; the rows are not worth holding.
        openTasks: tasks.length,
        openInvoices: openInvoices as InvoiceRow[],
        pfLoans: pfLoans as PfLoanRow[],
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load the dashboard" }
  );
  const { leads, clients, openQuotes, policies, carriers, openTasks, openInvoices, pfLoans } =
    res.data;

  // Heading first, then one gate over everything derived from the read — the
  // tiles and both cards are all statements about the data, and none of them
  // can be made until it has arrived.
  if (!res.loaded || res.error) {
    return (
      <>
        <h1>Dashboard</h1>
        <p className="sub">Pipeline at a glance</p>
        {res.error ? (
          <p className="error-text">{res.error}</p>
        ) : (
          <p className="muted small">Loading…</p>
        )}
      </>
    );
  }

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Pipeline at a glance</p>

      <div className="stat-row">
        <Tile n={leads.length} label="Open leads" onClick={() => navigate("/leads")} />
        <Tile n={clients.length} label="Clients" onClick={() => navigate("/clients")} />
        <Tile
          n={openQuotes.length}
          label="Quotes in flight"
          onClick={() => navigate("/quotes")}
        />
        <Tile
          n={policies.length}
          label="Policies bound"
          onClick={() => navigate("/policies")}
        />
        <Tile
          n={openTasks}
          label="Open tasks"
          onClick={() => navigate("/tasks")}
        />
      </div>

      <ReceivablesCard r={receivables(openInvoices, pfLoans)} />
      <RenewalsCard leads={leads} clients={clients} policies={policies} />
      <CarrierCharts
        policies={policies}
        carriers={carriers}
        accounts={[...leads, ...clients]}
      />
    </>
  );
}

/**
 * What the world owes the agency right now — two honest buckets, no netting:
 * invoices the association was asked to pay and hasn't, and financed
 * principal outstanding on loans money has touched.
 */
function ReceivablesCard({ r }: { r: Receivables }) {
  return (
    <div className="card">
      <h2>Accounts receivable</h2>
      <div className="stat-row">
        <div className="stat">
          <div className="n">{fmtMoney(r.invoiceTotal)}</div>
          <div className="l">
            Billed &amp; uncollected · {r.invoiceCount}{" "}
            {r.invoiceCount === 1 ? "invoice" : "invoices"}
          </div>
        </div>
        <div className="stat">
          <div className="n">{fmtMoney(r.loanTotal)}</div>
          <div className="l">
            Financed principal outstanding · {r.loanCount}{" "}
            {r.loanCount === 1 ? "loan" : "loans"}
          </div>
        </div>
        <div className="stat">
          <div className="n">{fmtMoney(r.invoiceTotal + r.loanTotal)}</div>
          <div className="l">Total receivable</div>
        </div>
      </div>
      {r.invoiceUnpriced > 0 && (
        <p className="muted small">
          {r.invoiceUnpriced} open{" "}
          {r.invoiceUnpriced === 1 ? "invoice carries" : "invoices carry"} no
          stored amount and {r.invoiceUnpriced === 1 ? "is" : "are"} not in the
          total — open {r.invoiceUnpriced === 1 ? "it" : "them"} from the
          account to see the figure.
        </p>
      )}
    </div>
  );
}

function Tile({ n, label, onClick }: { n: number; label: string; onClick: () => void }) {
  return (
    <div
      className="stat clickable"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

// ── Upcoming renewals: client policies + lead incumbent expirations ────

interface RenewalRow {
  accountId: string;
  name: string;
  kind: "CLIENT" | "LEAD";
  date: string; // YYYY-MM-DD
  days: number;
  detail: string;
}

function RenewalsCard({
  leads,
  clients,
  policies,
}: {
  leads: Account[];
  clients: Account[];
  policies: Policy[];
}) {
  const [horizon, setHorizon] = useState<30 | 60 | 90>(90);
  const navigate = useNavigate();

  const rows = useMemo(() => {
    const out: RenewalRow[] = [];
    const clientById = new Map(clients.map((c) => [c.id, c]));

    // A date `daysUntil` can't read is dropped rather than carried as a row
    // with no number in it. The local `daysUntil` this replaced returned NaN
    // there, and `NaN <= horizon` is false, so such a row never reached the
    // table under either version.
    for (const p of policies) {
      if (p.status !== "ACTIVE" || !p.expirationDate) continue;
      const acct = clientById.get(p.accountId);
      if (!acct) continue;
      const days = daysUntil(p.expirationDate);
      if (days == null) continue;
      out.push({
        accountId: acct.id,
        name: acct.name,
        kind: "CLIENT",
        date: p.expirationDate,
        days,
        detail: `Policy ${p.policyNumber || "—"} · ${(p.lines ?? []).filter(Boolean).join(", ") || "—"}`,
      });
    }
    for (const l of leads) {
      if (!l.currentPolicyExpiration) continue;
      const days = daysUntil(l.currentPolicyExpiration);
      if (days == null) continue;
      out.push({
        accountId: l.id,
        name: l.name,
        kind: "LEAD",
        date: l.currentPolicyExpiration,
        days,
        detail: "Incumbent policy expires",
      });
    }
    return out.filter((r) => r.days <= horizon);
  }, [leads, clients, policies, horizon]);

  const within = (d: number) => rows.filter((r) => r.days <= d && r.days >= 0).length;

  // Soonest renewal first — the work that's most at risk floats up.
  const { sorted, sortKey, dir, toggle } = useSort(
    rows,
    {
      account: (r) => r.name,
      renewal: (r) => r.date,
      days: (r) => r.days,
      detail: (r) => r.detail,
    },
    "days"
  );

  return (
    <div className="card">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Upcoming renewals</h2>
        <div className="grow" />
        <div className="chip-row">
          {([30, 60, 90] as const).map((d) => (
            <button
              key={d}
              className={horizon === d ? "on" : ""}
              onClick={() => setHorizon(d)}
            >
              {d}d · {within(d)}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="muted small">
          Nothing renewing in the next {horizon} days. Lead renewal dates come
          from "Current policy expiration" (set manually or via AI extraction).
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <th></th>
                <SortTh label="Renewal" colKey="renewal" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Days" colKey="days" sortKey={sortKey} dir={dir} onToggle={toggle} />
                <SortTh label="Detail" colKey="detail" sortKey={sortKey} dir={dir} onToggle={toggle} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr
                  key={`${r.accountId}-${i}`}
                  className="clickable"
                  onClick={() => navigate(`/accounts/${r.accountId}`)}
                >
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td>
                    <Badge {...statusBadge(ACCOUNT_STAGE_BADGE, r.kind)} />
                  </td>
                  <td>{fmtDate(r.date)}</td>
                  <td className="days-badge">
                    <Badge {...urgencyBadge(r.days, RENEWAL_HORIZON_SCALE)} />
                  </td>
                  <td className="small muted">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Premium & commission by carrier (shared date filter) ───────────────

type Preset = "all" | "ytd" | "12mo";

function CarrierCharts({
  policies,
  carriers,
  accounts,
}: {
  policies: Policy[];
  carriers: Carrier[];
  /** Every account, both stages — the lead-source chart joins through them. */
  accounts: Account[];
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  function applyPreset(p: Preset) {
    setPreset(p);
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (p === "all") {
      setFrom("");
      setTo("");
    } else if (p === "ytd") {
      setFrom(`${today.getFullYear()}-01-01`);
      setTo(iso(today));
    } else {
      const start = new Date(today);
      start.setFullYear(start.getFullYear() - 1);
      setFrom(iso(start));
      setTo(iso(today));
    }
  }

  const filtered = useMemo(
    () =>
      policies.filter((p) => {
        const d = p.effectiveDate;
        if (from && (!d || d < from)) return false;
        if (to && (!d || d > to)) return false;
        return true;
      }),
    [policies, from, to]
  );

  const rowsFor = (value: (p: Policy) => number) => {
    const byCarrier = new Map<string, { total: number; count: number }>();
    for (const p of filtered) {
      const key = p.carrierId ?? "unassigned";
      const cur = byCarrier.get(key) ?? { total: 0, count: 0 };
      cur.total += value(p);
      cur.count += 1;
      byCarrier.set(key, cur);
    }
    return [...byCarrier.entries()]
      .map(([key, agg]) => ({
        key,
        name:
          key === "unassigned"
            ? "Unassigned"
            : carriers.find((c) => c.id === key)?.name ?? "Unknown carrier",
        ...agg,
      }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);
  };

  const premiumRows = useMemo(() => rowsFor((p) => p.premium ?? 0), [filtered, carriers]);
  const commissionRows = useMemo(
    () => rowsFor(policyCommission),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, carriers]
  );
  // Same commission dollars, cut by where the account came from instead of
  // who wrote the paper — the answer to "which lead source pays for itself".
  const sourceRows = useMemo(
    () => commissionBySource(filtered, accounts),
    [filtered, accounts]
  );

  return (
    <>
      <div className="card">
        <h2>Production by carrier</h2>
        <div className="filter-row">
          <div className="field">
            <label>Effective from</label>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPreset("all");
              }}
            />
          </div>
          <div className="field">
            <label>Effective to</label>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPreset("all");
              }}
            />
          </div>
          <div className="preset-btns">
            {(
              [
                ["all", "All time"],
                ["ytd", "YTD"],
                ["12mo", "Last 12 mo"],
              ] as [Preset, string][]
            ).map(([p, label]) => (
              <button
                key={p}
                className={`secondary${preset === p && (p !== "all" || (!from && !to)) ? " on" : ""}`}
                onClick={() => applyPreset(p)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <BarCard
        title="Premium written by carrier"
        heroLabel="written premium"
        rows={premiumRows}
        setTip={setTip}
      />
      <BarCard
        title="Commission by carrier"
        heroLabel="commission (baked into premium)"
        rows={commissionRows}
        setTip={setTip}
      />
      <BarCard
        title="Commission by lead source"
        heroLabel="commission, by where the account came from"
        rows={sourceRows}
        setTip={setTip}
      />

      {tip && (
        <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </>
  );
}

function BarCard({
  title,
  heroLabel,
  rows,
  setTip,
}: {
  title: string;
  heroLabel: string;
  rows: { key: string; name: string; total: number; count: number }[];
  setTip: (t: { x: number; y: number; text: string } | null) => void;
}) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const max = rows[0]?.total || 1;

  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="chart-hero">
        <span className="n">{fmtMoney(total)}</span>
        <span className="l">
          {heroLabel} · {totalCount} {totalCount === 1 ? "policy" : "policies"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">No matching policies.</p>
      ) : (
        <div className="pbar-rows">
          {rows.map((r) => (
            <div
              className="pbar-row"
              key={r.key}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  text: `${r.name} · ${r.count} ${r.count === 1 ? "policy" : "policies"} — ${fmtMoney(r.total)}`,
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              <div className="pbar-label" title={r.name}>
                {r.name}
              </div>
              <div className="pbar-track">
                <div
                  className="pbar-fill"
                  style={{ width: `${Math.max(1, (r.total / max) * 100)}%` }}
                />
              </div>
              <div className="pbar-value">{fmtMoney(r.total)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
