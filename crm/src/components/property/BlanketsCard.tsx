import { client, fmtMoney, type Blanket } from "../../lib/client";
import { inputValue, num, str } from "../../lib/formCodec";
import { blanketKey } from "../../lib/extractionKeys";
import { useChildRows } from "../../lib/useChildRows";
import type { FormState } from "../../lib/useFormState";
import ChildRowsCard from "../ChildRowsCard";
import { MoneyInput } from "../inputs";

/**
 * The blanket limits an association's property schedule sits under.
 *
 * Not `Quote.blanketLimit` / `Policy.blanketLimit`, which look like the same
 * thing and are not: those are terms a carrier quoted or bound, and these are
 * the application's own schedule — what the association says it carries.
 */

interface BlanketForm {
  blanketNumber: string;
  type: string;
  amount: string;
}

const BLANK: BlanketForm = { blanketNumber: "", type: "", amount: "" };

export default function BlanketsCard({ accountId }: { accountId: string }) {
  const child = useChildRows<Blanket, BlanketForm>(client.models.Blanket, {
    accountId,
    noun: "blanket",
    initialForm: BLANK,
    toForm: (b) => ({
      blanketNumber: inputValue(b.blanketNumber),
      type: inputValue(b.type),
      amount: inputValue(b.amount),
    }),
    toCreate: (f) => ({ ...toWrite(f), extractionSourceKey: blanketKey(f) }),
    toUpdate: toWrite,
    describe: (form) => form.blanketNumber.trim() || "Blanket",
    describeRow: (b) => b.blanketNumber ?? "this blanket",
  });

  const total = child.rows.reduce((s, b) => s + (b.amount ?? 0), 0);

  return (
    <ChildRowsCard
      title="Blanket coverages"
      child={child}
      addLabel="+ Add blanket"
      emptyMessage="No blankets recorded."
      summary={`— ${child.rows.length} total${total ? ` · ${fmtMoney(total)}` : ""}`}
      defaultSort="number"
      columns={[
        {
          key: "number",
          label: "Blanket #",
          sort: (b) => b.blanketNumber,
          cell: (b) => b.blanketNumber ?? "—",
        },
        { key: "type", label: "Type", sort: (b) => b.type, cell: (b) => b.type ?? "—" },
        {
          key: "amount",
          label: "Amount",
          sort: (b) => b.amount,
          cell: (b) => fmtMoney(b.amount),
        },
      ]}
      editTitle={(b) => `Editing ${b.blanketNumber ?? "blanket"}`}
      removeMessage={(b) => `Remove ${b.blanketNumber ?? "this blanket"}?`}
      addFields={<BlanketFields form={child.addForm} onEnter={child.add} />}
      editFields={<BlanketFields form={child.editForm} />}
    />
  );
}

function toWrite(form: BlanketForm) {
  return {
    blanketNumber: str(form.blanketNumber),
    type: str(form.type),
    amount: num(form.amount),
  };
}

function BlanketFields({
  form,
  onEnter,
}: {
  form: FormState<BlanketForm>;
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
        <label>Blanket #</label>
        <input
          placeholder="BL-1"
          value={form.form.blanketNumber}
          onChange={(e) => form.setF("blanketNumber", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field" style={{ flex: "1 1 200px" }}>
        <label>Type</label>
        <input
          placeholder="Blanket Bldg & BPP"
          value={form.form.type}
          onChange={(e) => form.setF("type", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Amount ($)</label>
        <MoneyInput
          value={form.form.amount}
          onChange={(v) => form.setF("amount", v)}
          onKeyDown={enter}
        />
      </div>
    </>
  );
}
