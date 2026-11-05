import { Select } from "./ui/Select";
import { Button } from "./ui/Button";
import { Table } from "./ui/Table";
import { useState } from "react";
import { Link } from "react-router-dom";
import { DeliveryReview, ReviewAction } from "./CommunicationReview";
import { WorkPagination } from "./WorkPagination";
import { useWorkItems } from "../lib/communicationWork";
import { fmtDateTime } from "../lib/client";

const queues = { ISSUE: "Connection issues", OPERATION: "Delivery queue", EVENT: "Event processing" };
export default function CommunicationDiagnostics() {
  const [kind, setKind] = useState<keyof typeof queues>("ISSUE");
  const work = useWorkItems(kind);
  return <section aria-label="Communication troubleshooting">
    <p className="muted small">Administrator tools for reviewing connection problems and queued activity.</p>
    <div className="toolbar"><label className="field">Queue<Select value={kind} onChange={e => setKind(e.target.value as keyof typeof queues)}>{Object.entries(queues).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      <Button variant="secondary"  disabled={work.loading} onClick={() => void work.refresh()}>Refresh queue</Button></div>
    {work.error && <p role="alert" className="error-text">{work.error}</p>}
    {!work.loaded ? <p>Loading queue…</p> : !work.data.items.length ? work.error ? null : <p className="muted">{work.data.nextToken ? "More records remain to be checked." : "No items in this queue."}</p> : <div className="table-wrap"><Table><thead><tr><th>Item</th><th>Details</th><th>Review</th></tr></thead><tbody>{work.data.items.map(item => <tr key={`${kind}:${item.id}`}>
      <td>{item.accountId ? <Link to={`/accounts/${item.accountId}`}>{item.name || "Open lead"}</Link> : item.provider || "Connection"}<div className="small muted">{item.type?.toLowerCase().replaceAll("_", " ")}{item.at || item.dueAt ? ` · ${fmtDateTime(item.at ?? item.dueAt)}` : ""}</div></td>
      <td>{item.message || item.error || item.state?.toLowerCase().replaceAll("_", " ") || "Pending processing"}</td>
      <td>{kind === "OPERATION" ? <DeliveryReview item={item} onSaved={() => void work.refresh()} /> : <ReviewAction id={item.id} version={item.version} event={kind === "EVENT"} onSaved={() => void work.refresh()} />}</td>
    </tr>)}</tbody></Table></div>}
    <WorkPagination work={work} />
  </section>;
}
