import { useState } from "react";
import {
  client,
  friendlyError,
  LINES_OF_BUSINESS,
  type Carrier,
  type Policy,
  type Quote,
} from "../lib/client";
import { useFormState } from "../lib/useFormState";
import { currentActor } from "../lib/client";
import { SELECTABLE_QUOTE_STATUSES } from "../lib/quoteStatus";
import {
  AGGREGATE_APPLIES_TO_OPTIONS,
  BILL_TYPE_OPTIONS,
  POLICY_STATUSES,
  REPLACEMENT_COST_OPTIONS,
} from "../lib/enums";
import { DateInput, MoneyInput, PercentInput } from "./inputs";

/**
 * Shared create/edit form for quotes and policies.
 *
 * A Policy is a Quote plus a policy number and a different status set, so
 * both use one form — otherwise the two field lists drift apart every time a
 * term is added. Quotes can be created here; policies only ever come into
 * existence by binding a quote, so policy mode is edit-only.
 */

const num = (v: string) => (v.trim() === "" ? null : Number(v));
// Read side: column value → input string, seeding the form below. This runs
// the opposite way from `formCodec`'s same-named `str` (input → column);
// adopting that codec is a separate migration.
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

export default function CoverageForm({
  kind,
  accountId,
  carriers,
  existing,
  onSaved,
  onCancel,
}: {
  kind: "quote" | "policy";
  accountId: string;
  carriers: Carrier[];
  existing: Quote | Policy | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isPolicy = kind === "policy";
  const editing = !!existing;
  const asPolicy = existing as Policy | null;

  const { form, setF, patch } = useFormState({
    carrierId: existing?.carrierId ?? "",
    policyNumber: asPolicy?.policyNumber ?? "",
    billType: asPolicy?.billType ?? "",
    // W8: quotes carry the financing-eligibility facts too — pre-bind
    // billing reads them there, and bind carries them onto the policy.
    // (Auditable retired 2026-08-24 — "everything we do is final once
    // entered" — so the form no longer asks or writes it.)
    producerOfRecord: existing?.producerOfRecord ?? null,
    mepPct: str(existing?.minimumEarnedPremiumPct),
    status: (existing?.status ?? (isPolicy ? "ACTIVE" : "DRAFT")) as string,
    lines: (existing?.lines ?? []).filter((l): l is string => !!l),
    premium: str(existing?.premium),
    commissionPct: str(existing?.commissionPct),
    perOccDed: str(existing?.perOccurrenceDeductible),
    perUnitDed: str(existing?.perUnitDeductible),
    blanketLimit: str(existing?.blanketLimit),
    coinsurance: str(existing?.coinsurancePct),
    rcType: existing?.replacementCostType ?? "",
    // GL limits — these are what actually print on a certificate.
    glEachOcc: str(existing?.glEachOccurrence),
    glRented: str(existing?.glDamageToRentedPremises),
    glMed: str(existing?.glMedicalExpense),
    glPersAdv: str(existing?.glPersonalAdvInjury),
    glGenAgg: str(existing?.glGeneralAggregate),
    glProdAgg: str(existing?.glProductsCompletedOps),
    glClaimsMade: !!existing?.glClaimsMade,
    glAggApplies: existing?.glAggregateAppliesTo ?? "POLICY",
    effectiveDate: existing?.effectiveDate ?? "",
    expirationDate: existing?.expirationDate ?? "",
    notes: existing?.notes ?? "",
  });
  // Only autofill the carrier's standard rate on an untouched new quote —
  // never clobber a rate already negotiated on an existing record.
  //
  // Deliberately *not* a field of `form`: it is interaction history, not a
  // value. Deriving it from the form (current ≠ initial) would re-arm the
  // autofill the moment someone typed the standard rate back by hand.
  const [commissionTouched, setCommissionTouched] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function toggleLine(line: string) {
    setF("lines", (ls) =>
      ls.includes(line) ? ls.filter((l) => l !== line) : [...ls, line]
    );
  }

  function pickCarrier(id: string) {
    if (commissionTouched) {
      setF("carrierId", id);
      return;
    }
    const std = carriers.find((c) => c.id === id)?.standardCommissionPct;
    patch({ carrierId: id, commissionPct: std != null ? String(std) : "" });
  }

  async function save() {
    if (
      form.effectiveDate &&
      form.expirationDate &&
      form.effectiveDate > form.expirationDate
    ) {
      setError("Effective date can't be after the expiration date.");
      return;
    }
    setSaving(true);
    setError("");

    const shared = {
      carrierId: form.carrierId || null,
      lines: form.lines,
      premium: num(form.premium),
      commissionPct: num(form.commissionPct),
      perOccurrenceDeductible: num(form.perOccDed),
      perUnitDeductible: num(form.perUnitDed),
      blanketLimit: num(form.blanketLimit),
      coinsurancePct: num(form.coinsurance),
      replacementCostType: (form.rcType || null) as Quote["replacementCostType"],
      glEachOccurrence: num(form.glEachOcc),
      glDamageToRentedPremises: num(form.glRented),
      glMedicalExpense: num(form.glMed),
      glPersonalAdvInjury: num(form.glPersAdv),
      glGeneralAggregate: num(form.glGenAgg),
      glProductsCompletedOps: num(form.glProdAgg),
      glClaimsMade: form.glClaimsMade,
      glAggregateAppliesTo: form.glAggApplies as Quote["glAggregateAppliesTo"],
      effectiveDate: form.effectiveDate || null,
      expirationDate: form.expirationDate || null,
      notes: form.notes.trim() || null,
    };

    try {
      if (isPolicy) {
        if (!existing) throw new Error("Policies are created by binding a quote.");
        const { errors } = await client.models.Policy.update({
          id: existing.id,
          ...shared,
          policyNumber: form.policyNumber.trim() || null,
          status: form.status as Policy["status"],
          // Nullable on the way back out: a policy bound before this field
          // existed opens with the box empty, and saving other edits must not
          // invent an answer for it.
          billType: (form.billType || null) as Policy["billType"],
          /**
           * The financing-eligibility facts. Tri-state on purpose: null is
           * "nobody has answered", and financing blocks on it — so an edit
           * that never touched these must not turn null into false. The
           * producer-of-record stamps are written only on the transition to
           * true, by whoever ticked it.
           */
          minimumEarnedPremiumPct: form.mepPct.trim() === "" ? null : Number(form.mepPct),
          producerOfRecord: form.producerOfRecord,
          ...(form.producerOfRecord === true && asPolicy?.producerOfRecord !== true
            ? {
                producerOfRecordBy: (await currentActor()) ?? "unknown",
                producerOfRecordAt: new Date().toISOString(),
              }
            : {}),
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else if (existing) {
        const { errors } = await client.models.Quote.update({
          id: existing.id,
          ...shared,
          status: form.status as Quote["status"],
          // Same tri-state discipline as the policy branch: null means
          // "nobody has answered", and financing blocks on it.
          minimumEarnedPremiumPct: form.mepPct.trim() === "" ? null : Number(form.mepPct),
          producerOfRecord: form.producerOfRecord,
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.Quote.create({
          accountId,
          ...shared,
          status: form.status as Quote["status"],
          minimumEarnedPremiumPct: form.mepPct.trim() === "" ? null : Number(form.mepPct),
          producerOfRecord: form.producerOfRecord,
        });
        if (errors?.length) throw new Error(errors[0].message);
      }
      onSaved();
    } catch (err) {
      setError(friendlyError(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  // A bound quote's status is owned by the policy — don't offer to unwind it
  // from here, but don't hide it either.
  const statusOptions = isPolicy
    ? [...POLICY_STATUSES]
    : existing?.status === "BOUND"
      ? ["BOUND"]
      : [...SELECTABLE_QUOTE_STATUSES];

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <h3 style={{ marginTop: 0 }}>
        {editing ? "Edit" : "New"} {isPolicy ? "policy" : "quote"}
      </h3>
      <div className="form-grid">
        <div className="field">
          <label>Carrier</label>
          <select value={form.carrierId} onChange={(e) => pickCarrier(e.target.value)}>
            <option value="">—</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {isPolicy && (
          <div className="field">
            <label>Policy number</label>
            <input
              value={form.policyNumber}
              onChange={(e) => setF("policyNumber", e.target.value)}
            />
          </div>
        )}
        {/* The financing-eligibility facts, on quotes and policies alike:
            W8 bills — and offers financing on — a quote before bind, so the
            screens must be answerable where the offer is made. */}
        {(
          <>
            <div className="field">
              <label>Minimum earned premium % (from the {isPolicy ? "policy" : "quote"})</label>
              <PercentInput
                value={form.mepPct}
                onChange={(v) => setF("mepPct", v)}
              />
            </div>
            <div className="field">
              <label>Producer of record</label>
              <select
                value={
                  form.producerOfRecord === null
                    ? ""
                    : form.producerOfRecord
                      ? "yes"
                      : "no"
                }
                onChange={(e) =>
                  setF(
                    "producerOfRecord",
                    e.target.value === "" ? null : e.target.value === "yes"
                  )
                }
              >
                <option value="">Not confirmed</option>
                <option value="yes">Yes — we are the producer of record</option>
                <option value="no">No — another agency's paper</option>
              </select>
            </div>
          </>
        )}
        {/* Set at bind and correctable here — a placement can move from direct
            to agency bill mid-term, and the answer decides whether the agency
            invoices the premium at all. */}
        {isPolicy && (
          <div className="field">
            <label>Bill type</label>
            <select
              value={form.billType}
              onChange={(e) => setF("billType", e.target.value)}
            >
              <option value="">Not recorded</option>
              {BILL_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>Status</label>
          <select
            value={form.status}
            onChange={(e) => setF("status", e.target.value)}
            disabled={statusOptions.length === 1}
          >
            {[...statusOptions].sort((a, b) => a.localeCompare(b)).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Premium ($)</label>
          <MoneyInput
            value={form.premium}
            onChange={(v) => setF("premium", v)}
          />
        </div>
        <div className="field">
          <label>Commission % (baked into premium)</label>
          <PercentInput
            value={form.commissionPct}
            onChange={(v) => {
              setCommissionTouched(true);
              setF("commissionPct", v);
            }}
          />
        </div>
        <div className="field">
          <label>Effective date</label>
          <DateInput
            value={form.effectiveDate}
            onChange={(v) => setF("effectiveDate", v)}
          />
        </div>
        <div className="field">
          <label>Expiration date</label>
          <DateInput
            value={form.expirationDate}
            onChange={(v) => setF("expirationDate", v)}
          />
        </div>
        <div className="field">
          <label>Per-occurrence deductible ($)</label>
          <MoneyInput
            value={form.perOccDed}
            onChange={(v) => setF("perOccDed", v)}
          />
        </div>
        <div className="field">
          <label>Per-unit deductible ($)</label>
          <MoneyInput
            value={form.perUnitDed}
            onChange={(v) => setF("perUnitDed", v)}
          />
        </div>
        <div className="field">
          <label>Blanket limit ($)</label>
          <MoneyInput
            value={form.blanketLimit}
            onChange={(v) => setF("blanketLimit", v)}
          />
        </div>
        <div className="field">
          <label>Coinsurance %</label>
          <PercentInput
            value={form.coinsurance}
            onChange={(v) => setF("coinsurance", v)}
          />
        </div>
        <div className="field">
          <label>Replacement cost</label>
          <select value={form.rcType} onChange={(e) => setF("rcType", e.target.value)}>
            <option value="">—</option>
            {REPLACEMENT_COST_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field full">
          <h4 style={{ margin: "6px 0 0" }}>General liability limits</h4>
          <p className="muted small" style={{ margin: "2px 0 0" }}>
            These print on the certificate of insurance. A COI without limits
            is of no use to the holder.
          </p>
        </div>
        <div className="field">
          <label>Each occurrence ($)</label>
          <MoneyInput value={form.glEachOcc} onChange={(v) => setF("glEachOcc", v)} />
        </div>
        <div className="field">
          <label>Damage to rented premises ($)</label>
          <MoneyInput value={form.glRented} onChange={(v) => setF("glRented", v)} />
        </div>
        <div className="field">
          <label>Medical expense, any one person ($)</label>
          <MoneyInput value={form.glMed} onChange={(v) => setF("glMed", v)} />
        </div>
        <div className="field">
          <label>Personal &amp; advertising injury ($)</label>
          <MoneyInput value={form.glPersAdv} onChange={(v) => setF("glPersAdv", v)} />
        </div>
        <div className="field">
          <label>General aggregate ($)</label>
          <MoneyInput value={form.glGenAgg} onChange={(v) => setF("glGenAgg", v)} />
        </div>
        <div className="field">
          <label>Products &amp; completed ops aggregate ($)</label>
          <MoneyInput value={form.glProdAgg} onChange={(v) => setF("glProdAgg", v)} />
        </div>
        <div className="field">
          <label>Aggregate applies per</label>
          <select value={form.glAggApplies} onChange={(e) => setF("glAggApplies", e.target.value as typeof form.glAggApplies)}>
            {AGGREGATE_APPLIES_TO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Coverage form</label>
          <label className="small" style={{ display: "flex", gap: 6, alignItems: "center", height: 38 }}>
            <input
              type="checkbox"
              checked={form.glClaimsMade}
              onChange={(e) => setF("glClaimsMade", e.target.checked)}
            />
            Claims made (otherwise occurrence)
          </label>
        </div>
        <div className="field full">
          <label>Lines</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {/* Vocabulary first, then any legacy value this record carries
                that the vocabulary no longer names (bare "Property",
                pre-rename spellings) — a value with no checkbox would be
                stuck checked forever, invisible and unremovable. */}
            {[...new Set([...LINES_OF_BUSINESS, ...form.lines])].map((l) => (
              <label
                key={l}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={form.lines.includes(l)}
                  onChange={() => toggleLine(l)}
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={2} value={form.notes} onChange={(e) => setF("notes", e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : editing ? "Save changes" : "Save quote"}
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
