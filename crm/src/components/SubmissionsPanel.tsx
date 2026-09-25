import { Field } from "./ui/kit";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { client, type Account } from "../lib/client";
import { listAllPages } from "../lib/pagination";
import { useAsyncResource } from "../lib/useAsyncResource";
import { businessDate, eligibleEstimate, lastEffectiveDate, object, partialInput, portalUrl, submissionStatus, type SubmissionDetails } from "../../amplify/functions/honeycomb/submission-contract";
import type { Schema } from "../../amplify/data/resource";
import "./SubmissionsPanel.css";

type Submission = Schema["HoneycombSubmission"]["type"];
type Estimate = Schema["HoneycombEstimate"]["type"];
const labels: Record<string, string> = { PENDING: "Queued", RUNNING: "Creating submission…", CREATED: "Created", EXISTING: "Existing submission linked", REJECTED: "Needs correction", UNKNOWN: "Check Honeycomb before retrying" };
const pretty = (value: string) => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } };
export function initialDetails(account: Account): SubmissionDetails {
  const date = account.currentPolicyExpiration;
  return { address: [account.address, account.city, account.state, account.zip].filter(Boolean).join(", "), nameInsured: account.legalName || account.name,
    effectiveDate: date && date >= businessDate() && date <= lastEffectiveDate() ? date : "",
    numUnits: account.unitCount ?? "", yearBuilt: account.yearBuilt ?? "", numStories: account.stories ?? "" };
}
export default function SubmissionsPanel({ account, initialEstimateId }: { account: Account; initialEstimateId?: string }) {
  const [open, setOpen] = useState<boolean | undefined>(initialEstimateId ? true : undefined);
  const [retry, setRetry] = useState<Submission>();
  const [queuedId, setQueuedId] = useState("");
  const resource = useAsyncResource(async () => {
    const [submissions, estimates, settings] = await Promise.all([
      listAllPages(async nextToken => {
        const page = await client.models.HoneycombSubmission.listHoneycombSubmissionByAccountId({ accountId: account.id }, { nextToken });
        if (page.errors?.length) throw new Error("Unable to load submissions."); return page;
      }),
      listAllPages(async nextToken => {
        const page = await client.models.HoneycombEstimate.listHoneycombEstimateByAccountId({ accountId: account.id }, { nextToken });
        if (page.errors?.length) throw new Error("Unable to load estimates."); return page;
      }),
      client.queries.honeycombSubmissionSettings(),
    ]);
    if (settings.errors?.length) throw new Error("Unable to check submission availability.");
    return { submissions: submissions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), estimates: estimates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), enabled: object(settings.data).enabled === true };
  }, [account.id]);
  const records = resource.data?.submissions ?? [];
  const pending = records.some(r => ["PENDING", "RUNNING"].includes(submissionStatus(r))) || !!queuedId && !records.some(r => r.id === queuedId);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void resource.refetch(), 5000);
    return () => clearInterval(timer);
  }, [pending, resource.refetch]);
  return <section className="hc-submissions" aria-label="Carrier submissions">
    <div className="hc-heading"><div><h2>Honeycomb submission</h2><p className="muted">Create a Honeycomb partial submission, then finish it in the carrier portal.</p></div>
      {resource.data?.enabled && account.type === "ASSOCIATION" && <button className="primary" onClick={() => { setRetry(undefined); setOpen(true); }}>New submission</button>}
    </div>
    {resource.data?.enabled && <p className="hc-notice">Staging · For testing. Partial submissions stay on this account; they do not create a bindable quote or change a Lead to a Client.</p>}
    {resource.error && <p role="alert" className="error-text">{resource.error} <button className="secondary" onClick={() => void resource.refetch()}>Refresh</button></p>}
    {!resource.loaded && <p role="status">Loading submissions…</p>}
    {resource.data && !resource.data.enabled && <div className="empty-state"><strong>Honeycomb integration is not available in this environment</strong><p>It is currently enabled in staging only. Continue with your normal carrier submission process, then record the returned quote in Coverage &amp; markets → Quotes.</p></div>}
    {account.type !== "ASSOCIATION" && <p>This Honeycomb workflow supports association accounts.</p>}
    {resource.data?.enabled && !resource.error && account.type === "ASSOCIATION" && (open ?? (!records.length && !queuedId)) && <Composer
      key={retry ? `${retry.id}:${retry.attempt}` : "new"} account={account} estimates={resource.data.estimates} records={records} retry={retry}
      initialEstimateId={retry?.sourceEstimateId ?? initialEstimateId} onCancel={() => { setOpen(false); setRetry(undefined); }}
      onQueued={id => { setQueuedId(id); setOpen(false); setRetry(undefined); void resource.refetch(); }} />}
    {queuedId && !records.some(r => r.id === queuedId) && <p role="status">Request saved. Loading its status… <button className="secondary" onClick={() => void resource.refetch()}>Refresh</button></p>}
    {resource.loaded && <div className="hc-heading"><h3>Submission history</h3><button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>Refresh</button></div>}
    {records.map(record => <SubmissionCard key={record.id} record={record} enabled={resource.data?.enabled === true} refresh={resource.refetch}
      onRetry={() => { setRetry(record); setOpen(true); }} />)}
  </section>;
}
function Composer({ account, estimates, records, retry, initialEstimateId, onCancel, onQueued }: {
  account: Account; estimates: Estimate[]; records: Submission[]; retry?: Submission; initialEstimateId?: string; onCancel: () => void; onQueued: (id: string) => void;
}) {
  const eligible = estimates.filter(eligibleEstimate);
  const [sourceId, setSourceId] = useState(initialEstimateId ?? "");
  const source = eligible.find(e => e.id === sourceId);
  const [details, setDetails] = useState<SubmissionDetails>(() => retry ? { ...object(object(retry.input).submissionData), address: object(retry.input).address } as SubmissionDetails : initialDetails(account));
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const original = source ? object(source.input) : {}, originalData = object(original.submissionData);
  const form = { ...details, ...(source ? { ...originalData, address: original.address } : {}) } as SubmissionDetails;
  const duplicate = records.find(r => r.effectiveDate === details.effectiveDate && (!retry || r.id !== retry.id));
  const change = (key: keyof SubmissionDetails, value: string) => { setDetails(d => ({ ...d, [key]: value })); setReviewed(false); setError(""); };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (lock.current) return;
    if (sourceId && !source) { setError("This estimate is not eligible for conversion. Choose another estimate or enter property details."); return; }
    if (!reviewed) { setError("Review and confirm the property details first."); return; }
    try { partialInput(form, source); } catch (err) { setError((err as Error).message); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await client.mutations.startHoneycombSubmission({ accountId: account.id, details: JSON.stringify(form), sourceEstimateId: source?.id, reviewed, retryVersion: retry?.updatedAt });
      const receipt = object(result.data);
      if (result.errors?.length || receipt.ok !== true || typeof receipt.id !== "string") throw new Error(typeof receipt.error === "string" ? receipt.error : "Could not confirm the request. Refresh submission history before trying again.");
      onQueued(receipt.id);
    } catch (err) { setError((err as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <form className="card hc-composer" onSubmit={event => void submit(event)} aria-label="Review Honeycomb submission">
    <h3>{retry ? "Correct and retry submission" : "Review property details"}</h3>
    <Field className="field"><label htmlFor="hc-source">Start from</label><select id="hc-source" value={sourceId} disabled={busy} onChange={e => { setSourceId(e.target.value); setReviewed(false); setError(""); }}>
      <option value="">No linked estimate — enter property details</option>
      {sourceId && !source && <option value={sourceId}>Selected estimate is no longer eligible</option>}
      {eligible.map(e => <option value={e.id} key={e.id}>Website estimate · {new Date(e.createdAt).toLocaleDateString()} · {e.price != null ? `$${e.price.toLocaleString("en-US")}` : "Eligible"} · {e.estimationId}</option>)}
    </select></Field>
    {source && <p className="small muted">Honeycomb estimate {source.estimationId} is linked. Its original property details are preserved below.</p>}
    {!source && <p className="small muted">Enter known property details. Unanswered optional questions will be completed in Honeycomb.</p>}
    <fieldset disabled={busy} className="hc-fields"><div className="form-grid">
      <Field className="field hc-full"><label htmlFor="hc-name">Legal insured name *</label><input id="hc-name" required maxLength={200} value={form.nameInsured} readOnly={originalData.nameInsured != null} onChange={e => change("nameInsured", e.target.value)} /></Field>
      <Field className="field hc-full"><label htmlFor="hc-address">Full property address *</label><input id="hc-address" required maxLength={800} value={form.address} readOnly={!!source} onChange={e => change("address", e.target.value)} /></Field>
      <Field className="field"><label htmlFor="hc-date">Effective date *</label><input id="hc-date" type="date" required min={businessDate()} max={lastEffectiveDate()} value={form.effectiveDate} readOnly={!!retry || originalData.effectiveDate != null} onChange={e => change("effectiveDate", e.target.value)} /></Field>
      <Field className="field"><label htmlFor="hc-type">Property type</label><select id="hc-type" value={form.buildingType ?? ""} disabled={!!source} onChange={e => change("buildingType", e.target.value)}><option value="">Not yet confirmed</option><option value="condominium">Condominium association</option></select></Field>
      {([['grossSQFeet', 'Total building area (sq ft)'], ['replacementValue', 'Building replacement cost ($)'], ['numUnits', 'Number of units'], ['yearBuilt', 'Year built'], ['numStories', 'Stories']] as const).map(([key, label]) => <Field className="field" key={key}><label htmlFor={`hc-${key}`}>{label}</label><input id={`hc-${key}`} inputMode={key === "grossSQFeet" || key === "replacementValue" ? "decimal" : "numeric"} value={formatInput(form[key], key === "yearBuilt")} readOnly={originalData[key] != null} onChange={e => { const raw = e.target.value.replaceAll(",", ""); if (/^\d*(\.\d*)?$/.test(raw)) change(key, raw); }} /></Field>)}
    </div></fieldset>
    <p className="small muted">Replacement cost means the cost to rebuild the buildings. Confirm it separately from the account’s total insured value.</p>
    <label className="hc-review"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} /><span>I reviewed these details and want to create a partial submission in Honeycomb staging.</span></label>
    {duplicate && <p role="status">A submission already exists for this effective date. Review its status in the history below.</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="hc-actions"><button className="primary" disabled={busy || !reviewed || !!duplicate || !!sourceId && !source} type="submit">{busy ? "Saving request…" : retry ? "Retry partial submission" : "Create partial submission"}</button><button className="secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
function formatInput(value: string | number | undefined, year: boolean) {
  const raw = String(value ?? ""); if (year) return raw;
  const [integer, decimal] = raw.split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (decimal === undefined ? "" : `.${decimal}`);
}
function SubmissionCard({ record, enabled, refresh, onRetry }: { record: Submission; enabled: boolean; refresh: () => Promise<void>; onRetry: () => void }) {
  const status = submissionStatus(record), pending = ["PENDING", "RUNNING"].includes(status);
  const link = record.submissionId ? portalUrl(record.submissionId) : undefined;
  const declined = record.submissionStatus?.toLowerCase() === "declined";
  return <article className="card hc-submission" aria-label={`Submission effective ${record.effectiveDate}`}>
    <div className="hc-heading"><h3>Effective {record.effectiveDate}</h3><span className={`badge ${declined ? "red" : pending ? "blue" : status === "UNKNOWN" || status === "REJECTED" ? "amber" : "green"}`} role={pending ? "status" : undefined}>{declined ? "Declined by Honeycomb" : labels[status] ?? status}</span></div>
    <p className="small muted">Requested {new Date(record.requestedAt).toLocaleString()} · Attempt {record.attempt}{record.estimationId ? ` · Estimate ${record.estimationId}` : ""}</p>
    {pending && <p role="status">{status === "PENDING" ? "Your request is saved and waiting to be processed." : "Honeycomb is creating the partial submission. This may take about a minute."} You can leave this tab and return.</p>}
    {link && <><p><strong>Honeycomb status: {record.submissionStatus}</strong>{record.readableSubmissionId ? ` · ${record.readableSubmissionId}` : ""}</p><p><a className="secondary" href={link} target="_blank" rel="noopener noreferrer">Open in Honeycomb ↗</a></p><p className="small muted">Complete and review the remaining application in Honeycomb. Status shown here is from creation or manual review.</p></>}
    {status === "REJECTED" && <><p>Honeycomb did not create this submission. Review the response and correct the details before retrying.</p>{enabled && record.attempt < 5 && <button className="secondary" onClick={onRetry}>Review and retry</button>}</>}
    {status === "UNKNOWN" && <><p>Honeycomb may have created this submission. Check the staging portal or confirm with Honeycomb before recording an outcome below.</p>{enabled && <Recovery record={record} refresh={refresh} />}</>}
    {record.issue && <p className="small muted">Result: {record.issue}</p>}
    {record.resolutionNote && <p className="small">Review note: {record.resolutionNote}</p>}
    {record.result && <details><summary>Carrier response</summary><pre>{pretty(record.result)}</pre></details>}
    <details><summary>Submitted details</summary><pre>{pretty(record.input)}</pre></details>
    {record.history && record.history !== "[]" && <details><summary>Previous attempts</summary><pre>{pretty(record.history)}</pre></details>}
  </article>;
}
function Recovery({ record, refresh }: { record: Submission; refresh: () => Promise<void> }) {
  const [outcome, setOutcome] = useState("LINK_EXISTING"), [id, setId] = useState(""), [note, setNote] = useState(""), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  async function save(event: FormEvent) {
    event.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await client.mutations.resolveHoneycombSubmission({ id: record.id, outcome, submissionId: id.trim() || undefined, note, reviewed });
      const receipt = object(result.data);
      if (result.errors?.length || receipt.ok !== true) throw new Error(typeof receipt.error === "string" ? receipt.error : "Could not save the review. Refresh and try again.");
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <details><summary>Record portal review</summary><form className="hc-recovery" onSubmit={event => void save(event)}>
    <Field className="field"><label htmlFor={`${record.id}-outcome`}>Review outcome</label><select id={`${record.id}-outcome`} value={outcome} disabled={busy} onChange={e => { setOutcome(e.target.value); setReviewed(false); }}><option value="LINK_EXISTING">Found an existing submission</option><option value="NOT_CREATED">Confirmed no submission was created</option></select></Field>
    {outcome === "LINK_EXISTING" && <Field className="field"><label htmlFor={`${record.id}-carrier`}>Submission ID from Honeycomb portal URL</label><input id={`${record.id}-carrier`} required value={id} disabled={busy} onChange={e => setId(e.target.value)} /></Field>}
    <Field className="field"><label htmlFor={`${record.id}-note`}>Review note</label><textarea id={`${record.id}-note`} required maxLength={2000} value={note} disabled={busy} onChange={e => setNote(e.target.value)} /></Field>
    <label className="hc-review"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} /><span>I verified this outcome in the Honeycomb portal or with their team.</span></label>
    {error && <p role="alert">{error}</p>}<button className="secondary" disabled={!reviewed || busy} type="submit">{busy ? "Saving review…" : "Save review outcome"}</button>
  </form></details>;
}
