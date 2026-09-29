import { useMemo, useState } from "react";
import { ReportDownload } from "../../components/ReportDownload";
import { StackedBars, type ChartRow, type ChartSeries } from "../../components/StackedBars";
import { client, fmtMoney, listAllPages, type Account, type Carrier, type Policy, type Quote } from "../../lib/client";
import { loadCommercial } from "../../lib/commercial";
import { salespersonSeries } from "../../lib/dashboardPeople";
import { performanceBySalesperson, type PerformanceMoneyRow } from "../../lib/dashboardPerformance";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { localToday, TabFrame } from "./common";

interface PerformanceData {
  policies: Policy[];
  carriers: Carrier[];
  accounts: Account[];
  quotes: Quote[];
  commercial: Awaited<ReturnType<typeof loadCommercial>>;
}
const EMPTY: PerformanceData = { policies: [], carriers: [], accounts: [], quotes: [], commercial: { entries: {}, team: [] } };
type Preset = "all" | "ytd" | "12mo" | "custom";

export default function PerformanceTab() {
  const res = useAsyncResource<PerformanceData>(async () => {
    const [policies, carriers, accounts, quotes] = await Promise.all([
      listAllPages(nextToken => client.models.Policy.list({ nextToken })),
      listAllPages(nextToken => client.models.Carrier.list({ nextToken })),
      listAllPages(nextToken => client.models.Account.list({ nextToken })),
      listAllPages(nextToken => client.models.Quote.list({ nextToken })),
    ]);
    const commercial = await loadCommercial(accounts.map(account => account.id));
    return { policies, carriers, accounts, quotes, commercial };
  }, [], { initialData: EMPTY, errorMessage: "Failed to load dashboard" });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  const [excludeCancelled, setExcludeCancelled] = useState(true);
  const series = useMemo(() => salespersonSeries(res.data.commercial), [res.data.commercial]);
  const result = useMemo(() => performanceBySalesperson({
    ...res.data, entries: res.data.commercial.entries, series, from, to, excludeCancelled,
  }), [res.data, series, from, to, excludeCancelled]);
  const invalidRange = Boolean(from && to && from > to);
  const exportFilters = `${from || "Beginning"} through ${to || "all dates"} · policy/quote effective dates · current account salesperson · cancelled policies ${excludeCancelled ? "excluded" : "included"} · ${result.missingCommissionPct} policies missing commission %`;
  const commissionRows: ChartRow[] = result.people.map(person => ({ key: person.key, label: person.label, values: { [person.key]: person.commission } }));
  const decidedPeople = result.people.filter(person => person.winRate != null);
  const noDecisions = result.people.filter(person => person.winRate == null);
  const winRateRows: ChartRow[] = decidedPeople.map(person => ({
    key: person.key, label: `${person.label} · ${person.bound} / ${person.decided} won`, values: { [person.key]: person.winRate! * 100 },
  }));

  function applyPreset(value: Exclude<Preset, "custom">) {
    setPreset(value);
    const today = localToday();
    if (value === "all") { setFrom(""); setTo(""); }
    else if (value === "ytd") { setFrom(`${today.slice(0, 4)}-01-01`); setTo(today); }
    else {
      // Clamp Feb 29 to Feb 28 when the preceding year is not a leap year.
      const year = Number(today.slice(0, 4)) - 1;
      const month = Number(today.slice(5, 7));
      const day = Math.min(Number(today.slice(8, 10)), new Date(year, month, 0).getDate());
      setFrom(`${year}-${today.slice(5, 7)}-${String(day).padStart(2, "0")}`);
      setTo(today);
    }
  }

  return <TabFrame res={res}>
    <div className="chip-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
      {([["all", "All time"], ["ytd", "YTD"], ["12mo", "Last 12 mo"]] as const).map(([value, label]) => <button key={value} className={preset === value ? "on" : ""} onClick={() => applyPreset(value)}>{label}</button>)}
      <button className={preset === "custom" ? "on" : ""} onClick={() => setPreset("custom")}>Custom…</button>
      <button aria-pressed={excludeCancelled} className={excludeCancelled ? "on" : ""} onClick={() => setExcludeCancelled(value => !value)}>Exclude cancelled</button>
    </div>
    <p className="muted small">Policy and quote effective dates · current account salesperson. Unassigned records stay in the totals.</p>
    {preset === "custom" && <div className="card"><div className="filter-row">
      <div className="field"><label htmlFor="dashboard-effective-from">Effective from</label><input id="dashboard-effective-from" type="date" value={from} onChange={event => setFrom(event.target.value)} /></div>
      <div className="field"><label htmlFor="dashboard-effective-to">Effective to</label><input id="dashboard-effective-to" type="date" value={to} onChange={event => setTo(event.target.value)} /></div>
    </div></div>}
    {invalidRange ? <p className="error-text" role="alert">The start date must be on or before the end date.</p> : <>
      <div className="dashboard-chart-grid">
        <div className="card">
          <div className="card-head"><h2>Est. commission per person</h2><ReportDownload report={{ title: "Estimated commission per person", filters: exportFilters, sections: [{ title: "Estimated commission", columns: ["Salesperson", "Estimated commission (USD)", "Policy count", "Policies missing commission %"], rows: result.people.map(person => [person.label, person.commission, person.policies, person.missingCommissionPct]) }] }} /></div>
          <p className="muted small">Policy premium × commission percentage.</p>
          <StackedBars label="Estimated commission per person" rows={commissionRows} series={series} formatValue={fmtMoney} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Quote win rate per person</h2><ReportDownload report={{ title: "Quote win rate per person", filters: exportFilters, sections: [{ title: "Quote win rate", columns: ["Salesperson", "Win rate (%)", "Bound quotes", "Decided quotes"], rows: result.people.map(person => [person.label, person.winRate == null ? null : person.winRate * 100, person.bound, person.decided]) }] }} /></div>
          <p className="muted small">Bound ÷ decided quotes (bound, lost or declined). Open quotes are excluded.</p>
          <StackedBars label="Quote win rate per person" rows={winRateRows} series={series} formatValue={value => `${Math.round(value)}%`} maxValue={100} />
          {noDecisions.length > 0 && <p className="muted small">No decided quotes: {noDecisions.map(person => person.label).join(", ")}.</p>}
        </div>
      </div>
      {result.missingCommissionPct > 0 && <p className="muted small">{result.missingCommissionPct} {result.missingCommissionPct === 1 ? "policy has" : "policies have"} no commission percentage and {result.missingCommissionPct === 1 ? "counts" : "count"} as $0 in the commission charts.</p>}
      <MoneyCard title="Written premium by month" category="Month" rows={result.months} series={series} filters={exportFilters} vertical />
      <div className="dashboard-chart-grid">
        <MoneyCard title="Premium by carrier" category="Carrier" rows={result.premiumCarriers} series={series} filters={exportFilters} />
        <MoneyCard title="Commission by lead source" category="Lead source" rows={result.commissionSources} series={series} filters={exportFilters} />
      </div>
      <MoneyCard title="Commission by carrier" category="Carrier" rows={result.commissionCarriers} series={series} filters={exportFilters} />
    </>}
  </TabFrame>;
}

function MoneyCard({ title, category, rows, series, filters, vertical = false }: {
  title: string;
  category: string;
  rows: PerformanceMoneyRow[];
  series: ChartSeries[];
  filters: string;
  vertical?: boolean;
}) {
  return <div className="card">
    <div className="card-head"><h2>{title}</h2><ReportDownload report={{ title, filters, sections: [{ title, columns: [category, ...series.map(person => `${person.label} (USD)`), "Total (USD)", "Policy count"], rows: rows.map(row => [vertical ? row.key === "undated" ? row.label : row.key : row.label, ...series.map(person => row.values[person.key] ?? 0), row.total, row.count]) }] }} /></div>
    <StackedBars label={title} rows={rows} series={series} formatValue={fmtMoney} vertical={vertical} />
  </div>;
}
