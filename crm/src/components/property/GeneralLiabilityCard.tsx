import {
  client,
  fmtNum,
  type GlApplication,
  type GlClassCode,
} from "../../lib/client";
import { bool, boolValue, inputValue, num, str } from "../../lib/formCodec";
import { useChildRows } from "../../lib/useChildRows";
import { useSingletonChild } from "../../lib/useSingletonChild";
import type { FormState } from "../../lib/useFormState";
import {
  AGGREGATE_APPLIES_TO_OPTIONS,
  GL_DEDUCTIBLE_TYPE_OPTIONS,
  GL_PREMIUM_BASIS_LABELS,
  GL_PREMIUM_BASIS_OPTIONS,
} from "../../lib/enums";
import ChildRowsCard from "../ChildRowsCard";
import { SaveStatus } from "../SaveStatus";
import { IntegerInput, MoneyInput, PercentInput, YesNoRadio } from "../inputs";

/**
 * The general liability application — ACORD 126 input.
 *
 * **Not** what a carrier quoted. `Quote` and `Policy` already carry `gl*`
 * columns for that, and the two are easy to confuse precisely because they
 * hold the same-sounding numbers: `eachOccurrence` here is what the
 * association is applying for, and `Quote.glEachOccurrence` is what somebody
 * offered. Conflating them would put a quoted limit on an application.
 *
 * Two shapes in one section, because the form has two: a single set of
 * answers (`useSingletonChild`, created on the first save) and a list of
 * class codes (`useChildRows`).
 */

interface GlForm {
  eachOccurrence: string;
  generalAggregate: string;
  limitAppliesPer: string;
  productsCompletedOpsAggregate: string;
  personalAdvInjury: string;
  damageToRentedPremises: string;
  medicalExpense: string;
  deductibleType: string;
  propertyDamageDeductible: string;
  bodilyInjuryDeductible: string;
  usesSubcontractors: string;
  subsCarryLowerLimits: string;
  subsAllowedWithoutCoi: string;
  subcontractedWorkDescription: string;
  paidToSubcontractors: string;
  workSubcontractedPct: string;
  fullTimeEmployees: string;
  partTimeEmployees: string;
}

const BLANK_GL: GlForm = {
  eachOccurrence: "",
  generalAggregate: "",
  limitAppliesPer: "",
  productsCompletedOpsAggregate: "",
  personalAdvInjury: "",
  damageToRentedPremises: "",
  medicalExpense: "",
  deductibleType: "",
  propertyDamageDeductible: "",
  bodilyInjuryDeductible: "",
  usesSubcontractors: "",
  subsCarryLowerLimits: "",
  subsAllowedWithoutCoi: "",
  subcontractedWorkDescription: "",
  paidToSubcontractors: "",
  workSubcontractedPct: "",
  fullTimeEmployees: "",
  partTimeEmployees: "",
};

export default function GeneralLiabilityCard({ accountId }: { accountId: string }) {
  return (
    <>
      <GlApplicationCard accountId={accountId} />
      <GlClassCodesCard accountId={accountId} />
    </>
  );
}

