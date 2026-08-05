import {
  LINES_OF_BUSINESS,
  client,
  fmtDate,
  fmtMoney,
  validateDateRange,
  type PriorCarrier,
} from "../../lib/client";
import { inputValue, num, str } from "../../lib/formCodec";
import { priorCarrierKey } from "../../lib/extractionKeys";
import { useChildRows } from "../../lib/useChildRows";
import type { FormState } from "../../lib/useFormState";
import ChildRowsCard from "../../components/ChildRowsCard";
import { DateInput, MoneyInput } from "../../components/inputs";

/**
 * What the account is insured under today, one row per line.
 *
 * Replaces five Account columns — `priorCarrierName`, `priorPolicyNumber`,
 * `priorPremium`, `priorTermEffective`, `priorTermExpiration` — which between
 * them could describe exactly one expiring policy. An association routinely
 * carries property, general liability, D&O and crime with different carriers
 * on different terms, and a renewal submission has to state all of them; the
 * ACORD 125's prior-coverage section has a row per line for precisely that.
 *
 * ## Lead-only, and why the rows survive conversion
 *
 * The tab is hidden once `stage === "CLIENT"` — at that point the bound
 * Policy records are what the account is insured under, and a "prior carrier"
 * tab beside them invites someone to maintain two answers to one question.
 *
 * The rows are not deleted, and the tab being hidden is not the same as the
 * data being gone: every renewal submission for the rest of the account's
 * life fills its prior-coverage block from them. Deleting on conversion would
 * be throwing away the only record of what the association carried before it
 * came here.
 */

interface PriorCarrierForm {
  lineOfBusiness: string;
  carrierName: string;
  policyNumber: string;
  premium: string;
  effectiveDate: string;
  expirationDate: string;
}

const BLANK: PriorCarrierForm = {
  lineOfBusiness: "",
  carrierName: "",
  policyNumber: "",
  premium: "",
  effectiveDate: "",
  expirationDate: "",
};

export function PriorCarrierTab({ accountId }: { accountId: string }) {
  const child = useChildRows<PriorCarrier, PriorCarrierForm>(
    client.models.PriorCarrier,
    {
      accountId,
      noun: "prior carrier",
      initialForm: BLANK,
      toForm: (p) => ({
        lineOfBusiness: inputValue(p.lineOfBusiness),
        carrierName: inputValue(p.carrierName),
        policyNumber: inputValue(p.policyNumber),
        premium: inputValue(p.premium),
        effectiveDate: inputValue(p.effectiveDate),
        expirationDate: inputValue(p.expirationDate),
      }),
      toCreate: toWrite,
      toUpdate: toWrite,
      validate,
      describe: (form) =>
        [form.carrierName.trim(), form.lineOfBusiness].filter(Boolean).join(" — ") ||
        "Prior carrier",
      describeRow: (p) =>
        [p.carrierName, p.lineOfBusiness].filter(Boolean).join(" — ") ||
        "this prior carrier",
    }
  );

  return (
    <ChildRowsCard
      title="Prior coverage"
      child={child}
      addLabel="+ Add prior carrier"
      emptyMessage="No prior coverage recorded."
      summary={`— ${child.rows.length} line${child.rows.length === 1 ? "" : "s"}`}
      // Most recent term first: the expiring policy is the one a renewal
      // submission is about, and the older rows are history.
      defaultSort="expiration"
      defaultDir="desc"
      columns={[
        {
          key: "line",
          label: "Line",
          sort: (p) => p.lineOfBusiness,
          cell: (p) => p.lineOfBusiness ?? "—",
        },
        {
          key: "carrier",
          label: "Carrier",
          sort: (p) => p.carrierName,
          cell: (p) => p.carrierName ?? "—",
        },
        {
          key: "policy",
          label: "Policy #",
          sort: (p) => p.policyNumber,
          cell: (p) => p.policyNumber ?? "—",
        },
        {
          key: "premium",
          label: "Premium",
          sort: (p) => p.premium,
          cell: (p) => fmtMoney(p.premium),
        },
        {
          key: "effective",
          label: "Effective",
          sort: (p) => p.effectiveDate,
          cell: (p) => fmtDate(p.effectiveDate),
        },
        {
          key: "expiration",
          label: "Expiration",
          sort: (p) => p.expirationDate,
          cell: (p) => fmtDate(p.expirationDate),
        },
      ]}
      editTitle={(p) =>
        `Editing ${[p.carrierName, p.lineOfBusiness].filter(Boolean).join(" — ") || "prior carrier"}`
      }
      removeMessage={(p) =>
        `Remove ${[p.carrierName, p.lineOfBusiness].filter(Boolean).join(" — ") || "this row"}?`
      }
      addFields={<PriorCarrierFields form={child.addForm} onEnter={child.add} />}
      editFields={<PriorCarrierFields form={child.editForm} />}
    />
  );
}

function toWrite(form: PriorCarrierForm) {
  return {
    lineOfBusiness: str(form.lineOfBusiness),
    carrierName: str(form.carrierName),
    policyNumber: str(form.policyNumber),
    premium: num(form.premium),
    effectiveDate: str(form.effectiveDate),
    expirationDate: str(form.expirationDate),
    // Recomputed on every write, not just the create — correcting a mistyped
    // policy number moves the policy, and a stale key would let the next
    // extraction file the corrected row a second time.
    extractionSourceKey: priorCarrierKey(form),
  };
}

function validate(form: PriorCarrierForm): string[] {
  return validateDateRange(
    form.effectiveDate,
    form.expirationDate,
    "Effective date",
    "expiration date"
  );
}

function PriorCarrierFields({
  form,
  onEnter,
}: {
  form: FormState<PriorCarrierForm>;
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
        <label>Line of business</label>
        <select
          value={form.form.lineOfBusiness}
          onChange={(e) => form.setF("lineOfBusiness", e.target.value)}
        >
          <option value="">—</option>
          {LINES_OF_BUSINESS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Carrier</label>
        <input
          placeholder="Travelers"
          value={form.form.carrierName}
          onChange={(e) => form.setF("carrierName", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Policy #</label>
        <input
          value={form.form.policyNumber}
          onChange={(e) => form.setF("policyNumber", e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Premium ($)</label>
        <MoneyInput
          value={form.form.premium}
          onChange={(v) => form.setF("premium", v)}
          onKeyDown={enter}
        />
      </div>
      <div className="field">
        <label>Effective</label>
        <DateInput
          value={form.form.effectiveDate}
          onChange={(v) => form.setF("effectiveDate", v)}
        />
      </div>
      <div className="field">
        <label>Expiration</label>
        <DateInput
          value={form.form.expirationDate}
          onChange={(v) => form.setF("expirationDate", v)}
        />
      </div>
    </>
  );
}
