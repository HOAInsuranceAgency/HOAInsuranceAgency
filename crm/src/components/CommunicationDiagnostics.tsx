import { useState } from "react";
import { Link } from "react-router-dom";
import { DeliveryReview, ReviewAction } from "./CommunicationReview";
import { WorkPagination } from "./LeadWorkExtras";
import { useWorkItems } from "../lib/communicationWork";
import { fmtDateTime } from "../lib/client";
import ReportDeliveryReview from "./ReportDeliveryReview";

const queues = { ISSUE: "Connection issues", OPERATION: "Delivery queue", EVENT: "Event processing" };
export default function CommunicationDiagnostics() {
  const [kind, setKind] = useState<keyof typeof queues>("ISSUE");
  const work = useWorkItems(kind);
  return <section aria-label="Communication troubleshooting">
    <p className="muted small">Administrator tools for reviewing connection problems and queued activity. Lead follow-up stays on the staff work list.</p>
    <div className="toolbar"><label className="field">Queue<select value={kind} onChange={e => setKind(e.target.value as keyof typeof queues)}>{Object.entries(queues).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="secondary" disabled={work.loading} onClick={() => void work.refresh()}>Refresh queue</button></div>
    {work.error && <p role="alert" className="error-text">{work.error}</p>}
    {work.loading ? <p>Loading queue…</p> : work.error ? null : !work.data.items.length ? <p className="muted">{work.data.nextToken ? "More records remain to be checked." : "No items in this queue."}</p> : <div className="table-wrap"><table><thead><tr><th>Item</th><th>Details</th><th>Review</th></tr></thead><tbody>{work.data.items.map(item => <tr key={item.id}>
      <td>{item.accountId ? <Link to={`/accounts/${item.accountId}`}>{item.name || "Open lead"}</Link> : item.provider || "Connection"}<div className="small muted">{item.type?.toLowerCase().replaceAll("_", " ")}{item.at || item.dueAt ? ` · ${fmtDateTime(item.at ?? item.dueAt)}` : ""}</div></td>
      <td>{item.message || item.error || item.state?.toLowerCase().replaceAll("_", " ") || "Pending processing"}</td>
      <td>{kind === "OPERATION" ? <DeliveryReview item={item} onSaved={() => void work.refresh()} /> : <ReviewAction id={item.id} version={item.version} event={kind === "EVENT"} onSaved={() => void work.refresh()} />}</td>
    </tr>)}</tbody></table></div>}
    <WorkPagination work={work} />
    <details><summary>Morning report delivery</summary><ReportDeliveryReview /></details>
  </section>;
}
