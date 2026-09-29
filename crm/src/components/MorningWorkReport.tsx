import { Link } from "react-router-dom";
import type { MorningReport } from "../../../shared/morningReport";
import { reportGroup } from "../../../shared/morningReport";
import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDateTime } from "../lib/client";
import { saveReport } from "../lib/reportDownload";

export default function MorningWorkReport() {
  const report = useAsyncResource(() => request<{ report: MorningReport }>("myReport"), [], { initialData: null, errorMessage: "Could not load your morning work report" });
  const data = report.data?.report;
  return <section className="card" aria-label="My daily report"><div className="toolbar"><h2>Your work today</h2><div className="grow" />
    <button className="secondary" disabled={!data} onClick={() => data && saveReport({ title: "My work report", filters: data.complete ? "Complete current scope" : `Incomplete: ${data.health.join("; ")}`, sections: [{ title: "Work", columns: ["Account", "Action", "Responsible", "Why", "Due (Eastern)", "Last outreach (Eastern)", "Outreach type", "Report section"], rows: data.items.map(i => [i.account, i.title, i.responsible, i.why, i.dueAt ? fmtDateTime(i.dueAt) : "", i.lastOutreach ? fmtDateTime(i.lastOutreach) : "", i.lastOutreachKind, i.section]) }] }, { asOf: new Date(data.asOf), timezone: "America/New_York" }, "csv")}>Download report</button>
    <button className="secondary" disabled={report.loading} onClick={() => void report.refetch()}>Refresh</button></div>
    {report.error && <p className="error-text" role="alert">{report.error}</p>}
    {report.loading && <p role="status">Checking your work…</p>}
    {data && <><p className="muted">{data.accountCount} account{data.accountCount === 1 ? "" : "s"} · {data.items.length} action{data.items.length === 1 ? "" : "s"} · As of {fmtDateTime(data.asOf)}</p>
      {data.health.map(h => <p key={h} role="status" className="error-text">{h}</p>)}
      {!data.items.length && <p>{data.complete ? "Nothing needs attention in your report." : "No actions found yet. Resolve the report issues before treating this as complete."}</p>}
      {["Sales", "Client and carrier", "Setup and data"].map(group => {
        const items = data.items.filter(i => reportGroup(i) === group);
        if (!items.length) return null;
        const content = items.map(item => <article className="workflow-task" key={item.id}><span className="small muted">{item.section} · {item.role && `${item.role}: `}{item.responsible}</span><h3>{item.account}</h3><strong>{item.title}</strong><p>{item.why}</p><p className="muted small">{item.dueAt && `Due ${fmtDateTime(item.dueAt)}`}{item.lastOutreach && ` · Last ${item.lastOutreachKind}: ${fmtDateTime(item.lastOutreach)}`}</p>{item.blockerOwner && <p>Blocker owner: {item.blockerOwner} · Review {fmtDateTime(item.blockerReviewAt!)}</p>}<p>{item.next}</p>{item.url?.startsWith("https://") ? <a href={item.url} target="_blank" rel="noreferrer">{item.linkLabel ?? "Open the work"} →</a> : <Link to={item.url ?? (item.accountId ? `/accounts/${item.accountId}` : "/lead-work")}>{item.linkLabel ?? "Open the work"} →</Link>}</article>);
        return group === "Setup and data" ? <details key={group}><summary>{group} · {items.length} issues</summary>{content}</details> : <section key={group} aria-label={group}><h3>{group} · {items.length} action{items.length === 1 ? "" : "s"}</h3>{content}</section>;
      })}
    </>}
  </section>;
}
