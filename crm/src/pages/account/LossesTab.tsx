import {
  LINES_OF_BUSINESS,
  client,
  fmtDate,
  fmtMoney,
  validateDateRange,
  type Loss,
} from "../../lib/client";
import { bool, boolValue, inputValue, num, str } from "../../lib/formCodec";
import { lossKey } from "../../lib/extractionKeys";
import { useChildRows } from "../../lib/useChildRows";
import type { FormState } from "../../lib/useFormState";
import ChildRowsCard from "../../components/ChildRowsCard";
import { DateInput, MoneyInput, YesNoRadio } from "../../components/inputs";

/**
 * Loss history — the ACORD 125's loss-history rows, and the first thing an
 * underwriter looks at after the operations line.
 *
 * Visible for leads and clients alike: losses follow the account, and a
 * renewal submission declares the same ones a new-business submission did.
 * That is the difference between this tab and Prior coverage, which is
 * lead-only because a bound policy answers the same question better.
 */

interface LossForm {
  dateOfLoss: string;
  lineOfBusiness: string;
  typeOfLoss: string;
  description: string;
  claimDate: string;
  amountOfLoss: string;
  amountPaid: string;
  amountReserved: string;
  claimOpen: string;
}

const BLANK: LossForm = {
  dateOfLoss: "",
  lineOfBusiness: "",
  typeOfLoss: "",
  description: "",
  claimDate: "",
  amountOfLoss: "",
  amountPaid: "",
  amountReserved: "",
  claimOpen: "",
};

