import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Table } from "./ui/Table";
import { liveUpdates } from "../lib/liveUpdates";
import { useLiveRefresh, useLiveUpdateBlock } from "../lib/useLiveUpdates";
import { isAuthorizationError } from "../lib/authorizationError";
import { mergeLiveSnapshot } from "../lib/liveSnapshot";
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
type PendingRequest = { requestId: string; runId: string | null };
function savedRequest(): PendingRequest {
  try {
    const value = sessionStorage.getItem(REQUEST_KEY);
    if (value) {
      // Previous releases stored only the opaque request UUID.
      let saved: unknown;
      try { saved = JSON.parse(value); } catch { return { requestId: value, runId: null }; }
      if (saved && typeof saved === 'object' && 'requestId' in saved && typeof saved.requestId === 'string') {
        return { requestId: saved.requestId, runId: 'runId' in saved && typeof saved.runId === 'string' ? saved.runId : null };
      }
    }
  } catch { /* Storage may be unavailable. */ }
  return { requestId: "", runId: null };
}
function keepRequest(value: string, runId: string | null = null) {
  try { if (value) sessionStorage.setItem(REQUEST_KEY, JSON.stringify({ requestId: value, runId })); else sessionStorage.removeItem(REQUEST_KEY); } catch { /* In-memory deduplication remains available. */ }
}

