import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import { Button } from "../ui/Button";
import { client,
  unwrap,
  validateAccountFields,
  type Account } from "../../lib/client";
import { US_STATES } from "../../../../shared/usStates";
import { AddressAutocomplete } from "../../lib/googlePlaces";
import { useFormState } from "../../lib/useFormState";
import { SaveStatus, useSaveStatus } from "../SaveStatus";
import { inputValue, num, str } from "../../lib/formCodec";
import { IntegerInput, PercentInput } from "../inputs";
import { PROPERTY_TYPES, PROPERTY_TYPE_LABELS, normalizePropertyType } from "../../../../shared/propertyType";
import "./DetailsCard.css";

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
  const { form, setF, patch, markSaved } = useFormState({
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
    propertyType: normalizePropertyType(account.propertyType) ?? "",
    rentalPct: inputValue(account.rentalPct),
    firewallsVerified: account.firewallsVerified ?? false,
    coastal: account.coastal ?? false,
    milesToCoast: inputValue(account.milesToCoast),
    otherUpdates: inputValue(account.otherUpdates),
    fireDistrict: inputValue(account.fireDistrict),
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    const submitted = form;
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
    if (form.rentalPct && (Number(form.rentalPct) < 0 || Number(form.rentalPct) > 100)) {
      saveStatus.markError("Rented units must be between 0 and 100 percent.");
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
              propertyType: normalizePropertyType(form.propertyType),
              rentalPct: num(form.rentalPct),
              firewallsVerified: form.firewallsVerified,
              coastal: form.coastal,
              milesToCoast: form.coastal ? num(form.milesToCoast) : null,
              otherUpdates: str(form.otherUpdates),
              fireDistrict: str(form.fireDistrict),
            })
          )
        );
        markSaved(submitted);
      },
      { errorMessage: "Save failed" }
    );
  }

  return (
    <section className="card property-details" aria-label="Property">
      <div className="property-details-heading">
        <h2>Property</h2>
      </div>
      <div className="property-details-section">
        <h3>Location</h3>
        <div className="property-details-grid">
          <Field label="Street address" className="property-details-wide">
            {control => <AddressAutocomplete {...control}
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
            />}
          </Field>
          <Field label="City">
            {control => <Input {...control} value={form.city} onChange={(e) => setF("city", e.target.value)} />}
          </Field>
          <Field label="County">
            {control => <Input {...control} placeholder="Middlesex" value={form.county} onChange={(e) => setF("county", e.target.value)} />}
          </Field>
          <Field label="State">
            {control => <Select {...control} value={form.state} onChange={(e) => setF("state", e.target.value)}>
              <option value="">—</option>
              {US_STATES.map((s) => <option key={s}>{s}</option>)}
            </Select>}
          </Field>
          <Field label="ZIP">
            {control => <Input {...control} value={form.zip} onChange={(e) => setF("zip", e.target.value)} />}
          </Field>
          <Field label="Fire district" className="property-details-wide">
            {control => <Input {...control} placeholder="Middlesex FD #3" value={form.fireDistrict} onChange={(e) => setF("fireDistrict", e.target.value)} />}
          </Field>
        </div>
      </div>

      <div className="property-details-section">
        <h3>Property facts</h3>
        <div className="property-details-grid">
          <Field label="Property type" id="account-property-type">
            {control => <Select {...control} value={form.propertyType} onChange={e => setF("propertyType", e.target.value)}>
              <option value="">Use existing information</option>
              {PROPERTY_TYPES.map(value => <option key={value} value={value}>{PROPERTY_TYPE_LABELS[value]}</option>)}
            </Select>}
          </Field>
          <Field label="Incorporated association">
            {control => <Select {...control} value={form.incorporated} onChange={(e) => setF("incorporated", e.target.value)}>
              <option value="">—</option>
              <option value="yes">Yes — incorporated</option>
              <option value="no">No — unincorporated</option>
            </Select>}
          </Field>
          <Field label="Unit count">
            {control => <IntegerInput {...control} value={form.unitCount} onChange={(v) => setF("unitCount", v)} />}
          </Field>
          <Field label="Rented units (%)">
            {/* Blank remains unknown; appetite guides must not treat it as zero. */}
            {control => <PercentInput {...control} value={form.rentalPct} onChange={(v) => setF("rentalPct", v)} />}
          </Field>
        </div>
        <div className="property-details-exposures">
          <div className="property-details-toggle-card">
            <label className="property-details-toggle">
              <Input type="checkbox" checked={form.firewallsVerified} onChange={(e) => setF("firewallsVerified", e.target.checked)} />
              <span>Firewalls verified</span>
            </label>
          </div>
          <div className="property-details-toggle-card property-details-coastal">
            <label className="property-details-toggle">
              <Input type="checkbox" checked={form.coastal} onChange={(e) => setF("coastal", e.target.checked)} />
              <span>Coastal exposure</span>
            </label>
            {form.coastal && (
              <Field label="Miles to coast" className="property-details-distance">
                {control => <Input {...control} type="number" min={0} step="0.1" value={form.milesToCoast} onChange={(e) => setF("milesToCoast", e.target.value)} />}
              </Field>
            )}
          </div>
        </div>
        <Field label="Other updates" className="property-details-notes">
          {control => <Textarea {...control} rows={2} placeholder="Elevators 2019, windows 2021…" value={form.otherUpdates} onChange={(e) => setF("otherUpdates", e.target.value)} />}
        </Field>
      </div>

      <div className="form-actions property-details-actions">
        <Button variant="primary"  disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save property"}
        </Button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </section>
  );
}
