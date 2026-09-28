import { useCallback, useEffect, useRef, useState } from "react";
import { loadMarketingReports, saveMarketingReports, sendMarketingReport } from "../lib/marketingReports";
import type { MarketingReportRun, MarketingReportSettingsSnapshot } from "../../../shared/marketingReportSettings";

const REQUEST_KEY = "hoa-marketing-report-request";
const pending = (run: MarketingReportRun) => run.status === "queued" || run.status === "sending";
const statusLabels: Record<MarketingReportRun["status"], string> = {
  queued: "Preparing", sending: "Sending", sent: "Sent", failed: "Failed", unknown: "Delivery needs review",
};
const when = (value: string) => new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York",
}).format(new Date(value));
function savedRequest() {
  try { return sessionStorage.getItem(REQUEST_KEY) || ""; } catch { return ""; }
}
function keepRequest(value: string) {
  try { if (value) sessionStorage.setItem(REQUEST_KEY, value); else sessionStorage.removeItem(REQUEST_KEY); } catch { /* In-memory deduplication remains available. */ }
}

export default function MarketingReportSettings() {
  const [snapshot, setSnapshot] = useState<MarketingReportSettingsSnapshot | null>(null);
  const [recipient, setRecipient] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  const inFlight = useRef(false);
  const requestId = useRef(savedRequest());
  const mounted = useRef(true);

  const load = useCallback(async (adopt = false) => {
    try {
      const result = await loadMarketingReports();
      if (!mounted.current) return;
      setSnapshot(result); setReadError("");
      if (adopt) { setRecipient(result.settings.recipient); setEnabled(result.settings.enabled); }
    } catch (e) {
      if (mounted.current) setReadError(e instanceof Error ? e.message : "Could not load marketing report settings.");
    }
  }, []);

  useEffect(() => { mounted.current = true; void load(true); return () => { mounted.current = false; }; }, [load]);
  const hasPending = snapshot?.recentRuns.some(pending) ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [hasPending, load]);

  async function act(name: string, action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(name); setError(""); setMessage("");
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not complete this action. Try again."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(""); }
  }

  if (!snapshot) return <section className="card" aria-label="Marketing reports"><h2>Weekly marketing report</h2>
    <p role={readError ? "alert" : "status"}>{readError || "Loading report settings…"}</p>
    {readError && <button className="secondary" onClick={() => void load(true)}>Retry</button>}
  </section>;

  const dirty = recipient.trim() !== snapshot.settings.recipient || enabled !== snapshot.settings.enabled;
  const disabled = !!busy || !!readError;
  return <div>
    <section className="card" aria-labelledby="marketing-report-title">
      <h2 id="marketing-report-title">Weekly marketing report</h2>
      <p>A lead update using the 52-column spreadsheet layout. Each file includes the current CRM leads and converted clients, with missing information clearly identified.</p>
      <p><strong>Every Friday at 8:00 a.m. Eastern</strong> · Adjusts automatically for daylight saving time.</p>
      {snapshot.environment !== "main" && <p className="muted small">Test environment: automatic delivery is off. Manual sends are limited to approved test recipients.</p>}
      {(error || readError) && <p role="alert" className="error-text">{error || readError}</p>}
      {message && <p role="status">{message}</p>}
      <form aria-label="Marketing report settings" onSubmit={e => {
        e.preventDefault();
        void act("save", async () => {
          const result = await saveMarketingReports({ version: snapshot.settings.version, enabled, recipient: recipient.trim() });
          setSnapshot(result); setRecipient(result.settings.recipient); setEnabled(result.settings.enabled); setReadError("");
          setMessage(result.settings.enabled && result.environment === "main" ? "Saved. Weekly delivery is on for Friday at 8:00 a.m. Eastern." : "Settings saved. Automatic delivery is off.");
        });
      }}>
        <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field">Recipient email<input type="email" autoComplete="email" value={recipient} onChange={e => setRecipient(e.target.value)} required={enabled} maxLength={254} /></label>
          <label className="small"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Send automatically every Friday</label>
          <div className="form-actions"><button type="submit" className="primary" disabled={disabled || !dirty}>{busy === "save" ? "Saving…" : "Save settings"}</button></div>
        </fieldset>
      </form>
      <hr />
      <h3>Send a report now</h3>
      <p className="muted small">Email a fresh Excel snapshot to {snapshot.settings.recipient || "the saved recipient"}. This does not change the Friday schedule.</p>
      {dirty && <p className="muted small">Save your changes before sending.</p>}
      <div className="form-actions">
        <button type="button" className="primary" disabled={disabled || dirty || hasPending || !snapshot.settings.recipient} onClick={() => void act("send", async () => {
          if (!requestId.current) { requestId.current = crypto.randomUUID(); keepRequest(requestId.current); }
          const result = await sendMarketingReport(requestId.current);
          requestId.current = ""; keepRequest("");
          setSnapshot(previous => previous ? { ...previous, recentRuns: [result.run, ...previous.recentRuns.filter(r => r.id !== result.run.id)].slice(0, 10) } : previous);
          setMessage(pending(result.run) ? "Report queued. The delivery status below will update automatically." : result.run.status === "sent" ? "This report has already been sent. Its status is shown below." : "This request has already been processed. Review its delivery status below.");
        })}>{busy === "send" ? "Queuing…" : hasPending ? "Report in progress…" : "Send now"}</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void load()}>Refresh status</button>
      </div>
    </section>
    <section className="card" aria-label="Marketing report delivery history">
      <h2>Recent reports</h2>
      <p className="muted small">Times are Eastern. “Sent” means the email service accepted the message. If delivery needs review, check the original send before requesting another copy.</p>
      {!snapshot.recentRuns.length ? <p>No reports have been sent yet.</p> : <div className="table-wrap"><table>
        <thead><tr><th>Requested</th><th>Recipient</th><th>Delivery</th><th>Accounts</th></tr></thead>
        <tbody>{snapshot.recentRuns.map(run => <tr key={run.id}>
          <td>{when(run.createdAt)}<div className="muted small">{run.kind === "scheduled" ? "Friday schedule" : "Manual send"}</div></td>
          <td>{run.recipient}</td>
          <td><strong>{statusLabels[run.status]}</strong>{run.sentAt && <div className="muted small">{when(run.sentAt)}</div>}{run.error && <div className="error-text small">{run.error}</div>}</td>
          <td>{run.rowCount ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}
