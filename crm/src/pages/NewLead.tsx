import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client, friendlyError, US_STATES, validateAccountFields } from "../lib/client";
import { AddressAutocomplete } from "../lib/googlePlaces";

export default function NewLead() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    type: "ASSOCIATION",
    name: "",
    contactFirstName: "",
    contactLastName: "",
    contactEmail: "",
    contactPhone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    unitCount: "",
    yearBuilt: "",
    totalInsuredValue: "",
    currentAgent: "",
    currentPolicyExpiration: "",
    source: "",
    notes: "",
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    const problems = validateAccountFields(form);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setSaving(true);
    setError("");
    const { data, errors } = await client.models.Account.create({
      stage: "LEAD",
      type: form.type as "ASSOCIATION" | "PERSONAL" | "COMMERCIAL_OTHER",
      name: form.name.trim(),
      contactFirstName: form.contactFirstName.trim() || undefined,
      contactLastName: form.contactLastName.trim() || undefined,
      contactEmail: form.contactEmail.trim() || undefined,
      contactPhone: form.contactPhone.trim() || undefined,
      address: form.address.trim() || undefined,
      city: form.city.trim() || undefined,
      state: form.state || undefined,
      zip: form.zip.trim() || undefined,
      unitCount: form.unitCount ? Number(form.unitCount) : undefined,
      yearBuilt: form.yearBuilt ? Number(form.yearBuilt) : undefined,
      totalInsuredValue: form.totalInsuredValue
        ? Number(form.totalInsuredValue)
        : undefined,
      currentAgent: form.currentAgent.trim() || undefined,
      currentPolicyExpiration: form.currentPolicyExpiration || undefined,
      source: form.source.trim() || undefined,
      notes: form.notes.trim() || undefined,
    });
    setSaving(false);
    if (errors?.length || !data) {
      setError(friendlyError(new Error(errors?.[0]?.message), "Failed to create lead."));
      return;
    }
    // Land on Documents so uploads (and AI extraction) are the next step.
    navigate(`/accounts/${data.id}?tab=documents`);
  }

  const isPersonal = form.type === "PERSONAL";

  return (
    <>
      <h1>New lead</h1>
      <p className="sub">Association or individual prospect</p>

      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={set("type")}>
              <option value="ASSOCIATION">Association / HOA</option>
              <option value="COMMERCIAL_OTHER">Commercial — other</option>
              <option value="PERSONAL">Personal (HO-6)</option>
            </select>
          </div>
          <div className="field">
            <label>Name (association / insured) *</label>
            <input value={form.name} onChange={set("name")} />
          </div>
          <div className="field">
            <label>Source</label>
            <input
              placeholder="website, referral, cold…"
              value={form.source}
              onChange={set("source")}
            />
          </div>
          <div className="field">
            <label>Contact first name</label>
            <input value={form.contactFirstName} onChange={set("contactFirstName")} />
          </div>
          <div className="field">
            <label>Contact last name</label>
            <input value={form.contactLastName} onChange={set("contactLastName")} />
          </div>
          <div className="field">
            <label>Contact email</label>
            <input type="email" value={form.contactEmail} onChange={set("contactEmail")} />
          </div>
          <div className="field">
            <label>Contact phone</label>
            <input value={form.contactPhone} onChange={set("contactPhone")} />
          </div>
          <div className="field">
            <label>Street address</label>
            <AddressAutocomplete
              value={form.address}
              onChange={(v) => setForm((f) => ({ ...f, address: v }))}
              onPlace={(p) =>
                setForm((f) => ({
                  ...f,
                  address: p.address || f.address,
                  city: p.city || f.city,
                  state: p.state || f.state,
                  zip: p.zip || f.zip,
                }))
              }
            />
          </div>
          <div className="field">
            <label>City</label>
            <input value={form.city} onChange={set("city")} />
          </div>
          <div className="field">
            <label>State</label>
            <select value={form.state} onChange={set("state")}>
              <option value="">—</option>
              {US_STATES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>ZIP</label>
            <input value={form.zip} onChange={set("zip")} />
          </div>
          {!isPersonal && (
            <div className="field">
              <label>Unit count</label>
              <input type="number" min={0} value={form.unitCount} onChange={set("unitCount")} />
            </div>
          )}
          <div className="field">
            <label>Year built</label>
            <input type="number" value={form.yearBuilt} onChange={set("yearBuilt")} />
          </div>
          <div className="field">
            <label>Total insured value ($)</label>
            <input
              type="number"
              value={form.totalInsuredValue}
              onChange={set("totalInsuredValue")}
            />
          </div>
          <div className="field">
            <label>Current agent / broker</label>
            <input
              placeholder="Incumbent agency"
              value={form.currentAgent}
              onChange={set("currentAgent")}
            />
          </div>
          <div className="field">
            <label>Current policy expiration</label>
            <input
              type="date"
              value={form.currentPolicyExpiration}
              onChange={set("currentPolicyExpiration")}
            />
          </div>
          <div className="field full">
            <label>Notes</label>
            <textarea rows={3} value={form.notes} onChange={set("notes")} />
          </div>
        </div>
        <div className="form-actions">
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? "Creating…" : "Create lead"}
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      </div>
    </>
  );
}
