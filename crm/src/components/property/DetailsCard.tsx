import {
  client,
  US_STATES,
  unwrap,
  validateAccountFields,
  type Account,
} from "../../lib/client";
import { AddressAutocomplete } from "../../lib/googlePlaces";
import { useFormState } from "../../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../SaveStatus";
import { inputValue, num, str } from "../../lib/formCodec";
import { IntegerInput } from "../inputs";

export default function DetailsCard({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  // One owner for "is the confirmation still true": `useFormState`'s `saved`
  // is left unread and `useSaveStatus` carries saving/saved/error together.
  const saveStatus = useSaveStatus();
  const { form, setF, patch } = useFormState({
    address: inputValue(account.address),
    city: inputValue(account.city),
    county: inputValue(account.county),
    state: inputValue(account.state),
    zip: inputValue(account.zip),
    // Tri-state on purpose: unanswered is not "no". Rhode Island's financing
    // eligibility blocks until this is answered from the articles.
    incorporated:
      account.incorporated === true ? "yes" : account.incorporated === false ? "no" : "",
    unitCount: inputValue(account.unitCount),
    firewallsVerified: account.firewallsVerified ?? false,
    coastal: account.coastal ?? false,
    milesToCoast: inputValue(account.milesToCoast),
    otherUpdates: inputValue(account.otherUpdates),
    fireDistrict: inputValue(account.fireDistrict),
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    // The four system-update year checks moved with the years themselves:
    // they are per-building now, in `BuildingsCard`'s validator.
    const problems = validateAccountFields(form);
    if (problems.length) {
      saveStatus.markError(problems.join(" "));
      return;
    }
    if (form.coastal && form.milesToCoast && Number(form.milesToCoast) < 0) {
      saveStatus.markError("Miles to coast can't be negative.");
      return;
    }
    await saveStatus.run(
      async () => {
        onChange(
          unwrap(
            await client.models.Account.update({
              id: account.id,
              address: str(form.address),
              city: str(form.city),
              county: str(form.county),
              state: str(form.state),
              zip: str(form.zip),
              incorporated:
                form.incorporated === "yes" ? true : form.incorporated === "no" ? false : null,
              unitCount: num(form.unitCount),
              firewallsVerified: form.firewallsVerified,
              coastal: form.coastal,
              milesToCoast: form.coastal ? num(form.milesToCoast) : null,
              otherUpdates: str(form.otherUpdates),
              fireDistrict: str(form.fireDistrict),
            })
          )
        );
      },
      { errorMessage: "Save failed" }
    );
  }

  return (
    <div className="card">
      <h2>Property</h2>
      <div className="form-grid">
        <div className="field full">
          <label>Street address</label>
          <AddressAutocomplete
            value={form.address}
            onChange={(v) => setF("address", v)}
            onPlace={(p) =>
              patch((f) => ({
                address: p.address || f.address,
                city: p.city || f.city,
                state: p.state || f.state,
                zip: p.zip || f.zip,
              }))
            }
          />
        </div>
        <div className="field">
          <label>County</label>
          <input
            placeholder="Middlesex"
            value={form.county}
            onChange={(e) => setF("county", e.target.value)}
          />
        </div>
        <div className="field">
          <label>City</label>
          <input value={form.city} onChange={(e) => setF("city", e.target.value)} />
        </div>
        <div className="field">
          <label>State</label>
          <select value={form.state} onChange={(e) => setF("state", e.target.value)}>
            <option value="">—</option>
            {US_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>ZIP</label>
          <input value={form.zip} onChange={(e) => setF("zip", e.target.value)} />
        </div>
        <div className="field">
          <label>Incorporated association</label>
          <select
            value={form.incorporated}
            onChange={(e) => setF("incorporated", e.target.value)}
          >
            <option value="">—</option>
            <option value="yes">Yes — incorporated</option>
            <option value="no">No — unincorporated</option>
          </select>
        </div>
        <div className="field">
          <label>Unit count</label>
          <IntegerInput
            value={form.unitCount}
            onChange={(v) => setF("unitCount", v)}
          />
        </div>
        <div className="field">
          <label>Fire district</label>
          <input
            placeholder="Middlesex FD #3"
            value={form.fireDistrict}
            onChange={(e) => setF("fireDistrict", e.target.value)}
          />
        </div>
        <div className="field">
          <label>Firewalls verified?</label>
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={form.firewallsVerified}
              onChange={(e) => setF("firewallsVerified", e.target.checked)}
            />
            Verified
          </label>
        </div>
        <div className="field">
          <label>Coastal?</label>
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={form.coastal}
              onChange={(e) => setF("coastal", e.target.checked)}
            />
            Coastal exposure
          </label>
        </div>
        <div className="field full">
          <label>Other updates</label>
          <textarea
            rows={2}
            placeholder="Elevators 2019, windows 2021…"
            value={form.otherUpdates}
            onChange={(e) => setF("otherUpdates", e.target.value)}
          />
        </div>
        {form.coastal && (
          <div className="field">
            <label>Miles to coast</label>
            {/* Left as a native number input: a distance under 100 miles gains
                nothing from thousands separators, and none of the six
                formatted inputs is a fractional non-money quantity. */}
            <input
              type="number"
              min={0}
              step="0.1"
              value={form.milesToCoast}
              onChange={(e) => setF("milesToCoast", e.target.value)}
            />
          </div>
        )}
      </div>

      {/* The "System updates (year completed)" section is gone: the roof,
          HVAC, electrical and plumbing years are properties of a building,
          not of a site, and live on each Building now. `otherUpdates` stays
          here — it is a site-level note — and has moved into the grid above. */}
      <div className="form-actions">
        <button className="primary" disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save property"}
        </button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </div>
  );
}
