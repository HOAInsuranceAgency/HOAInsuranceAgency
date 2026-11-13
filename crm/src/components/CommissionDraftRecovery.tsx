import { useEffect, useRef, useState, type ReactNode } from "react";
import { commissionAction } from "../lib/commissions";
import { useAsyncResource } from "../lib/useAsyncResource";
import type { IntakeWorkingDraft, StatementIntake } from "../../../shared/commissionIntake";

function SavedValues({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="muted">Not entered</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (Array.isArray(value)) return <ol>{value.map((v, i) => <li key={i}><SavedValues value={v} /></li>)}</ol>;
  return <dl className="intake-saved-values">{Object.entries(value).map(([key, v]) =>
    <div key={key}><dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>
      {key.endsWith("Cents") && typeof v === "number" ? new Intl.NumberFormat("en-US", {style:"currency",currency:"USD"}).format(v/100) : <SavedValues value={v} />}
    </dd></div>)}</dl>;
}
export default function CommissionDraftRecovery<T extends object>({
  intake, scope, value, restore, disabled, onError,
}: {
  intake: StatementIntake; scope: string; value: T; restore: (data: T) => void;
  disabled?: boolean; onError: (error: unknown) => void;
}) {
  const resource = useAsyncResource(
    async () => {
      try { return await commissionAction<{ draft: IntakeWorkingDraft<T> | null }>("getIntakeWorkingDraft", { id: intake.id, scope }); }
      catch (error) { onError(error); throw error; }
    },
    [intake.id, scope], { clearDataOnError: () => true },
  );
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const lock = useRef(false);
  const current = JSON.stringify(value);
  const handled = useRef(current);
  const accepted = useRef(false);
  const [state, setState] = useState('Ready');
  const draft = resource.data?.draft;
  const stale = !!draft?.data && draft.baseVersion !== intake.version;
  async function save(data: T | null) {
    if (lock.current || !resource.loaded || resource.error) return;
    lock.current = true;
    setBusy(true); setState("Saving"); setError(""); setMessage("");
    try {
      const response = await commissionAction<{ draft?: IntakeWorkingDraft<T> }>("saveIntakeWorkingDraft", { id: intake.id, scope,
        version: draft?.version ?? 0, baseVersion: intake.version, data });
      handled.current = data === null ? current : JSON.stringify(data);
      accepted.current = true;
      if (response.draft) resource.setData({ draft: response.draft }); else await resource.refetch();
      setState('Saved');
      setMessage(data ? "Working draft saved to the server. Eligibility and earnings are unchanged." : "Saved working draft discarded.");
    } catch (e) {
      setState("Needs retry");
      setError(e instanceof Error ? e.message : "Could not save working draft.");
      onError(e);
    } finally { lock.current = false; setBusy(false); }
  }
  // Never save initial server values, overwrite an unrecovered draft, or retry a conflict silently.
  const recoveryPending = !!draft?.data && !accepted.current && JSON.stringify(draft.data) !== current;
  useEffect(() => {
    if (disabled || busy || resource.loading || !resource.loaded || resource.error || error || stale || recoveryPending || handled.current === current) return;
    setState('Waiting to save');
    const timer = window.setTimeout(() => { void save(JSON.parse(current) as T); }, 900);
    return () => window.clearTimeout(timer);
  }, [current, disabled, busy, resource.loading, resource.loaded, resource.error, error, stale, recoveryPending, intake.version]);
  return <div className="intake-draft-recovery" aria-label={(scope.startsWith("allocation-") ? "Settlement allocation" : ({header:"Statement details",rows:"Source rows",import:"Import mapping",settlement:"Payment details"} as Record<string,string>)[scope] ?? scope) + " working draft"}>
    <p role="status" className="small"><strong>{busy ? 'Saving…' : error || resource.error ? 'Needs retry' : stale ? 'Compare saved draft' : recoveryPending ? 'Saved draft available' : state}</strong> · Changes save privately after you pause. Review confirmations are never saved.</p>
    <div className="intake-actions">
      <button type="button" className="secondary" disabled={disabled || busy || resource.loading || !!resource.error}
        onClick={() => void save(value)}>Save working draft</button>
      {draft?.data && <>
        <button type="button" className="secondary" disabled={disabled || busy || resource.loading || stale} onClick={() => {
          accepted.current = true; handled.current = JSON.stringify(draft.data); restore(draft.data!); setState("Saved"); setMessage("Working draft restored for review. Save the section when ready.");
        }}>Restore saved draft</button>
        <button type="button" className="secondary" disabled={disabled || busy || resource.loading} onClick={() => void save(null)}>Discard saved draft</button>
        <span className="small muted">Saved {new Date(draft.savedAt).toLocaleString()}</span>
      </>}
    </div>
    {stale && <p role="alert">The statement changed after this draft was saved. Compare the saved values before entering changes again.</p>}
    {draft?.data && <details><summary>View saved working values</summary><div className="intake-source-text"><SavedValues value={draft.data} /></div></details>}
    {(error || resource.error) && <p role="alert" className="error-text">{error || resource.error}</p>}
    {(error || resource.error) && <button type="button" className="secondary" disabled={busy || resource.loading} onClick={() => { handled.current = current; accepted.current = false; setError(""); setState("Ready"); void resource.refetch(); }}>Reload saved draft</button>}
    {message && <p role="status" className="small">{message}</p>}
  </div>;
}
