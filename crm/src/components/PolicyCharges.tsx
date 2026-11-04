import { normalizePassThroughCharges } from "../../../shared/passThroughCharges";
import { formatMoney } from "../lib/invoiceTotals";

/** Client charges stay separate from base premium and agency revenue. */
export default function PolicyCharges({ source }: { source: { premium?: number | null; brokerFee?: number | null; passThroughCharges?: unknown } }) {
  const charges = normalizePassThroughCharges(source.passThroughCharges);
  if (!charges.length && !(source.brokerFee && source.brokerFee > 0)) return null;
  return <div className="small muted">
    {charges.map(charge => <div key={charge.id}>{charge.description}: {formatMoney(charge.amountCents / 100)}</div>)}
    {(source.brokerFee ?? 0) > 0 && <div>HOA broker fee: {formatMoney(source.brokerFee)}</div>}
    <div><strong>{formatMoney((source.premium ?? 0) + charges.reduce((sum, charge) => sum + charge.amountCents / 100, 0) + (source.brokerFee ?? 0))} client policy total</strong></div>
  </div>;
}
