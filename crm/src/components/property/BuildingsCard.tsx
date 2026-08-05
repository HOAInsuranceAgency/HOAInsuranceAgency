import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  client,
  fmtMoney,
  fmtNum,
  listAllPages,
  validateYear,
  validatePositiveInt,
  type Blanket,
  type Building,
} from "../../lib/client";
import { bool, boolValue, inputValue, num, str } from "../../lib/formCodec";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useChildRows } from "../../lib/useChildRows";
import type { FormState } from "../../lib/useFormState";
import {
  BUILDING_DEDUCTIBLE_TYPE_OPTIONS,
  CAUSE_OF_LOSS_OPTIONS,
  CONSTRUCTION_LABELS,
  CONSTRUCTION_OPTIONS,
  REPLACEMENT_COST_OPTIONS,
} from "../../lib/enums";
import ChildRowsCard from "../ChildRowsCard";
import { IntegerInput, MoneyInput, PercentInput, YearInput, YesNoRadio } from "../inputs";

/**
 * Buildings — the ACORD 140's unit of description, and now editable.
 *
 * Before W5 this card was add-only and held four fields. The 140 asks about
 * twenty-eight per building, and the seven construction columns that used to
 * live on `Account` were the app's way of pretending an association's
 * thirteen buildings were one: a single `yearBuilt`, a single roof year, one
 * construction class for a site with a 1978 clubhouse and 2016 townhouses.
 *
 * ## The table stays short
 *
 * Six columns and an Edit button. The other twenty-two fields are not table
 * columns — a table wide enough for them is a table nobody can read — so the
 * editor is `Modal`, grouped the way the 140 groups them: identity,
 * construction, protection, coverage, other.
 */

interface BuildingForm {
  label: string;
  streetAddress: string;
  description: string;
  sqft: string;
  // Construction
  yearBuilt: string;
  stories: string;
  basements: string;
  constructionType: string;
  roofType: string;
  roofYear: string;
  heatingYear: string;
  wiringYear: string;
  plumbingYear: string;
  // Protection
  distanceToHydrantFt: string;
  distanceToFireStationMi: string;
  fireProtectionType: string;
  sprinklerPct: string;
  // Coverage
  individualBuildingValue: string;
  valuation: string;
  coinsurancePct: string;
  deductibleType: string;
  deductibleAmount: string;
  blanketNumber: string;
  causeOfLoss: string;
  formsConditions: string;
  // Other
  otherOccupancies: string;
  historicalLandmark: string;
  sinkholeCoverageAccepted: string;
  mineSubsidenceCoverage: string;
  remarks: string;
}

const BLANK: BuildingForm = {
  label: "",
  streetAddress: "",
  description: "",
  sqft: "",
  yearBuilt: "",
  stories: "",
  basements: "",
  constructionType: "",
  roofType: "",
  roofYear: "",
  heatingYear: "",
  wiringYear: "",
  plumbingYear: "",
  distanceToHydrantFt: "",
  distanceToFireStationMi: "",
  fireProtectionType: "",
  sprinklerPct: "",
  individualBuildingValue: "",
  valuation: "",
  coinsurancePct: "",
  deductibleType: "",
  deductibleAmount: "",
  blanketNumber: "",
  causeOfLoss: "",
  formsConditions: "",
  otherOccupancies: "",
  historicalLandmark: "",
  sinkholeCoverageAccepted: "",
  mineSubsidenceCoverage: "",
  remarks: "",
};

