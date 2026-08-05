import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  client,
  fmtNum,
  validatePositiveInt,
  type Building,
} from "../../lib/client";
import { inputValue, num, str } from "../../lib/formCodec";
import { useChildRows } from "../../lib/useChildRows";
import type { FormState } from "../../lib/useFormState";
import ChildRowsCard from "../ChildRowsCard";
import { IntegerInput } from "../inputs";

interface BuildingForm {
  label: string;
  sqft: string;
  street: string;
  desc: string;
}

const BLANK: BuildingForm = { label: "", sqft: "", street: "", desc: "" };

export default function BuildingsCard({ accountId }: { accountId: string }) {
  // `toCreate` and friends are function *declarations* so they are hoisted
  // above this call while still closing over `child` — which is what lets the
  // default label count the rows the hook is holding. They only ever run from
  // a click, long after `child` is initialised.
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

  function toForm(b: Building): BuildingForm {
    return {
      label: inputValue(b.label),
      sqft: inputValue(b.sqft),
      street: inputValue(b.streetAddress),
      desc: inputValue(b.description),
    };
  }

  function toCreate(form: BuildingForm) {
    return { ...toUpdate(form), label: labelFor(form) };
  }

  function toUpdate(form: BuildingForm) {
    return {
      label: str(form.label),
      sqft: num(form.sqft),
      streetAddress: str(form.street),
      description: str(form.desc),
    };
  }

  function validate(form: BuildingForm): string[] {
    return validatePositiveInt(form.sqft, "Sq ft", { min: 1 });
  }

  const totalSqft = child.rows.reduce((s, b) => s + (b.sqft ?? 0), 0);

  return (
    <ChildRowsCard
      title="Buildings"
      child={child}
      addLabel="+ Add building"
      emptyMessage="No buildings yet."
      summary={`— ${child.rows.length} total${
        totalSqft ? ` · ${fmtNum(totalSqft)} sq ft` : ""
      }`}
      defaultSort="building"
      columns={[
        {
          key: "building",
          label: "Building",
          // Unlabelled rows sort last in either direction — `useSort`'s rule.
          sort: (b) => b.label,
          cell: (b) => b.label,
        },
        { key: "sqft", label: "Sq ft", sort: (b) => b.sqft, cell: (b) => fmtNum(b.sqft) },
      ]}
      editTitle={(b) => `Editing ${b.label ?? "building"}`}
      removeMessage={(b) => `Remove ${b.label ?? "this building"}?`}
      addFields={
        <BuildingFields
          form={child.addForm}
          labelPlaceholder={`Building ${child.rows.length + 1}`}
          onEnter={child.add}
        />
      }
      editFields={<BuildingFields form={child.editForm} />}
    />
  );
}

/**
 * The same four fields in the add toolbar and the edit form. Written once so
 * they cannot drift into two different field sets — the add form offering a
 * column the edit form can't change is the failure mode.
 */
function BuildingFields({
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
          value={form.form.street}
          onChange={(e) => form.setF("street", e.target.value)}
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
          value={form.form.desc}
          onChange={(e) => form.setF("desc", e.target.value)}
          onKeyDown={enter}
        />
      </div>
    </>
  );
}
