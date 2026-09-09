import { useEffect, useRef, useState } from "react";
import { communicationRequest as request, type IntegrationConfig, type TeamEligibility } from "../lib/communications";
import CommunicationSettingsEditor from "./CommunicationSettingsEditor";
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
type ConnectionCheck = { name: string; ok: boolean; detail: string };
type SettingsSnapshot = {
  config: IntegrationConfig;
  recovery?: Record<string, { version: number; checkedAt?: string }>;
  credentialStatus: Record<string, boolean>;
  webhookUrl?: string;
  sidebarUrl?: string;
  health?: { at?: string; lagging?: boolean };
};

const checkLabels: Record<string, [string, string]> = {
  "Default responsibilities": ["Lead ownership", "Set Brian as the default salesperson and deal champion."],
  "Front company": ["Front access", "Review the Front connection in Edit settings."],
  "Front sales channel": ["Email sending", "Connect and verify the sending mailbox in Front."],
  "Front inbox access": ["Front inbox", "Review which inboxes the connection can access."],
  "Dialpad company": ["Dialpad access", "Review the Dialpad connection in Edit settings."],
  "Dialpad call history": ["Call history", "Check access to the monitored business lines."],
  "Shared text channel": ["Shared texting", "Connect the main line’s texting channel in Front."],
  "Webhook signatures": ["Activity updates", "Complete the secure connection setup."],
};
function phoneLabel(number: string) {
  return number?.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3") || "Not configured";
}