export default function BuildingsCard({ accountId }: { accountId: string }) {
  // The account's blanket numbers, offered to the building's free-text
  // blanket field through a datalist. A read failure costs the suggestions
  // and nothing else — the field is free text either way — so it is
  // deliberately not surfaced.
  const blankets = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Blanket.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Blanket[] }
  );

  const child = useChildRows<Building, BuildingForm>(client.models.Building, {
    accountId,
    noun: "building",
    initialForm: BLANK,
    toForm,
    toCreate,
    toUpdate,
    validate,
    describe: labelFor,
    describeRow: (b) => b.label ?? "Building",
  });

  function labelFor(form: BuildingForm): string {
    return form.label.trim() || `Building ${child.rows.length + 1}`;
  }

  function toCreate(form: BuildingForm) {
    return { ...toUpdate(form), label: labelFor(form) };
  }

  const totalSqft = child.rows.reduce((s, b) => s + (b.sqft ?? 0), 0);
  const totalValue = child.rows.reduce(
    (s, b) => s + (b.individualBuildingValue ?? 0),
    0
  );
  const blanketNumbers = [
    ...new Set(blankets.data.map((b) => b.blanketNumber).filter(Boolean)),
  ] as string[];

  // Sq ft and insured value are the two totals an underwriter asks for, and
  // each is only shown once there is one — a "· $0 insured value" on an
  // account nobody has valued yet is an assertion, not a placeholder.
  const summary = [
    `— ${child.rows.length} total`,
    totalSqft ? `${fmtNum(totalSqft)} sq ft` : "",
    totalValue ? `${fmtMoney(totalValue)} insured value` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ChildRowsCard
      title="Buildings"
      child={child}
      addLabel="+ Add building"
      emptyMessage="No buildings yet."
      summary={summary}
      defaultSort="building"
      columns={[
        {
          key: "building",
          label: "Building",
          sort: (b) => b.label,
          cell: (b) => b.label,
        },
        {
          key: "address",
          label: "Address",
          sort: (b) => b.streetAddress,
          cell: (b) => b.streetAddress ?? "—",
        },
        { key: "sqft", label: "Sq ft", sort: (b) => b.sqft, cell: (b) => fmtNum(b.sqft) },
        {
          key: "yearBuilt",
          label: "Built",
          sort: (b) => b.yearBuilt,
          // Not fmtNum: a year is a label, so 1,985 would be wrong.
          cell: (b) => (b.yearBuilt != null ? String(b.yearBuilt) : "—"),
        },
        {
          key: "construction",
          label: "Construction",
          sort: (b) => (b.constructionType ? CONSTRUCTION_LABELS[b.constructionType] : null),
          cell: (b) =>
            b.constructionType
              ? CONSTRUCTION_LABELS[b.constructionType] ?? b.constructionType
              : "—",
        },
        {
          key: "value",
          label: "Value",
          sort: (b) => b.individualBuildingValue,
          cell: (b) => fmtMoney(b.individualBuildingValue),
        },
      ]}
      // Twenty-eight fields do not fit in a table row, and an inline form that
      // reflows the table under the cursor is worse than an overlay.
      editIn="modal"
      editTitle={(b) => `Editing ${b.label ?? "building"}`}
      removeMessage={(b) => `Remove ${b.label ?? "this building"}?`}
      addFields={
        <AddFields
          form={child.addForm}
          labelPlaceholder={`Building ${child.rows.length + 1}`}
          onEnter={child.add}
        />
      }
      editFields={
        <EditFields form={child.editForm} blanketNumbers={blanketNumbers} />
      }
    />
  );
}

function toForm(b: Building): BuildingForm {
  return {
    label: inputValue(b.label),
    streetAddress: inputValue(b.streetAddress),
    description: inputValue(b.description),
    sqft: inputValue(b.sqft),
    yearBuilt: inputValue(b.yearBuilt),
    stories: inputValue(b.stories),
    basements: inputValue(b.basements),
    constructionType: inputValue(b.constructionType),
    roofType: inputValue(b.roofType),
    roofYear: inputValue(b.roofYear),
    heatingYear: inputValue(b.heatingYear),
    wiringYear: inputValue(b.wiringYear),
    plumbingYear: inputValue(b.plumbingYear),
    distanceToHydrantFt: inputValue(b.distanceToHydrantFt),
    distanceToFireStationMi: inputValue(b.distanceToFireStationMi),
    fireProtectionType: inputValue(b.fireProtectionType),
    sprinklerPct: inputValue(b.sprinklerPct),
    individualBuildingValue: inputValue(b.individualBuildingValue),
    valuation: inputValue(b.valuation),
    coinsurancePct: inputValue(b.coinsurancePct),
    deductibleType: inputValue(b.deductibleType),
    deductibleAmount: inputValue(b.deductibleAmount),
    blanketNumber: inputValue(b.blanketNumber),
    causeOfLoss: inputValue(b.causeOfLoss),
    formsConditions: inputValue(b.formsConditions),
    otherOccupancies: inputValue(b.otherOccupancies),
    historicalLandmark: boolValue(b.historicalLandmark),
    sinkholeCoverageAccepted: boolValue(b.sinkholeCoverageAccepted),
    mineSubsidenceCoverage: boolValue(b.mineSubsidenceCoverage),
    remarks: inputValue(b.remarks),
  };
}

