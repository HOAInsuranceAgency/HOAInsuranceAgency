import ConfirmButton from "../../components/ConfirmButton";
import { SaveStatus } from "../../components/SaveStatus";
import { Button } from "../../components/ui/Button";
import { Badge, INVOICE_STATUS_BADGE, statusBadge } from "../../lib/badges";
import type { InvoiceEditorController } from './useInvoiceEditor';

type InvoiceHeaderState = Pick<
  InvoiceEditorController,
  | 'invoice'
  | 'saveStatus'
  | 'dirty'
  | 'pending'
  | 'saveEdits'
  | 'locked'
  | 'actionBusy'
  | 'voidThis'
  | 'canRestoreGroup'
  | 'restoreGroupedDraft'
  | 'lines'
  | 'sourcePricing'
  | 'issuedFee'
  | 'deleteThis'
>;

export function InvoiceHeader({ editor }: { editor: InvoiceHeaderState }) {
  const {
    invoice,
    saveStatus,
    dirty,
    pending,
    saveEdits,
    locked,
    actionBusy,
    voidThis,
    canRestoreGroup,
    restoreGroupedDraft,
    lines,
    sourcePricing,
    issuedFee,
    deleteThis,
  } = editor;
  return <><div className="card-head">
    <h2 className="invoice-title">
      {invoice.number ?? "Invoice"}
      <Badge {...statusBadge(INVOICE_STATUS_BADGE, invoice.status)} />
    </h2>
    <div className="inline-actions">
      <SaveStatus {...saveStatus.status} />
      {dirty && <Button type="button" disabled={pending > 0} onClick={() => void saveEdits()}>Save changes</Button>}
      {canRestoreGroup && <ConfirmButton
        label="Restore separate drafts"
        confirmLabel="Restore drafts"
        busyLabel="Restoring drafts…"
        variant="secondary"
        message="This closes the combined draft and restores the original drafts."
        disabled={actionBusy}
        onConfirm={restoreGroupedDraft}
      />}
      {/* Voided, not deleted: the number must never be reused, and a gap in
              the sequence is explainable in a way a reissue is not. */}
      {/* Not offered while a debit is clearing: an in-flight ACH cannot be
              un-collected, so the server refuses anyway — see void-invoice.
              The PROCESSING hint below the table says what to wait for. */}
      {!locked && invoice.status !== "PROCESSING" && (
        <ConfirmButton
          label="Void"
          busyLabel="Voiding…"
          variant="danger"
          message="The number is retired, and the payment link is closed."
          disabled={actionBusy}
          onConfirm={() => voidThis()}
        />
      )}
      {locked && lines.length === 0 && !sourcePricing && !issuedFee && (
        <ConfirmButton
          label="Delete"
          busyLabel="Deleting…"
          variant="danger"
          message="It is void and has no lines."
          disabled={actionBusy}
          onConfirm={deleteThis}
        />
      )}
    </div>
  </div></>;
}
