import { useEffect, useState } from "react";
import { communicationRequest as request, type IntegrationConfig, type TeamEligibility } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";

export function LeadEligibilitySettings() {
  const resource = useAsyncResource(() => request<{ team: TeamEligibility[] }>("team"), [], { initialData: { team: [] }, errorMessage: "Could not load assignment settings" });
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  async function save(member: TeamEligibility, patch: Partial<TeamEligibility>) {
    setBusy(member.userId); setError("");
    try { await request("saveEligibility", { ...member, ...patch }, true); await resource.refetch(); }
    catch(e) { setError(e instanceof Error ? e.message : "Could not save eligibility"); } finally { setBusy(""); }
  }
  return <div className="card"><h2>Lead assignment eligibility</h2><p className="muted small">These choices control who appears in the salesperson and deal champion dropdowns. They do not change access or permissions.</p>
    {(error || resource.error) && <p role="alert" className="error-text">{error || resource.error}</p>}
    {resource.loading && <p>Loading teammates…</p>}
    <div className="table-wrap"><table><thead><tr><th>Teammate</th><th>Salesperson</th><th>Deal champion</th><th>Front teammate</th><th>Dialpad user</th></tr></thead><tbody>
      {resource.data.team.map(m => <tr key={m.userId}><td>{m.name}<div className="muted small">{m.email}</div></td>
        <td><input aria-label={`Salesperson eligibility for ${m.name}`} type="checkbox" checked={m.salesperson} disabled={!!busy} onChange={e => void save(m, { salesperson: e.target.checked })} /></td>
        <td><input aria-label={`Deal champion eligibility for ${m.name}`} type="checkbox" checked={m.champion} disabled={!!busy} onChange={e => void save(m, { champion: e.target.checked })} /></td>
        <td><input key={`${m.userId}:front:${m.frontId}`} aria-label={`Front teammate ID for ${m.name}`} defaultValue={m.frontId ?? ""} placeholder="tea_…" onBlur={e => { if (e.target.value !== (m.frontId ?? "")) void save(m, { frontId: e.target.value }); }} disabled={!!busy} /></td>
        <td><input key={`${m.userId}:dialpad:${m.dialpadId}`} aria-label={`Dialpad user ID for ${m.name}`} defaultValue={m.dialpadId ?? ""} onBlur={e => { if (e.target.value !== (m.dialpadId ?? "")) void save(m, { dialpadId: e.target.value }); }} disabled={!!busy} /></td>
      </tr>)}
    </tbody></table></div></div>;
}
export default function CommunicationSettings() {
  const resource = useAsyncResource(() => request<{ config: IntegrationConfig; recovery?: Record<string, { version: number; checkedAt?: string }>; credentialStatus: Record<string, boolean>; webhookUrl?: string; sidebarUrl?: string; health?: { at?: string; lagging?: boolean } }>("settings"), [], { initialData: null, errorMessage: "Could not load integration settings" });
  const members = useAsyncResource(() => request<{ team: TeamEligibility[] }>("team"), [], { initialData: { team: [] } });
  const [draft, setDraft] = useState<IntegrationConfig | null>(null), [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string }[]>([]);
  const [nativeVerified, setNativeVerified] = useState(false), [cleanup, setCleanup] = useState(false);
  const [recoveryReason, setRecoveryReason] = useState(""), [historyConversation, setHistoryConversation] = useState("");
  const [migrationCursor, setMigrationCursor] = useState<string | null | undefined>();
  useEffect(() => { if (resource.data) { setDraft(resource.data.config); setCleanup(!!resource.data.config.cleanupEnabled); } }, [resource.data]);
  async function run(fn: () => Promise<void>) { setBusy(true); setError(""); setMessage(""); try { await fn(); } catch(e) { setError(e instanceof Error ? e.message : "Could not complete this action"); } finally { setBusy(false); } }
  const edit = <K extends keyof IntegrationConfig>(key: K, value: IntegrationConfig[K]) => setDraft(d => d ? { ...d, [key]: value } : d);
  if (!draft) return <div className="card"><h2>Front and Dialpad</h2><p>{resource.error || "Loading settings…"}</p><button onClick={() => void resource.refetch()}>Retry</button></div>;
  return <div className="card"><h2>Front and Dialpad</h2><p className="muted">Connect the sales inbox and business phone lines. Current environment: {draft.environment}.</p>
    {(error || message) && <p role="status" className={error ? "error-text" : ""}>{error || message}</p>}
    <form onSubmit={e => { e.preventDefault(); void run(async () => { const saved = await request<{ config: IntegrationConfig }>("saveSettings", { config: draft, credentials: keys }, true); setDraft(saved.config); setKeys({}); setMessage("Settings saved. Validate the connections before activation."); }); }}>
      <div className="form-grid">
        <label className="field">Default salesperson and champion<select value={draft.defaultUserId ?? ""} onChange={e => edit("defaultUserId", e.target.value || undefined)}><option value="">Choose Brian Cole</option>{members.data.team.filter(t => t.name.toLowerCase() === "brian cole").map(t => <option key={t.userId} value={t.userId}>{t.name}</option>)}</select><span className="muted small">Enable both assignment options for Brian under Team first.</span></label>
        {([ ["frontCompanyId", "Front company ID"], ["frontInboxId", "Sales inbox ID"], ["frontChannelId", "Sales email channel ID"], ["frontSender", "Shared sales email"], ["frontSmsChannelId", "Shared texting channel ID"], ["dialpadCompanyId", "Dialpad company ID"], ["dialpadOfficeId", "Dialpad office ID"] ] as const).map(([key,label]) => <label className="field" key={key}>{label}<input value={draft[key] ?? ""} onChange={e => edit(key, e.target.value)} /></label>)}
        <label className="field">Prospect text sender<input value="(508) 233-2261" readOnly /></label>
      </div>
      <div className="form-grid">
        {([ ["allowedInboxIds", "Additional Front inbox IDs"], ["dialpadNumbers", "Business phone numbers, including the main line"], ["holidays", "Agency holidays (YYYY-MM-DD)"], ["testRecipients", "Permitted test email recipients"] ] as const).map(([key,label]) => <label className="field" key={key}>{label}<textarea key={`${key}:${draft.version}`} defaultValue={draft[key].join("\n")} onBlur={e => edit(key, e.target.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean))} rows={3} /></label>)}
      </div>
      <details><summary>Secure connection credentials</summary><p className="muted small">Values are saved in server-side secret storage. Leave a field blank to retain its existing value.</p>
        <div className="form-grid">{([ ["frontToken", "Front API token"], ["frontSigningKey", "Front application signing key"], ["dialpadToken", "Dialpad API token"], ["dialpadSigningKey", "Dialpad webhook signing secret"] ] as const).map(([key,label]) => <label key={key} className="field">{label}<input autoComplete="new-password" type="password" value={keys[key] ?? ""} onChange={e => setKeys(k => ({ ...k, [key]: e.target.value }))} placeholder={resource.data?.credentialStatus[key] ? "Saved" : "Not configured"} /></label>)}</div>
      </details>
      <label><input type="checkbox" checked={draft.paused} onChange={e => edit("paused", e.target.checked)} /> Pause queued communication delivery</label>
      <div className="toolbar"><button disabled={busy}>Save settings</button><button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => { const r = await request<{ checks: typeof checks }>("validateConnection", {}, true); setChecks(r.checks); })}>Validate connections</button></div>
    </form>
    {checks.length > 0 && <ul>{checks.map(c => <li key={c.name}>{c.ok ? "✓" : "Needs attention:"} {c.name} — {c.detail}</li>)}</ul>}
    <h3>Activate the connection</h3>
    <p className="muted small">{draft.activatedAt ? `Capture started ${new Date(draft.activatedAt).toLocaleString()}.` : "Delivery starts after setup and controlled connection tests pass."} Worker: {resource.data?.health?.at ? `${new Date(resource.data.health.at).toLocaleString()}${resource.data.health.lagging ? " — backlog needs attention" : ""}` : "Awaiting first run"}.</p>
    {resource.data?.webhookUrl && <div className="small"><p>Front application webhook: <code>{resource.data.webhookUrl}front</code></p><p>Dialpad signed webhook: <code>{resource.data.webhookUrl}dialpad</code></p><p>Front sidebar: <code>{resource.data.sidebarUrl}</code></p></div>}
    <p className="muted small">Connect separate native Dialpad voice and SMS channels in Front. Register signed call and SMS subscriptions for the main line and individual business numbers; include SMS content and delivery status permissions. Send a controlled event from each provider before activation.</p>
    <label><input type="checkbox" checked={nativeVerified} onChange={e => setNativeVerified(e.target.checked)} /> I verified the individual lines, shared-line text sender, signed events, SMS content and delivery status using controlled test contacts.</label>
    <label><input type="checkbox" checked={cleanup} onChange={e => setCleanup(e.target.checked)} /> Enable automatic cleanup when the CRM has a future commitment and no unresolved communication.</label>
    <button disabled={busy || !nativeVerified} onClick={() => void run(async () => { const r = await request<{ config: IntegrationConfig }>("activate", { nativeChecksConfirmed: nativeVerified, cleanupEnabled: cleanup }, true); setDraft(r.config); setMessage("Integration activated. Lead deadlines remain controlled by the CRM."); })}>{draft.activatedAt ? "Revalidate and resume" : "Validate and activate"}</button>
    <h3>Repair history capture</h3>
    <p className="muted small">Restart a stalled provider search from the beginning of its unfinished time window, or retry a specific Front conversation. Captured messages are deduplicated and lead deadlines stay intact.</p>
    <label className="field">Recovery reason<input value={recoveryReason} onChange={e => setRecoveryReason(e.target.value)} placeholder="For example, reconnected the mailbox or replaced an expired cursor" /></label>
    <div className="toolbar">{(["front", "dialpad"] as const).map(provider => <button key={provider} className="secondary" disabled={busy || !draft.activatedAt || !recoveryReason.trim()} onClick={() => void run(async () => {
      await request("restartReconciliation", { provider, version: resource.data?.recovery?.[provider]?.version ?? 0, reason: recoveryReason }, true);
      await resource.refetch(); setMessage(`${provider === "front" ? "Front" : "Dialpad"} history will restart from its unfinished time window.`);
    })}>Restart {provider === "front" ? "Front" : "Dialpad"} history search</button>)}</div>
    <label className="field">Front conversation ID<input value={historyConversation} onChange={e => setHistoryConversation(e.target.value)} placeholder="cnv_…" /></label>
    <button className="secondary" disabled={busy || !recoveryReason.trim() || !/^cnv_[a-z0-9]+$/.test(historyConversation.trim())} onClick={() => void run(async () => {
      await request("restartConversationHistory", { conversationId: historyConversation.trim(), reason: recoveryReason }, true);
      setMessage("Conversation history is queued. An active history walk continues without losing its place.");
    })}>Retry conversation history</button>
    <h3>Existing leads</h3><p className="muted small">Fill missing responsibilities with Brian. Existing assignments and deadlines are preserved. This does not resend historical emails.</p>
    <button className="secondary" disabled={busy || migrationCursor === null} onClick={() => void run(async () => {
      const r = await request<{ assigned: number; exceptions: number; nextToken?: string }>("backfill", { nextToken: migrationCursor }, true);
      setMigrationCursor(r.nextToken ?? null); setMessage(`${r.assigned} assignments repaired; ${r.exceptions} need attention.${r.nextToken ? " Continue with the next batch." : " All batches reviewed."}`);
    })}>{migrationCursor === null ? "Backfill complete" : migrationCursor ? "Review next lead batch" : "Fill missing lead responsibilities"}</button>
  </div>;
}
