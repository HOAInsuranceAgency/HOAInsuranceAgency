import { Button } from "../components/ui/Button";
import { Table } from "../components/ui/Table";
import { Select } from "../components/ui/Select";
import { Input } from "../components/ui/Input";
import { useEffect, useRef, useState } from "react";
import { ReportDownload } from "../components/ReportDownload";
import { DateRangeFilter } from "../components/DateRangeFilter";
import { dateRangeError, dateRangePreset } from "../lib/dateRange";
import { useReportDateRange } from "../lib/useReportDateRange";
import { client } from "../lib/client";
import { useIsOwner } from "../lib/auth";
import { useAsyncResource } from "../lib/useAsyncResource";
import type { DashboardReport } from "../lib/reportDownload";
import {
  validateCompensationRecord, validateProfitabilityWindow,
  type CompensationTerm, type EmployeeCompensation, type EmployeeProfitabilityResult, type ProfitabilityRow,
} from "../../../shared/employeeProfitability";
import "./OwnerProfitability.css";

type Employee = { userId: string; name: string; salesperson?: boolean };
type Snapshot = { ok: true; employees: Employee[]; compensations: Record<string, EmployeeCompensation>; report: EmployeeProfitabilityResult; reportStale?: boolean };
const money = (cents: number | null) => cents == null ? "Incomplete" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(cents / 100);
const dollars = (cents: number | null) => cents == null ? null : cents / 100;
const basis = "Estimated carrier commission plus broker fees less recorded fee refunds, by policy effective date and current account salesperson. The estimated producer share applies to both revenue sources; prorated annual salary is deducted. Cancelled carrier commission and other operating costs are excluded; retained broker fees remain included.";

function response<T>(result: { data?: unknown; errors?: readonly { message?: string }[] }): T {
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message || "Request failed").join("; "));
  const data = typeof result.data === "string" ? JSON.parse(result.data) : result.data;
  if (!data || typeof data !== "object" || !("ok" in data) || data.ok !== true) {
    throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Could not load owner profitability.");
  }
  return data as T;
}

/** Unmount all private state when the active role leaves Owner. */
export default function OwnerProfitability() {
  const owner = useIsOwner();
  return owner ? <OwnerPage /> : <p role="alert">Switch to the Owner role to view employee profitability.</p>;
}

function OwnerPage() {
  const [window, setWindow] = useState(() => dateRangePreset('ytd'));
  const [editingPay, setEditingPay] = useState(false);
  const error = dateRangeError(window, { validate: validateProfitabilityWindow });
  const applied = useReportDateRange(window, !error);
  return <div className="owner-profitability">
    <DateRangeFilter label="Reporting period" value={window} onChange={setWindow} validate={validateProfitabilityWindow} disabled={editingPay} />
    {applied ? <ProfitabilitySnapshot key={`${applied.from}|${applied.to}`} {...applied} onEditingChange={setEditingPay} /> : !error && <p className="muted small">Loading employee profitability…</p>}
  </div>;
}

