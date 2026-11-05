import {
  formatMoney,
  isPassThrough
} from "../../../../shared/invoiceTotals";
import ConfirmButton from "../../components/ConfirmButton";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Table } from "../../components/ui/Table";
import {
  type InvoiceLine
} from "../../lib/client";
import { policyLabel, toInput } from './invoiceInputs';
import type { InvoiceEditorController } from './useInvoiceEditor';

type InvoiceLinesTableState = Pick<
  InvoiceEditorController,
  | 'lines'
  | 'lineDrafts'
  | 'sourcePricing'
  | 'adjustment'
  | 'legacyPolicyCharges'
  | 'linesLocked'
  | 'actionBusy'
  | 'editLine'
  | 'saveEdits'
  | 'moneyInputs'
  | 'editMoney'
  | 'addLine'
  | 'removeLine'
  | 'totals'
  | 'issuedFee'
  | 'issuedPricing'
  | 'invoice'
  | 'policy'
  | 'addPremiumFromPolicy'
  | 'warnings'
>;

/**
 * One invoice: its lines, what they cost us, and the button that emails it.
 *
 * ── Cost is on this screen and on no other ──────────────────────────────────
 * The cost column is the point of the whole feature and is also the one thing
 * that must never reach the insured. It lives here, in the CRM, behind a login;
 * `send-invoice/invoice.ts` renders retail only and has a test saying so. The
 * table says which columns those are in a header spanning them, because a
 * producer reading a bill over the phone should never have to remember.
 *
 * ── Totals are recomputed, never read ───────────────────────────────────────
 * Every figure below comes from `invoiceTotals` over the current rows, the same
 * function the send Lambda runs server-side. There is no stored total to
 * disagree with, so the screen and the email cannot say different numbers.
 *
 * ── Order follows the job, not the record ───────────────────────────────────
 * Lines first, then dates, then send. The fields used to run in schema order —
 * issued, due, payment link, memo, and only then what was actually being
 * billed — which put four pieces of administrivia above the one question the
 * producer opened the invoice to answer. The payment link went with them: it is
 * generated automatically, so it belongs beside the send button as an override,
 * not at the top as a demand.
 */

const LINE_KINDS = [
  ["PREMIUM", "Premium"],
  ["ENDORSEMENT", "Endorsement"],
  ["TAX", "Tax"],
  ["SURPLUS_LINES", "Surplus lines"],
  ["STAMPING_FEE", "Stamping fee"],
  // All margin, and reported to accounting as its own kind of income rather
  // than as commission. Nothing charges it until in-house financing is offered.
  ["INTEREST", "Interest"],
  ["OTHER", "Other"],
] as const;

const SUPPLIER_LINE_KINDS = [
  ["CARRIER_FEE", "Carrier fee"], ["WHOLESALER_FEE", "Wholesaler fee"],
  ["TAX", "Tax"], ["SURPLUS_LINES", "Surplus lines tax"], ["STAMPING_FEE", "Stamping fee"],
] as const;

