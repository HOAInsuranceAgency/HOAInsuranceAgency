import { Disclosure, Field } from "../components/ui/kit";
import { useDirtyForms } from "../components/ui/unsaved";
import TeamWorkflowSettings from "../components/TeamWorkflowSettings";
import { useState } from "react";
import LeadEligibilitySettings from "../components/LeadEligibilitySettings";
import { client, type UserProfile } from "../lib/client";
import { toE164 } from "../../amplify/functions/lead-intake/sms";
import { Badge, flagBadge } from "../lib/badges";
import SignatureManager from "../components/SignatureManager";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { useAsyncResource } from "../lib/useAsyncResource";
import { MobileSort, useSort, SortTh } from "../lib/useSort";
import { useFormState } from "../lib/useFormState";
import { DEFAULT_USER_ROLE, USER_ROLE_OPTIONS } from "../lib/enums";

interface TeamUser {
  userId: string;
  email: string;
  createdAt: string | null;
  groups: string[];
}

/**
 * The lead-text switch and the number it sends to.
 *
 * Keeps notification and phone edits together until Save notifications.
 * A failed save retains both values for correction or retry.
 *
 * The unreachable-number warning is here rather than left to the Lambda's log
 * because this is the only screen where it can be fixed. `toE164` is the same
 * function the sender uses, so what this calls unreachable is exactly what
 * will be skipped.
 */
function LeadTextCell({ profile, onSave }: { profile: UserProfile; onSave: (profile: UserProfile, patch: Partial<UserProfile>) => Promise<boolean> }) {
  const draft = useFormState({ phone: profile.mobilePhone ?? "", enabled: !!profile.leadTextAlerts });
  const [busy, setBusy] = useState(false);
  const reachable = toE164(draft.form.phone) !== null;
  return <div className="lead-text-cell">
    <label><input type="checkbox" checked={draft.form.enabled} onChange={e => draft.setF("enabled", e.target.checked)} /> Enable lead text notifications</label>
    <label className="field">Mobile number<input type="tel" value={draft.form.phone} onChange={e => draft.setF("phone", e.target.value)} /></label>
    {draft.form.enabled && !reachable && <p className="error-text">Enter a mobile number that can receive texts.</p>}
    <div className="summary-actions"><button disabled={busy || !draft.dirty || draft.form.enabled && !reachable} onClick={async () => { setBusy(true); try { if (await onSave(profile, { leadTextAlerts: draft.form.enabled, mobilePhone: draft.form.phone.trim() || null })) draft.markSaved(); } finally { setBusy(false); } }}>{busy ? "Saving…" : "Save notifications"}</button><button className="secondary" disabled={busy || !draft.dirty} onClick={() => draft.reset()}>Cancel</button></div>
  </div>;
}

// Stable identity for "not loaded yet" (and for a failed read), so the sort
// memo isn't rebuilt on every render while the team list is still in flight.
const NO_USERS: TeamUser[] = [];

/**
 * ADMIN-only. Rendered only for the Cognito ADMIN group (Settings gates the
 * tab on it), and enforced server-side by the group rule on the mutations —
 * so there's no check of its own here.
 */