function ProfitabilitySnapshot({ from, to, onEditingChange }: { from: string; to: string; onEditingChange: (editing: boolean) => void }) {
  // Pay writes can be ahead of the report's read. Keep the newest confirmed
  // versions in the parent so switching employees or reopening an editor
  // cannot restore an older salary or optimistic-lock version.
  const latestPay = useRef<Record<string, EmployeeCompensation>>({});
  const active = useRef(true);
  const readVersion = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; ++readVersion.current; latestPay.current = {}; };
  }, []);
  const resource = useAsyncResource(async () => {
    const reading = ++readVersion.current;
    try {
      const snapshot = response<Snapshot>(await client.queries.ownerProfitability({ from, to }));
      if (!active.current || reading !== readVersion.current) return snapshot;
      const compensations = { ...snapshot.compensations };
      let reportStale = false;
      for (const employee of snapshot.employees) {
        const known = latestPay.current[employee.userId];
        if (known && known.version > (compensations[employee.userId]?.version ?? -1)) {
          compensations[employee.userId] = known;
          reportStale = true;
        }
      }
      latestPay.current = compensations;
      return { ...snapshot, compensations, reportStale };
    } catch (error) {
      // The same fail-closed policy applies to this version memory as to the
      // rendered snapshot, including transient read failures.
      if (active.current && reading === readVersion.current) latestPay.current = {};
      throw error;
    }
  }, [from, to], { errorMessage: "Could not load employee profitability.", clearDataOnError: () => true });
  const [payOpen, setPayOpen] = useState(false), [employeeId, setEmployeeId] = useState(""), [paySaved, setPaySaved] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  useEffect(() => { onEditingChange(!!resource.data && (payOpen || payBusy)); }, [resource.data, payOpen, payBusy, onEditingChange]);
  const payPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (payOpen) payPanel.current?.focus(); }, [payOpen, employeeId]);
  const snapshot = resource.data;
  if (!snapshot) return <div className="card" aria-live="polite">{resource.error ? <><p role="alert" className="error-text">{resource.error}</p><Button variant="secondary"  onClick={() => void resource.refetch()} disabled={resource.loading}>Try again</Button></> : <p className="muted">Loading employee profitability…</p>}</div>;
  const { report, employees, compensations } = snapshot;
  const selected = employees.find(employee => employee.userId === employeeId) ?? employees[0];
  const setup = (userId: string) => { setEmployeeId(userId); setPaySaved(false); setPayOpen(true); };
  const totals = report.totals;
  return <>
    <div className="owner-profitability-toolbar">
      <p className="muted small">{report.from} through {report.to} · USD · Estimated</p>
      <div className="owner-profitability-actions"><Button variant="secondary"  disabled={resource.loading || payOpen} onClick={() => void resource.refetch()}>{resource.loading ? "Refreshing…" : "Refresh"}</Button><Button variant="secondary"  disabled={payBusy || resource.loading} aria-expanded={payOpen} onClick={() => setPayOpen(!payOpen)}>Manage pay settings</Button><ReportDownload disabled={resource.loading || snapshot.reportStale} report={exportReport(report)} /></div>
    </div>
    {snapshot.reportStale && <p className="owner-profitability-notice" role="status">Pay settings are saved, but the report is still catching up. {payOpen ? 'Close pay settings and refresh the report to update its totals.' : 'Refresh the report to update its totals.'}</p>}
    <div className="stat-row owner-profitability-summary">
      <Summary label="Agency commission" amount={totals.grossCommissionCents} known={totals.knownGrossCommissionCents} />
      <Summary label="Booked broker fees" amount={totals.brokerFeeCents} known={totals.knownBrokerFeeCents} />
      <Summary label="Total agency revenue" amount={totals.totalAgencyRevenueCents} known={totals.knownTotalAgencyRevenueCents} />
      <Summary label="After producer share" amount={totals.netRevenueCents} known={totals.knownNetRevenueCents} />
      <Summary label="Salary for period" amount={totals.salaryCents} known={totals.knownSalaryCents} />
      <Summary label="Estimated contribution" amount={totals.contributionCents} known={totals.knownContributionCents} />
    </div>
    {!totals.complete && <div className="owner-profitability-notice" role="status"><strong>This report is incomplete.</strong> Missing commission or pay details are not treated as zero. Known amounts are partial subtotals.</div>}
    <div className="card"><div className="card-head"><h2>Revenue and salary by employee</h2></div><p className="muted small">Revenue includes carrier commission and net broker fees after the estimated producer’s share. Compare it with salary for the selected period.</p><ComparisonChart rows={report.rows} /></div>
    <div className="card">
      <div className="card-head"><h2>Employee breakdown</h2><span className="muted small">{totals.policyCount} policies</span></div>
      {report.rows.length ? <div className="owner-profitability-table"><Table><thead><tr><th>Employee</th><th>Agency commission</th><th>Broker fees</th><th>Fee refunds</th><th>Total agency revenue</th><th>Producer share</th><th>Net revenue</th><th>Salary</th><th>Est. contribution</th><th>Policies</th><th>Data status</th></tr></thead><tbody>{report.rows.map(row => <tr key={row.userId ?? "unassigned"}>
        <th scope="row">{row.name}</th><td>{money(row.grossCommissionCents)}</td><td>{money(row.brokerFeeCents)}</td><td>{money(row.brokerFeeRefundedCents)}</td><td>{money(row.totalAgencyRevenueCents)}</td><td>{money(row.producerShareCents)}</td><td>{money(row.netRevenueCents)}</td><td>{money(row.salaryCents)}</td><td className={row.contributionCents != null && row.contributionCents < 0 ? "owner-profitability-negative" : "owner-profitability-contribution"}>{money(row.contributionCents)}</td><td>{row.policyCount}</td>
        <td className="owner-profitability-data-status">{row.complete ? <span>Complete</span> : <><strong>{row.userId && !compensations[row.userId]?.terms.length ? "Needs pay setup" : "Incomplete"}</strong>{row.warnings.length > 0 && <ul>{row.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}{row.userId && employees.some(employee => employee.userId === row.userId) && <Button variant="secondary"  disabled={payBusy || resource.loading} onClick={() => setup(row.userId!)} aria-label={`Edit pay settings for ${row.name}`}>Edit pay settings</Button>}</>}</td>
      </tr>)}</tbody></Table></div> : <p className="muted">No employees or policies found for this report.</p>}
    </div>
    {payOpen && <section className="card owner-profitability-pay-panel" ref={payPanel} tabIndex={-1} aria-label="Private pay settings"><h2>Private pay settings</h2><p className="muted small">Only owners can see or change these amounts. Add a dated period for each pay change. Use 0 for unpaid salary or no commission share.</p>
      {selected ? <CompensationEditor key={selected.userId} employee={selected} employees={employees} compensation={compensations[selected.userId]} defaultFrom={from} onBusyChange={setPayBusy} onSelect={id => { setEmployeeId(id); setPaySaved(false); }} onChange={() => setPaySaved(false)} onSaved={async saved => {
        if (!active.current) return;
        if (saved.version >= (latestPay.current[saved.userId]?.version ?? -1)) latestPay.current = { ...latestPay.current, [saved.userId]: saved };
        const confirmed = latestPay.current[saved.userId];
        resource.setData(current => current ? { ...current, compensations: { ...current.compensations, [saved.userId]: confirmed }, reportStale: true } : current);
        await resource.refetch();
        if (active.current) setPaySaved(true);
      }} /> : <p className="muted">No employees are available.</p>}
      {paySaved && <p role="status">Pay settings saved.</p>}
    </section>}
  </>;
}