export default function MarketingReportSettings() {
  const [snapshot, setSnapshot] = useState<MarketingReportSettingsSnapshot | null>(null);
  const [recipient, setRecipient] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [isEdited, setIsEdited] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  const inFlight = useRef(false);
  const [initialRequest] = useState(savedRequest);
  const requestId = useRef(initialRequest.requestId);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const reading = useRef(false);
  const edited = useRef(false);
  const draftVersion = useRef(0);
  const draftBaseline = useRef({ recipient: "", enabled: false });
  const currentDraft = useRef({ recipient: "", enabled: false });
  const adoptSettings = useCallback((settings: MarketingReportSettingsSnapshot['settings']) => {
    draftVersion.current = settings.version;
    draftBaseline.current = { recipient: settings.recipient, enabled: settings.enabled };
    currentDraft.current = { ...draftBaseline.current };
    edited.current = false; setIsEdited(false); setRecipient(settings.recipient); setEnabled(settings.enabled);
  }, []);
  function editSettings(patch: Partial<typeof currentDraft.current>) {
    ++draftEdits.current;
    const next = { ...currentDraft.current, ...patch }; currentDraft.current = next;
    edited.current = next.recipient.trim() !== draftBaseline.current.recipient || next.enabled !== draftBaseline.current.enabled;
    // Reverting an old draft also adopts any saved settings received while it
    // was dirty, so the displayed recipient agrees with the next explicit send.
    if (!edited.current && snapshotRef.current && snapshotRef.current.settings.version > draftVersion.current) {
      adoptSettings(snapshotRef.current.settings); return;
    }
    setIsEdited(edited.current); setRecipient(next.recipient); setEnabled(next.enabled);
  }

  const snapshotRef = useRef(snapshot);
  const actionVersion = useRef(0);
  const draftEdits = useRef(0);
  const denied = useRef(false);
  const acknowledgedRun = useRef(initialRequest.runId);
  const publish = useCallback((value: MarketingReportSettingsSnapshot | null) => {
    snapshotRef.current = value; setSnapshot(value);
  }, []);
  const clearDenied = useCallback((failure: unknown) => {
    if (!mounted.current) return;
    denied.current = true; ++readVersion.current; ++actionVersion.current;
    reading.current = false; adoptSettings({ version: 0, recipient: "", enabled: false });
    publish(null); setError(""); setMessage("");
    setReadError(failure instanceof Error ? failure.message : "You don't have permission to view marketing reports.");
  }, [adoptSettings, publish]);

  const load = useCallback(async (adopt = false, background = false): Promise<boolean> => {
    if (inFlight.current || reading.current) return false;
    const fence = liveUpdates.getSnapshot();
    if (background && !liveUpdates.canPublish(fence, false)) return false;
    const version = ++readVersion.current;
    reading.current = true;
    try {
      const incoming = await loadMarketingReports();
      if (!mounted.current || version !== readVersion.current) return true;
      if (background && !liveUpdates.canPublish(fence, false)) return false;
      const previous = snapshotRef.current;
      const knownRuns = new Map(previous?.recentRuns.map(run => [run.id, run]));
      const runs = incoming.recentRuns.map(run => {
        const known = knownRuns.get(run.id);
        // A request id is never requeued by the API after a terminal result.
        return known && !pending(known) && pending(run) ? known : run;
      });
      const result = {
        ...incoming,
        settings: previous && previous.settings.version > incoming.settings.version ? previous.settings : incoming.settings,
        recentRuns: mergeLiveSnapshot(previous?.recentRuns ?? [], runs),
      };
      denied.current = false; publish(result); setReadError("");
      if (acknowledgedRun.current && result.recentRuns.some(run => run.id === acknowledgedRun.current && !pending(run))) {
        acknowledgedRun.current = null; requestId.current = ""; keepRequest("");
      }
      if (adopt || !edited.current) adoptSettings(result.settings);
    } catch (failure) {
      if (!mounted.current || version !== readVersion.current) return true;
      if (isAuthorizationError(failure)) clearDenied(failure);
      else if (background && !liveUpdates.canPublish(fence, false)) return false;
      else setReadError(failure instanceof Error ? failure.message : "Could not load marketing report settings.");
    } finally { if (version === readVersion.current) reading.current = false; }
    return true;
  }, [adoptSettings, clearDenied, publish]);

  useEffect(() => { mounted.current = true; void load(true); return () => { mounted.current = false; ++readVersion.current; ++actionVersion.current; reading.current = false; }; }, [load]);
  const hasPending = snapshot?.recentRuns.some(pending) ?? false;
  const dirty = !!snapshot && isEdited;
  useLiveUpdateBlock(dirty);
  useLiveUpdateBlock(!!busy, 'write');
  // Fixed registrations preserve the four-second pending deadline, including
  // when the first snapshot is queued. Only one reader is enabled at a time.
  useLiveRefresh(() => load(false, true), { enabled: !hasPending, paused: !!busy, topics: ['CRM'], protectEdits: false, onDenied: clearDenied });
  useLiveRefresh(() => load(false, true), { enabled: hasPending, paused: !!busy, topics: ['CRM'], intervalMs: 4000, protectEdits: false, onDenied: clearDenied });

  async function act(name: string, action: (current: () => boolean) => Promise<void>) {
    if (inFlight.current || denied.current) return;
    const version = ++actionVersion.current;
    ++readVersion.current; reading.current = false;
    const release = liveUpdates.acquireBlock('write');
    inFlight.current = true; setBusy(name); setError(""); setMessage("");
    const current = () => mounted.current && version === actionVersion.current && !denied.current;
    try { await action(current); }
    catch (failure) {
      if (current()) {
        if (isAuthorizationError(failure)) clearDenied(failure);
        else setError(failure instanceof Error ? failure.message : "Could not complete this action. Try again.");
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(""); release(); }
  }

  if (!snapshot) return <section className="card" aria-label="Marketing reports"><h2>Weekly marketing report</h2>
    <p role={readError ? "alert" : "status"}>{readError || "Loading report settings…"}</p>
    {readError && <Button variant="secondary"  disabled={!!busy} onClick={() => void load(true)}>Retry</Button>}
  </section>;

  const disabled = !!busy || !!readError;
  return <div>
    <section className="card" aria-labelledby="marketing-report-title">
      <h2 id="marketing-report-title">Weekly marketing report</h2>
      <p>A lead update with property types and unit counts. Each spreadsheet includes the current CRM leads and converted clients, with missing information clearly identified.</p>
      <p><strong>Every Friday at 8:00 a.m. Eastern</strong> · Adjusts automatically for daylight saving time.</p>
      {snapshot.environment !== "main" && <p className="muted small">Test environment: automatic delivery is off. Manual sends are limited to approved test recipients.</p>}
      {(error || readError) && <p role="alert" className="error-text">{error || readError}{readError && <> <Button variant="secondary" type="button" disabled={!!busy} onClick={() => void load()}>Retry</Button></>}</p>}
      {message && <p role="status">{message}</p>}
      <form aria-label="Marketing report settings" onSubmit={e => {
        e.preventDefault();
        const submittedEdit = draftEdits.current;
        void act("save", async current => {
          const result = await saveMarketingReports({ version: draftVersion.current, enabled, recipient: recipient.trim() });
          if (!current()) return;
          draftVersion.current = result.settings.version; publish(result); setReadError("");
          if (submittedEdit === draftEdits.current) adoptSettings(result.settings);
          else {
            draftBaseline.current = { recipient: result.settings.recipient, enabled: result.settings.enabled };
            edited.current = currentDraft.current.recipient.trim() !== result.settings.recipient || currentDraft.current.enabled !== result.settings.enabled;
            setIsEdited(edited.current);
          }
          setMessage(result.settings.enabled && result.environment === "main" ? "Saved. Weekly delivery is on for Friday at 8:00 a.m. Eastern." : "Settings saved. Automatic delivery is off.");
        });
      }}>
        <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field">Recipient email<Input type="email" autoComplete="email" value={recipient} onChange={e => editSettings({ recipient: e.target.value })} required={enabled} maxLength={254} /></label>
          <label className="small"><Input type="checkbox" checked={enabled} onChange={e => editSettings({ enabled: e.target.checked })} /> Send automatically every Friday</label>
          <div className="form-actions"><Button variant="primary" type="submit"  disabled={disabled || !dirty}>{busy === "save" ? "Saving…" : "Save settings"}</Button>{dirty && <Button variant="secondary" type="button"  onClick={() => { const latest = snapshotRef.current; if (!latest) return; ++draftEdits.current; adoptSettings(latest.settings); setError(""); }}>Discard changes</Button>}</div>
        </fieldset>
      </form>
      <hr />
      <h3>Send a report now</h3>
      <p className="muted small">Email a fresh Excel snapshot to {snapshot.settings.recipient || "the saved recipient"}. This does not change the Friday schedule.</p>
      {dirty && <p className="muted small">Save your changes before sending.</p>}
      <div className="form-actions">
        <Button variant="primary" type="button"  disabled={disabled || dirty || hasPending || !snapshot.settings.recipient} onClick={() => void act("send", async current => {
          if (!requestId.current) { requestId.current = crypto.randomUUID(); keepRequest(requestId.current); }
          const result = await sendMarketingReport(requestId.current);
          if (!current()) return;
          // Keep an acknowledged queued request id until a terminal read. If
          // the history index briefly lags, another click still deduplicates.
          acknowledgedRun.current = pending(result.run) ? result.run.id : null;
          if (!pending(result.run)) requestId.current = "";
          keepRequest(requestId.current, acknowledgedRun.current);
          const previous = snapshotRef.current;
          if (previous) publish({ ...previous, recentRuns: [result.run, ...previous.recentRuns.filter(r => r.id !== result.run.id)].slice(0, 10) });
          setMessage(pending(result.run) ? "Report queued. The delivery status below will update automatically." : result.run.status === "sent" ? "This report has already been sent. Its status is shown below." : "This request has already been processed. Review its delivery status below.");
        })}>{busy === "send" ? "Queuing…" : hasPending ? "Report in progress…" : "Send now"}</Button>
      </div>
    </section>
    <section className="card" aria-label="Marketing report delivery history">
      <h2>Recent reports</h2>
      <p className="muted small">Times are Eastern. “Sent” means the email service accepted the message. If delivery needs review, check the original send before requesting another copy.</p>
      {!snapshot.recentRuns.length ? <p>No reports have been sent yet.</p> : <div className="table-wrap"><Table>
        <thead><tr><th>Requested</th><th>Recipient</th><th>Delivery</th><th>Accounts</th></tr></thead>
        <tbody>{snapshot.recentRuns.map(run => <tr key={run.id}>
          <td>{when(run.createdAt)}<div className="muted small">{run.kind === "scheduled" ? "Friday schedule" : "Manual send"}</div></td>
          <td>{run.recipient}</td>
          <td><strong>{statusLabels[run.status]}</strong>{run.sentAt && <div className="muted small">{when(run.sentAt)}</div>}{run.error && <div className="error-text small">{run.error}</div>}</td>
          <td>{run.rowCount ?? "—"}</td>
        </tr>)}</tbody>
      </Table></div>}
    </section>
  </div>;
}
