import { useMemo, useState } from "react";
import {
  client,
  fmtMoney,
  listAllPages,
  type Account,
  type Carrier,
  type Policy,
  type Quote,
} from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import {
  commissionBySource,
  moneyByCarrier,
  policyCommission,
  premiumByMonth,
  quoteWinRate,
  sumInWindow,
} from "../../lib/dashboardStats";
import { localToday, TabFrame, Tile } from "./common";
import type { Schema } from "../../../amplify/data/resource";

type InvoiceRow = Schema["Invoice"]["type"];
type PfPaymentRow = Schema["PfLoanPayment"]["type"];

// ── How is the book doing: production, win rate, and the money that
// actually landed, all behind one date window. ─────────────────────────

interface ReportingData {
  policies: Policy[];
  carriers: Carrier[];
  /** Every account, both stages — the lead-source chart joins through them. */
  accounts: Account[];
  quotes: Quote[];
  paidInvoices: InvoiceRow[];
  pfPayments: PfPaymentRow[];
}

const EMPTY: ReportingData = {
  policies: [],
  carriers: [],
  accounts: [],
  quotes: [],
  paidInvoices: [],
  pfPayments: [],
};

type Preset = "all" | "ytd" | "12mo" | "custom";

const PRESET_LABEL: Record<Preset, string> = {
  all: "all time",
  ytd: "YTD",
  "12mo": "last 12 mo",
  custom: "custom range",
};

/** A bounded window excludes undated rows; open bounds admit them. */
function inWindow(
  d: string | null | undefined,
  from: string,
  to: string
): boolean {
  if (from && (!d || d < from)) return false;
  if (to && (!d || d > to)) return false;
  return true;
}