const ADJUSTMENT_LINE_KINDS = [["ENDORSEMENT", "Endorsement or audit adjustment"], ...SUPPLIER_LINE_KINDS] as const;
export function InvoiceLinesTable({ editor }: { editor: InvoiceLinesTableState }) {
  const {
    lines,
    lineDrafts,
    sourcePricing,
    adjustment,
    legacyPolicyCharges,
    linesLocked,
    actionBusy,
    editLine,
    saveEdits,
    moneyInputs,
    editMoney,
    addLine,
    removeLine,
    totals,
    issuedFee,
    issuedPricing,
    invoice,
    policy,
    addPremiumFromPolicy,
    warnings,
  } = editor;
  return <>{/* ── What is being billed ───────────────────────────────────────── */}
    <div className="table-wrap">
      <Table className="invoice-lines">
        <thead>
          {/* Two header rows so the split is visible without reading the
                column names: everything under "The association sees" is on the
                emailed invoice, everything under "Agency only" never is. */}
          <tr className="ui-table-group">
            <th colSpan={3}>The association sees</th>
            <th colSpan={2} className="ui-table-internal ui-table-band-start">
              Agency only
            </th>
            <th />
          </tr>
          <tr>
            <th>Description</th>
            <th className="kind-col">Kind</th>
            <th className="num">Amount</th>
            <th className="num ui-table-internal ui-table-band-start">Costs us</th>
            <th className="num ui-table-internal">Margin</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((savedLine) => {
            const l = { ...savedLine, ...lineDrafts[savedLine.id] };
            const retail = l.retailAmount ?? 0;
            const cost = l.costAmount ?? 0;
            const sourceLocked = l.kind === "BROKER_FEE" || !!l.sourceQuoteChargeId;
            const pricingLocked = sourceLocked || sourcePricing && l.kind === "PREMIUM";
            const manualPassThrough = (adjustment || sourcePricing && legacyPolicyCharges) && !l.sourceQuoteChargeId && isPassThrough(l.kind);
            /**
             * A cost with nothing billed against it has no margin yet — it
             * is unpriced, not loss-making. Rendering the arithmetic would
             * put a large red negative on every freshly seeded invoice,
             * which is alarming about a row whose amount box is simply still
             * empty. Same reasoning as `marginPct` being null on zero retail.
             */
            const margin = retail === 0 && cost > 0 ? null : retail - cost;
            return (
              <tr key={l.id}>
                <td>
                  <Input
                    aria-label="Description"
                    placeholder="What this line is for"
                    value={l.description ?? ""}
                    disabled={linesLocked || actionBusy || pricingLocked}
                    onChange={e => editLine(l.id, { description: e.target.value })}
                    onBlur={() => void saveEdits()}
                  />
                </td>
                <td className="kind-col">
                  <Select
                    aria-label="Kind"
                    value={l.kind ?? "PREMIUM"}
                    disabled={linesLocked || actionBusy || pricingLocked}
                    onChange={e => {
                      const kind = e.target.value as InvoiceLine["kind"];
                      editLine(l.id, {
                        kind, ...((adjustment || sourcePricing && legacyPolicyCharges) && isPassThrough(kind)
                          ? { retailAmount: l.retailAmount ?? 0, costAmount: l.retailAmount ?? 0 } : {})
                      });
                      void saveEdits();
                    }}
                  >
                    {l.kind === "BROKER_FEE" && <option value="BROKER_FEE">HOA broker fee · from quote</option>}
                    {l.sourceQuoteChargeId && <option value={l.kind!}>{l.kind?.replaceAll("_", " ")} · supplier/tax from quote</option>}
                    {!sourceLocked && (adjustment ? ADJUSTMENT_LINE_KINDS : manualPassThrough ? SUPPLIER_LINE_KINDS : LINE_KINDS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="num">
                  <Input
                    aria-label="Bills the association"
                    className="money"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={moneyInputs[`${l.id}:retailAmount`] ?? toInput(l.retailAmount)}
                    disabled={linesLocked || actionBusy || pricingLocked}
                    onChange={e => editMoney(l.id, "retailAmount", e.target.value)}
                    onBlur={() => void saveEdits()}
                  />
                </td>
                <td className="num ui-table-internal ui-table-band-start">
                  <Input
                    aria-label="Costs the agency"
                    className="money"
                    type="text"
                    inputMode="decimal"
                    placeholder={["PREMIUM", "ENDORSEMENT"].includes(l.kind ?? "") && l.costAmount == null ? "Actual supplier cost" : "0.00"}
                    value={moneyInputs[`${l.id}:costAmount`] ?? toInput(l.costAmount)}
                    disabled={linesLocked || actionBusy || sourceLocked || manualPassThrough}
                    onChange={e => editMoney(l.id, "costAmount", e.target.value)}
                    onBlur={() => void saveEdits()}
                  />
                </td>
                <td className="num ui-table-internal muted">
                  {margin === null ? "—" : formatMoney(margin)}
                </td>
                <td className="row-action">
                  {!linesLocked && (
                    <div className="row-tools">
                      {/* On the row rather than under the table, so a line
                            lands where it is wanted instead of at the bottom
                            and needing to be dragged up. */}
                      {!sourcePricing && <Button
                        type="button"
                        iconOnly controlSize="compact" className="icon-btn"
                        title="Add a line below this one"
                        aria-label="Add a line below this one"
                        disabled={actionBusy}
                        onClick={() => void addLine(undefined, l)}
                      >
                        +
                      </Button>}
                      <ConfirmButton
                        label="Remove"
                        busyLabel="Removing…"
                        variant="danger"
                        disabled={actionBusy || pricingLocked}
                        onConfirm={() => removeLine(l.id)}
                      />
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {lines.length === 0 && (
            <tr>
              <td colSpan={6} className="muted small">
                No lines yet. A new invoice opens with its anchor's premium
                line; add one by hand with the button below.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>Total</th>
            <th className="num total">{formatMoney(totals.retail)}</th>
            <th className="num ui-table-internal ui-table-band-start">{formatMoney(totals.cost)}</th>
            <th className="num ui-table-internal">
              {totals.retail === 0 && totals.cost > 0 ? (
                <span className="muted">—</span>
              ) : (
                <>
                  {formatMoney(totals.margin)}
                  {totals.marginPct !== null && (
                    <span className="muted"> ({totals.marginPct}%)</span>
                  )}
                </>
              )}
            </th>
            <th />
          </tr>
        </tfoot>
      </Table>
    </div>

    {(issuedFee || issuedPricing) && <p className="muted small">Void this invoice before changing its charges.</p>}
    {!linesLocked && (!sourcePricing || legacyPolicyCharges || adjustment) && (
      <div className="inline-actions">
        {/* Every other row is added with its own +. This is the way in when
              there is no row to press one on, and the way to append. */}
        <Button variant="secondary" type="button" disabled={actionBusy} onClick={() => void addLine(adjustment
          ? { kind: "ENDORSEMENT", description: "Endorsement or audit adjustment", retailAmount: null, costAmount: null, policyId: invoice.policyId! }
          : sourcePricing ? { kind: "TAX", description: "Supplier charge or tax", retailAmount: 0, costAmount: 0, policyId: invoice.policyId! } : undefined)}>
          {adjustment ? "Add adjustment line" : sourcePricing ? "Add supplier/tax line" : lines.length === 0 ? "Add line" : "Add line at the end"}
        </Button>
        {policy && !sourcePricing && (
          <Button variant="secondary"
            type="button"

            disabled={actionBusy}
            onClick={() => void addPremiumFromPolicy()}
          >
            Add premium from {policyLabel(policy)}
          </Button>
        )}
      </div>
    )}
    {!linesLocked && sourcePricing && legacyPolicyCharges && <p className="small muted">This older policy has no recorded supplier charges. Add only actual carrier or wholesaler fees and taxes. Each amount is billed at the same cost, with no agency markup; the gross premium stays fixed.</p>}
    {adjustment && <p className="small muted">Endorsement or audit adjustment: enter only the change and its actual supplier remittance. Original premium, supplier charges and HOA broker fees are not billed again. Supplier fees and taxes pass through at cost.</p>}

    {warnings.length > 0 && (
      <ul className="warn-list">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    )}</>;
}
