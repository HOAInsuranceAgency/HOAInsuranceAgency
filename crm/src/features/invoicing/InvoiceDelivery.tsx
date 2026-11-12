import {
  financeableInvoiceTotal
} from "../../../../shared/invoiceTotals";
import { FinanceOfferHint } from "../../components/FinanceOfferHint";
import { SaveStatus } from "../../components/SaveStatus";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import type { InvoiceEditorController } from './useInvoiceEditor';

type InvoiceDeliveryState = Pick<
  InvoiceEditorController,
  | 'locked'
  | 'inputId'
  | 'withEmail'
  | 'toIds'
  | 'actionBusy'
  | 'setToIds'
  | 'adjustment'
  | 'totals'
  | 'account'
  | 'policy'
  | 'quote'
  | 'lines'
  | 'toEmails'
  | 'needsRemittanceCost'
  | 'needsSupplierAmount'
  | 'adjustmentError'
  | 'send'
  | 'invoice'
  | 'sendStatus'
  | 'markPaid'
>;

export function InvoiceSentDetails({ invoice }: { invoice: InvoiceDeliveryState['invoice'] }) {
  if (!invoice.sentAt) return null;
  return <p className="muted small">
    Last sent {new Date(invoice.sentAt).toLocaleString()}
    {invoice.sentTo ? ` to ${invoice.sentTo}` : ""}
  </p>;
}

export function InvoiceDelivery({ editor, financeOnly = false }: { editor: InvoiceDeliveryState; financeOnly?: boolean }) {
  const {
    locked,
    inputId,
    withEmail,
    toIds,
    actionBusy,
    setToIds,
    adjustment,
    totals,
    account,
    policy,
    quote,
    lines,
    toEmails,
    needsRemittanceCost,
    needsSupplierAmount,
    adjustmentError,
    send,
    invoice,
    sendStatus,
    markPaid,
  } = editor;
  return <>{/* ── Send ───────────────────────────────────────────────────────── */}
    {(!locked || financeOnly) && (
      <div className={financeOnly ? undefined : "card inset"}>
        <h3>Send</h3>
        <div className="field">
          <label htmlFor={inputId("to")}>Send to</label>
          {withEmail.length === 0 ? (
            <p className="warn-inline">
              No contact on this account has an email address. Add one on the
              Overview tab before sending.
            </p>
          ) : (
            <>
              {/* A checkbox each rather than a multiple <select>: an invoice
                    usually goes to two or three people — a manager and a
                    treasurer — and a ctrl-click list hides who is selected
                    behind a scrollbar, on the one field where being wrong
                    means the bill silently never arrives. */}
              <ul className="check-list" id={inputId("to")}>
                {withEmail.map((c) => (
                  <li key={c.id}>
                    <label>
                      <Input
                        type="checkbox"
                        checked={toIds.includes(c.id)}
                        disabled={actionBusy}
                        onChange={(e) =>
                          setToIds((ids) =>
                            e.target.checked
                              ? [...ids, c.id]
                              : ids.filter((id) => id !== c.id)
                          )
                        }
                      />
                      <span>
                        {c.name}
                        {c.isPrimary && <span className="badge gray">Primary</span>}
                        <span className="muted small">{c.email}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {financeOnly ? <p className="muted small">The email includes the invoice PDF and a link to review and accept financing.</p> : <p className="muted small">
          The agency is copied on every invoice, so a sent copy is findable
          without opening the CRM. A branded PDF is attached automatically,
          {adjustment && totals.retail <= 0 ? " with no payment link for a credit or zero-balance statement." : " and a Stripe bank-transfer link is generated when it sends."}
        </p>}
        {!financeOnly && !adjustment && account && (policy || quote) && (
          <FinanceOfferHint
            account={account}
            anchor={
              policy
                ? {
                  kind: "policy",
                  id: policy.id,
                  lines: policy.lines ?? [],
                  coverageEffectiveDate: policy.effectiveDate,
                }
                : {
                  kind: "quote",
                  id: quote!.id,
                  lines: quote!.lines ?? [],
                  coverageEffectiveDate: quote!.effectiveDate,
                }
            }
            retailTotal={financeableInvoiceTotal(lines)}
            brokerFee={lines.filter(line => line.kind === "BROKER_FEE").reduce((total, line) => total + (line.retailAmount ?? 0), 0)}
          />
        )}

        <div className="inline-actions">
          <Button variant="primary"
            type="button"

            disabled={actionBusy || lines.length === 0 || toEmails.length === 0 || needsRemittanceCost || needsSupplierAmount || !!adjustmentError}
            onClick={() => void send()}
          >
            {invoice.sentAt ? "Send again" : "Send invoice"}
          </Button>
          <SaveStatus {...sendStatus.status} />
        </div>
        {needsRemittanceCost && <p className="error-text">Enter actual carrier/wholesaler remittance cost in the cost cell before sending. Enter 0 only when the reviewed supplier amount is zero.</p>}
        {needsSupplierAmount && <p className="error-text">Enter a positive supplier or tax amount in whole cents, or remove the unused line before sending.</p>}
        {adjustmentError && <p className="error-text">{adjustmentError}</p>}
        {lines.length === 0 && (
          <p className="muted small">Add a line before sending.</p>
        )}
        {withEmail.length > 0 && toEmails.length === 0 && (
          <p className="muted small">Choose at least one recipient.</p>
        )}
        <InvoiceSentDetails invoice={invoice} />
      </div>
    )}

    {adjustment && invoice.status === "SENT" && totals.retail <= 0 && <p className="muted small" role="status">
      {totals.retail < 0 ? "Credit statement" : "Zero-balance statement"}: no incoming payment is due. This remains sent as the statement record.
    </p>}
    {!financeOnly && (invoice.status === "SENT" || invoice.status === "PROCESSING") && !(adjustment && totals.retail <= 0) && (
      <div className="inline-actions">
        <Button variant="secondary"
          type="button"

          disabled={actionBusy}
          onClick={() => void markPaid()}
        >
          Mark paid
        </Button>
        {invoice.status === "PROCESSING" && (
          <p className="muted small">
            A bank transfer has been authorised and is clearing. Stripe marks
            this paid when the money lands; the button is for a cheque that
            arrived another way.
          </p>
        )}
      </div>
    )}</>;
}
