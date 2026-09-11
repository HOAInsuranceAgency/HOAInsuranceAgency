import { useState } from "react";
import type { TeamRouting, TeamEligibility } from "../../../shared/leadWorkflow";
import { communicationRequest as request } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function TeamWorkflowSettings() {
  const resource = useAsyncResource(async () => {
    const [settings, roster] = await Promise.all([request<{ routing: TeamRouting }>("teamRouting"), request<{ team: TeamEligibility[] }>("team")]);
    return { ...settings, ...roster };
  }, [], { initialData: { routing: { members: [], version: 0 } as TeamRouting, team: [] as TeamEligibility[] }, errorMessage: "Could not load managers and coverage" });
  const [draft, setDraft] = useState<TeamRouting | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { team, routing } = resource.data;
  const name = (id?: string) => team.find(m => m.userId === id)?.name ?? "Not assigned";
  const options = (ids?: string[], exclude?: string) => team.filter(m => m.enabled && m.userId !== exclude && (!ids || ids.includes(m.userId))).map(m => <option key={m.userId} value={m.userId}>{m.name}</option>);
  const updateMember = (userId: string, patch: Partial<TeamRouting["members"][number]>) => setDraft(d => d && ({ ...d, members: [...d.members.filter(m => m.userId !== userId), { ...d.members.find(m => m.userId === userId), userId, ...patch }] }));
  return <section className="card" aria-label="Managers and coverage">
    <div className="toolbar"><h2>Managers and coverage</h2><div className="grow" />{!draft && <button className="secondary" disabled={resource.loading} onClick={() => { setDraft(structuredClone(routing)); setError(""); }}>Edit team routing</button>}</div>
    <p className="muted small">Sales managers oversee leads. The marketing manager oversees carriers and client service. Unhandled work reaches the agency owner.</p>
    {(error || resource.error) && <p className="error-text" role="alert">{error || resource.error}</p>}
    {!draft ? <><div className="form-grid"><p><strong>Agency owner</strong><br />{name(routing.ownerId)}</p><p><strong>Carrier / marketing manager</strong><br />{name(routing.marketingManagerId)}</p></div>
      <div className="table-wrap"><table><thead><tr><th>Teammate</th><th>Sales manager</th><th>Coverage</th></tr></thead><tbody>{team.filter(m => m.salesperson || m.champion).map(m => { const r = routing.members.find(r => r.userId === m.userId); return <tr key={m.userId}><td>{m.name}</td><td>{m.salesperson ? name(r?.salesManagerId) : "—"}</td><td>{r?.away ? `Away · ${name(r.coverId)} covering` : "Available"}</td></tr>; })}</tbody></table></div>
      <p className="muted small">Reports arrive at 9 a.m. Eastern. {routing.reportChannelId ? "Internal reporting channel saved." : "An internal reporting channel still needs to be connected."}</p></> : <form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError("");
        try { const result = await request<{ routing: TeamRouting }>("saveTeamRouting", draft, true); resource.setData(d => ({ ...d, routing: result.routing })); setDraft(null); }
        catch (e) { setError(e instanceof Error ? e.message : "Could not save routing"); } finally { setBusy(false); }
      }}><fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
        <div className="form-grid">{([
          ["ownerId", "Agency owner"], ["marketingManagerId", "Carrier / marketing manager"], ["intakeOwnerId", "Unmatched activity goes to"], ["integrationOwnerId", "Integration problems go to"],
        ] as const).map(([key, label]) => <label className="field" key={key}>{label}<select value={draft[key] ?? ""} onChange={e => setDraft(d => d && ({ ...d, [key]: e.target.value || undefined }))}><option value="">Choose teammate</option>{options(key === "marketingManagerId" ? draft.members.filter(m => m.marketingManager).map(m => m.userId) : undefined)}</select></label>)}</div>
        <div className="table-wrap"><table><thead><tr><th>Teammate</th><th>Manager eligibility</th><th>Sales manager</th><th>Temporary cover</th></tr></thead><tbody>{team.map(m => {
          const r = draft.members.find(r => r.userId === m.userId);
          return <tr key={m.userId}><td>{m.name}</td><td><label><input type="checkbox" checked={!!r?.salesManager} onChange={e => updateMember(m.userId, { salesManager: e.target.checked })} /> Sales manager</label><br /><label><input type="checkbox" checked={!!r?.marketingManager} onChange={e => updateMember(m.userId, { marketingManager: e.target.checked })} /> Marketing manager</label></td>
            <td>{m.salesperson ? <select aria-label={`Sales manager for ${m.name}`} value={r?.salesManagerId ?? ""} onChange={e => updateMember(m.userId, { salesManagerId: e.target.value || undefined })}><option value="">Choose manager</option>{options(draft.members.filter(m => m.salesManager).map(m => m.userId), m.userId)}</select> : "—"}</td>
            <td><label><input type="checkbox" checked={!!r?.away} onChange={e => updateMember(m.userId, { away: e.target.checked })} /> Away</label><select aria-label={`Temporary cover for ${m.name}`} value={r?.coverId ?? ""} onChange={e => updateMember(m.userId, { coverId: e.target.value || undefined })}><option value="">Choose cover</option>{options(undefined, m.userId)}</select><details><summary>Schedule coverage</summary><label className="field">From<input type="date" value={r?.coverFrom ?? ""} onChange={e => updateMember(m.userId, { coverFrom: e.target.value || undefined })} /></label><label className="field">Through<input type="date" value={r?.coverThrough ?? ""} onChange={e => updateMember(m.userId, { coverThrough: e.target.value || undefined })} /></label></details></td></tr>;
        })}</tbody></table></div>
        <p className="muted small">Manager eligibility changes dropdown choices, not CRM permissions. Coverage changes recipients without moving deadlines.</p>
        <details><summary>Internal report connection</summary><label className="field">Front reporting channel ID<input autoComplete="off" spellCheck={false} value={draft.reportChannelId ?? ""} placeholder="cha_…" onChange={e => setDraft(d => d && ({ ...d, reportChannelId: e.target.value.trim() || undefined }))} /><small>Use a verified email channel in an internal inbox separate from lead inboxes.</small></label></details>
        <div className="form-actions"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save managers and coverage"}</button><button type="button" className="secondary" onClick={() => setDraft(null)}>Cancel</button></div>
      </fieldset></form>}
  </section>;
}
