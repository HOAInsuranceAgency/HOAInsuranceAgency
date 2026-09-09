import { useRef, useState } from "react";
import { communicationRequest as request, type TeamEligibility } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import Modal from "./Modal";

type ConnectionIds = Pick<TeamEligibility, "frontId" | "dialpadId">;

export default function LeadEligibilitySettings() {
  const resource = useAsyncResource(() => request<{ team: TeamEligibility[] }>("team"), [], { initialData: { team: [] }, errorMessage: "Could not load assignment settings" });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [editing, setEditing] = useState<TeamEligibility | null>(null);
  const inFlight = useRef(false);
  async function save(member: TeamEligibility, patch: Partial<TeamEligibility>) {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await request<{ member: TeamEligibility }>("saveEligibility", { ...member, ...patch }, true);
      // Use the committed version, rather than immediately rereading a stale index.
      resource.setData(previous => ({ team: previous.team.map(item => item.userId === member.userId ? result.member : item) }));
      setMessage(`Settings saved for ${member.name}.`);
      return true;
    } catch(e) { setError(e instanceof Error ? e.message : "Could not save teammate settings"); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  function closeEditor() { if (!inFlight.current) { setEditing(null); setError(""); } }
  const disabled = busy || resource.loading || !!editing;
  return <section className="card team-eligibility" aria-labelledby="lead-eligibility-title">
    <h2 id="lead-eligibility-title">Lead assignment eligibility</h2>
    <p className="muted small">These choices control who appears in the salesperson and deal champion dropdowns. They do not change access or permissions.</p>
    {!editing && (error || resource.error) && <div role="alert"><p className="error-text">{error || resource.error}</p><button type="button" className="secondary" disabled={disabled} onClick={() => { setError(""); void resource.refetch(); }}>Refresh teammates</button></div>}
    <p className="small muted" role="status">{busy ? "Saving teammate settings…" : resource.loading ? "Loading teammates…" : message}</p>
    <div className="table-wrap"><table><thead><tr><th scope="col">Teammate</th><th scope="col">Salesperson</th><th scope="col">Deal champion</th><th scope="col">Front</th><th scope="col">Dialpad</th><th scope="col">Actions</th></tr></thead><tbody>
      {resource.data.team.map(member => <tr key={member.userId}>
        <td>{member.name}<div className="muted small">{member.email}</div></td>
        <td><input aria-label={`Salesperson eligibility for ${member.name}`} type="checkbox" checked={member.salesperson} disabled={disabled} onChange={event => void save(member, { salesperson: event.target.checked })} /></td>
        <td><input aria-label={`Deal champion eligibility for ${member.name}`} type="checkbox" checked={member.champion} disabled={disabled} onChange={event => void save(member, { champion: event.target.checked })} /></td>
        <td>{member.frontId ? <code className="team-connection-id">{member.frontId}</code> : <span className="muted small">Not linked</span>}</td>
        <td>{member.dialpadId ? <code className="team-connection-id">{member.dialpadId}</code> : <span className="muted small">Not linked</span>}</td>
        <td><button type="button" className="secondary" disabled={disabled} aria-label={`Edit connections for ${member.name}`} onClick={() => { setEditing(member); setError(""); setMessage(""); }}>Edit connections</button></td>
      </tr>)}
    </tbody></table></div>
    {resource.loaded && !resource.error && !resource.data.team.length && <p className="muted small">No teammates are available yet.</p>}
    {editing && <ConnectionEditor member={editing} busy={busy} error={error} onClose={closeEditor} onSave={async ids => { if (await save(editing, ids)) setEditing(null); }} />}
  </section>;
}

function ConnectionEditor({ member, busy, error, onClose, onSave }: {
  member: TeamEligibility; busy: boolean; error: string; onClose: () => void; onSave: (ids: ConnectionIds) => Promise<void>;
}) {
  const [frontId, setFrontId] = useState(member.frontId ?? ""), [dialpadId, setDialpadId] = useState(member.dialpadId ?? "");
  const front = frontId.trim(), dialpad = dialpadId.trim();
  const frontError = !!front && !/^tea_[a-z0-9]+$/.test(front);
  const dialpadError = !!dialpad && !/^\d+$/.test(dialpad);
  const dirty = front !== (member.frontId ?? "") || dialpad !== (member.dialpadId ?? "");
  return <Modal title={`Connections for ${member.name}`} className="modal-form team-connection-modal" onClose={onClose}>
    <p className="muted small">These IDs link this teammate to their Front and Dialpad accounts. Changes are applied only when you save.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
    <form aria-label={`Connections for ${member.name}`} onSubmit={event => { event.preventDefault(); if (!busy && dirty && !frontError && !dialpadError) void onSave({ frontId: front || undefined, dialpadId: dialpad || undefined }); }}>
      <fieldset disabled={busy} className="team-connection-fields">
        <div className="form-grid">
          <label className="field">Front teammate ID<input value={frontId} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="tea_…" aria-invalid={frontError} aria-describedby="front-id-help" onChange={event => setFrontId(event.target.value)} />
            <span id="front-id-help" className={frontError ? "error-text" : "muted small"}>{frontError ? "Use a Front teammate ID beginning with tea_, followed by lowercase letters or numbers." : "Starts with tea_, followed by letters and numbers."}</span></label>
          <label className="field">Dialpad user ID<input value={dialpadId} inputMode="numeric" autoComplete="off" spellCheck={false} aria-invalid={dialpadError} aria-describedby="dialpad-id-help" onChange={event => setDialpadId(event.target.value)} />
            <span id="dialpad-id-help" className={dialpadError ? "error-text" : "muted small"}>{dialpadError ? "Use the numeric Dialpad user ID without spaces or punctuation." : "The numeric user ID from Dialpad."}</span></label>
        </div>
        <div className="form-actions"><button type="submit" className="primary" disabled={!dirty || frontError || dialpadError}>{busy ? "Saving…" : "Save connections"}</button><button type="button" className="secondary" onClick={onClose}>Cancel</button></div>
      </fieldset>
    </form>
  </Modal>;
}
