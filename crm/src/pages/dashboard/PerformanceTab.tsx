import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useMemo, useState } from "react";
import { ReportDownload } from "../../components/ReportDownload";
import { DateRangeFilter } from "../../components/DateRangeFilter";
import { dateRangeError, type DateRange } from "../../lib/dateRange";
import { useReportDateRange } from "../../lib/useReportDateRange";
import { StackedBars, type ChartRow, type ChartSeries } from "../../components/StackedBars";
import { client, fmtMoney, listAllPages, type Carrier, type Policy, type Quote } from "../../lib/client";
import { loadAssignments, type AssignmentData } from "../../lib/dashboardAssignments";
import { salespersonSeries } from "../../lib/dashboardPeople";
import { effectiveInWindow, performanceBySalesperson, type PerformanceMoneyRow } from "../../lib/dashboardPerformance";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { isAuthorizationError } from "../../lib/authorizationError";
import { allWithAuthorizationPriority } from "../../lib/allWithAuthorizationPriority";
import { TabFrame } from "./common";

type PerformancePolicy = Pick<Policy, "id" | "accountId" | "carrierId" | "effectiveDate" | "premium" | "commissionPct" | "brokerFee" | "brokerFeeRefunded" | "status">;
type PerformanceQuote = Pick<Quote, "id" | "accountId" | "effectiveDate" | "status">;
interface PerformanceData {
  policies: PerformancePolicy[];
  carriers: Pick<Carrier, "id" | "name">[];
  accounts: AssignmentData["accounts"];
  quotes: PerformanceQuote[];
  commercial: AssignmentData;
}
const EMPTY: PerformanceData = { policies: [], carriers: [], accounts: [], quotes: [], commercial: { entries: {}, team: [], accounts: [] } };
const DECIDED_STATUSES = ["BOUND", "LOST", "DECLINED"] as const;

export default function PerformanceTab() {
  const [range, setRange] = useState<DateRange>({ from: '', to: '' });
  const [excludeCancelled, setExcludeCancelled] = useState(true);
  const invalidRange = !!dateRangeError(range, { allowOpenEnded: true });
  const applied = useReportDateRange(range, !invalidRange);

  return <>
    <DateRangeFilter label="Policy effective dates" value={range} onChange={setRange} allowOpenEnded />
    <div style={{ marginBottom: 12 }}>
      <SegmentedControl label="Policy status" value={excludeCancelled ? 'exclude' : undefined} onChange={() => setExcludeCancelled(value => !value)}
        items={[{ value: 'exclude', label: 'Exclude cancelled' }]} />
    </div>
    <p className="muted small">Policy and quote effective dates · current account salesperson. Unassigned records stay in the totals. Earned broker fees remain after cancellation; recorded refunds reduce fee revenue.</p>
    {applied ? <PerformanceSnapshot key={`${applied.from}|${applied.to}|${excludeCancelled}`} {...applied} excludeCancelled={excludeCancelled} /> : !invalidRange && <p className="muted small">Loading…</p>}
  </>;
}

/** A new filter mounts a new snapshot, so old amounts can never be exported
 * beneath the new window's labels while the scoped reads are in flight. */
