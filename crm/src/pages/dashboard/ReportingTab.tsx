import { useMemo, useState } from "react";
import {
  client,
  fmtMoney,
  listAllPages,
  type Account,
  type Carrier,
  type Policy,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import {
  commissionBySource,
  moneyByCarrier,
  policyCommission,
} from "../../lib/dashboardStats";
import { TabFrame } from "./common";

// ── Premium & commission production (shared date filter) ───────────────

interface ReportingData {
  policies: Policy[];
  carriers: Carrier[];
  /** Every account, both stages — the lead-source chart joins through them. */
  accounts: Account[];
}

const EMPTY: ReportingData = { policies: [], carriers: [], accounts: [] };

type Preset = "all" | "ytd" | "12mo";

export default function ReportingTab() {
  const res = useAsyncResource<ReportingData>(
    async () => {
      const [policies, carriers, accounts] = await Promise.all([
        listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
        listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
        listAllPages((nextToken) => client.models.Account.list({ nextToken })),
      ]);
      return { policies, carriers, accounts };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load reporting" }
  );
  const { policies, carriers, accounts } = res.data;

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  /**
   * On by default: a cancelled policy's premium is production that partially
   * un-happened, and charts that steer the agency shouldn't count it without
   * being asked to. EXPIRED and NON_RENEWED stay in either way — those
   * policies ran their term; they are history, not retractions.
   */
  const [excludeCancelled, setExcludeCancelled] = useState(true);
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
        if (excludeCancelled && p.status === "CANCELLED") return false;
        const d = p.effectiveDate;
        if (from && (!d || d < from)) return false;
        if (to && (!d || d > to)) return false;
        return true;
      }),
    [policies, from, to, excludeCancelled]
  );

  const premiumRows = useMemo(
    () => moneyByCarrier(filtered, carriers, (p) => p.premium ?? 0),
    [filtered, carriers]
  );
  const commissionRows = useMemo(
    () => moneyByCarrier(filtered, carriers, policyCommission),
    [filtered, carriers]
  );
  // Same commission dollars, cut by where the account came from instead of
  // who wrote the paper — the answer to "which lead source pays for itself".
  const sourceRows = useMemo(
    () => commissionBySource(filtered, accounts),
    [filtered, accounts]
  );

  return (
    <TabFrame res={res}>
      <div className="card">
        <h2>Production</h2>
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
        <div className="chip-row" style={{ marginTop: 10 }}>
          <button
            className={excludeCancelled ? "on" : ""}
            onClick={() => setExcludeCancelled((v) => !v)}
          >
            Exclude cancelled
          </button>
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
    </TabFrame>
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