export function LossesTab({ accountId }: { accountId: string }) {
  const child = useChildRows<Loss, LossForm>(client.models.Loss, {
    accountId,
    noun: "loss",
    nounPlural: "losses",
    initialForm: BLANK,
    toForm: (l) => ({
      dateOfLoss: inputValue(l.dateOfLoss),
      lineOfBusiness: inputValue(l.lineOfBusiness),
      typeOfLoss: inputValue(l.typeOfLoss),
      description: inputValue(l.description),
      claimDate: inputValue(l.claimDate),
      amountOfLoss: inputValue(l.amountOfLoss),
      amountPaid: inputValue(l.amountPaid),
      amountReserved: inputValue(l.amountReserved),
      claimOpen: boolValue(l.claimOpen),
    }),
    toCreate: toWrite,
    toUpdate: toWrite,
    validate,
    describe: (f) =>
      [f.dateOfLoss && fmtDate(f.dateOfLoss), f.lineOfBusiness]
        .filter(Boolean)
        .join(" ") || "Loss",
    describeRow: (l) =>
      [fmtDate(l.dateOfLoss), l.lineOfBusiness].filter(Boolean).join(" "),
  });

  // Gated on `loaded` by `ChildRowsCard`, which is what stops a total of $0
  // rendering over a read that has not settled — PATTERNS: never render an
  // assertion about data you do not have yet.
  const totalPaid = child.rows.reduce((s, l) => s + (l.amountPaid ?? 0), 0);
  const totalReserved = child.rows.reduce((s, l) => s + (l.amountReserved ?? 0), 0);
  const openCount = child.rows.filter((l) => l.claimOpen === true).length;

  return (
    <ChildRowsCard
      title="Loss history"
      child={child}
      addLabel="+ Add loss"
      emptyMessage="No losses recorded."
      summary={[
        `— ${child.rows.length} loss${child.rows.length === 1 ? "" : "es"}`,
        totalPaid ? `${fmtMoney(totalPaid)} paid` : "",
        totalReserved ? `${fmtMoney(totalReserved)} reserved` : "",
        openCount ? `${openCount} open` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
      // Most recent first: recency is what an underwriter weighs.
      defaultSort="date"
      defaultDir="desc"
      columns={[
        {
          key: "date",
          label: "Date of loss",
          sort: (l) => l.dateOfLoss,
          cell: (l) => fmtDate(l.dateOfLoss),
        },
        {
          key: "line",
          label: "Line",
          sort: (l) => l.lineOfBusiness,
          cell: (l) => l.lineOfBusiness,
        },
        {
          key: "type",
          label: "Type",
          sort: (l) => l.typeOfLoss,
          cell: (l) => l.typeOfLoss ?? "—",
        },
        {
          key: "paid",
          label: "Paid",
          sort: (l) => l.amountPaid,
          cell: (l) => fmtMoney(l.amountPaid),
        },
        {
          key: "reserved",
          label: "Reserved",
          sort: (l) => l.amountReserved,
          cell: (l) => fmtMoney(l.amountReserved),
        },
        {
          key: "status",
          label: "Status",
          sort: (l) => (l.claimOpen == null ? null : l.claimOpen ? "Open" : "Closed"),
          // Three states, because the column is nullable: a claim nobody has
          // told us about is not a closed one.
          cell: (l) => (l.claimOpen == null ? "—" : l.claimOpen ? "Open" : "Closed"),
        },
      ]}
      editIn="modal"
      editTitle={(l) => `Editing ${fmtDate(l.dateOfLoss)} ${l.lineOfBusiness}`}
      removeMessage={(l) =>
        `Remove the ${fmtDate(l.dateOfLoss)} ${l.lineOfBusiness} loss?`
      }
      addFields={<LossFields form={child.addForm} compact onEnter={child.add} />}
      editFields={<LossFields form={child.editForm} />}
    />
  );
}

function toWrite(form: LossForm) {
  return {
    dateOfLoss: str(form.dateOfLoss),
    lineOfBusiness: str(form.lineOfBusiness),
    typeOfLoss: str(form.typeOfLoss),
    description: str(form.description),
    claimDate: str(form.claimDate),
    amountOfLoss: num(form.amountOfLoss),
    amountPaid: num(form.amountPaid),
    amountReserved: num(form.amountReserved),
    claimOpen: bool(form.claimOpen),
    extractionSourceKey: lossKey(form),
  };
}

function validate(form: LossForm): string[] {
  const problems: string[] = [];
  // Both are `.required()` on the model, and both for the same reason: the
  // 125's loss rows are ordered by date and labelled by line, so a row
  // missing either cannot be submitted. Checking here turns a raw GraphQL
  // variable error into a sentence.
  if (!form.dateOfLoss) problems.push("Date of loss is required.");
  if (!form.lineOfBusiness) problems.push("Line of business is required.");
  // A claim cannot be reported before the thing it is about happened.
  problems.push(
    ...validateDateRange(form.dateOfLoss, form.claimDate, "Date of loss", "claim date")
  );
  return problems;
}

function LossFields({
  form,
  compact,
  onEnter,
}: {
  form: FormState<LossForm>;
  /** The add toolbar asks for the four fields a loss run always states. */
  compact?: boolean;
  onEnter?: () => void;
}) {
  const f = form.form;
  const set = form.setF;
  const enter = onEnter
    ? (e: { key: string }) => {
        if (e.key === "Enter") onEnter();
      }
    : undefined;

  return (
    <>
      <div className="field">
        <label>Date of loss *</label>
        <DateInput value={f.dateOfLoss} onChange={(v) => set("dateOfLoss", v)} />
      </div>
      <div className="field">
        <label>Line of business *</label>
        <select
          value={f.lineOfBusiness}
          onChange={(e) => set("lineOfBusiness", e.target.value)}
        >
          <option value="">—</option>
          {LINES_OF_BUSINESS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Type of loss</label>
        <input
          placeholder="Water damage"
          value={f.typeOfLoss}
          onChange={(e) => set("typeOfLoss", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Paid ($)</label>
        <MoneyInput
          value={f.amountPaid}
          onChange={(v) => set("amountPaid", v)}
          onKeyDown={enter}
        />
      </div>
      {compact ? null : (
        <>
          <div className="field">
            <label>Claim date</label>
            <DateInput value={f.claimDate} onChange={(v) => set("claimDate", v)} />
          </div>
          <div className="field">
            <label>Amount of loss ($)</label>
            <MoneyInput
              value={f.amountOfLoss}
              onChange={(v) => set("amountOfLoss", v)}
            />
          </div>
          <div className="field">
            <label>Reserved ($)</label>
            <MoneyInput
              value={f.amountReserved}
              onChange={(v) => set("amountReserved", v)}
            />
          </div>
          <div className="field">
            <label>Claim open?</label>
            {/* Radios: a claim nobody has told us the status of is not a
                closed one, and the column is nullable to say so. */}
            <YesNoRadio
              name="loss-claim-open"
              value={f.claimOpen}
              onChange={(v) => set("claimOpen", v)}
            />
          </div>
          <div className="field full">
            <label>Description</label>
            <textarea
              rows={2}
              value={f.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
        </>
      )}
    </>
  );
}
