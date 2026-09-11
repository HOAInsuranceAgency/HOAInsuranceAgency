import { useRef, useState } from "react";
import { communicationRequest as request, type LeadWorkflow } from "../lib/communications";
import { fmtDate, fmtDateTime } from "../lib/client";

export default function NextYearControl({ workflow, onSaved }: { workflow: LeadWorkflow; onSaved: () => void }) {
  const [preview, setPreview] = useState<{ current: string; next: string; returnAt: string } | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  if (workflow.disposition !== "ACTIVE") return null;
  return <div className="front-tool-action"><button className="secondary" disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try { setPreview(await request("nextYearPreview", { accountId: workflow.accountId })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load the incumbent date"); } finally { setBusy(false); }
  }}>Next year</button>
    <p className="muted small">Move the incumbent date ahead one year. We’ll bring this lead back 90 days before that date.</p>
    {preview && <div className="workflow-editor"><p>Incumbent expiration: <strong>{fmtDate(preview.current)} → {fmtDate(preview.next)}</strong></p><p>Returns to sales: <strong>{fmtDateTime(preview.returnAt)} Eastern</strong></p><p className="muted small">Ordinary chasing pauses. New requests and independent coverage commitments stay tracked.</p><div className="toolbar"><button className="primary" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await request("nextYear", { accountId: workflow.accountId, version: workflow.version, expiration: preview.current, requestId: requestId.current }, true); setPreview(null); requestId.current = crypto.randomUUID(); onSaved(); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not move the lead"); } finally { setBusy(false); }
    }}>Move to next year</button><button className="secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div></div>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