export default function ReportingTab() {
  const res = useAsyncResource<ReportingData>(
    async () => {
      const [policies, carriers, accounts, quotes, paidInvoices, pfPayments] =
        await Promise.all([
          listAllPages((nextToken) => client.models.Policy.list({ nextToken })),
          listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
          listAllPages((nextToken) => client.models.Account.list({ nextToken })),
          listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
          listAllPages((nextToken) =>
            client.models.Invoice.list({
              filter: { status: { eq: "PAID" } },
              nextToken,
            })
          ),
          listAllPages((nextToken) => client.models.PfLoanPayment.list({ nextToken })),
        ]);
      return {
        policies,
        carriers,
        accounts,
        quotes,
        paidInvoices: paidInvoices as InvoiceRow[],
        pfPayments: pfPayments as PfPaymentRow[],
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load reporting" }
  );
  const { policies, carriers, accounts, quotes, paidInvoices, pfPayments } = res.data;

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

  function applyPreset(p: Exclude<Preset, "custom">) {
    setPreset(p);
    // localToday, not toISOString: the UTC day rolls past local midnight
    // every evening, and a "YTD" ending on tomorrow's date would cross the
    // year boundary on Dec 31 — while the chart's month logic already
    // thinks in local days. String math keeps the two in one calendar.
    const today = localToday();
    if (p === "all") {
      setFrom("");
      setTo("");
    } else if (p === "ytd") {
      setFrom(`${today.slice(0, 4)}-01-01`);
      setTo(today);
    } else {
      setFrom(`${Number(today.slice(0, 4)) - 1}${today.slice(4)}`);
      setTo(today);
    }
  }

  const filtered = useMemo(
    () =>
      policies.filter((p) => {
        if (excludeCancelled && p.status === "CANCELLED") return false;
        return inWindow(p.effectiveDate, from, to);
      }),
    [policies, from, to, excludeCancelled]
  );
  const decidedQuotes = useMemo(
    () => quotes.filter((q) => inWindow(q.effectiveDate, from, to)),
    [quotes, from, to]
  );

  const writtenPremium = useMemo(
    () => filtered.reduce((s, p) => s + (p.premium ?? 0), 0),
    [filtered]
  );
  const estCommission = useMemo(
    () => filtered.reduce((s, p) => s + policyCommission(p), 0),
    [filtered]
  );
  const missingPct = useMemo(
    () =>
      filtered.filter((p) => (p.premium ?? 0) > 0 && p.commissionPct == null).length,
    [filtered]
  );
  const winRate = useMemo(() => quoteWinRate(decidedQuotes), [decidedQuotes]);
  const collected = useMemo(
    () =>
      sumInWindow(
        paidInvoices,
        (i) => i.paidAt,
        (i) => (i.stripeLinkAmountCents ?? 0) / 100,
        from,
        to
      ),
    [paidInvoices, from, to]
  );
  const interest = useMemo(
    () => sumInWindow(pfPayments, (p) => p.postedAt, (p) => p.interest, from, to),
    [pfPayments, from, to]
  );

  const months = useMemo(
    () => premiumByMonth(filtered, from, to, localToday()),
    [filtered, from, to]
  );
  const monthMax = Math.max(1, ...months.map((m) => m.total));
  const thisMonth = localToday().slice(0, 7);

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

  const windowLabel = PRESET_LABEL[preset];

  return (
    <TabFrame res={res}>
      <div className="chip-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        {(
          [
            ["all", "All time"],
            ["ytd", "YTD"],
            ["12mo", "Last 12 mo"],
          ] as [Exclude<Preset, "custom">, string][]
        ).map(([p, label]) => (
          <button
            key={p}
            className={preset === p ? "on" : ""}
            onClick={() => applyPreset(p)}
          >
            {label}
          </button>
        ))}
        <button
          className={preset === "custom" ? "on" : ""}
          onClick={() => setPreset("custom")}
        >
          Custom…
        </button>
        <button
          className={excludeCancelled ? "on" : ""}
          onClick={() => setExcludeCancelled((v) => !v)}
        >
          Exclude cancelled
        </button>
      </div>

      {preset === "custom" && (
        <div className="card">
          <div className="filter-row">
            <div className="field">
              <label>Effective from</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Effective to</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      <div className="stat-row">
        <Tile n={fmtMoney(writtenPremium)} label={`Written premium · ${windowLabel}`} />
        <Tile n={fmtMoney(estCommission)} label={`Est. commission · ${windowLabel}`} />
        <Tile
          n={winRate.rate == null ? "—" : `${Math.round(winRate.rate * 100)}%`}
          label={`Quote win rate · ${winRate.decided} decided`}
        />
        <Tile n={fmtMoney(collected.total)} label={`Collected · ${windowLabel}`} />
        <Tile n={fmtMoney(interest.total)} label={`PF interest income · ${windowLabel}`} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Written premium by month</h2>
          <span className="muted small">policy effective date</span>
        </div>
        <div className="months">
          {months.map((m) => {
            // A future month with production in it (post-dated effective
            // dates are routine) draws a real bar, marked as not-yet-
            // arrived; only a future month with nothing gets the empty
            // placeholder — the tiles count that premium, so hiding its
            // bar would make the chart disagree with them.
            const placeholder = m.future && m.count === 0;
            return (
              <div
                key={m.key}
                className={`mbar${m.key === thisMonth ? " hi" : ""}${
                  placeholder ? " future" : m.future ? " future-filled" : ""
                }`}
                style={
                  placeholder
                    ? undefined
                    : { height: `${Math.max(2, (m.total / monthMax) * 100)}%` }
                }
                onMouseMove={(e) =>
                  setTip({
                    x: e.clientX,
                    y: e.clientY,
                    text: `${m.label} ${m.key.slice(0, 4)} · ${m.count} ${m.count === 1 ? "policy" : "policies"} — ${fmtMoney(m.total)}`,
                  })
                }
                onMouseLeave={() => setTip(null)}
              />
            );
          })}
        </div>
        <div className="month-labels">
          {months.map((m) => (
            <span key={m.key}>{m.label}</span>
          ))}
        </div>
      </div>

      <div className="cols">
        <BarCard
          title="Premium by carrier"
          heroLabel="written premium"
          rows={premiumRows}
          setTip={setTip}
        />
        <BarCard
          title="Commission by lead source"
          heroLabel="commission, by where the account came from"
          rows={sourceRows}
          setTip={setTip}
        />
      </div>
      <BarCard
        title="Commission by carrier"
        heroLabel="commission (baked into premium)"
        rows={commissionRows}
        setTip={setTip}
      />
      {missingPct > 0 && (
        <p className="muted small">
          {missingPct} {missingPct === 1 ? "policy" : "policies"} in this range{" "}
          {missingPct === 1 ? "carries" : "carry"} no commission % and{" "}
          {missingPct === 1 ? "counts" : "count"} $0 in the commission figures.
        </p>
      )}

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
