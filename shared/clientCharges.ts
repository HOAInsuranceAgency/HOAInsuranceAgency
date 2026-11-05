import { brokerFeeCents } from './brokerFees';
import { passThroughTotalCents } from './passThroughCharges';

/** Premium/HOA fee are dollars; supplier charges retain their recorded cents. */
export interface ClientChargeSource {
  premium?: number | null;
  brokerFee?: number | null;
  passThroughCharges?: unknown;
}

/** Client-facing amounts only. Supplier remittance and agency earnings are separate. */
export interface ClientChargeBreakdown {
  premiumCents: number;
  passThroughCents: number;
  brokerFeeCents: number;
  clientTotalCents: number;
}

function safeCents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The quoted client charges exceed the supported amount.');
  return value;
}

/** Round each recorded policy premium once before adding any fees or taxes. */
export function clientChargeBreakdown(source: ClientChargeSource): ClientChargeBreakdown {
  const premium = source.premium ?? 0;
  if (typeof premium !== 'number' || !Number.isFinite(premium) || premium < 0) throw new Error('Record a valid client premium.');
  const premiumCents = safeCents(Math.round(premium * 100));
  const passThroughCents = passThroughTotalCents(source.passThroughCharges);
  const feeCents = brokerFeeCents(source.brokerFee);
  return {
    premiumCents,
    passThroughCents,
    brokerFeeCents: feeCents,
    clientTotalCents: safeCents(premiumCents + passThroughCents + feeCents),
  };
}

/** Aggregate policy breakdowns; never round a package's combined dollar amount. */
export function clientChargeTotals(sources: readonly ClientChargeSource[]): ClientChargeBreakdown {
  return sources.reduce<ClientChargeBreakdown>((total, source) => {
    const next = clientChargeBreakdown(source);
    return {
      premiumCents: safeCents(total.premiumCents + next.premiumCents),
      passThroughCents: safeCents(total.passThroughCents + next.passThroughCents),
      brokerFeeCents: safeCents(total.brokerFeeCents + next.brokerFeeCents),
      clientTotalCents: safeCents(total.clientTotalCents + next.clientTotalCents),
    };
  }, { premiumCents: 0, passThroughCents: 0, brokerFeeCents: 0, clientTotalCents: 0 });
}