function GlApplicationCard({ accountId }: { accountId: string }) {
  const gl = useSingletonChild<GlApplication, GlForm>(client.models.GlApplication, {
    accountId,
    noun: "general liability application",
    initialForm: BLANK_GL,
    toForm: (r) => ({
      eachOccurrence: inputValue(r.eachOccurrence),
      generalAggregate: inputValue(r.generalAggregate),
      limitAppliesPer: inputValue(r.limitAppliesPer),
      productsCompletedOpsAggregate: inputValue(r.productsCompletedOpsAggregate),
      personalAdvInjury: inputValue(r.personalAdvInjury),
      damageToRentedPremises: inputValue(r.damageToRentedPremises),
      medicalExpense: inputValue(r.medicalExpense),
      deductibleType: inputValue(r.deductibleType),
      propertyDamageDeductible: inputValue(r.propertyDamageDeductible),
      bodilyInjuryDeductible: inputValue(r.bodilyInjuryDeductible),
      usesSubcontractors: boolValue(r.usesSubcontractors),
      subsCarryLowerLimits: boolValue(r.subsCarryLowerLimits),
      subsAllowedWithoutCoi: boolValue(r.subsAllowedWithoutCoi),
      subcontractedWorkDescription: inputValue(r.subcontractedWorkDescription),
      paidToSubcontractors: inputValue(r.paidToSubcontractors),
      workSubcontractedPct: inputValue(r.workSubcontractedPct),
      fullTimeEmployees: inputValue(r.fullTimeEmployees),
      partTimeEmployees: inputValue(r.partTimeEmployees),
    }),
    toWrite: (f) => ({
      eachOccurrence: num(f.eachOccurrence),
      generalAggregate: num(f.generalAggregate),
      limitAppliesPer: str(f.limitAppliesPer) as GlApplication["limitAppliesPer"],
      productsCompletedOpsAggregate: num(f.productsCompletedOpsAggregate),
      personalAdvInjury: num(f.personalAdvInjury),
      damageToRentedPremises: num(f.damageToRentedPremises),
      medicalExpense: num(f.medicalExpense),
      deductibleType: str(f.deductibleType) as GlApplication["deductibleType"],
      propertyDamageDeductible: num(f.propertyDamageDeductible),
      bodilyInjuryDeductible: num(f.bodilyInjuryDeductible),
      usesSubcontractors: bool(f.usesSubcontractors),
      subsCarryLowerLimits: bool(f.subsCarryLowerLimits),
      subsAllowedWithoutCoi: bool(f.subsAllowedWithoutCoi),
      subcontractedWorkDescription: str(f.subcontractedWorkDescription),
      paidToSubcontractors: num(f.paidToSubcontractors),
      workSubcontractedPct: num(f.workSubcontractedPct),
      fullTimeEmployees: num(f.fullTimeEmployees),
      partTimeEmployees: num(f.partTimeEmployees),
    }),
    validate: (f) => {
      const pct = Number(f.workSubcontractedPct);
      return f.workSubcontractedPct && (pct < 0 || pct > 100)
        ? ["Work sub-contracted should be a percentage between 0 and 100."]
        : [];
    },
  });

  const { form, setF } = gl.form;
  const money = (key: keyof GlForm, label: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <MoneyInput value={form[key]} onChange={(v) => setF(key, v)} />
    </div>
  );

  return (
    <div className="card">
      <h2>General liability</h2>
      <p className="muted small">
        What the association carries or is applying for — the ACORD 126's
        input. Quoted terms live on each quote.
      </p>

      {!gl.loaded ? (
        <p className="muted small">Loading…</p>
      ) : gl.error ? (
        <p className="error-text">{gl.error}</p>
      ) : (
        <>
          <h3>Limits</h3>
          <div className="form-grid">
            {money("eachOccurrence", "Each occurrence ($)")}
            {money("generalAggregate", "General aggregate ($)")}
            <div className="field">
              <label>General aggregate applies per</label>
              <select
                value={form.limitAppliesPer}
                onChange={(e) => setF("limitAppliesPer", e.target.value)}
              >
                <option value="">—</option>
                {AGGREGATE_APPLIES_TO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {money("productsCompletedOpsAggregate", "Products / completed ops ($)")}
            {money("personalAdvInjury", "Personal & advertising injury ($)")}
            {money("damageToRentedPremises", "Damage to rented premises ($)")}
            {money("medicalExpense", "Medical expense ($)")}
          </div>

          <h3>Deductibles</h3>
          <div className="form-grid">
            <div className="field">
              <label>Applies</label>
              <select
                value={form.deductibleType}
                onChange={(e) => setF("deductibleType", e.target.value)}
              >
                <option value="">—</option>
                {GL_DEDUCTIBLE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {money("propertyDamageDeductible", "Property damage ($)")}
            {money("bodilyInjuryDeductible", "Bodily injury ($)")}
          </div>

          <h3>Sub-contractors</h3>
          <div className="form-grid">
            {(
              [
                ["usesSubcontractors", "Are sub-contractors used?"],
                ["subsCarryLowerLimits", "Do any carry lower limits?"],
                ["subsAllowedWithoutCoi", "Allowed to work without a COI?"],
              ] as [keyof GlForm, string][]
            ).map(([key, label]) => (
              <div className="field" key={key}>
                <label>{label}</label>
                {/* Radios, not checkboxes: an unanswered question and a "no"
                    are different answers on an application. */}
                <YesNoRadio
                  name={`gl-${key}`}
                  value={form[key]}
                  onChange={(v) => setF(key, v)}
                />
              </div>
            ))}
            {money("paidToSubcontractors", "Paid to sub-contractors ($)")}
            <div className="field">
              <label>Work sub-contracted</label>
              <PercentInput
                value={form.workSubcontractedPct}
                onChange={(v) => setF("workSubcontractedPct", v)}
              />
            </div>
            <div className="field">
              <label>Full-time employees</label>
              <IntegerInput
                value={form.fullTimeEmployees}
                onChange={(v) => setF("fullTimeEmployees", v)}
              />
            </div>
            <div className="field">
              <label>Part-time employees</label>
              <IntegerInput
                value={form.partTimeEmployees}
                onChange={(v) => setF("partTimeEmployees", v)}
              />
            </div>
            <div className="field full">
              <label>Description of work sub-contracted</label>
              <textarea
                rows={2}
                value={form.subcontractedWorkDescription}
                onChange={(e) => setF("subcontractedWorkDescription", e.target.value)}
              />
            </div>
          </div>

          <div className="form-actions">
            <button className="primary" disabled={gl.status.busy} onClick={gl.save}>
              {gl.status.busy ? "Saving…" : "Save general liability"}
            </button>
            <SaveStatus {...gl.status.status} />
          </div>
        </>
      )}
    </div>
  );
}

interface ClassCodeForm {
  hazardNumber: string;
  classCode: string;
  premiumBasis: string;
  exposure: string;
  description: string;
}

const BLANK_CODE: ClassCodeForm = {
  hazardNumber: "",
  classCode: "",
  premiumBasis: "",
  exposure: "",
  description: "",
};

function GlClassCodesCard({ accountId }: { accountId: string }) {
  const child = useChildRows<GlClassCode, ClassCodeForm>(
    client.models.GlClassCode,
    {
      accountId,
      noun: "class code",
      initialForm: BLANK_CODE,
      toForm: (c) => ({
        hazardNumber: inputValue(c.hazardNumber),
        classCode: inputValue(c.classCode),
        premiumBasis: inputValue(c.premiumBasis),
        exposure: inputValue(c.exposure),
        description: inputValue(c.description),
      }),
      toCreate: toWriteCode,
      toUpdate: toWriteCode,
      describe: (f) => f.classCode.trim() || "Class code",
      describeRow: (c) => c.classCode ?? "this class code",
    }
  );

  return (
    <ChildRowsCard
      title="GL class codes"
      child={child}
      addLabel="+ Add class code"
      emptyMessage="No class codes recorded."
      summary={`— ${child.rows.length} total`}
      defaultSort="code"
      columns={[
        {
          key: "code",
          label: "Class code",
          sort: (c) => c.classCode,
          cell: (c) => c.classCode ?? "—",
        },
        {
          key: "hazard",
          label: "Hazard",
          sort: (c) => c.hazardNumber,
          cell: (c) => c.hazardNumber ?? "—",
        },
        {
          key: "basis",
          label: "Premium basis",
          sort: (c) => (c.premiumBasis ? GL_PREMIUM_BASIS_LABELS[c.premiumBasis] : null),
          cell: (c) =>
            c.premiumBasis ? GL_PREMIUM_BASIS_LABELS[c.premiumBasis] ?? c.premiumBasis : "—",
        },
        {
          key: "exposure",
          label: "Exposure",
          sort: (c) => c.exposure,
          cell: (c) => fmtNum(c.exposure),
        },
        {
          key: "description",
          label: "Description",
          sort: (c) => c.description,
          cell: (c) => c.description ?? "—",
        },
      ]}
      // Five fields plus a description that runs long — this is the one
      // child-rows screen in W4 that does not fit in a table row.
      editIn="modal"
      editTitle={(c) => `Editing class code ${c.classCode ?? ""}`.trim()}
      removeMessage={(c) => `Remove class code ${c.classCode ?? "row"}?`}
      addFields={<ClassCodeFields form={child.addForm} onEnter={child.add} />}
      editFields={<ClassCodeFields form={child.editForm} />}
    />
  );
}

function toWriteCode(form: ClassCodeForm) {
  return {
    hazardNumber: str(form.hazardNumber),
    classCode: str(form.classCode),
    premiumBasis: str(form.premiumBasis) as GlClassCode["premiumBasis"],
    exposure: num(form.exposure),
    description: str(form.description),
  };
}

function ClassCodeFields({
  form,
  onEnter,
}: {
  form: FormState<ClassCodeForm>;
  onEnter?: () => void;
}) {
  const enter = onEnter
    ? (e: { key: string }) => {
        if (e.key === "Enter") onEnter();
      }
    : undefined;
  return (
    <>
      <div className="field">
        <label>Class code</label>
        <input
          placeholder="62003"
          value={form.form.classCode}
          onChange={(e) => form.setF("classCode", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Hazard #</label>
        <input
          value={form.form.hazardNumber}
          onChange={(e) => form.setF("hazardNumber", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Premium basis</label>
        <select
          value={form.form.premiumBasis}
          onChange={(e) => form.setF("premiumBasis", e.target.value)}
        >
          <option value="">—</option>
          {GL_PREMIUM_BASIS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Exposure</label>
        <IntegerInput
          value={form.form.exposure}
          onChange={(v) => form.setF("exposure", v)}
          onKeyDown={enter}
        />
      </div>
      <div className="field full">
        <label>Description</label>
        <input
          placeholder="Condominiums — residential"
          value={form.form.description}
          onChange={(e) => form.setF("description", e.target.value)}
          onKeyDown={enter}
        />
      </div>
    </>
  );
}
