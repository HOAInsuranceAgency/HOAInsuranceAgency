import { useEffect, useRef, useState } from "react";
import { ReportDownload } from "../components/ReportDownload";
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
type Snapshot = { ok: true; employees: Employee[]; compensations: Record<string, EmployeeCompensation>; report: EmployeeProfitabilityResult };
const money = (cents: number | null) => cents == null ? "Incomplete" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(cents / 100);
const dollars = (cents: number | null) => cents == null ? null : cents / 100;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const basis = "Estimated insurance commission by policy effective date and current account salesperson. Producer commission share and prorated annual salary are deducted. Cancelled policies and other operating costs are excluded.";

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
  const [window, setWindow] = useState(() => ({ from: `${today().slice(0, 4)}-01-01`, to: today() }));
  const [draft, setDraft] = useState(window), [error, setError] = useState("");
  function apply(from: string, to: string) {
    try { const next = validateProfitabilityWindow(from, to); setWindow(next); setDraft(next); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Choose valid report dates."); }
  }
  return <div className="owner-profitability">
    <header className="owner-profitability-heading"><div><p className="owner-profitability-eyebrow">Owner only</p><h1>Employee profitability</h1><p className="muted">Estimated contribution after commission share and salary.</p></div></header>
    <form className="card owner-profitability-period" aria-label="Reporting period" onSubmit={event => { event.preventDefault(); apply(draft.from, draft.to); }}>
      <div className="filter-row">
        <button type="button" className="secondary" onClick={() => apply(`${today().slice(0, 4)}-01-01`, today())}>Year to date</button>
        <label className="field">From<input aria-label="Report from" type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
        <label className="field">Through<input aria-label="Report through" type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
        <button type="submit" className="primary">Apply dates</button>
      </div>
      {error && <p role="alert" className="error-text">{error}</p>}
    </form>
    <ProfitabilitySnapshot key={`${window.from}|${window.to}`} {...window} />
  </div>;
}

