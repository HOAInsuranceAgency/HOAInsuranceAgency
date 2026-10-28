import { useEffect, useMemo, useRef, useState } from "react";
import { receivesNewLeads } from "../../../shared/salespersonOwnership";
import { communicationRequest as request, type TeamEligibility } from "../lib/communications";
import { useAsyncResource } from "../lib/useAsyncResource";
import { isAuthorizationError } from "../lib/authorizationError";
import Modal from "./Modal";

type ConnectionIds = Pick<TeamEligibility, "frontId" | "dialpadId" | "frontChannelId" | "frontSignatureId">;

/** Display authority comes from the bounded Cognito roster and its profiles. */
export type EligibilityRosterMember = {
  userId: string; name: string; email: string; enabled: boolean; groups: readonly string[]; hasProfile: boolean;
};

/** Load only visible teammates' stored settings, preserving committed versions
 * as roster pages arrive and keeping connection drafts isolated from reads. */
export function useLeadEligibilitySettings(members: readonly EligibilityRosterMember[], paused = false) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [editing, setEditing] = useState<TeamEligibility | null>(null);
  const inFlight = useRef(false), readPending = useRef(false), refreshPending = useRef(false);
  const saved = useRef(new Map<string, TeamEligibility>()), loaded = useRef(new Set<string>());
  const readIds = useRef<string[]>([]);
  const current = useRef({ members, paused, editing });
  current.current = { members, paused, editing };
  const resource = useAsyncResource(async () => {
    const ids = [...readIds.current];
    try {
      const rows: TeamEligibility[] = [];
      for (let offset = 0; offset < ids.length; offset += 20) {
        const page = await request<{ team: TeamEligibility[] }>("teamSettings", { userIds: ids.slice(offset, offset + 20) });
        rows.push(...page.team);
      }
      // Do not replace a newer committed version with an older response. Missing
      // rows mean defaults, rather than needing a broad roster/profile lookup.
      for (const id of ids) loaded.current.add(id);
      for (const row of rows) {
        const previous = saved.current.get(row.userId);
        if (ids.includes(row.userId) && (!previous || (row.version ?? 0) >= (previous.version ?? 0))) saved.current.set(row.userId, row);
      }
      return { team: [...saved.current.values()] };
    } finally {
      // Release before the resource publishes loading=false, so newly visible
      // IDs can start their read in that render's effect without a timing gap.
      readPending.current = false;
    }
  }, [], { manual: true, initialData: { team: [] as TeamEligibility[] }, errorMessage: "Could not load assignment settings",
    clearDataOnError: failure => {
      if (!isAuthorizationError(failure)) return false;
      saved.current.clear(); loaded.current.clear();
      return true;
    },
  });
  const idsKey = JSON.stringify(members.map(member => member.userId));

  function read(ids: string[]) {
    if (!ids.length || readPending.current || inFlight.current || current.current.editing || current.current.paused) return;
    readIds.current = [...new Set(ids)];
    readPending.current = true;
    void resource.refetch();
  }
  useEffect(() => {
    if (paused || busy || editing || resource.loading) return;
    if (refreshPending.current) {
      refreshPending.current = false;
      read(current.current.members.map(member => member.userId));
    } else if (!resource.error) read(current.current.members.map(member => member.userId).filter(id => !loaded.current.has(id)));
  }, [idsKey, paused, busy, editing, resource.loading, resource.error]);

  const team = useMemo(() => {
    const raw = new Map(resource.data.team.map(member => [member.userId, member]));
    return members.flatMap(member => {
      if (!member.hasProfile || !loaded.current.has(member.userId)) return [];
      const stored = raw.get(member.userId), producer = member.groups.includes("PRODUCER");
      return [{ ...stored, userId: member.userId, name: member.name, email: member.email,
        enabled: member.enabled, available: member.enabled, salesperson: producer,
        receiveNewLeads: receivesNewLeads(stored, producer), version: stored?.version ?? 0 }];
    });
  }, [members, resource.data]);

  async function save(member: TeamEligibility, patch: Partial<TeamEligibility>) {
    if (inFlight.current || readPending.current || current.current.paused) return false;
    inFlight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await request<{ member: TeamEligibility }>("saveEligibility", { userId: member.userId, version: member.version ?? 0, ...patch }, true);
      saved.current.set(member.userId, result.member);
      loaded.current.add(member.userId);
      resource.setData({ team: [...saved.current.values()] });
      setMessage(`Settings saved for ${member.name}.`);
      return true;
    } catch(e) { setError(e instanceof Error ? e.message : "Could not save teammate settings"); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }
  function closeEditor() { if (!inFlight.current) { setEditing(null); setError(""); } }
  const disabled = busy || resource.loading || !!editing;
  function editMember(member: TeamEligibility) { if (!readPending.current && !current.current.paused) { setEditing(member); setError(""); setMessage(""); } }
  function refresh() {
    if (inFlight.current || current.current.editing) return;
    if (current.current.paused) { refreshPending.current = true; return; }
    setError(""); read(current.current.members.map(member => member.userId));
  }
  return { resource: { ...resource, data: { team } }, busy, error, message, editing, disabled, save, closeEditor, editMember, refresh, setEditing };
}
type EligibilitySettings = ReturnType<typeof useLeadEligibilitySettings>;

