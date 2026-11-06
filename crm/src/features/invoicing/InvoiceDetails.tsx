import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";
import { policyLabel } from './invoiceInputs';
import type { InvoiceEditorController } from './useInvoiceEditor';

type InvoiceDetailsState = Pick<
  InvoiceEditorController,
  | 'policy'
  | 'quote'
  | 'billWarning'
  | 'inputId'
  | 'invoiceDraft'
  | 'invoice'
  | 'locked'
  | 'actionBusy'
  | 'editInvoice'
  | 'saveEdits'
>;

export function InvoiceDetails({ editor }: { editor: InvoiceDetailsState }) {
  const {
    policy,
    quote,
    billWarning,
    inputId,
    invoiceDraft,
    invoice,
    locked,
    actionBusy,
    editInvoice,
    saveEdits,
  } = editor;
  return <>{/* ── Details ────────────────────────────────────────────────────── */}
    <div className="form-grid invoice-details">
      {/* Its own row. The warning below it is the loudest thing on this
            card and reads as four cramped lines in a third-width column. */}
      <div className="field full policy-field">
        <label>Bills</label>
        {/* W8: fixed at creation. Wrong anchor? Delete the draft and make
              a new one — re-pointing a bill is how two invoices land on one
              premium. */}
        <p style={{ margin: "4px 0 0" }}>
          {policy
            ? policyLabel(policy)
            : quote
              ? `Quote — ${(quote.lines ?? []).filter(Boolean).join(", ") || "coverage"}${quote.effectiveDate ? ` (${quote.effectiveDate})` : ""}`
              : "Nothing — this invoice predates anchored billing, and its lines bill more than one policy. Remove lines until one policy's remain (the invoice then bills that policy), or void this and bill each policy on its own invoice."}
        </p>
        {/* Three states, deliberately. The warning is the loud one and only
              fires when premium is actually billed; the quiet notes state the
              arrangement so it is known *before* a line is added rather than
              after. A policy with no bill type recorded says nothing — it was
              bound before the field existed and has no answer to give. */}
        {billWarning ? (
          <p className="warn-inline">{billWarning}</p>
        ) : policy?.billType === "DIRECT" ? (
          <p className="muted small">
            Direct bill — the carrier collects the premium.
          </p>
        ) : policy?.billType === "AGENCY" ? (
          <p className="muted small">Agency bill — we collect and remit.</p>
        ) : quote ? (
          <p className="muted small">
            Bills a quote — binding rolls this invoice (and any financing)
            onto the new policy.
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={inputId("issued")}>Issued</label>
        <Input
          id={inputId("issued")}
          type="date"
          value={Object.hasOwn(invoiceDraft, "issuedAt") ? invoiceDraft.issuedAt ?? "" : invoice.issuedAt ?? ""}
          disabled={locked || actionBusy}
          onChange={e => editInvoice({ issuedAt: e.target.value || null })}
          onBlur={() => void saveEdits()}
        />
      </div>
      <div className="field">
        <label htmlFor={inputId("due")}>Due</label>
        <Input
          id={inputId("due")}
          type="date"
          value={Object.hasOwn(invoiceDraft, "dueAt") ? invoiceDraft.dueAt ?? "" : invoice.dueAt ?? ""}
          disabled={locked || actionBusy}
          onChange={e => editInvoice({ dueAt: e.target.value || null })}
          onBlur={() => void saveEdits()}
        />
      </div>
      <div className="field full">
        <label htmlFor={inputId("memo")}>Memo</label>
        <Textarea
          id={inputId("memo")}
          rows={2}
          placeholder="Optional. Shown to the association above the total."
          value={Object.hasOwn(invoiceDraft, "memo") ? invoiceDraft.memo ?? "" : invoice.memo ?? ""}
          disabled={locked || actionBusy}
          onChange={e => editInvoice({ memo: e.target.value || null })}
          onBlur={() => void saveEdits()}
        />
      </div>
    </div></>;
}
