import { brokerFeeCents } from '../../../shared/brokerFees';

export interface ReportBrokerFeePolicy {
  id: string;
  accountId: string;
  brokerFee?: number | null;
  brokerFeeCollected?: number | null;
  brokerFeeRefunded?: number | null;
  status?: string | null;
}

/** Policy aggregates contain confirmed lifetime receipts and refunds. A refund
 * reduces earned revenue, not the amount due, so it never recreates a charge. */
export function brokerFeeBalances(policies: readonly ReportBrokerFeePolicy[]) {
  let booked = 0, collected = 0, refunded = 0, uncollected = 0;
  const seen = new Set<string>();
  for (const policy of policies) {
    if (seen.has(policy.id)) throw new Error('Broker fee policies were repeated. Refresh the report.');
    seen.add(policy.id);
    const fee = brokerFeeCents(policy.brokerFee), received = brokerFeeCents(policy.brokerFeeCollected), returned = brokerFeeCents(policy.brokerFeeRefunded);
    if (returned > received || returned > fee || received > fee) throw new Error('Broker fee receipts need reconciliation before this report can be completed.');
    booked += fee; collected += received; refunded += returned;
    uncollected += Math.max(0, fee - received);
  }
  if (![booked, collected, refunded, uncollected].every(Number.isSafeInteger)) throw new Error('Broker fee totals are too large to report accurately.');
  return { booked: booked / 100, grossCollected: collected / 100, refunded: refunded / 100,
    netCollected: (collected - refunded) / 100, netRevenue: (booked - refunded) / 100, uncollected: uncollected / 100, count: policies.length };
}