export function LeadEligibilityFeedback({ settings }: { settings: EligibilitySettings }) {
  const { editing, error, resource, disabled, refresh, busy, message } = settings;
  return <>
    {!editing && (error || resource.error) && <div role="alert"><p className="error-text">{error || resource.error}</p><button type="button" className="secondary" disabled={disabled} onClick={refresh}>Refresh assignment settings</button></div>}
    <p className="small muted" role="status">{busy ? "Saving teammate settings…" : resource.loading ? "Loading assignment settings…" : message}</p>
  </>;
}

export function LeadEligibilityCells({ member, settings, disabled: rowDisabled = false }: { member?: TeamEligibility; settings: EligibilitySettings; disabled?: boolean }) {
  const { disabled, save, editMember, resource } = settings;
  if (!member) return <td colSpan={2} className="muted small">{resource.error ? "Assignment settings unavailable" : "Loading assignment settings…"}</td>;
  return <>
    <td>{member.salesperson ? <label className="lead-text-switch">
      <input aria-label={`Receive new leads for ${member.name}`} type="checkbox" checked={member.receiveNewLeads !== false}
        disabled={disabled || rowDisabled || member.available === false}
        onChange={event => void save(member, { receiveNewLeads: event.target.checked })} />
      <span>{member.receiveNewLeads !== false ? "On" : "Off"}</span>
    </label> : <span className="muted small">Producers only</span>}</td>
    <td>
      <div className="small">Front: {member.frontId ? <code className="team-connection-id">{member.frontId}</code> : <span className="muted">Not linked</span>}</div>
      {member.frontId && <div className="small muted">Email: {member.frontChannelId || member.frontSignatureId ? "Custom Front selections" : "Automatic from Front"}</div>}
      <div className="small">Dialpad: {member.dialpadId ? <code className="team-connection-id">{member.dialpadId}</code> : <span className="muted">Not linked</span>}</div>
      <button type="button" className="secondary" disabled={disabled || rowDisabled || member.available === false} aria-label={`Edit connections for ${member.name}`} onClick={() => editMember(member)}>Edit connections</button>
    </td>
  </>;
}

export function LeadEligibilityEditor({ settings }: { settings: EligibilitySettings }) {
  const { editing, busy, error, closeEditor, save, setEditing } = settings;
  return editing && <ConnectionEditor member={editing} busy={busy} error={error} onClose={closeEditor} onSave={async ids => { if (await save(editing, ids)) setEditing(null); }} />;
}

