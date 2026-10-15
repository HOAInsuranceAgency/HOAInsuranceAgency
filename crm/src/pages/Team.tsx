import { useEffect, useRef, useState } from "react";
import { useIsOwner } from "../lib/auth";
import { LeadEligibilityCells, LeadEligibilityEditor, LeadEligibilityFeedback, useLeadEligibilitySettings } from "../components/LeadEligibilitySettings";
import { client, fmtDate, friendlyError, type UserProfile } from "../lib/client";
import { toE164 } from "../../amplify/functions/lead-intake/sms";
import { Badge, flagBadge } from "../lib/badges";
import SignatureManager from "../components/SignatureManager";
import Modal from "../components/Modal";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";
import { useFormState } from "../lib/useFormState";
import { DEFAULT_USER_ROLE, isUserRole, USER_ROLE_OPTIONS, type UserRole } from "../lib/enums";

interface TeamUser {
  userId: string;
  email: string;
  createdAt: string | null;
  groups: string[];
  enabled?: boolean;
}

function RoleChoices({ roles, onChange, disabled = false, keepRole, canManageOwners }: {
  roles: UserRole[];
  onChange: (roles: UserRole[]) => void;
  disabled?: boolean;
  keepRole?: "ADMIN" | "OWNER";
  canManageOwners: boolean;
}) {
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
    <legend>Assigned roles</legend>
    <p className="muted small" style={{ margin: "4px 0 10px" }}>Choose one or two roles.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
      {USER_ROLE_OPTIONS.filter(option => option.value !== "OWNER" || canManageOwners || roles.includes("OWNER")).map(option => {
        const checked = roles.includes(option.value);
        return <label key={option.value} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={checked}
            disabled={(option.value === "OWNER" && !canManageOwners) || (checked ? roles.length === 1 || keepRole === option.value : roles.length >= 2)}
            onChange={() => onChange(checked ? roles.filter(role => role !== option.value) : [...roles, option.value])} />
          {option.label}
        </label>;
      })}
    </div>
    {keepRole && <p className="muted small">Keep your {keepRole === "OWNER" ? "Owner" : "Admin"} role to manage team access.</p>}
  </fieldset>;
}

function RoleEditor({ user, name, currentUser, onSave, onClose }: {
  user: TeamUser;
  name: string;
  currentUser: boolean;
  onSave: (roles: UserRole[]) => Promise<void>;
  onClose: () => void;
}) {
  const canManageOwners = useIsOwner();
  const initialRoles = user.groups.filter(isUserRole);
  const [roles, setRoles] = useState<UserRole[]>(initialRoles);
  const status = useSaveStatus();
  const dirty = roles.length !== initialRoles.length || roles.some(role => !initialRoles.includes(role));
  const close = () => { if (!status.busy) onClose(); };
  return <Modal title={`Roles for ${name}`} className="modal-form team-connection-modal" onClose={close}>
    <p className="muted small">The team member can switch between assigned roles at the bottom of the side menu.</p>
    <RoleChoices roles={roles} disabled={status.busy || (initialRoles.includes("OWNER") && !canManageOwners)} canManageOwners={canManageOwners}
      keepRole={currentUser ? initialRoles.includes("OWNER") ? "OWNER" : initialRoles.includes("ADMIN") ? "ADMIN" : undefined : undefined}
      onChange={next => { setRoles(next); status.markDirty(); }} />
    <div className="form-actions">
      <button className="primary" disabled={status.busy || !dirty || roles.length < 1 || roles.length > 2}
        onClick={() => void status.run(async () => { await onSave(roles); onClose(); }, { errorMessage: "Couldn't save roles." })}>
        {status.busy ? "Saving…" : "Save roles"}
      </button>
      <button className="secondary" disabled={status.busy} onClick={close}>Cancel</button>
      <SaveStatus {...status.status} />
    </div>
  </Modal>;
}