function ProfitabilitySnapshot({ from, to }: { from: string; to: string }) {
  const resource = useAsyncResource(async () => response<Snapshot>(await client.queries.ownerProfitability({ from, to })), [from, to], { errorMessage: "Could not load employee profitability.", clearDataOnError: () => true });
  const [payOpen, setPayOpen] = useState(false), [employeeId, setEmployeeId] = useState(""), [paySaved, setPaySaved] = useState(false);
  const payPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (payOpen) payPanel.current?.focus(); }, [payOpen, employeeId]);
  const snapshot = resource.data;
  if (!snapshot) return <div className="card" aria-live="polite">{resource.error ? <><p role="alert" className="error-text">{resource.error}</p><button className="secondary" onClick={() => void resource.refetch()} disabled={resource.loading}>Try again</button></> : <p className="muted">Loading employee profitability…</p>}</div>;
  const { report, employees, compensations } = snapshot;
  const selected = employees.find(employee => employee.userId === employeeId) ?? employees[0];
  const setup = (userId: string) => { setEmployeeId(userId); setPaySaved(false); setPayOpen(true); };
  const totals = report.totals;
  return <>
    <div className="owner-profitability-toolbar">
      <p className="muted small">{report.from} through {report.to} · USD · Estimated</p>
      <div className="owner-profitability-actions"><button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>{resource.loading ? "Refreshing…" : "Refresh"}</button><button className="secondary" aria-expanded={payOpen} onClick={() => setPayOpen(!payOpen)}>Manage pay settings</button><ReportDownload disabled={resource.loading} report={exportReport(report)} /></div>
    </div>
    <div className="stat-row owner-profitability-summary">
      <Summary label="Agency commission" amount={totals.grossCommissionCents} known={totals.knownGrossCommissionCents} />
      <Summary label="After producer share" amount={totals.netRevenueCents} known={totals.knownNetRevenueCents} />
      <Summary label="Salary for period" amount={totals.salaryCents} known={totals.knownSalaryCents} />
      <Summary label="Estimated contribution" amount={totals.contributionCents} known={totals.knownContributionCents} />
    </div>
    {!totals.complete && <div className="owner-profitability-notice" role="status"><strong>This report is incomplete.</strong> Missing commission or pay details are not treated as zero. Known amounts are partial subtotals.</div>}
    <div className="card"><div className="card-head"><h2>Revenue and salary by employee</h2></div><p className="muted small">Revenue is agency commission after the producer’s share. Compare it with salary for the selected period.</p><ComparisonChart rows={report.rows} /></div>
    <div className="card">
      <div className="card-head"><h2>Employee breakdown</h2><span className="muted small">{totals.policyCount} policies</span></div>
      {report.rows.length ? <div className="owner-profitability-table"><table><thead><tr><th>Employee</th><th>Agency commission</th><th>Producer share</th><th>Net revenue</th><th>Salary</th><th>Est. contribution</th><th>Policies</th><th>Data status</th></tr></thead><tbody>{report.rows.map(row => <tr key={row.userId ?? "unassigned"}>
        <th scope="row">{row.name}</th><td>{money(row.grossCommissionCents)}</td><td>{money(row.producerShareCents)}</td><td>{money(row.netRevenueCents)}</td><td>{money(row.salaryCents)}</td><td className={row.contributionCents != null && row.contributionCents < 0 ? "owner-profitability-negative" : "owner-profitability-contribution"}>{money(row.contributionCents)}</td><td>{row.policyCount}</td>
        <td className="owner-profitability-data-status">{row.complete ? <span>Complete</span> : <><strong>{row.userId && !compensations[row.userId]?.terms.length ? "Needs pay setup" : "Incomplete"}</strong>{row.warnings.length > 0 && <ul>{row.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}{row.userId && employees.some(employee => employee.userId === row.userId) && <button className="secondary" onClick={() => setup(row.userId!)} aria-label={`Edit pay settings for ${row.name}`}>Edit pay settings</button>}</>}</td>
      </tr>)}</tbody></table></div> : <p className="muted">No employees or policies found for this report.</p>}
    </div>
    {payOpen && <section className="card owner-profitability-pay-panel" ref={payPanel} tabIndex={-1} aria-label="Private pay settings"><h2>Private pay settings</h2><p className="muted small">Only owners can see or change these amounts. Add a dated period for each pay change. Use 0 for unpaid salary or no commission share.</p>
      {selected ? <CompensationEditor key={`${selected.userId}:${compensations[selected.userId]?.version ?? 0}`} employee={selected} employees={employees} compensation={compensations[selected.userId]} defaultFrom={from} onSelect={id => { setEmployeeId(id); setPaySaved(false); }} onChange={() => setPaySaved(false)} onSaved={async () => { await resource.refetch(); setPaySaved(true); }} /> : <p className="muted">No employees are available.</p>}
      {paySaved && <p role="status">Pay settings saved.</p>}
    </section>}
    <section className="card owner-profitability-basis" aria-label="Report calculation basis"><h2>How this estimate works</h2><p>{basis}</p><p>Annual salary is prorated by calendar day within each dated pay period. This is an estimate of employee contribution, not collected income or accounting net profit.</p>
      <p>{report.cancelledPolicyCount} cancelled policies excluded · {report.undatedPolicyCount} policies excluded for missing or invalid effective dates.</p>
      {report.warnings.length > 0 && <ul>{report.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    </section>
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
    { title: "Employees", columns: ["Employee", "Agency commission (USD)", "Producer share (USD)", "Net revenue (USD)", "Salary (USD)", "Estimated contribution (USD)", "Policy count", "Complete", "Missing commission policies", "Missing compensation policies", "Warnings"], rows: report.rows.map(row => [row.name, dollars(row.grossCommissionCents), dollars(row.producerShareCents), dollars(row.netRevenueCents), dollars(row.salaryCents), dollars(row.contributionCents), row.policyCount, row.complete ? "Yes" : "No", row.missingCommissionCount, row.missingCompensationCount, row.warnings.join("; ")]) },
    { title: "Totals", columns: ["Amount", "Total (USD)", "Known subtotal (USD)", "Complete"], rows: ([
      ["Agency commission", report.totals.grossCommissionCents, report.totals.knownGrossCommissionCents], ["Producer share", report.totals.producerShareCents, report.totals.knownProducerShareCents], ["Net revenue", report.totals.netRevenueCents, report.totals.knownNetRevenueCents], ["Salary", report.totals.salaryCents, report.totals.knownSalaryCents], ["Estimated contribution", report.totals.contributionCents, report.totals.knownContributionCents],
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

function CompensationEditor({ employee, employees, compensation, defaultFrom, onSelect, onChange, onSaved }: { employee: Employee; employees: Employee[]; compensation?: EmployeeCompensation; defaultFrom: string; onSelect: (id: string) => void; onChange: () => void; onSaved: () => Promise<void> }) {
  const [terms, setTerms] = useState<DraftTerm[]>(() => compensation?.terms.map(toDraft) ?? [{ from: defaultFrom, to: "", salary: "", share: "" }]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const inFlight = useRef(false);
  function update(index: number, patch: Partial<DraftTerm>) { setTerms(previous => previous.map((term, i) => i === index ? { ...term, ...patch } : term)); onChange(); }
  async function save() {
    if (inFlight.current) return;
    setError(""); onChange();
    try {
      const value = validateCompensationRecord({ userId: employee.userId, version: compensation?.version ?? 0, terms: terms.map(term => ({ from: term.from, ...(term.to ? { to: term.to } : {}), annualSalaryCents: decimalHundredths(term.salary, "annual salary"), producerShareBps: decimalHundredths(term.share, "commission share") })) });
      inFlight.current = true; setBusy(true);
      response<{ ok: true; compensation: EmployeeCompensation }>(await client.mutations.saveEmployeeCompensation({ userId: employee.userId, version: value.version, terms: JSON.stringify(value.terms) }));
      await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save pay settings."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <form aria-label={`Pay settings for ${employee.name}`} onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset className="owner-profitability-pay-fields" disabled={busy}>
      <label className="field owner-profitability-employee-select">Employee<select value={employee.userId} onChange={event => onSelect(event.target.value)}>{employees.map(item => <option key={item.userId} value={item.userId}>{item.name}</option>)}</select></label>
      {terms.map((term, index) => <fieldset className="owner-profitability-pay-period" key={index}><legend>Pay period {index + 1}</legend><div className="owner-profitability-pay-grid">
        <label className="field">Start date<input aria-label={`Start date ${index + 1}`} type="date" required value={term.from} onChange={event => update(index, { from: event.target.value })} /></label>
        <label className="field">Last day (optional)<input aria-label={`Last day ${index + 1}`} type="date" value={term.to} onChange={event => update(index, { to: event.target.value })} /></label>
        <label className="field">Annual salary ($)<input aria-label={`Annual salary ${index + 1}`} inputMode="decimal" required value={term.salary} onChange={event => update(index, { salary: event.target.value })} /></label>
        <label className="field">Commission share (%)<input aria-label={`Commission share ${index + 1}`} inputMode="decimal" required value={term.share} onChange={event => update(index, { share: event.target.value })} /></label>
        <button type="button" className="secondary" aria-label={`Remove pay period ${index + 1}`} onClick={() => { setTerms(previous => previous.filter((_, i) => i !== index)); onChange(); }}>Remove</button>
      </div></fieldset>)}
      {!terms.length && <p className="muted small">No pay periods. Saving will remove this employee’s compensation setup.</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={() => { setTerms(previous => [...previous, { from: "", to: "", salary: "", share: "" }]); onChange(); }}>Add pay period</button><button type="submit" className="primary">{busy ? "Saving…" : "Save pay settings"}</button></div>
    </fieldset>
    <p className="muted small">The last day is included. Leave it blank for ongoing employment. Close the prior period before adding a new pay rate.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
  </form>;
}