function ConnectionEditor({ member, busy, error, onClose, onSave }: {
  member: TeamEligibility; busy: boolean; error: string; onClose: () => void; onSave: (ids: ConnectionIds) => Promise<void>;
}) {
  const [frontId, setFrontId] = useState(member.frontId ?? ""), [dialpadId, setDialpadId] = useState(member.dialpadId ?? "");
  const [frontChannelId, setFrontChannelId] = useState(member.frontChannelId ?? ""), [frontSignatureId, setFrontSignatureId] = useState(member.frontSignatureId ?? "");
  const front = frontId.trim(), dialpad = dialpadId.trim(), channel = frontChannelId.trim(), signature = frontSignatureId.trim();
  const frontError = !!front && !/^tea_[a-z0-9]+$/.test(front);
  const dialpadError = !!dialpad && !/^\d+$/.test(dialpad);
  const channelError = !!channel && (!front || !/^cha_[a-z0-9]+$/.test(channel));
  const signatureError = !!signature && (!front || !/^sig_[a-z0-9]+$/.test(signature));
  const invalid = frontError || dialpadError || channelError || signatureError;
  const dirty = front !== (member.frontId ?? "") || dialpad !== (member.dialpadId ?? "") || channel !== (member.frontChannelId ?? "") || signature !== (member.frontSignatureId ?? "");
  return <Modal title={`Connections for ${member.name}`} className="modal-form team-connection-modal" onClose={onClose}>
    <p className="muted small">These IDs link this teammate to their Front and Dialpad accounts. Changes are applied only when you save.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
    <form aria-label={`Connections for ${member.name}`} onSubmit={event => { event.preventDefault(); if (!busy && dirty && !invalid) void onSave({ frontId: front, dialpadId: dialpad, frontChannelId: channel, frontSignatureId: signature }); }}>
      <fieldset disabled={busy} className="team-connection-fields">
        <div className="form-grid">
          <label className="field">Front teammate ID<input value={frontId} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="tea_…" aria-invalid={frontError} aria-describedby="front-id-help" onChange={event => { if (event.target.value.trim() !== front) { setFrontChannelId(""); setFrontSignatureId(""); } setFrontId(event.target.value); }} />
            <span id="front-id-help" className={frontError ? "error-text" : "muted small"}>{frontError ? "Use a Front teammate ID beginning with tea_, followed by lowercase letters or numbers." : "Starts with tea_, followed by letters and numbers."}</span></label>
          <label className="field">Dialpad user ID<input value={dialpadId} inputMode="numeric" autoComplete="off" spellCheck={false} aria-invalid={dialpadError} aria-describedby="dialpad-id-help" onChange={event => setDialpadId(event.target.value)} />
            <span id="dialpad-id-help" className={dialpadError ? "error-text" : "muted small"}>{dialpadError ? "Use the numeric Dialpad user ID without spaces or punctuation." : "The numeric user ID from Dialpad."}</span></label>
          <label className="field">Email channel ID<input value={frontChannelId} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="cha_…" aria-invalid={channelError} aria-describedby="front-channel-help front-email-help" onChange={event => setFrontChannelId(event.target.value)} />
            <span id="front-channel-help" className={channelError ? "error-text" : "muted small"}>{channelError ? "Link a Front teammate and use their channel ID beginning with cha_." : "Optional Front sending channel, beginning with cha_."}</span></label>
          <label className="field">Email signature ID<input value={frontSignatureId} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="sig_…" aria-invalid={signatureError} aria-describedby="front-signature-help front-email-help" onChange={event => setFrontSignatureId(event.target.value)} />
            <span id="front-signature-help" className={signatureError ? "error-text" : "muted small"}>{signatureError ? "Link a Front teammate and use their signature ID beginning with sig_." : "Optional Front email signature, beginning with sig_."}</span></label>
        </div>
        <p id="front-email-help" className="muted small">Leave blank to use the salesperson’s only mailbox and default signature in Front. Changing the Front teammate clears these selections.</p>
        <div className="form-actions"><button type="submit" className="primary" disabled={!dirty || invalid}>{busy ? "Saving…" : "Save connections"}</button><button type="button" className="secondary" onClick={onClose}>Cancel</button></div>
      </fieldset>
    </form>
  </Modal>;
}
