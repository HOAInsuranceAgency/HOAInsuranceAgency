import { useState } from "react";
import { client, fmtDate, type UserProfile } from "../lib/client";
import { toE164 } from "../../amplify/functions/lead-intake/sms";
import { Badge, flagBadge } from "../lib/badges";
import SignatureManager from "../components/SignatureManager";
import { SaveStatus, useSaveStatus } from "../components/SaveStatus";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSort, SortTh } from "../lib/useSort";
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
}: {
  profile: UserProfile;
  onSave: (p: UserProfile, patch: Partial<UserProfile>) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(profile.mobilePhone ?? "");
  const on = !!profile.leadTextAlerts;
  const reachable = toE164(draft) !== null;

  return (
    <div className="lead-text-cell">
      <label className="lead-text-switch">
        <input
          type="checkbox"
          checked={on}
          aria-label={`Lead texts for ${profile.firstName} ${profile.lastName}`}
          onChange={(e) => void onSave(profile, { leadTextAlerts: e.target.checked })}
        />
        <span>{on ? "On" : "Off"}</span>
      </label>
      <input
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

/**
 * ADMIN-only. Rendered only for the Cognito ADMIN group (Settings gates the
 * tab on it), and enforced server-side by the group rule on the mutations —
 * so there's no check of its own here.
 */
export default function Team({ profile }: { profile: UserProfile }) {
  // The invite confirmation used to be a `notice` string nothing ever
  // cleared — it sat over the form while you typed the next invitee's
  // address. `markDirty` in `onEdit` is what retires it now.
  const inviteStatus = useSaveStatus();
  // Auto-clearing: these are per-row edits with no form to go dirty and
  // retire the message, so nothing else would ever clear it.
  const alertStatus = useSaveStatus({ autoClearMs: 4000 });
  const { form, setF } = useFormState(
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
        setF("email", "");
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

  /**
   * Save a lead-alert change straight away — there is no Save button on this
   * table, and a toggle that needed one would be a toggle people believe they
   * have set. The phone field commits on blur for the same reason.
   */
  async function saveAlerts(p: UserProfile, patch: Partial<UserProfile>) {
    setProfiles((ps) =>
      ps.map((x) => (x.id === p.id ? { ...x, ...patch } : x))
    );
    await alertStatus.run(
      async () => {
        const { data, errors } = await client.models.UserProfile.update({
          id: p.id,
          ...patch,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        setProfiles((ps) => ps.map((x) => (x.id === data.id ? data : x)));
      },
      {
        savedMessage: `Lead alerts updated for ${p.firstName} ${p.lastName}.`,
        errorMessage: "Couldn't save that.",
      }
    );
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
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setF("email", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
            />
          </div>
          <div className="field">
            <label>Role</label>
            <select value={form.role} onChange={(e) => setF("role", e.target.value)}>
              {USER_ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
          The role you pick here is the user's Cognito group, and it's what
          admin-only screens and the team mutations check — so it does
          restrict access.
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
            <table>
              <thead>
                <tr>
                  <SortTh label="Email" colKey="email" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Name" colKey="name" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Role" colKey="role" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Onboarded" colKey="onboarded" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th>Signature</th>
                  <SortTh label="Lead texts" colKey="leadTexts" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Invited" colKey="invited" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => {
                  const p = profileFor(u);
                  return (
                    <tr key={u.userId}>
                      <td>
                        {u.email}
                        {u.email === profile.email && (
                          <span className="badge blue" style={{ marginLeft: 6 }}>
                            you
                          </span>
                        )}
                      </td>
                      <td>
                        {p ? `${p.firstName} ${p.lastName}` : <span className="muted">—</span>}
                      </td>
                      <td>
                        <span className="badge gray">
                          {u.groups[0] ?? p?.role ?? "—"}
                        </span>
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
                              ps.map((x) => (x.id === updated.id ? updated : x))
                            )
                          }
                        />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {/* No profile means the invite is unaccepted — there
                            is no row to write the preference onto yet. */}
                        {p ? (
                          <LeadTextCell profile={p} onSave={saveAlerts} />
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
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
      </div>
    </>
  );
}
