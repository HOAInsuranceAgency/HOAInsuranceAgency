import { useState } from "react";
import type { IntegrationConfig, TeamEligibility } from "../lib/communications";

const listFields = ["allowedInboxIds", "dialpadNumbers", "holidays", "testRecipients"] as const;
type ListField = typeof listFields[number];
const parseList = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);

/** A local edit session: background reads cannot replace unfinished input. */
export default function CommunicationSettingsEditor({ config, team, teamError, credentialStatus, busy, onSave, onCancel }: {
  config: IntegrationConfig; team: TeamEligibility[]; teamError: string;
  credentialStatus: Record<string, boolean>; busy: boolean;
  onSave: (config: IntegrationConfig, credentials: Record<string, string>) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(config);
  const [lists, setLists] = useState(() => Object.fromEntries(listFields.map(key => [key, config[key].join("\n")])) as Record<ListField, string>);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const candidate = { ...draft, ...Object.fromEntries(listFields.map(key => [key, parseList(lists[key])])) } as IntegrationConfig;
  const dirty = JSON.stringify(candidate) !== JSON.stringify(config) || Object.values(keys).some(value => value.trim());
  const edit = <K extends keyof IntegrationConfig>(key: K, value: IntegrationConfig[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const brian = team.find(member => member.name.trim().toLowerCase() === "brian cole");
  const canAssignBrian = brian?.enabled && brian.salesperson && brian.champion;
  function listInput(key: ListField, label: string, hint?: string) {
    return <label className="field">{label}<textarea value={lists[key]} onChange={event => setLists(previous => ({ ...previous, [key]: event.target.value }))} rows={3} />{hint && <small className="muted">{hint}</small>}</label>;
  }
  return <section className="card communication-editor" aria-labelledby="communication-edit-title">
    <h2 id="communication-edit-title">Edit settings</h2>
    <p className="muted small">Changes take effect when you save. Updating a connection pauses delivery until it is checked again.</p>
    <form aria-label="Communication settings" onSubmit={event => { event.preventDefault(); if (!busy && dirty) onSave(candidate, keys); }}>
      <fieldset disabled={busy} className="communication-controls">
        <div className="communication-fields">
          <label className="field">Email sender<input type="email" value={draft.frontSender} onChange={event => edit("frontSender", event.target.value)} /><small className="muted">The mailbox Front sends from. Test recipients are listed separately.</small></label>
          <label className="field">Default salesperson and champion<select value={draft.defaultUserId ?? ""} onChange={event => edit("defaultUserId", event.target.value || undefined)}>
            <option value="">Choose Brian Cole</option>
            {brian && <option value={brian.userId} disabled={!canAssignBrian}>Brian Cole</option>}
            {!brian && draft.defaultUserId && <option value={draft.defaultUserId} disabled>Saved teammate unavailable</option>}
          </select><small className="muted">{canAssignBrian ? "Both roles apply to new leads." : "Enable both assignment roles for Brian in Team settings first."}</small>
          {teamError && <span className="error-text small">{teamError}</span>}</label>
        </div>
        {config.environment !== "main" && listInput("testRecipients", "Test email recipients", "Only these addresses can receive staging emails. Enter one per line.")}
        <details className="communication-edit-section"><summary>Business hours and holidays</summary>
          <p className="muted small">Monday–Friday, 9 a.m.–5 p.m. Eastern. Holidays below are excluded from follow-up and callback deadlines.</p>
          {listInput("holidays", "Agency holidays", "Enter one date per line, for example 2026-12-25.")}
        </details>
        <details className="communication-edit-section"><summary>Connection setup</summary>
          <p className="muted small">These identifiers are normally set once when Front and Dialpad are connected.</p>
          <div className="communication-fields">
            {([
              ["frontCompanyId", "Front company ID"], ["frontInboxId", "Sales inbox ID"], ["frontChannelId", "Sales email channel ID"],
              ["frontSmsChannelId", "Shared texting channel ID"], ["dialpadCompanyId", "Dialpad company ID"], ["dialpadOfficeId", "Dialpad office ID"],
            ] as const).map(([key, label]) => <label className="field" key={key}>{label}<input value={draft[key] ?? ""} onChange={event => edit(key, event.target.value)} /></label>)}
            {listInput("allowedInboxIds", "Additional Front inbox IDs")}
            {listInput("dialpadNumbers", "Monitored business numbers", "Include the shared main line and individual business numbers.")}
          </div>
        </details>
        <details className="communication-edit-section"><summary>Secure credentials</summary>
          <p className="muted small">Leave saved credentials blank to keep them. New values are stored securely.</p>
          <div className="communication-fields">{([
            ["frontToken", "Front API token"], ["frontSigningKey", "Front application signing key"],
            ["dialpadToken", "Dialpad API token"], ["dialpadSigningKey", "Dialpad webhook signing secret"],
          ] as const).map(([key, label]) => <label key={key} className="field">{label}<input autoComplete="new-password" type="password" value={keys[key] ?? ""} onChange={event => setKeys(previous => ({ ...previous, [key]: event.target.value }))} placeholder={credentialStatus[key] ? "Saved" : "Not configured"} /></label>)}</div>
        </details>
        <div className="communication-actions">
          <button type="submit" disabled={!dirty}>{busy ? "Saving…" : "Save changes"}</button>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <span className="muted small">{dirty ? "Unsaved changes" : "No changes yet"}</span>
        </div>
      </fieldset>
    </form>
  </section>;
}