function AccessEditor({ user, name, onSave, onClose }: {
  user: TeamUser;
  name: string;
  onSave: (enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const status = useSaveStatus();
  const pending = useRef(false);
  const enable = user.enabled === false;
  const close = () => { if (!pending.current) onClose(); };
  async function save() {
    if (pending.current) return;
    pending.current = true;
    try {
      await status.run(async () => { await onSave(enable); onClose(); }, { errorMessage: "Couldn't update this member's access." });
    } finally { pending.current = false; }
  }
  return <Modal title={`${enable ? "Reactivate" : "Deactivate"} ${name}`} className="modal-form team-connection-modal" onClose={close}>
    <p>{enable ? "Restore this team member’s access to the CRM. They’ll need to sign in again."
      : "Block this team member’s CRM access and sign them out. They won’t be eligible for new assignments. You can reactivate them later."}</p>
    <div className="form-actions">
      <button type="button" className={enable ? "primary" : "danger"} disabled={status.busy} onClick={() => void save()}>
        {status.busy ? "Updating access…" : enable ? "Reactivate user" : "Deactivate user"}
      </button>
      <button type="button" className="secondary" disabled={status.busy} onClick={close}>Cancel</button>
      <SaveStatus {...status.status} />
    </div>
  </Modal>;
}

/**
 * The lead-text switch and the number it sends to.
 *
 * Its own component for the local phone draft: the field commits on blur, so
 * between keystrokes it holds a value the saved profile does not, and keeping
 * that in the page would re-render every row on every character.
 *
 * The unreachable-number warning is here rather than left to the Lambda's log
 * because this is the only screen where it can be fixed. `toE164` is the same
 * function the sender uses, so what this calls unreachable is exactly what
 * will be skipped.
 */
function LeadTextCell({
  profile,
  onSave,
  disabled,
}: {
  profile: UserProfile;
  disabled: boolean;
  onSave: (p: UserProfile, patch: Partial<UserProfile>) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(profile.mobilePhone ?? "");
  const previousPhone = useRef(profile.mobilePhone ?? "");
  useEffect(() => {
    const phone = profile.mobilePhone ?? "";
    const previous = previousPhone.current;
    setDraft(current => current === previous ? phone : current);
    previousPhone.current = phone;
  }, [profile.mobilePhone]);
  const on = !!profile.leadTextAlerts;
  const reachable = toE164(draft) !== null;

  return (
    <div className="lead-text-cell">
      <label className="lead-text-switch">
        <input
          type="checkbox"
          disabled={disabled}
          checked={on}
          aria-label={`Lead texts for ${profile.firstName} ${profile.lastName}`}
          onChange={(e) => void onSave(profile, { leadTextAlerts: e.target.checked })}
        />
        <span>{on ? "On" : "Off"}</span>
      </label>
      <input
        disabled={disabled}
        className="lead-text-phone"
        type="tel"
        inputMode="tel"
        placeholder="Mobile number"
        aria-label={`Mobile number for ${profile.firstName} ${profile.lastName}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== (profile.mobilePhone ?? "")) {
            void onSave(profile, { mobilePhone: next || null });
          }
        }}
      />
      {on && !reachable && (
        <span className="error-text small">
          {draft.trim()
            ? "Not a number we can text."
            : "No mobile number — nothing will send."}
        </span>
      )}
    </div>
  );
}

// Stable identity for "not loaded yet" (and for a failed read), so the sort
// memo isn't rebuilt on every render while the team list is still in flight.
const NO_USERS: TeamUser[] = [];
const EMPTY_TEAM = { users: NO_USERS, profiles: [] as UserProfile[], nextToken: null as string | null };

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return (raw as Record<string, unknown>) ?? {};
}

async function fetchTeamPage(nextToken?: string) {
  const { data, errors } = await client.queries.listTeamUsers({ nextToken });
  if (errors?.length) throw new Error(errors[0].message);
  const body = parse(data);
  if (body.ok === false) throw new Error(String(body.error ?? "Failed to load team"));
  const users = (body.users as TeamUser[] | undefined) ?? NO_USERS;
  // The bounded server response includes profile decorations, so opening a
  // roster page requires one browser request regardless of its member count.
  const profiles = (body.profiles as UserProfile[] | undefined) ?? [];
  return { users, profiles, nextToken: typeof body.nextToken === "string" && body.nextToken ? body.nextToken : null };
}

/**
 * ADMIN-only. Rendered only for the Cognito ADMIN group (Settings gates the
 * tab on it), and enforced server-side by the group rule on the mutations —
 * so there's no check of its own here.
 */
export default function Team({ profile }: { profile: UserProfile }) {
  const canManageOwners = useIsOwner();
  const eligibility = useLeadEligibilitySettings();
  // The invite confirmation used to be a `notice` string nothing ever
  // cleared — it sat over the form while you typed the next invitee's
  // address. `markDirty` in `onEdit` is what retires it now.
  const inviteStatus = useSaveStatus();
  // Auto-clearing: these are per-row edits with no form to go dirty and
  // retire the message, so nothing else would ever clear it.
  const alertStatus = useSaveStatus({ autoClearMs: 4000 });
  const alertPending = useRef(false);
  const [editingRoles, setEditingRoles] = useState<TeamUser | null>(null);
  const [editingAccess, setEditingAccess] = useState<TeamUser | null>(null);
  const roleStatus = useSaveStatus({ autoClearMs: 4000 });
  const accessStatus = useSaveStatus({ autoClearMs: 4000 });
  const { form, setF, reset } = useFormState(
    { email: "", roles: [DEFAULT_USER_ROLE] as UserRole[] },
    { onEdit: inviteStatus.markDirty }
  );

  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState("");
  const morePending = useRef(false);
  const pageVersion = useRef(0);
  useEffect(() => () => { pageVersion.current++; }, []);

  // `client.queries.*` reports failure by *resolving* with an `errors` array,
  // so the unwrap has to stay inside the fetcher — nothing above it would see
  // a rejection otherwise.
  const team = useAsyncResource(
    async () => {
      // Refresh starts a new sequence. An older Load more response cannot
      // append stale rows or replace the refreshed continuation token.
      pageVersion.current++;
      morePending.current = false;
      setMoreLoading(false);
      setMoreError("");
      return fetchTeamPage();
    },
    [],
    { initialData: EMPTY_TEAM, errorMessage: "Failed to load team" }
  );
  const { users, profiles } = team.data;
  const setProfiles = (update: (profiles: UserProfile[]) => UserProfile[]) =>
    team.setData(previous => ({ ...previous, profiles: update(previous.profiles) }));

  async function loadMore() {
    const nextToken = team.data.nextToken;
    if (!nextToken || team.loading || morePending.current) return;
    const version = pageVersion.current;
    morePending.current = true;
    setMoreLoading(true);
    setMoreError("");
    try {
      const page = await fetchTeamPage(nextToken);
      if (version !== pageVersion.current) return;
      // Cognito pagination can repeat a member if the pool changes between
      // reads. Keep existing rows (and any edits) instead of duplicating them.
      team.setData(previous => ({
        users: [...previous.users, ...page.users.filter(user => !previous.users.some(existing => existing.userId === user.userId))],
        profiles: [...previous.profiles, ...page.profiles.filter(p => !previous.profiles.some(existing => existing.id === p.id))],
        nextToken: page.nextToken,
      }));
    } catch (error) {
      if (version === pageVersion.current) setMoreError(friendlyError(error, "Couldn't load more team members."));
    } finally {
      if (version === pageVersion.current) {
        morePending.current = false;
        setMoreLoading(false);
      }
    }
  }

  // An invite adds a Cognito user, so restart the roster and its decorations.
  function reload() {
    void team.refetch();
    eligibility.refresh();
  }

  async function invite() {
    const email = form.email.trim().toLowerCase();
    if (!email) return;
    await inviteStatus.run(
      async () => {
        const { data, errors } = await client.mutations.inviteUser({
          email,
          roles: form.roles,
        });
        if (errors?.length) throw new Error(errors[0].message);
        const body = parse(data);
        if (!body.ok) {
          // Failed cleanup can leave a real member behind. Refresh access
          // details while keeping the invitation failure beside the form.
          reload();
          throw new Error(String(body.error ?? "Invite failed"));
        }
        // Clear the submitted address while preserving the selected roles.
        // This is a completed-form reset, not an unsaved user edit.
        reset({ ...form, email: "" });
        reload();
      },
      {
        savedMessage: `Invited ${email} as ${form.roles.join(" and ")}. They'll get an email with the portal link — they sign in with a magic link, no password.`,
        errorMessage: "Invite failed",
      }
    );
  }

  const profileFor = (u: TeamUser) =>
    profiles.find((p) => p.userId === u.userId || p.email === u.email);

  async function saveRoles(user: TeamUser, roles: UserRole[]) {
    const { data, errors } = await client.mutations.updateUserRoles({ userId: user.userId, roles });
    if (errors?.length) throw new Error(errors[0].message);
    const body = parse(data);
    if (!body.ok) {
      void team.refetch();
      throw new Error(String(body.error ?? "Couldn't save roles."));
    }
    team.setData(previous => ({ ...previous, users: previous.users.map(member => member.userId === user.userId
      ? { ...member, groups: [...member.groups.filter(group => !isUserRole(group)), ...roles] }
      : member) }));
    roleStatus.markSaved(`Roles updated for ${user.email}.`);
    eligibility.refresh();
    if (user.userId === profile.userId) window.dispatchEvent(new Event("team-roles-changed"));
  }

  async function saveAccess(user: TeamUser, enabled: boolean) {
    const { data, errors } = await client.mutations.setTeamUserEnabled({ userId: user.userId, enabled });
    const body = parse(data);
    if (typeof body.enabled === "boolean") {
      team.setData(previous => ({ ...previous, users: previous.users.map(member => member.userId === user.userId
        ? { ...member, enabled: body.enabled as boolean } : member) }));
    }
    eligibility.refresh();
    if (errors?.length || !body.ok) {
      void team.refetch();
      throw new Error(errors?.[0]?.message ?? String(body.error ?? "Couldn't update this member's access."));
    }
    accessStatus.markSaved(`Access ${enabled ? "restored" : "deactivated"} for ${user.email}.`);
  }

  /**
   * Save a lead-alert change straight away — there is no Save button on this
   * table, and a toggle that needed one would be a toggle people believe they
   * have set. The phone field commits on blur for the same reason.
   */
  async function saveAlerts(p: UserProfile, patch: Partial<UserProfile>) {
    if (alertPending.current) return;
    alertPending.current = true;
    await alertStatus.run(
      async () => {
        const { data, errors } = await client.models.UserProfile.update({
          id: p.id,
          ...patch,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        // Only the submitted fields belong to this response; another control
        // may have saved a signature or profile decoration in the meantime.
        const committed = Object.fromEntries(Object.keys(patch).map(key => [key, data[key as keyof UserProfile]]));
        setProfiles(ps => ps.map(x => x.id === data.id ? { ...x, ...committed } : x));
      },
      {
        savedMessage: `Lead alerts updated for ${p.firstName} ${p.lastName}.`,
        errorMessage: "Couldn't save that.",
      }
    );
    alertPending.current = false;
  }

  // By email; a user with no email sorts last, which useSort does for nulls
  // in either direction.
  const { sorted, sortKey, dir, toggle } = useSort(
    users,
    {
      email: (u) => u.email,
      name: (u) => {
        const p = profileFor(u);
        return p ? `${p.firstName} ${p.lastName}` : null;
      },
      role: (u) => u.groups.filter(isUserRole).join(", ") || profileFor(u)?.role,
      onboarded: (u) => (profileFor(u)?.onboardingComplete ? "Yes" : "Invited"),
      leadTexts: (u) => (profileFor(u)?.leadTextAlerts ? "On" : "Off"),
      invited: (u) => u.createdAt,
    },
    "email"
  );

  return (
    <>
      <div className="card">
        <h2>Team — invite someone</h2>
        <p className="muted small">
          Invited staff and producers sign in with an emailed link — no
          passwords. Admin only.
        </p>
        <div className="form-grid" style={{ maxWidth: 640 }}>
          <div className="field">
            <label htmlFor="team-invite-email">Email</label>
            <input
              id="team-invite-email"
              disabled={inviteStatus.busy}
              type="email"
              value={form.email}
              onChange={(e) => setF("email", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
            />
          </div>
          <div className="field">
            <RoleChoices roles={form.roles} disabled={inviteStatus.busy} canManageOwners={canManageOwners} onChange={roles => setF("roles", roles)} />
          </div>
        </div>
        <div className="form-actions">
          <button
            className="primary"
            disabled={inviteStatus.busy || !form.email.trim()}
            onClick={invite}
          >
            {inviteStatus.busy ? "Inviting…" : "Send invite"}
          </button>
          <SaveStatus {...inviteStatus.status} />
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Producers complete their licensing details during first sign-in.
          Assign up to two roles. Team members switch roles at the bottom of
          the side menu; Producer shows only their assigned accounts and work.
        </p>
      </div>

      <section className="card team-eligibility" aria-labelledby="team-members-title">
        <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
          <div>
            <h2 id="team-members-title" style={{ margin: 0 }}>Team members</h2>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Assign roles and manage access, new leads, lead texts and connections in one place.
              Producers are automatically eligible for account assignments. Receive new leads controls automatic website lead rotation.
              Only the assigned producer gets the Front conversation and lead text.
              Lead texts need both the switch and a mobile number.
            </p>
          </div>
          <div className="grow" />
          <button type="button" className="secondary" disabled={team.loading || moreLoading || alertStatus.busy || eligibility.disabled || !!editingRoles || !!editingAccess} onClick={reload}>
            Refresh team
          </button>
          {/* Toggles are per-row with no per-row place to report; this is
              the card's one status line. */}
          <SaveStatus {...alertStatus.status} />
          <SaveStatus {...roleStatus.status} />
          <SaveStatus {...accessStatus.status} />
        </div>
        <LeadEligibilityFeedback settings={eligibility} />
        {!team.loaded ? (
          <p className="muted small">Loading…</p>
        ) : users.length === 0 ? (
          !team.error && <p className="muted small">No users found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="Team member" colKey="email" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Roles" colKey="role" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th scope="col">Access</th>
                  <SortTh label="Onboarded" colKey="onboarded" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Signature</th>
                  <SortTh label="Lead texts" colKey="leadTexts" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th scope="col">Receive new leads</th>
                  <th scope="col">Connections</th>
                  <SortTh label="Invited" colKey="invited" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => {
                  const p = profileFor(u);
                  const member = eligibility.resource.data.team.find(item => item.userId === u.userId);
                  const name = p ? `${p.firstName} ${p.lastName}` : member?.name;
                  return (
                    <tr key={u.userId}>
                      <td>
                        <div>{name || u.email}</div>
                        {name && <div className="muted small">{u.email}</div>}
                        {u.email === profile.email && (
                          <span className="badge blue" style={{ marginLeft: 6 }}>
                            you
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                          {(u.groups.filter(isUserRole).length ? u.groups.filter(isUserRole) : [p?.role ?? "—"]).map(role =>
                            <span key={role} className="badge gray">{role}</span>)}
                        </div>
                        <button type="button" className="secondary" disabled={team.loading || eligibility.busy || !!editingRoles || !!editingAccess || (u.groups.includes("OWNER") && !canManageOwners)} aria-label={`Edit roles for ${name || u.email}`}
                          onClick={() => { roleStatus.markDirty(); setEditingRoles(u); }}>Edit roles</button>
                      </td>
                      <td>
                        <div style={{ marginBottom: 6 }}><span className={`badge ${u.enabled === false ? "gray" : "green"}`}>{u.enabled === false ? "Inactive" : "Active"}</span></div>
                        {canManageOwners && <button type="button" className="secondary"
                          disabled={u.userId === profile.userId || team.loading || eligibility.busy || !!editingRoles || !!editingAccess}
                          aria-label={`${u.enabled === false ? "Reactivate" : "Deactivate"} ${name || u.email}`}
                          onClick={() => { accessStatus.markDirty(); setEditingAccess(u); }}>{u.enabled === false ? "Reactivate" : "Deactivate"}</button>}
                      </td>
                      <td>
                        {/* One-off pair — onboarding state is badged here and
                            nowhere else. Note `p` may be absent entirely,
                            which `flagBadge` reads as not-onboarded. */}
                        <Badge
                          {...flagBadge(p?.onboardingComplete, {
                            on: { cls: "green", label: "Yes" },
                            off: { cls: "amber", label: "Invited" },
                          })}
                        />
                      </td>
                      <td>
                        <SignatureManager
                          compact
                          profile={p ?? null}
                          onChange={(updated) =>
                            setProfiles((ps) =>
                              ps.map((x) => (x.id === updated.id ? { ...x, signatureKey: updated.signatureKey } : x))
                            )
                          }
                        />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {/* No profile means the invite is unaccepted — there
                            is no row to write the preference onto yet. */}
                        {p ? (
                          <LeadTextCell profile={p} disabled={u.enabled === false || team.loading || alertStatus.busy || !!editingAccess} onSave={saveAlerts} />
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <LeadEligibilityCells member={member} settings={eligibility} disabled={u.enabled === false || team.loading || !!editingRoles || !!editingAccess} />
                      <td className="small">
                        {fmtDate(u.createdAt?.slice(0, 10))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {team.error && <div role="alert">
          <p className="error-text">{team.error}</p>
          <button type="button" className="secondary" disabled={team.loading} onClick={() => void team.refetch()}>Retry team</button>
        </div>}
        {moreError && <p className="error-text" role="alert">{moreError}</p>}
        {team.data.nextToken && <div className="form-actions">
          <button type="button" className="secondary" disabled={team.loading || moreLoading} onClick={() => void loadMore()}>
            {moreLoading ? "Loading more…" : moreError ? "Retry loading more" : "Load more team members"}
          </button>
        </div>}
        <LeadEligibilityEditor settings={eligibility} />
        {editingRoles && <RoleEditor user={editingRoles}
          name={(() => { const p = profileFor(editingRoles); return p ? `${p.firstName} ${p.lastName}` : editingRoles.email; })()}
          currentUser={editingRoles.userId === profile.userId}
          onSave={roles => saveRoles(editingRoles, roles)} onClose={() => setEditingRoles(null)} />}
        {editingAccess && <AccessEditor user={editingAccess}
          name={(() => { const p = profileFor(editingAccess); return p ? `${p.firstName} ${p.lastName}` : editingAccess.email; })()}
          onSave={enabled => saveAccess(editingAccess, enabled)} onClose={() => setEditingAccess(null)} />}
      </section>
    </>
  );
}
