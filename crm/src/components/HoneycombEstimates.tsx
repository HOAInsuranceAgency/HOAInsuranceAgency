import { Link } from "react-router-dom";
import { eligibleEstimate } from "../../amplify/functions/honeycomb/submission-contract";
import { listAllPages } from "../lib/pagination";
import { useEffect } from "react";
import { client } from "../lib/client";
import { useAsyncResource } from "../lib/useAsyncResource";
import { isAuthorizationError } from "../lib/authorizationError";
import { visibleStatus } from "../../amplify/functions/honeycomb/contract";

export default function HoneycombEstimates({ accountId }: { accountId: string }) {
  const resource = useAsyncResource(async () => {
    return listAllPages(async nextToken => {
      const result = await client.models.HoneycombEstimate.listHoneycombEstimateByAccountId({ accountId }, { nextToken });
      return result;
    });
  }, [accountId], { initialData: [], errorMessage: "Carrier estimates could not be loaded.", clearDataOnError: isAuthorizationError });
  const pending = resource.data.some(r => ["PENDING", "RUNNING"].includes(visibleStatus(r)));
  useEffect(() => {
    if (!pending || resource.loading) return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void resource.refetch().finally(() => { polling = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [pending, resource.loading, resource.refetch]);
  if (!resource.data.length && !resource.error) return null;
  return <section className="card" style={{ marginBottom: 20 }} aria-label="Honeycomb estimates">
    <h3>Honeycomb · staging estimates</h3>
    <p className="muted small">Directional indications only. No application has been submitted to underwriting.</p>
    {resource.error && <p role="alert">{resource.error} <button onClick={() => void resource.refetch()}>Retry</button></p>}
    {resource.data.map(record => {
      const status = visibleStatus(record);
      return <div key={record.id} style={{ marginBottom: 16 }}>
        <strong>{status.replaceAll("_", " ")}</strong>
        {record.price != null && <span> · {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(record.price)}</span>}
        <p className="muted small">{new Date(record.createdAt).toLocaleString()}{record.estimationId ? ` · ${record.estimationId}` : ""}</p>
        {eligibleEstimate(record) && <p><Link to={`?tab=submissions&estimate=${encodeURIComponent(record.id)}`}>Start submission from this estimate →</Link></p>}
        {record.issue && <p className="small">{record.issue}</p>}
        {status === "TIMED_OUT" && <p className="small">The request did not finish in time. Continue agent follow-up; the website retains its normal confirmation.</p>}
        {record.result && <details><summary>Carrier response (internal)</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{pretty(record.result)}</pre></details>}
        {record.input && <details><summary>Submitted property details</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{pretty(record.input)}</pre></details>}
      </div>;
    })}
  </section>;
}
function pretty(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
