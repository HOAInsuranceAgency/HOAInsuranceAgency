import {
  client,
  US_STATES,
  unwrap,
  validateAccountFields,
  validateYear,
  type Account,
} from "../../lib/client";
import { AddressAutocomplete } from "../../lib/googlePlaces";
import { useFormState } from "../../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../SaveStatus";
import { CONSTRUCTION_OPTIONS } from "../../lib/enums";
import { inputValue, num, str } from "../../lib/formCodec";
import { IntegerInput, YearInput } from "../inputs";

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
    unitCount: inputValue(account.unitCount),
    yearBuilt: inputValue(account.yearBuilt),
    constructionType: inputValue(account.constructionType),
    firewallsVerified: account.firewallsVerified ?? false,
    stories: inputValue(account.stories),
    coastal: account.coastal ?? false,
    milesToCoast: inputValue(account.milesToCoast),
    roofUpdatedYear: inputValue(account.roofUpdatedYear),
    hvacUpdatedYear: inputValue(account.hvacUpdatedYear),
    electricalUpdatedYear: inputValue(account.electricalUpdatedYear),
    plumbingUpdatedYear: inputValue(account.plumbingUpdatedYear),
    otherUpdates: inputValue(account.otherUpdates),
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    // The composition `client.ts:200-211` describes, replacing a file-local
    // `yearOk` that hard-coded the +1 bound and reported all four bad years as
    // one "Check the Roof, HVAC years." with no bounds in it.
    const problems = [
      ...validateAccountFields(form),
      ...validateYear(form.roofUpdatedYear, "Roof updated year", { maxYearsAhead: 1 }),
      ...validateYear(form.hvacUpdatedYear, "HVAC updated year", { maxYearsAhead: 1 }),
      ...validateYear(form.electricalUpdatedYear, "Electrical updated year", {
        maxYearsAhead: 1,
      }),
      ...validateYear(form.plumbingUpdatedYear, "Plumbing updated year", {
        maxYearsAhead: 1,
      }),
    ];
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
              unitCount: num(form.unitCount),
              yearBuilt: num(form.yearBuilt),
              constructionType: str(
                form.constructionType
              ) as Account["constructionType"],
              firewallsVerified: form.firewallsVerified,
              stories: num(form.stories),
              coastal: form.coastal,
              milesToCoast: form.coastal ? num(form.milesToCoast) : null,
              roofUpdatedYear: num(form.roofUpdatedYear),
              hvacUpdatedYear: num(form.hvacUpdatedYear),
              electricalUpdatedYear: num(form.electricalUpdatedYear),
              plumbingUpdatedYear: num(form.plumbingUpdatedYear),
              otherUpdates: str(form.otherUpdates),
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
          <label>Unit count</label>
          <IntegerInput
            value={form.unitCount}
            onChange={(v) => setF("unitCount", v)}
          />
        </div>
        <div className="field">
          <label>Year built</label>
          <YearInput
            value={form.yearBuilt}
            onChange={(v) => setF("yearBuilt", v)}
          />
        </div>
        <div className="field">
          <label>Construction type</label>
          <select
            value={form.constructionType}
            onChange={(e) => setF("constructionType", e.target.value)}
          >
            <option value="">—</option>
            {CONSTRUCTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Stories</label>
          <IntegerInput value={form.stories} onChange={(v) => setF("stories", v)} />
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

      <h3>System updates (year completed)</h3>
      <div className="form-grid">
        <div className="field">
          <label>Roof</label>
          <YearInput
            value={form.roofUpdatedYear}
            onChange={(v) => setF("roofUpdatedYear", v)}
          />
        </div>
        <div className="field">
          <label>HVAC</label>
          <YearInput
            value={form.hvacUpdatedYear}
            onChange={(v) => setF("hvacUpdatedYear", v)}
          />
        </div>
        <div className="field">
          <label>Electrical</label>
          <YearInput
            value={form.electricalUpdatedYear}
            onChange={(v) => setF("electricalUpdatedYear", v)}
          />
        </div>
        <div className="field">
          <label>Plumbing</label>
          <YearInput
            value={form.plumbingUpdatedYear}
            onChange={(v) => setF("plumbingUpdatedYear", v)}
          />
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
      </div>

      <div className="form-actions">
        <button className="primary" disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save property"}
        </button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </div>
  );
}
