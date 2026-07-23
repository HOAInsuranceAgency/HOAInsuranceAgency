import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  type Account,
  type Carrier,
  type Policy,
  type Quote,
} from "../lib/client";

export default function Dashboard() {
  const [leads, setLeads] = useState<Account[]>([]);
  const [clients, setClients] = useState<Account[]>([]);
  const [openQuotes, setOpenQuotes] = useState<Quote[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    client.models.Account.list({ filter: { stage: { eq: "LEAD" } } }).then(
      ({ data }) => setLeads(data)
    );
    client.models.Account.list({ filter: { stage: { eq: "CLIENT" } } }).then(
      ({ data }) => setClients(data)
    );
    client.models.Quote.list({
      filter: {
        or: [
          { status: { eq: "DRAFT" } },
          { status: { eq: "SUBMITTED" } },
          { status: { eq: "QUOTED" } },
          { status: { eq: "PRESENTED" } },
        ],
      },
    }).then(({ data }) => setOpenQuotes(data));
    client.models.Policy.list().then(({ data }) => setPolicies(data));
    client.models.Carrier.list().then(({ data }) => setCarriers(data));
  }, []);

  const recentLeads = [...leads]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 8);

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Pipeline at a glance</p>

      <div className="stat-row">
        <div className="stat">
          <div className="n">{leads.length}</div>
          <div className="l">Open leads</div>
        </div>
        <div className="stat">
          <div className="n">{clients.length}</div>
          <div className="l">Clients</div>
        </div>
        <div className="stat">
          <div className="n">{openQuotes.length}</div>
          <div className="l">Quotes in flight</div>
        </div>
        <div className="stat">
          <div className="n">{policies.length}</div>
          <div className="l">Policies bound</div>
        </div>
      </div>

      <PremiumByCarrier policies={policies} carriers={carriers} />

      <div className="card">
        <h2>Recent leads</h2>
        {recentLeads.length === 0 ? (
          <p className="muted small">
            No leads yet. <Link to="/leads/new">Create the first one.</Link>
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>State</th>
                  <th>Source</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentLeads.map((a) => (
                  <tr
                    key={a.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${a.id}`)}
                  >
                    <td>{a.name}</td>
                    <td>{a.type}</td>
                    <td>{a.state ?? "—"}</td>
                    <td>{a.source ?? "—"}</td>
                    <td>{fmtDate(a.createdAt?.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

type Preset = "all" | "ytd" | "12mo";

/**
 * Premium written by carrier: horizontal bars (single hue — magnitude, not
 * identity), value at each bar tip, hover tooltip, date-range filter on
 * policy effective date.
 */
function PremiumByCarrier({
  policies,
  carriers,
}: {
  policies: Policy[];
  carriers: Carrier[];
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  const [tip, setTip] = useState<{ x: number; y: number; text: string; value: string } | null>(null);

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

  const rows = useMemo(() => {
    const inRange = policies.filter((p) => {
      const d = p.effectiveDate;
      if (from && (!d || d < from)) return false;
      if (to && (!d || d > to)) return false;
      return true;
    });
    const byCarrier = new Map<string, { premium: number; count: number }>();
    for (const p of inRange) {
      const key = p.carrierId ?? "unassigned";
      const cur = byCarrier.get(key) ?? { premium: 0, count: 0 };
      cur.premium += p.premium ?? 0;
      cur.count += 1;
      byCarrier.set(key, cur);
    }
    return [...byCarrier.entries()]
      .map(([carrierId, agg]) => ({
        carrierId,
        name:
          carrierId === "unassigned"
            ? "Unassigned"
            : carriers.find((c) => c.id === carrierId)?.name ?? "Unknown carrier",
        ...agg,
      }))
      .sort((a, b) => b.premium - a.premium);
  }, [policies, carriers, from, to]);

  const total = rows.reduce((s, r) => s + r.premium, 0);
  const totalPolicies = rows.reduce((s, r) => s + r.count, 0);
  const max = rows[0]?.premium || 1;

  return (
    <div className="card">
      <h2>Premium written by carrier</h2>

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

      <div className="chart-hero">
        <span className="n">{fmtMoney(total)}</span>
        <span className="l">
          written premium · {totalPolicies} {totalPolicies === 1 ? "policy" : "policies"}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="muted small">
          No bound policies{from || to ? " in this date range" : " yet"} — premium
          appears here as quotes are bound.
        </p>
      ) : (
        <div className="pbar-rows">
          {rows.map((r) => (
            <div
              className="pbar-row"
              key={r.carrierId}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  text: `${r.name} · ${r.count} ${r.count === 1 ? "policy" : "policies"}`,
                  value: fmtMoney(r.premium),
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
                  style={{ width: `${Math.max(1, (r.premium / max) * 100)}%` }}
                />
              </div>
              <div className="pbar-value">{fmtMoney(r.premium)}</div>
            </div>
          ))}
        </div>
      )}

      {tip && (
        <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text} — <span className="t-val">{tip.value}</span>
        </div>
      )}
    </div>
  );
}