function Summary({ label, amount, known }: { label: string; amount: number | null; known: number }) {
  return <div className={`stat${amount != null && amount < 0 ? " hot" : ""}`}><div className="l">{label}</div><div className="n">{money(amount)}</div>{amount == null && <p className="muted small">{money(known)} known · partial</p>}</div>;
}

function ComparisonChart({ rows }: { rows: ProfitabilityRow[] }) {
  const values = rows.flatMap(row => [row.netRevenueCents, row.salaryCents]).filter((value): value is number => value != null);
  const max = Math.max(1, ...values.map(Math.abs)), signed = values.some(value => value < 0), zero = signed ? 50 : 0;
  if (!rows.length) return <p className="muted">No employee data to compare.</p>;
  return <figure className="owner-profitability-chart" aria-label="Net revenue compared with salary by employee"><figcaption className="owner-profitability-legend"><span><i className="owner-profitability-revenue-key" />Net revenue</span><span><i className="owner-profitability-salary-key" />Salary</span></figcaption>
    {rows.map(row => <div className="owner-profitability-chart-row" key={row.userId ?? "unassigned"}><strong>{row.name}</strong><div>{([["Net revenue", row.netRevenueCents, "revenue"], ["Salary", row.salaryCents, "salary"]] as const).map(([label, value, kind]) => {
      const width = value == null ? 0 : Math.abs(value) / max * (signed ? 50 : 100);
      return <div className="owner-profitability-chart-measure" key={kind}><span className="sr-only">{label}: </span><div className="owner-profitability-track" aria-hidden="true"><i className="owner-profitability-zero" style={{ left: `${zero}%` }} />{value != null && <span className={`owner-profitability-bar ${kind}`} style={{ left: `${value < 0 ? zero - width : zero}%`, width: `${width}%` }} />}</div><span className="owner-profitability-chart-value">{money(value)}</span></div>;
    })}</div></div>)}
  </figure>;
}

