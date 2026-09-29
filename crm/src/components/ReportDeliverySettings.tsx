import { useState } from "react";
import type { TeamRouting, TeamEligibility } from "../../../shared/leadWorkflow";
import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";

const contacts = [
  ["ownerId", "Report issues"],
  ["intakeOwnerId", "Unmatched activity"],
  ["integrationOwnerId", "Connection issues"],
] as const;

export default function ReportDeliverySettings() {
  const resource = useAsyncResource(async () => {
    const [settings, roster] = await Promise.all([request<{ routing: TeamRouting }>("teamRouting"), request<{ team: TeamEligibility[] }>("team")]);
    return { ...settings, ...roster };
  }, [], { initialData: { routing: { members: [], version: 0 } as TeamRouting, team: [] as TeamEligibility[] }, errorMessage: "Could not load report delivery settings" });
  const [draft, setDraft] = useState<TeamRouting | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { team, routing } = resource.data;
  const name = (id?: string) => team.find(m => m.userId === id)?.name ?? "Not selected";
  return <section className="card" aria-label="Report delivery">
    <div className="toolbar"><h2>Report delivery</h2><div className="grow" />{!draft && <button className="secondary" disabled={resource.loading || !!resource.error} onClick={() => {
      setDraft({ version: routing.version, members: [], ownerId: routing.ownerId, intakeOwnerId: routing.intakeOwnerId, integrationOwnerId: routing.integrationOwnerId, reportChannelId: routing.reportChannelId });
      setError("");
    }}>Edit report delivery</button>}</div>
    <p className="muted small">Individual work reports arrive at 9 a.m. Eastern. Choose who receives setup and connection alerts below. These contacts do not change account assignments or access.</p>
    {(error || resource.error) && <p className="error-text" role="alert">{error || resource.error}</p>}
    {resource.loading && <p className="muted small">Loading report delivery…</p>}
    {!draft ? <><div className="form-grid">{contacts.map(([key, label]) => <p key={key}><strong>{label}</strong><br />{name(routing[key])}</p>)}</div>
      <p className="muted small">{routing.reportChannelId ? "Internal reporting channel saved." : "An internal reporting channel still needs to be connected."}</p></> : <form aria-label="Report delivery settings" onSubmit={async event => {
        event.preventDefault(); if (busy) return; setBusy(true); setError("");
        try { const result = await request<{ routing: TeamRouting }>("saveTeamRouting", draft, true); resource.setData(data => ({ ...data, routing: result.routing })); setDraft(null); }
        catch (error) { setError(error instanceof Error ? error.message : "Could not save report delivery"); } finally { setBusy(false); }
      }}><fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <div className="form-grid">{contacts.map(([key, label]) => <label className="field" key={key}>{label}<select value={draft[key] ?? ""} onChange={event => setDraft(previous => previous && ({ ...previous, [key]: event.target.value || undefined }))}><option value="">Choose teammate</option>{team.filter(member => member.enabled).map(member => <option key={member.userId} value={member.userId}>{member.name}</option>)}</select></label>)}</div>
        <details><summary>Internal report connection</summary><label className="field">Front reporting channel ID<input autoComplete="off" spellCheck={false} value={draft.reportChannelId ?? ""} placeholder="cha_…" onChange={event => setDraft(previous => previous && ({ ...previous, reportChannelId: event.target.value.trim() || undefined }))} /><small>Use a verified email channel in an internal inbox separate from lead inboxes.</small></label></details>
        <div className="form-actions"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save report delivery"}</button><button type="button" className="secondary" onClick={() => setDraft(null)}>Cancel</button></div>
      </fieldset></form>}
  </section>;
}
