/** Commission contracts and arithmetic. All ledger amounts are integer USD cents.
 * These records are private; never place them on shared Policy/UserProfile rows. */
export type CommissionBasis = 'WRITTEN' | 'EARNED' | 'COLLECTED';
export const COMMISSION_BASES: Record<CommissionBasis, string> = {
  WRITTEN: 'Written premium',
  EARNED: 'Earned premium',
  COLLECTED: 'Collected premium / installments',
};
export interface CommissionPlan {
  id: string;
  version: number;
  producerId: string;
  name: string;
  terms: { from: string; to?: string; newBps: number; renewalBps: number; agreement: string }[];
}
export interface CarrierCommissionTerms {
  id: string;
  version: number;
  name: string;
  basis: CommissionBasis;
  schedule: string;
  evidence: string;
}
export interface CommissionEntry {
  id: string;
  statementId: string;
  lineRef: string;
  receivedOn: string;
  kind: 'RECEIPT' | 'REVERSAL' | 'RESTORATION';
  agencyCents: number;
  producerCents: number;
  originalId?: string;
  eligibilityNote: string;
  eligible: boolean;
  batchId?: string;
}
export interface CommissionPolicy {
  id: string;
  version: number;
  accountId: string;
  accountName: string;
  quoteId: string;
  policyNumber: string;
  carrierId: string;
  carrierName: string;
  producerId: string;
  producerName: string;
  boundAt: string;
  effectiveDate: string;
  expirationDate: string;
  transaction: 'NEW' | 'RENEWAL';
  premiumCents: number;
  agencyRateUnits: number;
  producerBps: number;
  agreement: string;
  planVersion: number;
  carrierTerms: CarrierCommissionTerms;
  entries: CommissionEntry[];
}
export interface StatementLine {
  reportedPremiumCents?: number;
  reportedRateUnits?: number;
  policyId: string;
  lineRef: string;
  kind: CommissionEntry['kind'];
  agencyCents: number;
  originalId?: string;
  eligible: boolean;
  eligibilityNote: string;
}
export interface CommissionStatement {
  id: string;
  version: number;
  carrierId: string;
  reference: string;
  source: string;
  receivedOn: string;
  settlementRef: string;
  settlementType: 'DEPOSIT' | 'RETAINED' | 'NET_SETTLEMENT';
  totalCents: number;
  lines: StatementLine[];
  status: 'DRAFT' | 'POSTED';
  postedAt?: string;
  postedBy?: string;
}
export interface CommissionBatch {
  id: string;
  version: number;
  producerId: string;
  producerName: string;
  cutoff: string;
  payDate: string;
  status: 'APPROVED' | 'PAID' | 'CANCELLED';
  reference?: string;
  totalCents: number;
  lines: {
    policyId: string;
    entryId: string;
    accountName: string;
    policyNumber: string;
    agencyCents: number;
    producerBps: number;
    amountCents: number;
  }[];
}
export interface CommissionOverview {
  plans: CommissionPlan[];
  carriers: CarrierCommissionTerms[];
  policies: CommissionPolicy[];
  statements: CommissionStatement[];
  batches: CommissionBatch[];
}
export function day(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error('Enter a valid calendar date.');
  return value;
}
export function required(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`Enter ${label}.`);
  return value.trim();
}
export function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Enter a valid ${label}.`);
  return value;
}
/** Accept a decimal string without floating-point rounding or truncation. */
export function decimal(value: string, places = 2): number {
  if (!new RegExp(`^-?\\d+(?:\\.\\d{1,${places}})?$`).test(value.trim()))
    throw new Error(`Enter a number with at most ${places} decimal places.`);
  const negative = value.trim().startsWith('-'),
    [whole, fraction = ''] = value.trim().replace('-', '').split('.');
  const n = Number(BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0')));
  if (!Number.isSafeInteger(n)) throw new Error('Amount is too large.');
  return negative ? -n : n;
}
export const MONEY_MAX = 100_000_000_000; // $1 billion per item; arithmetic below also checks sums.
export function ratio(amount: number, rate: number, scale: number): number {
  const value = Number((BigInt(amount) * BigInt(rate) + BigInt(scale) / 2n) / BigInt(scale));
  if (!Number.isSafeInteger(value)) throw new Error('Amount is too large.');
  return value;
}
export function sum(values: number[]): number {
  const value = Number(values.reduce((total, n) => total + BigInt(n), 0n));
  if (!Number.isSafeInteger(value)) throw new Error('Total is too large.');
  return value;
}
export function validatePlan(plan: CommissionPlan): CommissionPlan {
  required(plan.producerId, 'a producer', 128);
  required(plan.name, 'a producer name', 200);
  if (!Array.isArray(plan.terms) || !plan.terms.length || plan.terms.length > 100)
    throw new Error('Enter between 1 and 100 agreement periods.');
  const terms = plan.terms
    .map((t) => ({
      from: day(t.from),
      ...(t.to ? { to: day(t.to) } : {}),
      newBps: integer(t.newBps, 0, 10000, 'new-business rate'),
      renewalBps: integer(t.renewalBps, 0, 10000, 'renewal rate'),
      agreement: required(t.agreement, 'an agreement reference'),
    }))
    .sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 0; i < terms.length; i++)
    if (
      (terms[i].to && terms[i].to! < terms[i].from) ||
      (i && (!terms[i - 1].to || terms[i].from <= terms[i - 1].to!))
    )
      throw new Error('Agreement periods must not overlap or end before they start.');
  return { ...plan, terms };
}
/** Append, never rewrite posted history. Negative producer amounts are proposed
 * recoveries only; they do not reduce unpaid wages or enter payroll batches. */
export function appendEntry(
  policy: CommissionPolicy,
  line: StatementLine,
  statement: CommissionStatement,
  entryId: string,
): CommissionPolicy {
  if (policy.entries.length >= 500)
    throw new Error('This policy history needs archival before more entries can be posted.');
  integer(line.agencyCents, -MONEY_MAX, MONEY_MAX, 'agency commission');
  if (line.agencyCents === 0)
    throw new Error('A statement line must have a nonzero commission amount.');
  required(line.lineRef, 'a carrier transaction reference');
  required(line.eligibilityNote, 'eligibility / variance review evidence');
  if (typeof line.eligible !== 'boolean') throw new Error('Review commission eligibility.');
  if (!['RECEIPT', 'REVERSAL', 'RESTORATION'].includes(line.kind))
    throw new Error('Choose a statement transaction type.');
  let producerCents = 0;
  if (line.kind === 'RECEIPT') {
    if (line.agencyCents < 0 || line.originalId)
      throw new Error('Receipts must be positive and have no reversal link.');
    const prior = policy.entries.filter((e) => e.kind === 'RECEIPT' && e.eligible);
    const received = sum(prior.map((e) => e.agencyCents));
    producerCents = line.eligible
      ? ratio(sum([received, line.agencyCents]), policy.producerBps, 10000) -
        sum(prior.map((e) => e.producerCents))
      : 0;
  } else {
    const original = policy.entries.find((e) => e.id === line.originalId);
    const reverse = line.kind === 'REVERSAL';
    if (
      !original ||
      !(reverse
        ? ['RECEIPT', 'RESTORATION'].includes(original.kind)
        : original.kind === 'REVERSAL') ||
      (reverse ? line.agencyCents >= 0 : line.agencyCents <= 0)
    )
      throw new Error('Link the adjustment to its original receipt or reversal on this policy.');
    if (statement.receivedOn < original.receivedOn)
      throw new Error('An adjustment cannot precede its original receipt.');
    const previous = policy.entries.filter((e) => e.originalId === original.id);
    const used = sum(previous.map((e) => Math.abs(e.agencyCents))),
      amount = Math.abs(line.agencyCents),
      limit = Math.abs(original.agencyCents);
    if (used + amount > limit)
      throw new Error(
        'Adjustments exceed the original commission. Record unrelated carrier losses separately.',
      );
    const share =
      ratio(used + amount, Math.abs(original.producerCents), limit) -
      sum(previous.map((e) => Math.abs(e.producerCents)));
    producerCents = reverse ? -share : share;
  }
  return {
    ...policy,
    entries: [
      ...policy.entries,
      {
        id: entryId,
        statementId: statement.id,
        lineRef: line.lineRef,
        receivedOn: statement.receivedOn,
        kind: line.kind,
        agencyCents: line.agencyCents,
        producerCents,
        ...(line.originalId ? { originalId: line.originalId } : {}),
        eligibilityNote: line.eligibilityNote,
        eligible: line.eligible,
      },
    ],
  };
}
export function policyTotals(policy: CommissionPolicy) {
  const earned = sum(
    policy.entries.filter((e) => e.kind === 'RECEIPT').map((e) => e.producerCents),
  );
  const recovery =
    0 - sum(policy.entries.filter((e) => e.kind !== 'RECEIPT').map((e) => e.producerCents));
  return {
    expectedAgency: ratio(policy.premiumCents, policy.agencyRateUnits, 1_000_000),
    receivedAgency: sum(policy.entries.map((e) => e.agencyCents)),
    earned,
    proposedRecovery: recovery,
    unbatched: sum(
      policy.entries.filter((e) => e.kind === 'RECEIPT' && !e.batchId).map((e) => e.producerCents),
    ),
  };
}

/** Split proposed adjustments by actual payment status. An unpaid earning is
 * not money already collected from the producer. Recovery remains disabled. */
export function recoveryBalances(policy: CommissionPolicy, batches: readonly CommissionBatch[]) {
  const paid = new Set(batches.filter((b) => b.status === 'PAID').map((b) => b.id));
  let paidRecovery = 0,
    unpaidAdjustment = 0;
  for (const entry of policy.entries.filter((e) => e.kind !== 'RECEIPT')) {
    let original = entry;
    for (let depth = 0; original.originalId && depth < policy.entries.length; depth++) {
      const prior = policy.entries.find((e) => e.id === original.originalId);
      if (!prior) throw new Error('An adjustment is missing its original receipt.');
      original = prior;
    }
    if (original.kind !== 'RECEIPT') throw new Error('Invalid commission adjustment chain.');
    if (original.batchId && paid.has(original.batchId))
      paidRecovery = sum([paidRecovery, -entry.producerCents]);
    else unpaidAdjustment = sum([unpaidAdjustment, -entry.producerCents]);
  }
  return { paidRecovery, unpaidAdjustment };
}

/** Queries across multiple partitions can straddle a concurrent payroll write.
 * Refuse inconsistent totals and retry instead of displaying partial balances. */
export function validateAllocationSnapshot(
  policies: readonly CommissionPolicy[],
  batches: readonly CommissionBatch[],
) {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const entryById = new Map(
    policies.flatMap((p) => p.entries.map((e) => [`${p.id}|${e.id}`, e] as const)),
  );
  const fail = () => {
    throw new Error(
      'Commission records changed while loading. Refresh to load consistent balances.',
    );
  };
  for (const p of policies)
    for (const e of p.entries)
      if (e.batchId) {
        const b = batchById.get(e.batchId);
        if (
          !b ||
          b.status === 'CANCELLED' ||
          b.producerId !== p.producerId ||
          !b.lines.some(
            (l) => l.policyId === p.id && l.entryId === e.id && l.amountCents === e.producerCents,
          )
        )
          fail();
      }
  for (const b of batches.filter((b) => b.status !== 'CANCELLED')) {
    if (sum(b.lines.map((l) => l.amountCents)) !== b.totalCents) fail();
    for (const l of b.lines) {
      const e = entryById.get(`${l.policyId}|${l.entryId}`);
      if (!e || e.batchId !== b.id || e.producerCents !== l.amountCents) fail();
    }
  }
}
