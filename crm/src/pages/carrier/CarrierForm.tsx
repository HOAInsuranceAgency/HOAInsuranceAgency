import { MoneyInput, PhoneInput, PercentInput } from "../../components/inputs";
import { Field } from "../../components/ui/kit";
import { client, US_STATES, type Carrier } from "../../lib/client";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { useFormState } from "../../lib/useFormState";
import { MARKET_TYPE_OPTIONS, type MarketType } from "../../lib/enums";

export function CarrierForm({
  carrier,
  onChange,
}: {
  carrier: Carrier;
  onChange: (c: Carrier) => void;
}) {
  // `useSaveStatus` owns the confirmation; `useFormState`'s `saved` is left
  // unread so there is exactly one answer to "did that save land".
  const saveStatus = useSaveStatus();
  const { form, setF, markSaved } = useFormState({
    name: carrier.name,
    appointed: carrier.appointed,
    marketType: carrier.marketType ?? "",
    dateAppointed: carrier.dateAppointed ?? "",
    primaryContactName: carrier.primaryContactName ?? "",
    primaryContactEmail: carrier.primaryContactEmail ?? "",
    primaryContactPhone: carrier.primaryContactPhone ?? "",
    primaryUnderwriterName: carrier.primaryUnderwriterName ?? "",
    primaryUnderwriterEmail: carrier.primaryUnderwriterEmail ?? "",
    primaryUnderwriterPhone: carrier.primaryUnderwriterPhone ?? "",
    states: (carrier.states ?? []).filter((s): s is string => !!s),
    naicCode: carrier.naicCode ?? "",
    standardCommissionPct: carrier.standardCommissionPct?.toString() ?? "",
    annualMinimumPremium: carrier.annualMinimumPremium?.toString() ?? "",
    profitSharingPremiumThreshold:
      carrier.profitSharingPremiumThreshold?.toString() ?? "",
    profitSharingLossRatioThreshold:
      carrier.profitSharingLossRatioThreshold?.toString() ?? "",
    commercialLines: carrier.commercialLines ?? false,
    personalLines: carrier.personalLines ?? false,
    notes: carrier.notes ?? "",
  }, { onEdit: saveStatus.markDirty });

  function toggleState(s: string) {
    setF("states", (ss) =>
      ss.includes(s) ? ss.filter((x) => x !== s) : [...ss, s].sort()
    );
  }

  async function save() {
    await saveStatus.run(
      async () => {
        const { data, errors } = await client.models.Carrier.update({
          id: carrier.id,
          name: form.name.trim() || carrier.name,
          appointed: form.appointed,
          // "" is the unstated market type, and null is how the schema
          // spells it — an empty string would fail enum validation.
          marketType: (form.marketType as MarketType) || null,
          dateAppointed: form.dateAppointed || null,
          primaryContactName: form.primaryContactName.trim() || null,
          primaryContactEmail: form.primaryContactEmail.trim() || null,
          primaryContactPhone: form.primaryContactPhone.trim() || null,
          primaryUnderwriterName: form.primaryUnderwriterName.trim() || null,
          primaryUnderwriterEmail: form.primaryUnderwriterEmail.trim() || null,
          primaryUnderwriterPhone: form.primaryUnderwriterPhone.trim() || null,
          states: form.states,
          naicCode: form.naicCode.trim() || null,
          standardCommissionPct: form.standardCommissionPct
            ? Number(form.standardCommissionPct)
            : null,
          annualMinimumPremium: form.annualMinimumPremium
            ? Number(form.annualMinimumPremium)
            : null,
          profitSharingPremiumThreshold: form.profitSharingPremiumThreshold
            ? Number(form.profitSharingPremiumThreshold)
            : null,
          profitSharingLossRatioThreshold: form.profitSharingLossRatioThreshold
            ? Number(form.profitSharingLossRatioThreshold)
            : null,
          commercialLines: form.commercialLines,
          personalLines: form.personalLines,
          notes: form.notes.trim() || null,
        });
        if (errors?.length || !data) throw new Error(errors?.[0]?.message);
        markSaved();
        onChange(data);
      },
      { errorMessage: "Save failed" }
    );
  }

  return (
    <div className="card">
      <h2>Appointment details</h2>
      <div className="form-grid">
        <Field className="field">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setF("name", e.target.value)} />
        </Field>
        <Field className="field">
          <label>Status</label>
          <select
            value={form.appointed ? "1" : "0"}
            onChange={(e) => setF("appointed", e.target.value === "1")}
          >
            <option value="1">Appointed</option>
            <option value="0">Prospective</option>
          </select>
        </Field>
        <Field className="field">
          <label>Market type</label>
          <select
            value={form.marketType}
            onChange={(e) => setF("marketType", e.target.value)}
          >
            <option value="">—</option>
            {MARKET_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field className="field">
          <label>Date appointed</label>
          <input type="date" value={form.dateAppointed} onChange={(e) => setF("dateAppointed", e.target.value)} />
        </Field>
        <Field className="field">
          <label>NAIC code</label>
          <input value={form.naicCode} onChange={(e) => setF("naicCode", e.target.value)} />
        </Field>
        <Field className="field">
          <label>Standard commission % (autofills new quotes)</label>
          <PercentInput value={form.standardCommissionPct} onChange={v => setF("standardCommissionPct", v)} />
        </Field>
        <Field className="field">
          <label>Annual minimum premium to maintain appointment ($)</label>
          <MoneyInput value={form.annualMinimumPremium} onChange={v => setF("annualMinimumPremium", v)} />
        </Field>
        <Field className="field">
          <label>Profit sharing threshold — premium written ($)</label>
          <MoneyInput value={form.profitSharingPremiumThreshold} onChange={v => setF("profitSharingPremiumThreshold", v)} />
        </Field>
        <Field className="field">
          <label>Profit sharing loss ratio threshold (%)</label>
          <PercentInput value={form.profitSharingLossRatioThreshold} onChange={v => setF("profitSharingLossRatioThreshold", v)} />
        </Field>
        <Field className="field">
          <label>Lines written</label>
          <div style={{ display: "flex", gap: 16, alignItems: "center", height: 38 }}>
            <label
              className="small"
              style={{ display: "flex", gap: 5, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.commercialLines}
                onChange={(e) => setF("commercialLines", e.target.checked)}
              />
              Commercial lines
            </label>
            <label
              className="small"
              style={{ display: "flex", gap: 5, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={form.personalLines}
                onChange={(e) => setF("personalLines", e.target.checked)}
              />
              Personal lines
            </label>
          </div>
        </Field>
        <Field className="field">
          <label>Primary contact</label>
          <input value={form.primaryContactName} onChange={(e) => setF("primaryContactName", e.target.value)} />
        </Field>
        <Field className="field">
          <label>Contact email</label>
          <input value={form.primaryContactEmail} onChange={(e) => setF("primaryContactEmail", e.target.value)} />
        </Field>
        <Field className="field">
          <label>Contact phone</label>
          <PhoneInput value={form.primaryContactPhone} onChange={v => setF("primaryContactPhone", v)} />
        </Field>
        <Field className="field">
          <label>Primary underwriter</label>
          <input
            value={form.primaryUnderwriterName}
            onChange={(e) => setF("primaryUnderwriterName", e.target.value)}
          />
        </Field>
        <Field className="field">
          <label>Underwriter email</label>
          <input
            value={form.primaryUnderwriterEmail}
            onChange={(e) => setF("primaryUnderwriterEmail", e.target.value)}
          />
        </Field>
        <Field className="field">
          <label>Underwriter phone</label>
          <PhoneInput value={form.primaryUnderwriterPhone} onChange={v => setF("primaryUnderwriterPhone", v)} />
        </Field>
        <Field className="field full">
          <label>States covered ({form.states.length})</label>
          <div className="toolbar" style={{ marginTop: 0, marginBottom: 6 }}>
            <button
              className="secondary"
              disabled={form.states.length === US_STATES.length}
              onClick={() => setF("states", [...US_STATES])}
            >
              All states
            </button>
            <button
              className="secondary"
              disabled={form.states.length === 0}
              onClick={() => setF("states", [])}
            >
              Clear
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
            {US_STATES.map((s) => (
              <label
                key={s}
                className="small"
                style={{ display: "flex", gap: 3, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={form.states.includes(s)}
                  onChange={() => toggleState(s)}
                />
                {s}
              </label>
            ))}
          </div>
        </Field>
        <Field className="field full">
          <label>Notes</label>
          <textarea rows={3} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save changes"}
        </button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </div>
  );
}