export function exportReport(report: EmployeeProfitabilityResult): DashboardReport {
  return { title: "Estimated employee profitability", filters: `${report.from} through ${report.to}. ${basis} ${report.totals.complete ? "Complete data." : "INCOMPLETE: blank amounts are unknown, not zero; known totals are partial."} ${report.cancelledPolicyCount} cancelled and ${report.undatedPolicyCount} undated policies excluded. ${report.warnings.join(" ")}`, sections: [
    { title: "Employees", columns: ["Employee", "Agency commission (USD)", "Producer share (USD)", "Net revenue (USD)", "Salary (USD)", "Estimated contribution (USD)", "Policy count", "Complete", "Missing commission policies", "Missing compensation policies", "Warnings", "Booked broker fees (USD)", "Broker fee refunds (USD)", "Total agency revenue (USD)", "Policies with fees"], rows: report.rows.map(row => [row.name, dollars(row.grossCommissionCents), dollars(row.producerShareCents), dollars(row.netRevenueCents), dollars(row.salaryCents), dollars(row.contributionCents), row.policyCount, row.complete ? "Yes" : "No", row.missingCommissionCount, row.missingCompensationCount, row.warnings.join("; "), dollars(row.brokerFeeCents), dollars(row.brokerFeeRefundedCents), dollars(row.totalAgencyRevenueCents), row.feePolicyCount]) },
    { title: "Totals", columns: ["Amount", "Total (USD)", "Known subtotal (USD)", "Complete"], rows: ([
      ["Agency commission", report.totals.grossCommissionCents, report.totals.knownGrossCommissionCents], ["Producer share", report.totals.producerShareCents, report.totals.knownProducerShareCents], ["Net revenue", report.totals.netRevenueCents, report.totals.knownNetRevenueCents], ["Salary", report.totals.salaryCents, report.totals.knownSalaryCents], ["Estimated contribution", report.totals.contributionCents, report.totals.knownContributionCents],
      ["Booked broker fees", report.totals.brokerFeeCents, report.totals.knownBrokerFeeCents], ["Broker fee refunds", report.totals.brokerFeeRefundedCents, report.totals.knownBrokerFeeRefundedCents], ["Total agency revenue", report.totals.totalAgencyRevenueCents, report.totals.knownTotalAgencyRevenueCents],
    ] as const).map(([label, total, known]) => [label, dollars(total), dollars(known), total == null ? "No" : "Yes"]) },
  ] };
}

type DraftTerm = { from: string; to: string; salary: string; share: string };
function decimalHundredths(value: string, label: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error(`Enter ${label} as a nonnegative number with up to two decimal places.`);
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount)) throw new Error(`${label} is too large.`);
  return amount;
}
function toDraft(term: CompensationTerm): DraftTerm { return { from: term.from, to: term.to ?? "", salary: (term.annualSalaryCents / 100).toFixed(2), share: (term.producerShareBps / 100).toFixed(2) }; }

