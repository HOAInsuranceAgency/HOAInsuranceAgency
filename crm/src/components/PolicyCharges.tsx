import { normalizePassThroughCharges } from "../../../shared/passThroughCharges";
import { clientChargeBreakdown } from "../../../shared/clientCharges";
import { formatMoney } from "../../../shared/invoiceTotals";

/** Client charges stay separate from base premium and agency revenue. */
export default function PolicyCharges({ source }: { source: { premium?: number | null; brokerFee?: number | null; passThroughCharges?: unknown } }) {
  let charges, total;
  try {
    charges = normalizePassThroughCharges(source.passThroughCharges);
    total = clientChargeBreakdown(source);
  } catch {
    return <div className="small error-text">Review the recorded client charges.</div>;
  }
  if (!charges.length && !(source.brokerFee && source.brokerFee > 0)) return null;
  return <div className="small muted">
    {charges.map(charge => <div key={charge.id}>{charge.description}: {formatMoney(charge.amountCents / 100)}</div>)}
    {(source.brokerFee ?? 0) > 0 && <div>HOA broker fee: {formatMoney(source.brokerFee)}</div>}
    <div><strong>{formatMoney(total.clientTotalCents / 100)} client policy total</strong></div>
  </div>;
}