function toUpdate(form: BuildingForm) {
  return {
    label: str(form.label),
    streetAddress: str(form.streetAddress),
    description: str(form.description),
    sqft: num(form.sqft),
    yearBuilt: num(form.yearBuilt),
    stories: num(form.stories),
    basements: num(form.basements),
    constructionType: str(form.constructionType) as Building["constructionType"],
    roofType: str(form.roofType),
    roofYear: num(form.roofYear),
    heatingYear: num(form.heatingYear),
    wiringYear: num(form.wiringYear),
    plumbingYear: num(form.plumbingYear),
    distanceToHydrantFt: num(form.distanceToHydrantFt),
    distanceToFireStationMi: num(form.distanceToFireStationMi),
    fireProtectionType: str(form.fireProtectionType),
    sprinklerPct: num(form.sprinklerPct),
    individualBuildingValue: num(form.individualBuildingValue),
    valuation: str(form.valuation) as Building["valuation"],
    coinsurancePct: num(form.coinsurancePct),
    deductibleType: str(form.deductibleType) as Building["deductibleType"],
    deductibleAmount: num(form.deductibleAmount),
    blanketNumber: str(form.blanketNumber),
    causeOfLoss: str(form.causeOfLoss) as Building["causeOfLoss"],
    formsConditions: str(form.formsConditions),
    otherOccupancies: str(form.otherOccupancies),
    historicalLandmark: bool(form.historicalLandmark),
    sinkholeCoverageAccepted: bool(form.sinkholeCoverageAccepted),
    mineSubsidenceCoverage: bool(form.mineSubsidenceCoverage),
    remarks: str(form.remarks),
  };
}

/**
 * The year rules are the ones `client.ts:270` documents, applied per building
 * rather than per account: construction can be scheduled up to five years
 * ahead, but work already *done* cannot be years in the future.
 */
function validate(form: BuildingForm): string[] {
  return [
    ...validatePositiveInt(form.sqft, "Sq ft", { min: 1 }),
    ...validatePositiveInt(form.stories, "Stories", { min: 1 }),
    ...validatePositiveInt(form.basements, "Basements"),
    ...validateYear(form.yearBuilt, "Year built", { maxYearsAhead: 5 }),
    ...validateYear(form.roofYear, "Roof year", { maxYearsAhead: 1 }),
    ...validateYear(form.heatingYear, "Heating year", { maxYearsAhead: 1 }),
    ...validateYear(form.wiringYear, "Wiring year", { maxYearsAhead: 1 }),
    ...validateYear(form.plumbingYear, "Plumbing year", { maxYearsAhead: 1 }),
  ];
}

/** The four fields the add toolbar asks for. The rest are set by editing. */
function AddFields({
  form,
  labelPlaceholder,
  onEnter,
}: {
  form: FormState<BuildingForm>;
  labelPlaceholder?: string;
  onEnter?: () => void;
}) {
  const enter = onEnter
    ? (e: ReactKeyboardEvent) => {
        if (e.key === "Enter") onEnter();
      }
    : undefined;
  return (
    <>
      <div className="field">
        <label>Label</label>
        <input
          placeholder={labelPlaceholder}
          value={form.form.label}
          onChange={(e) => form.setF("label", e.target.value)}
        />
      </div>
      <div className="field">
        <label>Street address</label>
        <input
          placeholder="2 John Hancock Dr"
          value={form.form.streetAddress}
          onChange={(e) => form.setF("streetAddress", e.target.value)}
        />
      </div>
      <div className="field">
        <label>Sq ft</label>
        <IntegerInput
          value={form.form.sqft}
          onChange={(v) => form.setF("sqft", v)}
          onKeyDown={enter}
        />
      </div>
      <div className="field" style={{ flex: "1 1 260px" }}>
        <label>Description (prints on ACORD 125)</label>
        <input
          placeholder="2, 4, 10, 12 John Hancock. Two-story wood frame…"
          value={form.form.description}
          onChange={(e) => form.setF("description", e.target.value)}
          onKeyDown={enter}
        />
      </div>
    </>
  );
}

