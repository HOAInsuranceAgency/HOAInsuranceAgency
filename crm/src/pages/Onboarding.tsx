import { useRef, useState } from "react";
import type { AuthUser } from "aws-amplify/auth";
import { client, friendlyError, US_STATES, type UserProfile } from "../lib/client";
import type { Role } from "../lib/auth";
import { loadProducerLicenses, type SavedProducerLicense } from "../lib/producerOnboarding";
import { useFormState } from "../lib/useFormState";
import {
  LICENSE_RESIDENCY_OPTIONS,
  USER_ROLE_LABELS,
  type LicenseResidency,
} from "../lib/enums";

interface LicenseDraft {
  state: string;
  licenseNumber: string;
  expirationDate: string;
  residency: LicenseResidency;
}

const emptyLicense = (): LicenseDraft => ({
  state: "",
  licenseNumber: "",
  expirationDate: "",
  residency: "RESIDENT",
});

/**
 * First-login onboarding. Staff onboard with just their name; producers must
 * provide their NPN and at least one state license before entering the CRM.
 *
 * `role` comes from the Cognito group the inviting admin put the user in —
 * it isn't the user's to choose, so what's written to UserProfile.role is a
 * mirror of the real authority rather than a claim.
 */
export default function Onboarding({
  user,
  existing,
  existingLicenses = [],
  role,
  roles = [role],
  onComplete,
}: {
  user: AuthUser;
  existing: UserProfile | null;
  existingLicenses?: SavedProducerLicense[];
  role: Role;
  roles?: Role[];
  onComplete: (p: UserProfile, licenses: SavedProducerLicense[]) => void;
}) {
  const { form, setF } = useFormState({
    firstName: existing?.firstName ?? "",
    lastName: existing?.lastName ?? "",
    npn: existing?.npn ?? "",
    licenses: (existingLicenses.length ? [] : [emptyLicense()]) as LicenseDraft[],
  });
  const savedProfile = useRef(existing);
  const confirmedLicenses = useRef<SavedProducerLicense[]>([]);
  const [savedLicenses, setSavedLicenses] = useState(existingLicenses);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isProducer = roles.includes("PRODUCER");
  const validLicenses = form.licenses.filter(
    (l) => l.state && l.licenseNumber.trim()
  );

  function setLicense(i: number, patch: Partial<LicenseDraft>) {
    setF("licenses", (ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (isProducer && !form.npn.trim()) {
      setError("Producers must provide their NPN.");
      return;
    }
    if (isProducer && savedLicenses.length === 0 && validLicenses.length === 0) {
      setError("Producers must provide at least one state license.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const email =
        user.signInDetails?.loginId ?? existing?.email ?? "unknown@unknown";
      const payload = {
        userId: user.userId,
        email,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        role,
        npn: isProducer ? form.npn.trim() : undefined,
        // License writes can fail independently. Keep setup open until all
        // submitted licenses have been persisted successfully.
        onboardingComplete: !isProducer,
      };
      const newProfileId = `onboarding:${user.userId}`;
      if (!savedProfile.current) {
        // A create may persist even when its response is lost. Reconcile its
        // stable identity before retrying, including after a page reload.
        const recovered = await client.models.UserProfile.get({ id: newProfileId });
        if (recovered.errors?.length) {
          throw new Error(recovered.errors[0].message || "Couldn't load your profile.");
        }
        if (recovered.data) {
          if (recovered.data.userId !== user.userId) throw new Error("Couldn't load your profile.");
          savedProfile.current = recovered.data;
        }
      }
      const { data: profile, errors } = savedProfile.current
        ? await client.models.UserProfile.update({ id: savedProfile.current.id, ...payload })
        : await client.models.UserProfile.create({ id: newProfileId, ...payload });
      if (profile) savedProfile.current = profile;
      if (errors?.length || !profile) throw new Error(errors?.[0]?.message || "Failed to save profile.");

      if (isProducer) {
        // Reconcile on every attempt: an earlier request may have persisted a
        // license even if its response was lost. Keep successful partial work.
        const persisted = await loadProducerLicenses(profile.id);
        // Lists may lag successful creates. Retain confirmed writes from this
        // setup session so a final-profile retry does not require re-entry.
        for (const confirmed of confirmedLicenses.current) {
          if (!persisted.some((saved) => saved.state === confirmed.state && saved.licenseNumber === confirmed.licenseNumber)) {
            persisted.push(confirmed);
          }
        }
        setSavedLicenses(persisted);
        for (const l of validLicenses) {
          const licenseNumber = l.licenseNumber.trim();
          if (!persisted.some((saved) => saved.state === l.state && saved.licenseNumber === licenseNumber)) {
            const result = await client.models.License.create({
              // The same license retains its identity across retries/reloads,
              // including a write whose response was lost before the list catches up.
              id: `onboarding:${profile.id}:${l.state}:${encodeURIComponent(licenseNumber)}`,
              holderType: "PRODUCER",
              userProfileId: profile.id,
              holderName: `${form.firstName.trim()} ${form.lastName.trim()}`,
              state: l.state,
              licenseNumber,
              npn: form.npn.trim(),
              licenseClass: "PRODUCER",
              residency: l.residency,
              status: "ACTIVE",
              expirationDate: l.expirationDate || undefined,
            });
            if (result.errors?.length || !result.data) {
              throw new Error(result.errors?.[0]?.message || "Failed to save state license.");
            }
            confirmedLicenses.current.push(result.data);
            persisted.push(result.data);
            setSavedLicenses([...persisted]);
          }
          setF("licenses", (drafts) => drafts.filter((draft) =>
            draft.state !== l.state || draft.licenseNumber.trim() !== licenseNumber
          ));
        }
        if (!persisted.length) throw new Error("Producers must provide at least one state license.");
        const completed = await client.models.UserProfile.update({ id: profile.id, onboardingComplete: true });
        if (completed.errors?.length || !completed.data) {
          throw new Error(completed.errors?.[0]?.message || "Failed to complete setup.");
        }
        savedProfile.current = completed.data;
        onComplete(completed.data, persisted);
      } else {
        onComplete(profile, []);
      }
    } catch (err) {
      setError(friendlyError(err, "Failed to save profile."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="main" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1>Welcome to HOA CRM</h1>
      <p className="sub">Set up your profile to get started.</p>

      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label>First name *</label>
            <input disabled={saving} value={form.firstName} onChange={(e) => setF("firstName", e.target.value)} />
          </div>
          <div className="field">
            <label>Last name *</label>
            <input disabled={saving} value={form.lastName} onChange={(e) => setF("lastName", e.target.value)} />
          </div>
          <div className="field">
            <label>Assigned roles</label>
            <input value={(roles.length ? roles : [role]).map(value => USER_ROLE_LABELS[value]).join(" + ")} disabled />
            <span className="muted small">
              Set by whoever invited you — ask an admin to change it.
            </span>
          </div>
          {isProducer && (
            <div className="field">
              <label>NPN (National Producer Number) *</label>
              <input disabled={saving} value={form.npn} onChange={(e) => setF("npn", e.target.value)} />
            </div>
          )}
        </div>

        {isProducer && (
          <>
            <h3>State licenses *</h3>
            {savedLicenses.map((license) => (
              <p key={license.id}>Saved license: {license.state} · {license.licenseNumber}</p>
            ))}
            {form.licenses.map((l, i) => (
              <div className="form-grid" key={i} style={{ marginBottom: 8 }}>
                <div className="field">
                  <label>State</label>
                  <select
                    disabled={saving}
                    value={l.state}
                    onChange={(e) => setLicense(i, { state: e.target.value })}
                  >
                    <option value="">—</option>
                    {US_STATES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>License number</label>
                  <input
                    disabled={saving}
                    value={l.licenseNumber}
                    onChange={(e) => setLicense(i, { licenseNumber: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Residency</label>
                  <select
                    disabled={saving}
                    value={l.residency}
                    onChange={(e) =>
                      setLicense(i, {
                        residency: e.target.value as LicenseDraft["residency"],
                      })
                    }
                  >
                    {LICENSE_RESIDENCY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Expiration</label>
                  <input
                    disabled={saving}
                    type="date"
                    value={l.expirationDate}
                    onChange={(e) => setLicense(i, { expirationDate: e.target.value })}
                  />
                </div>
              </div>
            ))}
            <button
              className="secondary"
              disabled={saving}
              onClick={() =>
                setF("licenses", (ls) => [
                  ...ls,
                  // Additional licenses are non-resident by default — you only
                  // ever hold one resident license.
                  { ...emptyLicense(), residency: "NON_RESIDENT" },
                ])
              }
            >
              + Add another license
            </button>
          </>
        )}

        <div className="form-actions">
          <button className="primary" disabled={saving} onClick={submit}>
            {saving ? "Saving…" : "Complete setup"}
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      </div>
    </div>
  );
}
