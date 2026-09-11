import { useState } from "react";
import { Link } from "react-router-dom";
import type { MorningReport } from "../../../shared/morningReport";
import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { fmtDateTime } from "../lib/client";
import { saveReport } from "../lib/reportDownload";

export default function MorningWorkReport() {
  const report = useAsyncResource(() => request<{ report: MorningReport }>("myReport"), [], { initialData: null, errorMessage: "Could not load your morning work report" });
  const data = report.data?.report;
  const [actionError, setActionError] = useState("");
  return <section className="card" aria-label="My daily report"><div className="toolbar"><h2>Your work today</h2><div className="grow" />
    <button className="secondary" disabled={!data} onClick={() => data && saveReport({ title: "My work report", filters: data.complete ? "Complete current scope" : `Incomplete: ${data.health.join("; ")}`, sections: [{ title: "Work", columns: ["Account", "Action", "Responsible", "Why", "Due (Eastern)", "Last outreach (Eastern)", "Outreach type", "Report section"], rows: data.items.map(i => [i.account, i.title, i.responsible, i.why, i.dueAt ? fmtDateTime(i.dueAt) : "", i.lastOutreach ? fmtDateTime(i.lastOutreach) : "", i.lastOutreachKind, i.section]) }] }, { asOf: new Date(data.asOf), timezone: "America/New_York" }, "csv")}>Download report</button>
    <button className="secondary" disabled={report.loading} onClick={() => void report.refetch()}>Refresh</button></div>
    {(report.error || actionError) && <p className="error-text" role="alert">{actionError || report.error}</p>}
    {report.loading && <p role="status">Checking your work…</p>}
    {data && <><p className="muted">{data.accountCount} accounts · {data.items.length} actions · As of {fmtDateTime(data.asOf)}</p>
      {data.health.map(h => <p key={h} role="status" className="error-text">{h}</p>)}
      {data.teamCounts.length > 0 && <div className="table-wrap"><table><thead><tr><th>My sales team</th><th>Needs attention</th><th>Overdue</th></tr></thead><tbody>{data.teamCounts.map(t => <tr key={t.name}><td>{t.name}</td><td>{t.due}</td><td>{t.overdue}</td></tr>)}</tbody></table></div>}
      {!data.items.length && <p>{data.complete ? "Nothing needs attention in your report." : "No actions found yet. Coverage must be checked before calling this clear."}</p>}
      {data.items.map(item => <article className="workflow-task" key={item.id}><span className="small muted">{item.section} · {item.responsible}</span><h3>{item.account}</h3><strong>{item.title}</strong>{item.taskVersion != null && ["MANAGER", "OWNER"].includes(item.stage) && <button className="secondary" onClick={async () => { try { setActionError(""); await request("takeResponse", { taskId: item.id, version: item.taskVersion }, true); await report.refetch(); } catch (e) { setActionError(e instanceof Error ? e.message : "Could not take this response"); } }}>Handle this response</button>}<p>{item.why}</p><p className="muted small">{item.dueAt && `Due ${fmtDateTime(item.dueAt)}`}{item.lastOutreach && ` · Last ${item.lastOutreachKind}: ${fmtDateTime(item.lastOutreach)}`}</p>{item.accountId ? <Link to={`/accounts/${item.accountId}`}>Open the work →</Link> : <Link to="/lead-work">Review shared activity →</Link>}</article>)}
    </>}
  </section>;
}
