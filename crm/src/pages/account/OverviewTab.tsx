import { useId } from "react";
import { acquisitionLabel, websiteFormLabel } from "../../../../shared/leadSource";
import {
  client,
  unwrap,
  validateAccountFields,
  type Account,
} from "../../lib/client";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { useFormState } from "../../lib/useFormState";
import { inputValue, num, str } from "../../lib/formCodec";
import { DateInput, FeinInput, MoneyInput } from "../../components/inputs";
import { LEGAL_ENTITY_OPTIONS } from "../../lib/enums";
import "./OverviewTab.css";

export function OverviewTab({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  // `useSaveStatus` owns the confirmation here — it carries saving and error
  // as well, which the two local flags used to split between them.
  // `useFormState`'s own `saved` is deliberately not destructured: two flags
  // answering "is the confirmation still true" is the bug this replaces.
  const fieldId = useId();
  const saveStatus = useSaveStatus();
  const { form, setF } = useFormState({
    name: account.legalName?.trim() || account.name,
    fein: inputValue(account.fein),
    sicCode: inputValue(account.sicCode),
    naicsCode: inputValue(account.naicsCode),
    legalEntityType: inputValue(account.legalEntityType),
    annualRevenue: inputValue(account.annualRevenue),
    totalInsuredValue: inputValue(account.totalInsuredValue),
    currentAgent: inputValue(account.currentAgent),
    currentPolicyExpiration: inputValue(account.currentPolicyExpiration),
    notes: inputValue(account.notes),
  }, { onEdit: saveStatus.markDirty });

  async function save() {
    const name = str(form.name);
    if (!name) {
      saveStatus.markError("Enter a name.");
      return;
    }
    const problems = validateAccountFields(form);
    if (problems.length) {
      saveStatus.markError(problems.join(" "));
      return;
    }
    await saveStatus.run(
      async () => {
        onChange(
          unwrap(
            await client.models.Account.update({
              id: account.id,
              name,
              legalName: name,
              fein: str(form.fein),
              sicCode: str(form.sicCode),
              naicsCode: str(form.naicsCode),
              legalEntityType: str(
                form.legalEntityType
              ) as Account["legalEntityType"],
              annualRevenue: num(form.annualRevenue),
              totalInsuredValue: num(form.totalInsuredValue),
              currentAgent: str(form.currentAgent),
              currentPolicyExpiration: str(form.currentPolicyExpiration),
              notes: str(form.notes),
            })
          )
        );
      },
      { errorMessage: "Save failed" }
    );
  }

  const websiteForm = websiteFormLabel(account.source);
  const leadSource = [acquisitionLabel(account.leadSource, account.source),
    ...(websiteForm === "Not recorded" ? [] : [websiteForm])].join(" · ");

  return (
    <section className="card overview-details" aria-label="Account details">
      <div className="overview-details-heading">
        <h2>Account details</h2>
        <dl className="overview-source">
          <dt>Lead source</dt>
          <dd>{leadSource}</dd>
        </dl>
      </div>
      <div className="overview-details-grid">
        <div className="field overview-field-wide">
          <label htmlFor={`${fieldId}-name`}>Name</label>
          <input id={`${fieldId}-name`} value={form.name} onChange={(e) => setF("name", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${fieldId}-entity`}>Legal entity type</label>
          <select id={`${fieldId}-entity`} value={form.legalEntityType} onChange={(e) => setF("legalEntityType", e.target.value)}>
            {/* Blank associations use Not For Profit on the ACORD 125. */}
            <option value="">{account.type === "ASSOCIATION" ? "— (Not For Profit)" : "—"}</option>
            {LEGAL_ENTITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${fieldId}-fein`}>FEIN</label>
          <FeinInput id={`${fieldId}-fein`} value={form.fein} onChange={(v) => setF("fein", v)} />
        </div>
        <div className="field">
          <label htmlFor={`${fieldId}-sic`}>SIC</label>
          <input id={`${fieldId}-sic`} value={form.sicCode} onChange={(e) => setF("sicCode", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${fieldId}-naics`}>NAICS</label>
          <input id={`${fieldId}-naics`} value={form.naicsCode} onChange={(e) => setF("naicsCode", e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${fieldId}-revenue`}>Annual revenue ($)</label>
          <MoneyInput id={`${fieldId}-revenue`} value={form.annualRevenue} onChange={(v) => setF("annualRevenue", v)} />
        </div>
        <div className="field">
          <label htmlFor={`${fieldId}-tiv`}>Total insured value ($)</label>
          <MoneyInput id={`${fieldId}-tiv`} value={form.totalInsuredValue} onChange={(v) => setF("totalInsuredValue", v)} />
        </div>
        <div className="field overview-field-wide">
          <label htmlFor={`${fieldId}-agent`}>Current agent / broker</label>
          <input id={`${fieldId}-agent`} value={form.currentAgent} onChange={(e) => setF("currentAgent", e.target.value)} />
        </div>
        {/* Lead-only: once bound, the Policy records are authoritative. */}
        {account.stage !== "CLIENT" && (
          <div className="field overview-field-wide">
            <label htmlFor={`${fieldId}-expiration`}>Current policy expiration</label>
            <DateInput id={`${fieldId}-expiration`} value={form.currentPolicyExpiration} onChange={(v) => setF("currentPolicyExpiration", v)} />
          </div>
        )}
        <div className="field overview-field-full">
          <label htmlFor={`${fieldId}-notes`}>Notes</label>
          <textarea id={`${fieldId}-notes`} rows={3} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
      </div>
      <div className="form-actions overview-details-actions">
        <button className="primary" disabled={saveStatus.busy} onClick={save}>
          {saveStatus.busy ? "Saving…" : "Save changes"}
        </button>
        <SaveStatus {...saveStatus.status} />
      </div>
    </section>
  );
}