function CompensationEditor({ employee, employees, compensation, defaultFrom, onSelect, onChange, onSaved, onBusyChange }: { employee: Employee; employees: Employee[]; compensation?: EmployeeCompensation; defaultFrom: string; onSelect: (id: string) => void; onChange: () => void; onSaved: (compensation: EmployeeCompensation) => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const [baseline, setBaseline] = useState(compensation);
  const initialTerms = (value?: EmployeeCompensation) => value?.terms.map(toDraft) ?? [{ from: defaultFrom, to: "", salary: "", share: "" }];
  const [terms, setTerms] = useState<DraftTerm[]>(() => initialTerms(compensation));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false);
  const dirty = JSON.stringify(terms) !== JSON.stringify(initialTerms(baseline));
  useEffect(() => {
    // A report refresh can discover a newer pay version while this form is
    // being edited. Preserve its draft and original concurrency version.
    if (!dirty && !busy && (compensation?.version ?? 0) >= (baseline?.version ?? 0)) {
      setBaseline(compensation); setTerms(initialTerms(compensation));
    }
  }, [compensation, dirty, busy, baseline?.version, defaultFrom]);
  function update(index: number, patch: Partial<DraftTerm>) { setTerms(previous => previous.map((term, i) => i === index ? { ...term, ...patch } : term)); onChange(); }
  async function save() {
    if (inFlight.current) return;
    setError(""); onChange();
    try {
      const value = validateCompensationRecord({ userId: employee.userId, version: baseline?.version ?? 0, terms: terms.map(term => ({ from: term.from, ...(term.to ? { to: term.to } : {}), annualSalaryCents: decimalHundredths(term.salary, "annual salary"), producerShareBps: decimalHundredths(term.share, "commission share") })) });
      inFlight.current = true; setBusy(true); onBusyChange(true);
      const result = response<{ ok: true; compensation: EmployeeCompensation }>(await client.mutations.saveEmployeeCompensation({ userId: employee.userId, version: value.version, terms: JSON.stringify(value.terms) }));
      setBaseline(result.compensation); setTerms(initialTerms(result.compensation));
      await onSaved(result.compensation);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save pay settings."); }
    finally { inFlight.current = false; setBusy(false); onBusyChange(false); }
  }
  return <form aria-label={`Pay settings for ${employee.name}`} onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset className="owner-profitability-pay-fields" disabled={busy}>
      <label className="field owner-profitability-employee-select">Employee<Select value={employee.userId} onChange={event => onSelect(event.target.value)}>{employees.map(item => <option key={item.userId} value={item.userId}>{item.name}</option>)}</Select></label>
      {terms.map((term, index) => <fieldset className="owner-profitability-pay-period" key={index}><legend>Pay period {index + 1}</legend><div className="owner-profitability-pay-grid">
        <label className="field">Start date<Input aria-label={`Start date ${index + 1}`} type="date" required value={term.from} onChange={event => update(index, { from: event.target.value })} /></label>
        <label className="field">Last day (optional)<Input aria-label={`Last day ${index + 1}`} type="date" value={term.to} onChange={event => update(index, { to: event.target.value })} /></label>
        <label className="field">Annual salary ($)<Input aria-label={`Annual salary ${index + 1}`} inputMode="decimal" required value={term.salary} onChange={event => update(index, { salary: event.target.value })} /></label>
        <label className="field">Commission share (%)<Input aria-label={`Commission share ${index + 1}`} inputMode="decimal" required value={term.share} onChange={event => update(index, { share: event.target.value })} /></label>
        <Button variant="secondary" type="button"  aria-label={`Remove pay period ${index + 1}`} onClick={() => { setTerms(previous => previous.filter((_, i) => i !== index)); onChange(); }}>Remove</Button>
      </div></fieldset>)}
      {!terms.length && <p className="muted small">No pay periods. Saving will remove this employee’s compensation setup.</p>}
      <div className="form-actions"><Button variant="secondary" type="button"  onClick={() => { setTerms(previous => [...previous, { from: "", to: "", salary: "", share: "" }]); onChange(); }}>Add pay period</Button><Button variant="primary" type="submit" >{busy ? "Saving…" : "Save pay settings"}</Button>{dirty && <Button variant="secondary" type="button"  onClick={() => { setBaseline(compensation); setTerms(initialTerms(compensation)); setError(""); onChange(); }}>Discard pay changes</Button>}</div>
    </fieldset>
    <p className="muted small">The last day is included. Leave it blank for ongoing employment. Close the prior period before adding a new pay rate.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
  </form>;
}