function PerformanceSnapshot({ from, to, excludeCancelled }: { from: string; to: string; excludeCancelled: boolean }) {
  const res = useAsyncResource<PerformanceData>(async () => {
    const dateFilter = from || to ? { effectiveDate: { ...(from ? { ge: from } : {}), ...(to ? { le: to } : {}) } } : {};
    const [rawPolicies, carriers, rawQuotes] = await allWithAuthorizationPriority([
      listAllPages(nextToken => client.models.Policy.list({
        nextToken,
        ...(from || to || excludeCancelled ? { filter: { ...dateFilter, ...(excludeCancelled ? { or: [{ status: { ne: "CANCELLED" as const } }, { brokerFee: { gt: 0 } }] } : {}) } } : {}),
        selectionSet: ["id", "accountId", "carrierId", "effectiveDate", "premium", "commissionPct", "brokerFee", "brokerFeeRefunded", "status"],
      })),
      listAllPages(nextToken => client.models.Carrier.list({ nextToken, selectionSet: ["id", "name"] })),
      listAllPages(nextToken => client.models.Quote.list({
        nextToken,
        filter: { ...dateFilter, or: DECIDED_STATUSES.map(status => ({ status: { eq: status } })) },
        selectionSet: ["id", "accountId", "effectiveDate", "status"],
      })),
    ]);
    // Scope account/workflow reads to rows that actually contribute. This also
    // preserves undated all-time production without requesting every CRM account.
    const policies = rawPolicies.filter(policy => (!excludeCancelled || policy.status !== "CANCELLED" || (policy.brokerFee ?? 0) > 0) && effectiveInWindow(policy.effectiveDate, from, to));
    const quotes = rawQuotes.filter(quote => DECIDED_STATUSES.some(status => status === quote.status) && effectiveInWindow(quote.effectiveDate, from, to));
    const commercial = await loadAssignments([...new Set([...policies, ...quotes].map(row => row.accountId))]);
    return { policies, carriers, quotes, accounts: commercial.accounts, commercial };
  }, [from, to, excludeCancelled], { initialData: EMPTY, errorMessage: "Failed to load dashboard", clearDataOnError: isAuthorizationError , live: true });
  const series = useMemo(() => salespersonSeries(res.data.commercial), [res.data.commercial]);
  const result = useMemo(() => performanceBySalesperson({
    ...res.data, entries: res.data.commercial.entries, series, from, to, excludeCancelled,
  }), [res.data, series, from, to, excludeCancelled]);
  const exportFilters = `${from || "Beginning"} through ${to || "all dates"} · policy/quote effective dates · current account salesperson · cancelled premium/carrier commission ${excludeCancelled ? "excluded" : "included"}; earned broker fees retained and refunds deducted · ${result.missingCommissionPct} policies missing commission %`;
  const commissionRows: ChartRow[] = result.people.map(person => ({ key: person.key, label: person.label, values: { [person.key]: person.commission } }));
  const decidedPeople = result.people.filter(person => person.winRate != null);
  const noDecisions = result.people.filter(person => person.winRate == null);
  const winRateRows: ChartRow[] = decidedPeople.map(person => ({
    key: person.key, label: `${person.label} · ${person.bound} / ${person.decided} won`, values: { [person.key]: person.winRate! * 100 },
  }));

  return <TabFrame res={res} hasSnapshot={res.data !== EMPTY}>
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
      <div className="dashboard-chart-grid">
        <div className="card">
          <div className="card-head"><h2>Broker fees per person</h2><ReportDownload report={{ title: "Broker fees per person", filters: exportFilters, sections: [{ title: "Broker fees", columns: ["Salesperson", "Booked broker fees (USD)", "Refunded fees (USD)", "Net fee revenue (USD)", "Policies with a fee"], rows: result.people.map(person => [person.label, person.brokerFees, person.brokerFeeRefunds, person.netBrokerFees, person.feePolicies]) }] }} /></div>
          <p className="muted small">Booked fees less recorded refunds, by policy effective date. Includes fees retained on cancelled policies.</p>
          <StackedBars label="Broker fees per person" rows={result.people.map(person => ({ key: person.key, label: person.label, values: { [person.key]: person.netBrokerFees } }))} series={series} formatValue={fmtMoney} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Total agency revenue per person</h2><ReportDownload report={{ title: "Total agency revenue per person", filters: exportFilters, sections: [{ title: "Agency revenue", columns: ["Salesperson", "Estimated carrier commission (USD)", "Net broker fees (USD)", "Total agency revenue (USD)"], rows: result.people.map(person => [person.label, person.commission, person.netBrokerFees, person.agencyRevenue]) }] }} /></div>
          <p className="muted small">Estimated carrier commission + net broker fees, before producer compensation. Actual producer earnings are in Commissions.</p>
          <StackedBars label="Total agency revenue per person" rows={result.people.map(person => ({ key: person.key, label: person.label, values: { [person.key]: person.agencyRevenue } }))} series={series} formatValue={fmtMoney} />
        </div>
      </div>
      {result.missingCommissionPct > 0 && <p className="muted small">{result.missingCommissionPct} {result.missingCommissionPct === 1 ? "policy has" : "policies have"} no commission percentage and {result.missingCommissionPct === 1 ? "counts" : "count"} as $0 in the commission charts.</p>}
      <MoneyCard title="Written premium by month" category="Month" rows={result.months} series={series} filters={exportFilters} vertical />
      <div className="dashboard-chart-grid">
        <MoneyCard title="Premium by carrier" category="Carrier" rows={result.premiumCarriers} series={series} filters={exportFilters} />
        <MoneyCard title="Commission by lead source" category="Lead source" rows={result.commissionSources} series={series} filters={exportFilters} />
      </div>
      <MoneyCard title="Commission by carrier" category="Carrier" rows={result.commissionCarriers} series={series} filters={exportFilters} />
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