export default function CommunicationSettings() {
  const resource = useAsyncResource(() => request<SettingsSnapshot>("settings"), [], { initialData: null, errorMessage: "Could not load integration settings" });
  const members = useAsyncResource(() => request<{ team: TeamEligibility[] }>("team"), [], { initialData: { team: [] }, errorMessage: "Could not load teammates" });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(""), [message, setMessage] = useState(""), [error, setError] = useState("");
  const inFlight = useRef(false);
  const [checks, setChecks] = useState<ConnectionCheck[]>([]);
  const [checkedAt, setCheckedAt] = useState("");
  const [nativeVerified, setNativeVerified] = useState(false), [cleanup, setCleanup] = useState(false);
  const [recoveryReason, setRecoveryReason] = useState(""), [historyConversation, setHistoryConversation] = useState("");
  const [migrationCursor, setMigrationCursor] = useState<string | null | undefined>();
  const saved = resource.data?.config;
  useEffect(() => { setCleanup(!!saved?.cleanupEnabled); }, [saved?.cleanupEnabled, saved?.version]);

  async function run(action: string, fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(action); setError(""); setMessage("");
    try { await fn(); }
    catch(e) { setError(e instanceof Error ? e.message : "Could not complete this action. Try again."); }
    finally { inFlight.current = false; setBusy(""); }
  }
  function adoptConfig(config: IntegrationConfig, credentialNames: string[] = []) {
    resource.setData(previous => previous ? {
      ...previous, config,
      credentialStatus: { ...previous.credentialStatus, ...Object.fromEntries(credentialNames.map(name => [name, true])) },
    } : previous);
  }
  function saveSettings(config: IntegrationConfig, credentials: Record<string, string>) {
    void run("save", async () => {
      const result = await request<{ config: IntegrationConfig }>("saveSettings", { config, credentials }, true);
      adoptConfig(result.config, Object.keys(credentials).filter(key => credentials[key].trim()));
      setEditing(false); setChecks([]); setCheckedAt(""); setNativeVerified(false);
      setMessage(result.config.paused ? "Settings saved. Delivery remains paused." : "Settings saved.");
    });
  }

  if (!saved) return <div className="card communication-settings"><h2>Front and Dialpad</h2>
    <p role={resource.error ? "alert" : "status"}>{resource.error || "Loading settings…"}</p>
    {resource.error && <button className="secondary" disabled={resource.loading} onClick={() => void resource.refetch()}>Retry</button>}
  </div>;
  const disabled = !!busy || editing || resource.loading;
  const failures = checks.filter(check => !check.ok);
  const owner = members.data.team.find(member => member.userId === saved.defaultUserId);
  const status = !saved.activatedAt ? "Setup incomplete" : saved.paused ? "Delivery paused" : "Delivery active";
  const editingHint = editing ? "Finish or cancel your edits before checking or changing delivery." : "";
  const summaryFields: [string, string | undefined][] = [
    ["Front company", saved.frontCompanyId], ["Sales inbox", saved.frontInboxId], ["Email channel", saved.frontChannelId],
    ["Text channel", saved.frontSmsChannelId], ["Dialpad company", saved.dialpadCompanyId], ["Dialpad office", saved.dialpadOfficeId],
    ["Additional inboxes", saved.allowedInboxIds.join(", ")],
  ];

  return <div className="communication-settings">
    <section className="card communication-overview" aria-labelledby="communication-title">
      <div className="communication-heading">
        <div><h2 id="communication-title">Front and Dialpad</h2><p className="muted">Email, calls, and lead follow-up in one place.</p></div>
        <span className="badge gray">{saved.environment === "main" ? "Production" : saved.environment === "staging" ? "Staging" : "Test environment"}</span>
      </div>
      <div className="communication-status">
        <span className={`badge ${saved.activatedAt && !saved.paused ? "green" : "amber"}`}>{status}</span>
        <span>{!saved.activatedAt ? "Complete setup and controlled tests before starting delivery." : saved.paused ? "Queued messages will wait until delivery resumes." : "The CRM keeps track of the team’s commitments."}</span>
      </div>
      {(error || message || resource.error) && <p role={error || resource.error ? "alert" : "status"} className={error || resource.error ? "error-text" : "communication-success"}>{error || resource.error || message}</p>}
      <dl className="communication-summary">
        <div><dt>Email sender</dt><dd>{saved.frontSender || "Not configured"}</dd>
          {saved.environment !== "main" && <small>Test recipients: {saved.testRecipients.join(", ") || "Not set"}</small>}</div>
        <div><dt>Shared text number</dt><dd>{phoneLabel(saved.sharedSmsNumber)}</dd><small>{saved.dialpadNumbers.length} business {saved.dialpadNumbers.length === 1 ? "number" : "numbers"} configured</small></div>
        <div><dt>Default salesperson &amp; deal champion</dt><dd>{owner?.name || (saved.defaultUserId ? (members.loading ? "Checking teammate…" : "Teammate unavailable") : "Not set")}</dd>
          <small>{saved.defaultUserId ? "Both roles apply to new leads." : "Brian Cole needs to be configured in Team settings."}</small>
          {members.error && <span className="error-text small">{members.error} <button type="button" className="secondary" disabled={members.loading} onClick={() => void members.refetch()}>Retry teammates</button></span>}</div>
        <div><dt>Inbox cleanup</dt><dd>{saved.cleanupEnabled ? "Automatic" : "Off"}</dd><small>Snoozing in Front never moves a CRM deadline.</small></div>
      </dl>
      <div className="communication-actions">
        <button type="button" className="secondary" disabled={disabled} onClick={() => void run("check", async () => {
          const result = await request<{ checks: ConnectionCheck[] }>("validateConnection", {}, true);
          setChecks(result.checks); setCheckedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
        })}>{busy === "check" ? "Checking…" : "Check connections"}</button>
        {!editing && <button type="button" className="secondary" disabled={disabled} onClick={() => { setEditing(true); setError(""); setMessage(""); }}>Edit settings</button>}
        {checkedAt && <span className="muted small">Checked at {checkedAt}</span>}
      </div>
      {editingHint && <p className="muted small">{editingHint}</p>}
      {!!checks.length && <div className="communication-checks" role="status">
        <strong>{failures.length ? `${failures.length} ${failures.length === 1 ? "item needs" : "items need"} attention` : "Connection checks passed"}</strong>
        {failures.length ? <ul>{failures.map(check => <li key={check.name}><strong>{checkLabels[check.name]?.[0] ?? check.name}:</strong> {checkLabels[check.name]?.[1] ?? "Review the details under Advanced tools."}</li>)}</ul>
          : <p className="muted small">Access is verified. Live email, call, and text tests are still required before starting delivery.</p>}
      </div>}
    </section>

    {editing && <CommunicationSettingsEditor config={saved} team={members.data.team} teamError={members.error} credentialStatus={resource.data?.credentialStatus ?? {}}
      busy={!!busy} onSave={saveSettings} onCancel={() => { setEditing(false); setError(""); }} />}

    <details className="card communication-disclosure">
      <summary><span>Delivery and inbox cleanup<small>Pause delivery, resume after testing, or change automatic cleanup.</small></span></summary>
      <fieldset disabled={disabled} className="communication-controls">
        {saved.activatedAt && !saved.paused && <div className="communication-actions"><button type="button" className="secondary" onClick={() => void run("pause", async () => {
          const result = await request<{ config: IntegrationConfig }>("saveSettings", { config: { ...saved, paused: true } }, true);
          adoptConfig(result.config); setMessage("Delivery paused. Team deadlines are unchanged.");
        })}>Pause delivery</button></div>}
        <p className="muted small">Before starting or resuming delivery, test email replies, calls on each business number, and texts from the shared main line. Confirm that activity and text delivery status appear in the CRM.</p>
        <label className="communication-check"><input type="checkbox" checked={nativeVerified} onChange={event => setNativeVerified(event.target.checked)} /><span>I verified email, calls, and shared-line texts with test contacts.</span></label>
        <label className="communication-check"><input type="checkbox" checked={cleanup} onChange={event => setCleanup(event.target.checked)} /><span>Automatically tidy conversations awaiting a future follow-up.<small>Conversations needing a response stay visible. CRM deadlines stay in place.</small></span></label>
        <button type="button" disabled={!nativeVerified} onClick={() => void run("activate", async () => {
          const result = await request<{ config: IntegrationConfig }>("activate", { nativeChecksConfirmed: nativeVerified, cleanupEnabled: cleanup }, true);
          adoptConfig(result.config); setNativeVerified(false); setMessage("Delivery settings applied. Lead deadlines remain controlled by the CRM.");
        })}>{busy === "activate" ? "Checking and applying…" : !saved.activatedAt ? "Start delivery" : saved.paused ? "Resume delivery" : "Apply delivery settings"}</button>
      </fieldset>
    </details>

    <details className="card communication-disclosure">
      <summary><span>Advanced tools<small>Connection details, history repair, and existing lead assignments.</small></span></summary>
      <div className="communication-advanced">
        <details className="tucked"><summary>Connection details</summary>
          <dl className="communication-technical">{summaryFields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not set"}</dd></div>)}
            <div><dt>Last background check</dt><dd>{resource.data?.health?.at ? new Date(resource.data.health.at).toLocaleString() : "Awaiting first check"}{resource.data?.health?.lagging ? " — updates delayed" : ""}</dd></div>
            {resource.data?.webhookUrl && <><div><dt>Front webhook</dt><dd>{resource.data.webhookUrl}front</dd></div><div><dt>Dialpad webhook</dt><dd>{resource.data.webhookUrl}dialpad</dd></div></>}
            {resource.data?.sidebarUrl && <div><dt>Front sidebar</dt><dd>{resource.data.sidebarUrl}</dd></div>}
          </dl>
          {!!checks.length && <ul className="small">{checks.map(check => <li key={check.name}>{check.ok ? "Passed" : "Needs attention"}: {check.name} — {check.detail}</li>)}</ul>}
        </details>
        <fieldset disabled={disabled} className="communication-controls">
          <h3>Repair missing history</h3><p className="muted small">Use when activity is missing after a connection problem. Existing messages and deadlines are preserved.</p>
          <label className="field">Recovery reason<input value={recoveryReason} onChange={event => setRecoveryReason(event.target.value)} placeholder="For example, the mailbox was reconnected" /></label>
          <div className="communication-actions">{(["front", "dialpad"] as const).map(provider => <button type="button" key={provider} className="secondary" disabled={!saved.activatedAt || !recoveryReason.trim()} onClick={() => void run("recovery", async () => {
            await request("restartReconciliation", { provider, version: resource.data?.recovery?.[provider]?.version ?? 0, reason: recoveryReason }, true);
            await resource.refetch(); setMessage(`${provider === "front" ? "Front" : "Dialpad"} history will be checked again.`);
          })}>Restart {provider === "front" ? "Front" : "Dialpad"} history search</button>)}</div>
          <label className="field">Front conversation ID<input value={historyConversation} onChange={event => setHistoryConversation(event.target.value)} placeholder="cnv_…" /></label>
          <button type="button" className="secondary" disabled={!recoveryReason.trim() || !/^cnv_[a-z0-9]+$/.test(historyConversation.trim())} onClick={() => void run("history", async () => {
            await request("restartConversationHistory", { conversationId: historyConversation.trim(), reason: recoveryReason }, true);
            setMessage("Conversation history is queued for another check.");
          })}>Retry conversation history</button>
          <h3>Existing lead assignments</h3><p className="muted small">Fill missing responsibilities with Brian. Existing assignments and deadlines stay in place; historical emails are not resent.</p>
          <button type="button" className="secondary" disabled={!saved.defaultUserId || migrationCursor === null} onClick={() => void run("backfill", async () => {
            const result = await request<{ assigned: number; exceptions: number; nextToken?: string }>("backfill", { nextToken: migrationCursor }, true);
            setMigrationCursor(result.nextToken ?? null); setMessage(`${result.assigned} assignments updated; ${result.exceptions} need attention.${result.nextToken ? " Continue with the next batch." : " All batches reviewed."}`);
          })}>{migrationCursor === null ? "Backfill complete" : migrationCursor ? "Review next lead batch" : "Fill missing lead responsibilities"}</button>
        </fieldset>
      </div>
    </details>
  </div>;
}
