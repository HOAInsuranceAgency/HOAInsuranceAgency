import {
  client,
  unwrap,
  validateAccountFields,
  type Account,
} from "../../lib/client";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { useFormState } from "../../lib/useFormState";
import { inputValue, num, str } from "../../lib/formCodec";
import { DateInput, MoneyInput } from "../../components/inputs";

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
  const saveStatus = useSaveStatus();
  const { form, setF } = useFormState({
    name: account.name,
    legalName: inputValue(account.legalName),
    fein: inputValue(account.fein),
    sicCode: inputValue(account.sicCode),
    naicsCode: inputValue(account.naicsCode),
    priorCarrierName: inputValue(account.priorCarrierName),
    priorPolicyNumber: inputValue(account.priorPolicyNumber),
    priorPremium: inputValue(account.priorPremium),
    priorTermEffective: inputValue(account.priorTermEffective),
    priorTermExpiration: inputValue(account.priorTermExpiration),
    totalInsuredValue: inputValue(account.totalInsuredValue),
    currentAgent: inputValue(account.currentAgent),
    currentPolicyExpiration: inputValue(account.currentPolicyExpiration),
    source: inputValue(account.source),
    notes: inputValue(account.notes),
  }, { onEdit: saveStatus.markDirty });

  async function save() {
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
              name: str(form.name) ?? account.name,
              legalName: str(form.legalName),
              fein: str(form.fein),
              sicCode: str(form.sicCode),
              naicsCode: str(form.naicsCode),
              priorCarrierName: str(form.priorCarrierName),
              priorPolicyNumber: str(form.priorPolicyNumber),
              priorPremium: num(form.priorPremium),
              priorTermEffective: str(form.priorTermEffective),
              priorTermExpiration: str(form.priorTermExpiration),
              totalInsuredValue: num(form.totalInsuredValue),
              currentAgent: str(form.currentAgent),
              currentPolicyExpiration: str(form.currentPolicyExpiration),
              source: str(form.source),
              notes: str(form.notes),
            })
          )
        );
      },
      { errorMessage: "Save failed" }
    );
  }

  return (
    <div className="card">
      <h2>Details</h2>
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setF("name", e.target.value)} />
        </div>
        <div className="field">
          <label>Full legal name (carrier submissions)</label>
          <input
            placeholder={account.name}
            value={form.legalName}
            onChange={(e) => setF("legalName", e.target.value)}
          />
        </div>
        <div className="field">
          <label>FEIN</label>
          <input value={form.fein} onChange={(e) => setF("fein", e.target.value)} />
        </div>
        <div className="field">
          <label>SIC</label>
          <input value={form.sicCode} onChange={(e) => setF("sicCode", e.target.value)} />
        </div>
        <div className="field">
          <label>NAICS</label>
          <input value={form.naicsCode} onChange={(e) => setF("naicsCode", e.target.value)} />
        </div>
        {/* The four contact fields and the inspection pair moved to the
            Contacts card below — an association has more than two people, and
            these six columns could hold exactly two. */}
        <div className="field">
          <label>Total insured value ($)</label>
          <MoneyInput
            value={form.totalInsuredValue}
            onChange={(v) => setF("totalInsuredValue", v)}
          />
        </div>
        <div className="field">
          <label>Current agent / broker</label>
          <input value={form.currentAgent} onChange={(e) => setF("currentAgent", e.target.value)} />
        </div>
        <div className="field">
          <label>Prior carrier</label>
          <input value={form.priorCarrierName} onChange={(e) => setF("priorCarrierName", e.target.value)} />
        </div>
        <div className="field">
          <label>Prior policy number</label>
          <input value={form.priorPolicyNumber} onChange={(e) => setF("priorPolicyNumber", e.target.value)} />
        </div>
        <div className="field">
          <label>Prior premium ($)</label>
          <MoneyInput
            value={form.priorPremium}
            onChange={(v) => setF("priorPremium", v)}
          />
        </div>
        <div className="field">
          <label>Prior term effective</label>
          <DateInput
            value={form.priorTermEffective}
            onChange={(v) => setF("priorTermEffective", v)}
          />
        </div>
        <div className="field">
          <label>Prior term expiration</label>
          <DateInput
            value={form.priorTermExpiration}
            onChange={(v) => setF("priorTermExpiration", v)}
          />
        </div>
        {/* Lead-only: once bound, the Policy records are authoritative. */}
        {account.stage !== "CLIENT" && (
        <div className="field">
          <label>Current policy expiration</label>
          <DateInput
            value={form.currentPolicyExpiration}
            onChange={(v) => setF("currentPolicyExpiration", v)}
          />
        </div>
        )}
        <div className="field">
          <label>Source</label>
          <input value={form.source} onChange={(e) => setF("source", e.target.value)} />
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={4} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
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