export default function Team({ profile }: { profile: UserProfile }) {
  // The invite confirmation used to be a `notice` string nothing ever
  // cleared — it sat over the form while you typed the next invitee's
  // address. `markDirty` in `onEdit` is what retires it now.
  const { confirmDiscard } = useDirtyForms();
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const inviteStatus = useSaveStatus();
  // Auto-clearing: these are per-row edits with no form to go dirty and
  // retire the message, so nothing else would ever clear it.
  const alertStatus = useSaveStatus({ autoClearMs: 4000 });
  const { form, setF, reset } = useFormState(
    { email: "", role: DEFAULT_USER_ROLE as string },
    { onEdit: inviteStatus.markDirty }
  );

  const parse = (raw: unknown): Record<string, unknown> => {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return (raw as Record<string, unknown>) ?? {};
  };

  // `client.queries.*` reports failure by *resolving* with an `errors` array,
  // so the unwrap has to stay inside the fetcher — nothing above it would see
  // a rejection otherwise.
  const team = useAsyncResource(
    async () => {
      const { data, errors } = await client.queries.listTeamUsers();
      if (errors?.length) throw new Error(errors[0].message);
      return (parse(data).users as TeamUser[] | undefined) ?? NO_USERS;
    },
    [],
    { initialData: NO_USERS, errorMessage: "Failed to load team" }
  );
  const users = team.data;

  // Profiles decorate the roster (name, onboarding, signature) — the roster
  // itself renders without them, so this read's failure is deliberately not
  // surfaced, exactly as the bare `.then()` it replaces did not surface it.
  // The hook still catches it, which is the part that was missing.
  const profileRes = useAsyncResource(
    async () => (await client.models.UserProfile.list()).data,
    [],
    { initialData: [] as UserProfile[] }
  );
  const profiles = profileRes.data;
  const setProfiles = profileRes.setData;

  // An invite adds a Cognito user, so both reads are re-run — same as the
  // single `load()` that used to do both.
  function reload() {
    void team.refetch();
    void profileRes.refetch();
  }

  async function invite() {
    const email = form.email.trim().toLowerCase();
    if (!email) return;
    await inviteStatus.run(
      async () => {
        const { data, errors } = await client.mutations.inviteUser({
          email,
          role: form.role,
        });
        if (errors?.length) throw new Error(errors[0].message);
        const body = parse(data);
        if (!body.ok) throw new Error(String(body.error ?? "Invite failed"));
        // Not `reset()`: the baseline would put the role back to STAFF too, and
        // inviting a second person to the same role is the common case. Its
        // `onEdit` fires while the status is still "saving", which markDirty
        // ignores — so clearing the field can't erase the confirmation.
        reset({ ...form, email: "" });
        reload();
      },
      {
        savedMessage: `Invited ${email} as ${form.role}. They'll get an email with the portal link — they sign in with a magic link, no password.`,
        errorMessage: "Invite failed",
      }
    );
  }

  const profileFor = (u: TeamUser) =>
    profiles.find((p) => p.userId === u.userId || p.email === u.email);

  async function saveAlerts(p: UserProfile, patch: Partial<UserProfile>) {
    let saved = false;
    await alertStatus.run(
      async () => {
        const { data, errors } = await client.models.UserProfile.update({
          id: p.id,
          ...patch,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setProfiles((ps) => ps.map((x) => (x.id === data.id ? data : x)));
        saved = true;
      },
      {
        savedMessage: `Lead alerts updated for ${p.firstName} ${p.lastName}.`,
        errorMessage: "Couldn't save that.",
      }
    );
    return saved;
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
      role: (u) => u.groups[0] ?? profileFor(u)?.role,
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
          <Field className="field">
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setF("email", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
            />
          </Field>
          <Field className="field">
            <label>Role</label>
            <select value={form.role} onChange={(e) => setF("role", e.target.value)}>
              {USER_ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
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
          The role controls CRM access. Assignment responsibilities can be set separately after inviting them.
        </p>
      </div>

      <div className="card">
        <div className="toolbar" style={{ marginTop: 0, alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0 }}>Team members</h2>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Lead texts go out the moment a website enquiry lands. Both the
              switch and a mobile number are needed — a switch on its own
              sends nothing.
            </p>
          </div>
          <div className="grow" />
          {/* Toggles are per-row with no per-row place to report; this is
              the card's one status line. */}
          <SaveStatus {...alertStatus.status} />
        </div>
        {!team.loaded ? (
          <p className="muted small">Loading…</p>
        ) : team.error ? (
          <p className="error-text">{team.error}</p>
        ) : users.length === 0 ? (
          <p className="muted small">No users found.</p>
        ) : (
          <div className="table-wrap">
            <MobileSort options={[["email", "Email"], ["name", "Name"], ["role", "Role"], ["onboarded", "Onboarded"]]} sortKey={sortKey} dir={dir} onToggle={toggle} />
            <table className="stacked-table">
              <thead>
                <tr>
                  <SortTh label="Email" colKey="email" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Role" colKey="role" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Onboarded" colKey="onboarded" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => {
                  const p = profileFor(u);
                  return (
                    <tr key={u.userId}>
                      <td data-label="Email">
                        {u.email}
                        {u.email === profile.email && (
                          <span className="badge blue" style={{ marginLeft: 6 }}>
                            you
                          </span>
                        )}
                      </td>
                      <td data-label="Name">
                        {p ? `${p.firstName} ${p.lastName}` : <span className="muted">—</span>}
                      </td>
                      <td data-label="Role">
                        <span className="badge gray">
                          {u.groups[0] ?? p?.role ?? "—"}
                        </span>
                      </td>
                      <td data-label="Onboarded">
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
                      <td data-label="Manage"><button className="secondary" onClick={() => { if (confirmDiscard()) setSelectedUser(selectedUser === u.userId ? null : u.userId); }} aria-expanded={selectedUser === u.userId}>Manage {p?.firstName || "teammate"}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selectedUser && <div className="card"><div className="toolbar"><h2>Teammate settings</h2><button className="secondary" onClick={() => { if (confirmDiscard()) setSelectedUser(null); }}>Close teammate settings</button></div>
        <LeadEligibilitySettings key={selectedUser} userId={selectedUser} />
        {(() => { const member = profiles.find(p => p.userId === selectedUser); return member ? <><h3>Signature</h3><SignatureManager profile={member} onChange={updated => setProfiles(ps => ps.map(p => p.id === updated.id ? updated : p))} /><h3>Lead text notifications</h3><LeadTextCell key={member.id} profile={member} onSave={saveAlerts} /></> : <p>Personal settings become available after the invitation is accepted.</p>; })()}
      </div>}
      <Disclosure title="Managers and temporary coverage" description="Reporting relationships and who covers work while a teammate is away"><TeamWorkflowSettings /></Disclosure>
    </>
  );
}
