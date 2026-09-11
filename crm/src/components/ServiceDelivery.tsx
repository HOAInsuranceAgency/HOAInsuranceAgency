import type { LeadTask } from "../lib/communications";
import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import BusinessDraftButton from "./BusinessDraftButton";
export default function ServiceDelivery({ task, conversationId, onPrepare }: { task: LeadTask; conversationId: string; onPrepare: () => void }) {
  const records = useAsyncResource(() => request<{ options: { id: string; name: string; kind: "CERTIFICATE" | "DOCUMENT" }[] }>("deliveryOptions", { taskId: task.id }), [task.id, task.version], { initialData: { options: [] }, errorMessage: "Could not load prepared documents" });
  const prepare = <button className="secondary" onClick={onPrepare}>{task.serviceType === "CERTIFICATE" ? "Prepare certificate" : "Prepare requested document"}</button>;
  return <>{records.error && <p className="error-text" role="alert">{records.error}</p>}{records.data.options.map(o => <div key={o.id}><p className="muted small">{o.name}</p><BusinessDraftButton accountId={task.accountId} conversationId={conversationId} kind={o.kind} recordId={o.id} label="Prepare delivery email" /></div>)}{records.data.options.length ? <details><summary>Prepare another document</summary>{prepare}</details> : !records.loading && prepare}</>;
}