/** Everything, grouped the way the ACORD 140 groups it. */
function EditFields({
  form,
  blanketNumbers,
}: {
  form: FormState<BuildingForm>;
  blanketNumbers: string[];
}) {
  const f = form.form;
  const set = form.setF;

  const text = (key: keyof BuildingForm, label: string, placeholder?: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <input
        placeholder={placeholder}
        value={f[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </div>
  );
  const year = (key: keyof BuildingForm, label: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <YearInput value={f[key]} onChange={(v) => set(key, v)} />
    </div>
  );
  const count = (key: keyof BuildingForm, label: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <IntegerInput value={f[key]} onChange={(v) => set(key, v)} />
    </div>
  );
  const money = (key: keyof BuildingForm, label: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <MoneyInput value={f[key]} onChange={(v) => set(key, v)} />
    </div>
  );
  const pct = (key: keyof BuildingForm, label: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <PercentInput value={f[key]} onChange={(v) => set(key, v)} />
    </div>
  );
  const choice = (
    key: keyof BuildingForm,
    label: string,
    options: readonly { value: string; label: string }[]
  ) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <select value={f[key]} onChange={(e) => set(key, e.target.value)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  const yesNo = (key: keyof BuildingForm, label: string) => (
    <div className="field" key={key}>
      <label>{label}</label>
      <YesNoRadio name={`building-${key}`} value={f[key]} onChange={(v) => set(key, v)} />
    </div>
  );

  return (
    <>
      <h3 className="field full">Identity</h3>
      {text("label", "Label", "Building A")}
      {text("streetAddress", "Street address", "2 John Hancock Dr")}
      <div className="field full">
        <label>Description (prints on ACORD 125)</label>
        <input
          value={f.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </div>

      <h3 className="field full">Construction</h3>
      {year("yearBuilt", "Year built")}
      {count("stories", "Stories")}
      {count("basements", "Basements")}
      {choice("constructionType", "Construction type", CONSTRUCTION_OPTIONS)}
      {count("sqft", "Sq ft")}
      {text("roofType", "Roof type", "Asphalt shingle")}
      {year("roofYear", "Roof updated")}
      {year("heatingYear", "Heating updated")}
      {year("wiringYear", "Wiring updated")}
      {year("plumbingYear", "Plumbing updated")}

      <h3 className="field full">Protection</h3>
      {count("distanceToHydrantFt", "Distance to hydrant (ft)")}
      <div className="field">
        <label>Distance to fire station (mi)</label>
        {/* Fractional miles, like `milesToCoast` — none of the formatted
            inputs is a fractional non-money quantity. */}
        <input
          type="number"
          min={0}
          step="0.1"
          value={f.distanceToFireStationMi}
          onChange={(e) => set("distanceToFireStationMi", e.target.value)}
        />
      </div>
      {text("fireProtectionType", "Fire protection", "Wet sprinkler, central station")}
      {pct("sprinklerPct", "Sprinklered")}

      <h3 className="field full">Coverage</h3>
      {money("individualBuildingValue", "Individual building value ($)")}
      {choice("valuation", "Valuation", REPLACEMENT_COST_OPTIONS)}
      {pct("coinsurancePct", "Coinsurance")}
      {choice("deductibleType", "Deductible applies", BUILDING_DEDUCTIBLE_TYPE_OPTIONS)}
      {money("deductibleAmount", "Deductible ($)")}
      <div className="field">
        <label>Blanket #</label>
        {/* Free text with suggestions, not a foreign key: the form prints the
            number an underwriter wrote, and a number with no Blanket row is
            legal. */}
        <input
          list="account-blanket-numbers"
          value={f.blanketNumber}
          onChange={(e) => set("blanketNumber", e.target.value)}
        />
        <datalist id="account-blanket-numbers">
          {blanketNumbers.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </div>
      {choice("causeOfLoss", "Cause of loss", CAUSE_OF_LOSS_OPTIONS)}
      {text("formsConditions", "Forms & conditions")}

      <h3 className="field full">Other</h3>
      {text("otherOccupancies", "Other occupancies")}
      {yesNo("historicalLandmark", "Historical landmark?")}
      {yesNo("sinkholeCoverageAccepted", "Sinkhole coverage accepted?")}
      {yesNo("mineSubsidenceCoverage", "Mine subsidence coverage?")}
      <div className="field full">
        <label>Remarks (ACORD 101 overflow)</label>
        <textarea
          rows={2}
          value={f.remarks}
          onChange={(e) => set("remarks", e.target.value)}
        />
      </div>
    </>
  );
}
