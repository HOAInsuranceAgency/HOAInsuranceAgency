/** Commission contracts and arithmetic. All ledger amounts are integer USD cents.
 * These records are private; never place them on shared Policy/UserProfile rows. */
export type CommissionBasis = 'WRITTEN' | 'EARNED' | 'COLLECTED';
export const COMMISSION_BASES: Record<CommissionBasis | 'UNSPECIFIED', string> = {
  UNSPECIFIED: 'Actual receipts only',
  WRITTEN: 'Written premium',
  EARNED: 'Earned premium',
  COLLECTED: 'Collected premium',
};
export const ACCOUNT_COMMISSION_CLASSES = {
  STANDARD: 'Standard account',
  GIM: 'GIM Property Management · house account',
} as const;
export type AccountCommissionClass = keyof typeof ACCOUNT_COMMISSION_CLASSES;
export interface CommissionAccount {
  id: string;
  version: number;
  name: string;
  firstBoundOn?: string;
  neverBound?: true;
  bindingEvidence?: string;
  firstBindPolicyId?: string;
  periods: {
    from: string;
    to?: string;
    classification: AccountCommissionClass;
    evidence: string;
  }[];
}
export interface CommissionRates {
  newBps: number;
  renewalBps: number;
  agreement: string;
}
/** Reusable configuration; assignment dates and employee eligibility belong to PLAN terms. */
export interface CommissionPlanDefinition extends CommissionRates {
  id: string; version: number; name: string; archived: boolean; gim?: CommissionRates;
}
export interface CommissionAssignment {
  id: string; planId: string; planVersion: number; planName: string; planReference: string;
  notes?: string;
}
export interface CommissionPlan {
  id: string;
  version: number;
  producerId: string;
  name: string;
  accountBoundFrom?: string;
  receiptsFrom?: string;
  terms: (CommissionRates & {
    from: string;
    to?: string;
    gim?: CommissionRates;
    assignment?: CommissionAssignment;
    accountBoundFrom?: string;
    receiptsFrom?: string;
  })[];
}
/** Commission basis is independent of the frequency at which the payor remits it. */
export interface CarrierPaymentArrangement {
  id: string;
  from: string;
  to?: string;
  lines?: string[];
  transaction?: 'NEW' | 'RENEWAL';
  billType?: 'AGENCY' | 'DIRECT';
  basis: CommissionBasis;
  payor: string;
  trigger: 'BIND' | 'EFFECTIVE' | 'COLLECTION' | 'EARNED';
  cadence: 'ONCE' | 'MONTHLY' | 'QUARTERLY';
  lagDays: number;
  cutoffDay?: number;
  paymentDay?: number;
  earningMethod?: 'DAILY_PRORATA' | 'MANUAL';
  evidence: string;
  notes?: string;
}
export interface CarrierCommissionTerms {
  /** Explicit receipt-only setup: no assumed carrier basis or payment forecast. */
  receiptOnly?: true;
  id: string;
  version: number;
  name: string;
  basis: CommissionBasis | 'UNSPECIFIED';
  schedule: string;
  evidence: string;
  arrangements?: CarrierPaymentArrangement[];
  /** Immutable resolved arrangement on a policy term; absent on legacy terms. */
  payment?: CarrierPaymentArrangement;
}
export interface CommissionReceiptForecast {
  items: { dueOn: string; agencyCents: number }[];
  evidence: string;
  confirmed: boolean;
  complete: boolean;
  /** Written by the server when an Owner reviews the current receipt history. */
  reviewedEntryCount?: number;
}
export interface CommissionReconciliationBalances {
  asOf: string;
  fullTermEstimate: number;
  forecastTotal: number | null;
  expectedToDate: number | null;
  receivedToDate: number;
  overdue: number | null;
  futureForecast: number | null;
  unallocatedForecast: number | null;
  confirmed: boolean;
  status: string;
  adjustmentReview: boolean;
}
export interface CommissionEntry {
  allocationId?: string;
  supersededBy?: string;
  excludedByCase?: string;
  id: string;
  statementId: string;
  lineRef: string;
  receivedOn: string;
  kind: 'RECEIPT' | 'REVERSAL' | 'RESTORATION';
  revenueKind?: 'CARRIER_COMMISSION' | 'BROKER_FEE';
  agencyCents: number;
  producerCents: number;
  originalId?: string;
  eligibilityNote: string;
  eligible: boolean;
  batchId?: string;
}
export interface CommissionPolicy {
  allocations?: import('./commissionExceptions').CommissionAllocation[];
  reviewHolds?: CommissionReviewHold[];
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
  brokerFeeCents?: number;
  producerBps: number;
  agreement: string;
  planVersion: number;
  assignment?: CommissionAssignment & { from: string; to?: string };
  // Optional only for snapshots created before account classification was introduced.
  accountClassification?: CommissionAccount['periods'][number] & {
    version: number;
  };
  eligibility?: {
    accountFirstBoundOn: string;
    accountBoundFrom: string;
    eligible: boolean;
  };
  receiptsFrom?: string;
  carrierTerms: CarrierCommissionTerms;
  receiptForecast?: CommissionReceiptForecast;
  /** Safe computed summary for a producer response, without private source terms. */
  reconciliationBalances?: CommissionReconciliationBalances;
  entries: CommissionEntry[];
}
export interface StatementLine {
  sourceRow?: number;
  reviewStatus?: 'PENDING' | 'ELIGIBLE' | 'INELIGIBLE';
  reportedPremiumCents?: number;
  reportedRateUnits?: number;
  policyId: string;
  lineRef: string;
  kind: CommissionEntry['kind'];
  revenueKind?: CommissionEntry['revenueKind'];
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
export const COMMISSION_REVIEW_CATEGORIES = ['LICENSING', 'DOCUMENTATION', 'SPLIT', 'SEPARATION', 'CANCELLATION', 'DISPUTE', 'LATE_RECEIPT', 'OTHER'] as const;
export interface CommissionReviewHold {
  id: string; category: typeof COMMISSION_REVIEW_CATEGORIES[number]; note: string; dueOn: string;
  status: 'OPEN' | 'RESOLVED'; openedAt: string; openedBy: string;
  resolvedAt?: string; resolvedBy?: string; resolution?: string;
}
export function assertCommissionReviewed(policy: CommissionPolicy) {
  if (policy.reviewHolds?.some(h => h.status === 'OPEN')) throw new Error(`Resolve the commission review items for ${policy.policyNumber || policy.id} before payroll approval.`);
}
export interface CommissionBatch {
  payments?: { id: string; amountCents: number; paidOn: string; reference: string; recordedAt: string; recordedBy: string }[];
  /** Safe aggregate for the employee projection; payment references remain private. */
  paidCents?: number;
  cycleId?: string;
  cycleRevision?: number;
  actualPaidOn?: string;
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
    earningId?: string;
    source?: 'SHARED_RECEIPT' | 'ADJUSTMENT';
    shareBps?: number;
    receivedOn?: string;
    transaction?: 'NEW' | 'RENEWAL';
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
  /** Owner-only saved account settings; never part of an employee projection. */
  accounts?: CommissionAccount[];
  earnings?: import('./commissionExceptions').CommissionEarning[];
  planDefinitions?: CommissionPlanDefinition[];
  plans: CommissionPlan[];
  carriers: CarrierCommissionTerms[];
  policies: CommissionPolicy[];
  statements: CommissionStatement[];
  batches: CommissionBatch[];
}
export function batchPaidCents(batch: CommissionBatch): number {
  const amount = batch.payments ? sum(batch.payments.map(p => p.amountCents)) : batch.paidCents ?? (batch.status === 'PAID' ? batch.totalCents : 0);
  return integer(amount, 0, batch.totalCents, 'recorded commission payment');
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
function validatePeriods<T extends { from: string; to?: string }>(periods: T[]): T[] {
  if (!Array.isArray(periods) || !periods.length || periods.length > 100)
    throw new Error('Enter between 1 and 100 agreement or classification periods.');
  const sorted = periods
    .map((t) => ({
      ...t,
      from: day(t.from),
      ...(t.to ? { to: day(t.to) } : {}),
    }))
    .sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 0; i < sorted.length; i++)
    if (
      (sorted[i].to && sorted[i].to! < sorted[i].from) ||
      (i && (!sorted[i - 1].to || sorted[i].from <= sorted[i - 1].to!))
    )
      throw new Error(
        'Agreement or classification periods must not overlap or end before they start.',
      );
  return sorted;
}
function validateRates(rates: CommissionRates): CommissionRates {
  return {
    newBps: integer(rates.newBps, 0, 10000, 'new-business rate'),
    renewalBps: integer(rates.renewalBps, 0, 10000, 'renewal rate'),
    agreement: required(rates.agreement, 'an agreement reference'),
  };
}
export function validatePlan(plan: CommissionPlan): CommissionPlan {
  required(plan.producerId, 'a producer', 128);
  required(plan.name, 'a producer name', 200);
  return {
    ...plan,
    ...(plan.accountBoundFrom ? { accountBoundFrom: day(plan.accountBoundFrom) } : {}),
    ...(plan.receiptsFrom ? { receiptsFrom: day(plan.receiptsFrom) } : {}),
    terms: validatePeriods(plan.terms).map((t) => ({
      from: t.from,
      ...(t.to ? { to: t.to } : {}),
      ...validateRates(t),
      ...(t.gim !== undefined ? { gim: validateRates(t.gim) } : {}),
      ...(t.accountBoundFrom ? { accountBoundFrom: day(t.accountBoundFrom) } : {}),
      ...(t.receiptsFrom ? { receiptsFrom: day(t.receiptsFrom) } : {}),
      ...(t.assignment ? { assignment: { id: required(t.assignment.id, 'an assignment ID', 128), planId: required(t.assignment.planId, 'a commission plan', 128), planVersion: integer(t.assignment.planVersion, 1, Number.MAX_SAFE_INTEGER, 'plan version'), planName: required(t.assignment.planName, 'a plan name', 200), planReference: required(t.assignment.planReference, 'the plan reference'), ...(t.assignment.notes ? { notes: required(t.assignment.notes, 'assignment notes', 2000) } : {}) } } : {}),
    })),
  };
}
export function validatePlanDefinition(plan: CommissionPlanDefinition): CommissionPlanDefinition {
  if (typeof plan.archived !== 'boolean') throw new Error('Choose whether the plan is archived.');
  return { id: required(plan.id, 'a plan ID', 128), version: integer(plan.version, 0, Number.MAX_SAFE_INTEGER, 'plan version'), name: required(plan.name, 'a plan name', 200), archived: plan.archived, ...validateRates(plan), ...(plan.gim ? { gim: validateRates(plan.gim) } : {}) };
}
export function validateCommissionAccount(account: CommissionAccount): CommissionAccount {
  if (account.neverBound !== undefined && account.neverBound !== true)
    throw new Error('Confirm whether the account has ever been bound.');
  if (account.firstBoundOn && account.neverBound)
    throw new Error(
      'Choose an original first bind date or confirm the account has never been bound.',
    );
  if (account.firstBoundOn) day(account.firstBoundOn);
  if (account.firstBoundOn || account.neverBound)
    required(account.bindingEvidence, 'the first-bind history reference');
  return {
    ...account,
    periods: validatePeriods(account.periods).map((t) => {
      if (!Object.hasOwn(ACCOUNT_COMMISSION_CLASSES, t.classification))
        throw new Error(
          'Choose Standard or GIM Property Management. GIM is the only house-account program.',
        );
      return {
        from: t.from,
        ...(t.to ? { to: t.to } : {}),
        classification: t.classification,
        evidence: required(t.evidence, 'the account classification reference'),
      };
    }),
  };
}
/** Classification is an explicit Owner decision, not a name match or mutable manager link.
 * Select once on the commission date and freeze the result in the policy snapshot. */
export function selectCommissionTerms(
  plan: CommissionPlan,
  account: CommissionAccount | undefined,
  rateDate: string,
  transaction: 'NEW' | 'RENEWAL',
  accountFirstBoundOn?: string,
) {
  day(rateDate);
  const classification = account?.periods.find(
    (t) => t.from <= rateDate && (!t.to || t.to >= rateDate),
  );
  if (!classification || !Object.hasOwn(ACCOUNT_COMMISSION_CLASSES, classification.classification))
    throw new Error(
      `An Owner must classify this account as Standard or GIM Property Management for ${rateDate} in Agreements & carriers.`,
    );
  // Legacy producer agreements remain readable. New assignment terms keep
  // eligibility boundaries with the selected plan instead of on the employee.
  let term = plan.terms.find(t => t.from <= rateDate && (!t.to || t.to >= rateDate));
  const earliest = plan.terms[0], historicalCutoff = earliest?.accountBoundFrom ?? plan.accountBoundFrom;
  if (!term && earliest && historicalCutoff && accountFirstBoundOn && accountFirstBoundOn < historicalCutoff && rateDate < historicalCutoff && earliest.from <= historicalCutoff && (!earliest.to || earliest.to >= historicalCutoff)) term = earliest;
  if (!term) throw new Error(`An Owner must assign a commission plan covering ${rateDate}.`);
  const accountBoundFrom = term.accountBoundFrom ?? (term.assignment ? undefined : plan.accountBoundFrom);
  const receiptsFrom = term.receiptsFrom ?? (term.assignment ? undefined : plan.receiptsFrom);
  if (accountBoundFrom && !accountFirstBoundOn)
    throw new Error(
      'An Owner must confirm this account’s original first bind history in Agreements & carriers.',
    );
  const eligibility = accountBoundFrom
    ? {
        accountFirstBoundOn: day(accountFirstBoundOn),
        accountBoundFrom,
        eligible: accountFirstBoundOn! >= accountBoundFrom,
      }
    : undefined;
  const rates = classification.classification === 'GIM' ? term.gim : term;
  if (!rates)
    throw new Error(
      `An Owner must configure this producer’s GIM house-account rates for ${rateDate}. Standard rates cannot be used.`,
    );
  return {
    ...(eligibility ? { eligibility } : {}),
    ...(receiptsFrom ? { receiptsFrom } : {}),
    ...(term.assignment ? { assignment: { ...term.assignment, from: term.from, ...(term.to ? { to: term.to } : {}) } } : {}),
    producerBps:
      eligibility?.eligible === false ? 0 : transaction === 'NEW' ? rates.newBps : rates.renewalBps,
    agreement: rates.agreement,
    accountClassification: { ...classification, version: account!.version },
  };
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
  if (line.reviewStatus && !['PENDING', 'ELIGIBLE', 'INELIGIBLE'].includes(line.reviewStatus)) throw new Error('Choose a valid eligibility decision.');
  if (line.reviewStatus === 'PENDING') throw new Error('Resolve pending eligibility before posting this receipt.');
  if (line.reviewStatus && (line.reviewStatus === 'ELIGIBLE') !== line.eligible) throw new Error('The eligibility decision and amount treatment disagree.');
  if (!['RECEIPT', 'REVERSAL', 'RESTORATION'].includes(line.kind))
    throw new Error('Choose a statement transaction type.');
  const allocation = line.kind === 'RECEIPT' ? policy.allocations?.filter(a => a.from <= statement.receivedOn).at(-1) : policy.allocations?.find(a => a.id === policy.entries.find(e => e.id === line.originalId)?.allocationId);
  let producerCents = 0;
  if (line.kind === 'RECEIPT') {
    if (line.agencyCents < 0 || line.originalId)
      throw new Error('Receipts must be positive and have no reversal link.');
    if (!allocation && line.eligible && policy.eligibility?.eligible === false)
      throw new Error(
        'This account was first bound before the producer agreement cutoff. New business and later renewals are noncommissionable. Record the agency receipt as ineligible.',
      );
    if (!allocation && line.eligible && policy.receiptsFrom && statement.receivedOn < policy.receiptsFrom)
      throw new Error(
        `Agency commission received before ${policy.receiptsFrom} is not eligible under this agreement.`,
      );
    const prior = policy.entries.filter((e) => e.kind === 'RECEIPT' && e.eligible && !e.allocationId && (e.revenueKind ?? 'CARRIER_COMMISSION') === (line.revenueKind ?? 'CARRIER_COMMISSION'));
    const received = sum(prior.map((e) => e.agencyCents));
    producerCents = line.eligible && !allocation
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
        ...(allocation ? { allocationId: allocation.id } : {}),
        statementId: statement.id,
        lineRef: line.lineRef,
        receivedOn: statement.receivedOn,
        kind: line.kind,
        ...(line.revenueKind ? { revenueKind: line.revenueKind } : {}),
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
    policy.entries.filter((e) => e.kind === 'RECEIPT' && !e.supersededBy && !e.excludedByCase).map((e) => e.producerCents),
  );
  const recovery =
    0 - sum(policy.entries.filter((e) => e.kind !== 'RECEIPT').map((e) => e.producerCents));
  return {
    expectedAgency: ratio(policy.premiumCents, policy.agencyRateUnits, 1_000_000) + (policy.brokerFeeCents ?? 0),
    receivedAgency: sum(policy.entries.map((e) => e.agencyCents)),
    earned,
    proposedRecovery: recovery,
    unbatched: sum(
      policy.entries.filter((e) => e.kind === 'RECEIPT' && !e.batchId && !e.supersededBy && !e.excludedByCase).map((e) => e.producerCents),
    ),
  };
}

/** Split proposed adjustments by actual payment status. An unpaid earning is
 * not money already collected from the producer. Recovery remains disabled. */
export function recoveryBalances(policy: CommissionPolicy, batches: readonly CommissionBatch[]) {
  const paid = new Set(batches.filter((b) => b.status === 'PAID').map((b) => b.id));
  const partial = new Set(batches.filter(b => batchPaidCents(b) > 0 && batchPaidCents(b) < b.totalCents).map(b => b.id));
  let partialAdjustment = 0;
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
    if (original.batchId && partial.has(original.batchId)) partialAdjustment = sum([partialAdjustment, -entry.producerCents]);
    else if (original.batchId && paid.has(original.batchId))
      paidRecovery = sum([paidRecovery, -entry.producerCents]);
    else unpaidAdjustment = sum([unpaidAdjustment, -entry.producerCents]);
  }
  return { paidRecovery, unpaidAdjustment, ...(partialAdjustment ? { partialAdjustment } : {}) };
}

/** Queries across multiple partitions can straddle a concurrent payroll write.
 * Refuse inconsistent totals and retry instead of displaying partial balances. */
export function validateAllocationSnapshot(
  policies: readonly CommissionPolicy[],
  batches: readonly CommissionBatch[],
  earnings: readonly import('./commissionExceptions').CommissionEarning[] = [],
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
  for (const earning of earnings) if (earning.batchId) {
    const batch = batchById.get(earning.batchId);
    if (!batch || batch.status === 'CANCELLED' || batch.producerId !== earning.producerId || earning.status !== 'PAYABLE' || !batch.lines.some(l => l.earningId === earning.id && l.amountCents === earning.amountCents && l.policyId === earning.policyId)) fail();
  }
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
      const paid = batchPaidCents(b);
      if (b.payments && (new Set(b.payments.map(p => p.id)).size !== b.payments.length || b.payments.some(p => !Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) || (b.status === 'PAID' ? paid !== b.totalCents : paid >= b.totalCents && b.totalCents > 0))) fail();
    if (new Set(b.lines.map(l => l.earningId ?? `${l.policyId}|${l.entryId}`)).size !== b.lines.length) fail();
    if (sum(b.lines.map((l) => l.amountCents)) !== b.totalCents) fail();
    for (const l of b.lines) {
      if (l.earningId) {
        const earning = earnings.find(e => e.id === l.earningId);
        if (!earning || earning.batchId !== b.id || earning.producerId !== b.producerId || earning.amountCents !== l.amountCents || earning.policyId !== l.policyId || earning.status !== 'PAYABLE') fail();
        continue;
      }
      const e = entryById.get(`${l.policyId}|${l.entryId}`);
      if (!e || e.batchId !== b.id || e.producerCents !== l.amountCents) fail();
    }
  }
}

function arrangementSpecificity(a: CarrierPaymentArrangement): number {
  return Number(!!a.lines?.length) + Number(!!a.transaction) + Number(!!a.billType);
}
function arrangementsOverlap(a: CarrierPaymentArrangement, b: CarrierPaymentArrangement): boolean {
  return (
    a.from <= (b.to ?? '9999-12-31') &&
    b.from <= (a.to ?? '9999-12-31') &&
    (!a.transaction || !b.transaction || a.transaction === b.transaction) &&
    (!a.billType || !b.billType || a.billType === b.billType) &&
    (!a.lines?.length || !b.lines?.length || a.lines.some((line) => b.lines!.includes(line)))
  );
}
/** New writes require structured, sourced terms. Legacy snapshots remain readable. */
/** Receipt-only terms deliberately carry no dates, premium basis, or forecast facts. */
export function receiptOnlyCarrierTerms(input: Pick<CarrierCommissionTerms, 'id' | 'version' | 'name'>): CarrierCommissionTerms {
  return { id: required(input.id, 'a carrier'), version: integer(input.version, 0, Number.MAX_SAFE_INTEGER, 'carrier version'),
    name: required(input.name, 'a carrier name', 200), receiptOnly: true, basis: 'UNSPECIFIED',
    schedule: 'Actual receipts only; payment timing not configured.', evidence: '' };
}
export function validateCarrierPaymentTerms(terms: CarrierCommissionTerms): CarrierCommissionTerms {
  const name = required(terms.name, 'a carrier name', 200);
  if (!Array.isArray(terms.arrangements) || !terms.arrangements.length || terms.arrangements.length > 100)
    throw new Error('Enter 1–100 carrier payment arrangements.');
  const arrangements = terms.arrangements.map((a): CarrierPaymentArrangement => {
    if (!a || typeof a !== 'object') throw new Error('Enter a valid carrier payment arrangement.');
    const from = day(a.from), to = a.to ? day(a.to) : undefined;
    if (to && to < from) throw new Error('A carrier arrangement cannot end before it starts.');
    if (!['WRITTEN', 'EARNED', 'COLLECTED'].includes(a.basis)) throw new Error('Choose a commission basis.');
    if (!['BIND', 'EFFECTIVE', 'COLLECTION', 'EARNED'].includes(a.trigger))
      throw new Error('Choose a carrier payment trigger.');
    if ((a.basis === 'WRITTEN' && !['BIND', 'EFFECTIVE'].includes(a.trigger)) ||
        (a.basis === 'EARNED' && a.trigger !== 'EARNED') ||
        (a.basis === 'COLLECTED' && a.trigger !== 'COLLECTION'))
      throw new Error('The carrier payment trigger must match its commission basis.');
    if (!['ONCE', 'MONTHLY', 'QUARTERLY'].includes(a.cadence))
      throw new Error('Choose a carrier remittance cadence.');
    if (a.transaction !== undefined && !['NEW', 'RENEWAL'].includes(a.transaction))
      throw new Error('Choose a new-business or renewal scope.');
    if (a.billType !== undefined && !['AGENCY', 'DIRECT'].includes(a.billType))
      throw new Error('Choose an agency-bill or direct-bill scope.');
    if (a.basis === 'EARNED' && a.earningMethod === undefined)
      throw new Error('Choose a daily pro-rata or manual earned-premium calculation method.');
    if (a.earningMethod !== undefined &&
        (a.basis !== 'EARNED' || !['DAILY_PRORATA', 'MANUAL'].includes(a.earningMethod)))
      throw new Error('Choose an earned-premium calculation method only for earned-premium terms.');
    if (a.cadence === 'ONCE' && a.cutoffDay !== undefined)
      throw new Error('A one-time remittance does not have a statement cutoff.');
    let lines: string[] | undefined;
    if (a.lines !== undefined) {
      if (!Array.isArray(a.lines) || !a.lines.length || a.lines.length > 50)
        throw new Error('Choose 1–50 coverage lines or leave the scope unrestricted.');
      lines = a.lines.map((line) => required(line, 'a coverage line', 100).toUpperCase());
      if (new Set(lines).size !== lines.length) throw new Error('Coverage line scopes must be unique.');
      lines.sort();
    }
    return {
      id: required(a.id, 'an arrangement identifier', 128),
      from,
      ...(to ? { to } : {}),
      ...(lines ? { lines } : {}),
      ...(a.transaction ? { transaction: a.transaction } : {}),
      ...(a.billType ? { billType: a.billType } : {}),
      basis: a.basis,
      payor: required(a.payor, 'the commission payor', 200),
      trigger: a.trigger,
      cadence: a.cadence,
      lagDays: integer(a.lagDays, 0, 730, 'calendar-day payment lag'),
      ...(a.cutoffDay !== undefined ? { cutoffDay: integer(a.cutoffDay, 1, 31, 'statement cutoff day') } : {}),
      ...(a.paymentDay !== undefined ? { paymentDay: integer(a.paymentDay, 1, 31, 'payment day') } : {}),
      ...(a.earningMethod ? { earningMethod: a.earningMethod } : {}),
      evidence: required(a.evidence, 'the carrier agreement reference', 2000),
      ...(a.notes?.trim() ? { notes: required(a.notes, 'carrier wording or notes', 2000) } : {}),
    };
  });
  if (new Set(arrangements.map((a) => a.id)).size !== arrangements.length)
    throw new Error('Carrier arrangement identifiers must be unique.');
  for (let i = 0; i < arrangements.length; i++)
    for (let j = i + 1; j < arrangements.length; j++)
      if (arrangementSpecificity(arrangements[i]) === arrangementSpecificity(arrangements[j]) &&
          arrangementsOverlap(arrangements[i], arrangements[j]))
        throw new Error('Carrier payment arrangements with the same scope specificity cannot overlap.');
  // Preserve legacy fields as a readable summary, never a second timing source.
  const validated: CarrierCommissionTerms = {
    id: required(terms.id, 'a carrier identifier', 128),
    version: integer(terms.version, 0, Number.MAX_SAFE_INTEGER, 'carrier terms version'),
    name,
    basis: arrangements[0].basis,
    schedule: typeof terms.schedule === 'string' ? terms.schedule.trim().slice(0, 2000) : '',
    evidence: arrangements[0].evidence,
    arrangements,
  };
  if (new TextEncoder().encode(JSON.stringify(validated)).length > 200_000)
    throw new Error('Carrier payment terms are too large. Use shorter agreement references and notes.');
  return validated;
}
export interface CarrierPaymentContext {
  effectiveDate: string;
  lines?: readonly string[];
  billType?: 'AGENCY' | 'DIRECT';
  transaction: 'NEW' | 'RENEWAL';
}
/** Select by policy effective date; scoped arrangements outrank carrierwide defaults.
 * Equal-specificity matches are ambiguous even if they name disjoint policy lines. */
export function selectCarrierPaymentTerms(
  terms: CarrierCommissionTerms,
  context: CarrierPaymentContext,
): CarrierCommissionTerms {
  const effectiveDate = day(context.effectiveDate);
  if (terms.receiptOnly) {
    if (terms.arrangements?.length || terms.payment) throw new Error('Receipt-only setup cannot contain a payment forecast.');
    return receiptOnlyCarrierTerms(terms);
  }
  if (!terms.arrangements?.length) {
    const { payment: _payment, ...legacy } = terms;
    return { ...legacy };
  }
  const validated = validateCarrierPaymentTerms(terms);
  const lines = new Set((context.lines ?? []).map((line) => line.trim().toUpperCase()).filter(Boolean));
  const knownBillType = context.billType === 'AGENCY' || context.billType === 'DIRECT';
  const dated = validated.arrangements!.filter((a) =>
    a.from <= effectiveDate && (!a.to || a.to >= effectiveDate) &&
    (!a.transaction || a.transaction === context.transaction),
  );
  const applicable = dated.filter((a) =>
    !a.billType || (knownBillType && a.billType === context.billType),
  );
  const matches = applicable.filter((a) =>
    !a.lines?.length || (lines.size > 0 && [...lines].every((line) => a.lines!.includes(line))),
  ).sort((a, b) => arrangementSpecificity(b) - arrangementSpecificity(a));
  // Missing historical metadata is unknown, not proof that an override does not
  // apply. A known contrary scope or a lower-priority exception cannot win.
  const unresolvedScope = dated.some((a) =>
    (!a.billType || !knownBillType || a.billType === context.billType) &&
    (!a.lines?.length || !lines.size || a.lines.some((line) => lines.has(line))) &&
    ((!!a.billType && !knownBillType) || (!!a.lines?.length && !lines.size)) &&
    (!matches[0] || arrangementSpecificity(a) >= arrangementSpecificity(matches[0])));
  if (unresolvedScope)
    throw new Error('Confirm the policy’s billing type and coverage lines before selecting scoped carrier payment terms.');
  const partial = applicable.some((a) => a.lines?.some((line) => lines.has(line)) &&
    ![...lines].every((line) => a.lines!.includes(line)) &&
    (!matches[0] || arrangementSpecificity(a) >= arrangementSpecificity(matches[0])));
  if (partial)
    throw new Error('Carrier payment terms differ across this policy’s coverage lines. Split the policy or configure one arrangement covering all its lines.');
  if (!matches.length)
    throw new Error('Configure carrier payment terms covering this policy effective date and scope.');
  if (matches[1] && arrangementSpecificity(matches[0]) === arrangementSpecificity(matches[1]))
    throw new Error('Carrier payment terms are ambiguous for this policy. Resolve the overlapping scopes.');
  const payment = matches[0];
  return { ...validated, basis: payment.basis, evidence: payment.evidence, payment };
}
export function validateReceiptForecast(forecast: CommissionReceiptForecast): CommissionReceiptForecast {
  if (!forecast || typeof forecast !== 'object' || !Array.isArray(forecast.items) || forecast.items.length > 100)
    throw new Error('Enter at most 100 expected receipt items.');
  if (typeof forecast.confirmed !== 'boolean' || typeof forecast.complete !== 'boolean')
    throw new Error('Review whether the receipt forecast is confirmed and complete.');
  if (!forecast.complete && !forecast.items.length)
    throw new Error('Enter an expected receipt or confirm a complete zero forecast.');
  const items = forecast.items.map((item) => ({
    dueOn: day(item.dueOn),
    agencyCents: integer(item.agencyCents, 0, MONEY_MAX, 'expected agency commission'),
  })).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  sum(items.map((item) => item.agencyCents));
  return {
    items,
    evidence: required(forecast.evidence, 'the receipt forecast source or review reference', 2000),
    confirmed: forecast.confirmed,
    complete: forecast.complete,
    ...(forecast.reviewedEntryCount !== undefined
      ? { reviewedEntryCount: integer(forecast.reviewedEntryCount, 0, 500, 'reviewed entry count') }
      : {}),
  };
}

const CALENDAR_DAY_MS = 86_400_000;
function dateAt(value: string): Date { return new Date(`${day(value)}T00:00:00Z`); }
function dateString(value: Date): string {
  const result = value.toISOString().slice(0, 10);
  return day(result);
}
function addCalendarDays(value: string, days: number): string {
  return dateString(new Date(dateAt(value).getTime() + days * CALENDAR_DAY_MS));
}
function monthDate(year: number, month: number, dayOfMonth: number): string {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return dateString(new Date(Date.UTC(year, month, Math.min(dayOfMonth, last))));
}
function bindCalendarDate(boundAt: string): string {
  // Historical adoption stores an original local date rather than an instant.
  if (/^\d{4}-\d{2}-\d{2}$/.test(boundAt)) return day(boundAt);
  const instant = new Date(boundAt);
  if (!Number.isFinite(instant.getTime())) throw new Error('The original bind timestamp is invalid.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return day(`${part('year')}-${part('month')}-${part('day')}`);
}
/** Calendar statement periods close on cutoffDay (default monthend). Monthly means
 * every month; quarterly means Mar/Jun/Sep/Dec. A later trigger rolls a full period.
 * paymentDay is in the month after the cutoff; days 29–31 clamp to monthend.
 * lagDays are calendar days added after that payment day (or after the cutoff).
 * ONCE has no cutoff: paymentDay is its next occurrence on/after the trigger. */
function remittanceDue(trigger: string, payment: CarrierPaymentArrangement): string {
  const date = dateAt(trigger), year = date.getUTCFullYear(), month = date.getUTCMonth();
  let due: string;
  if (payment.cadence === 'ONCE') {
    due = trigger;
    if (payment.paymentDay !== undefined) {
      due = monthDate(year, month, payment.paymentDay);
      if (due < trigger) due = monthDate(year, month + 1, payment.paymentDay);
    }
  } else {
    const months = payment.cadence === 'MONTHLY' ? 1 : 3;
    let closeMonth = Math.floor(month / months) * months + months - 1;
    let close = monthDate(year, closeMonth, payment.cutoffDay ?? 31);
    if (trigger > close) {
      closeMonth += months;
      close = monthDate(year, closeMonth, payment.cutoffDay ?? 31);
    }
    due = payment.paymentDay === undefined
      ? close
      : monthDate(year, closeMonth + 1, payment.paymentDay);
  }
  return addCalendarDays(due, payment.lagDays);
}
function automaticReceiptItems(policy: CommissionPolicy, total: number): CommissionReceiptForecast | null {
  const payment = policy.carrierTerms.payment;
  if (!payment) return null;
  if (payment.basis === 'COLLECTED' || (payment.basis === 'EARNED' && payment.earningMethod !== 'DAILY_PRORATA'))
    return null;
  const evidence = payment.evidence;
  if (payment.basis === 'WRITTEN') {
    const trigger = payment.trigger === 'BIND' ? bindCalendarDate(policy.boundAt) : day(policy.effectiveDate);
    return { items: [{ dueOn: remittanceDue(trigger, payment), agencyCents: total }], evidence, confirmed: true, complete: true };
  }
  const start = day(policy.effectiveDate), end = day(policy.expirationDate);
  if (end <= start) throw new Error('The policy expiration date must follow its effective date.');
  if (payment.cadence === 'ONCE')
    return { items: [{ dueOn: remittanceDue(addCalendarDays(end, -1), payment), agencyCents: total }], evidence, confirmed: true, complete: true };
  const totalDays = (dateAt(end).getTime() - dateAt(start).getTime()) / CALENDAR_DAY_MS;
  const months = payment.cadence === 'MONTHLY' ? 1 : 3;
  let periodStart = start, prior = 0;
  const items: CommissionReceiptForecast['items'] = [];
  while (periodStart < end) {
    if (items.length >= 100) return null; // Long terms require an explicit bounded plan.
    const date = dateAt(periodStart), month = date.getUTCMonth(), year = date.getUTCFullYear();
    let closeMonth = Math.floor(month / months) * months + months - 1;
    let close = monthDate(year, closeMonth, payment.cutoffDay ?? 31);
    if (periodStart > close) {
      closeMonth += months;
      close = monthDate(year, closeMonth, payment.cutoffDay ?? 31);
    }
    const next = addCalendarDays(close, 1);
    const periodEnd = next < end ? next : end;
    const elapsed = (dateAt(periodEnd).getTime() - dateAt(start).getTime()) / CALENDAR_DAY_MS;
    const cumulative = ratio(total, elapsed, totalDays);
    items.push({ dueOn: remittanceDue(addCalendarDays(periodEnd, -1), payment), agencyCents: cumulative - prior });
    prior = cumulative;
    periodStart = periodEnd;
  }
  return { items, evidence, confirmed: true, complete: true };
}
/** Forecasts never post receipts or alter producer earnings. Unknown timing remains
 * null. An incomplete manual plan reports only known items and an unknown remainder.
 * Early receipts allocate to due items then future items; futureForecast is the
 * remaining future scheduled balance rather than the original gross schedule.
 * Due today contributes to expectedToDate, and becomes overdue tomorrow. Reversals
 * require a forecast review before any overdue amount is reliable again. */
export function carrierReconciliationBalances(
  policy: CommissionPolicy,
  asOf: string,
): CommissionReconciliationBalances {
  day(asOf);
  const fullTermEstimate = ratio(policy.premiumCents, policy.agencyRateUnits, 1_000_000);
  const receivedEntries = policy.entries.filter((entry) => entry.revenueKind !== 'BROKER_FEE' && entry.receivedOn <= asOf);
  const receivedToDate = sum(receivedEntries.map((entry) => entry.agencyCents));
  const forecast = policy.receiptForecast
    ? validateReceiptForecast(policy.receiptForecast)
    : automaticReceiptItems(policy, fullTermEstimate);
  const reviewedEntryCount = policy.receiptForecast?.reviewedEntryCount ?? 0;
  // The review watermark counts the complete immutable ledger, including fees.
  // Preserve those indexes while excluding fee reversals from carrier review.
  const adjustmentReview = policy.entries.some((entry, index) =>
    entry.revenueKind !== 'BROKER_FEE' && entry.receivedOn <= asOf && entry.kind !== 'RECEIPT' && index >= reviewedEntryCount);
  if (!forecast) return {
    asOf, fullTermEstimate, forecastTotal: null, expectedToDate: null, receivedToDate,
    overdue: null, futureForecast: null, unallocatedForecast: null, confirmed: false,
    status: adjustmentReview ? 'ADJUSTMENT_REVIEW' : 'UNKNOWN', adjustmentReview,
  };
  const knownTotal = sum(forecast.items.map((item) => item.agencyCents));
  const expectedToDate = sum(forecast.items.filter((item) => item.dueOn <= asOf).map((item) => item.agencyCents));
  const pastDue = sum(forecast.items.filter((item) => item.dueOn < asOf).map((item) => item.agencyCents));
  return {
    asOf,
    fullTermEstimate,
    forecastTotal: forecast.complete ? knownTotal : null,
    expectedToDate,
    receivedToDate,
    overdue: forecast.confirmed && !adjustmentReview ? Math.max(0, pastDue - receivedToDate) : null,
    futureForecast: Math.max(0,
      sum(forecast.items.filter((item) => item.dueOn > asOf).map((item) => item.agencyCents)) -
      Math.max(0, receivedToDate - expectedToDate)),
    unallocatedForecast: forecast.complete ? 0 : Math.max(0, fullTermEstimate - knownTotal),
    confirmed: forecast.confirmed,
    status: adjustmentReview ? 'ADJUSTMENT_REVIEW' : !forecast.complete ? 'PARTIAL_FORECAST' : forecast.confirmed ? 'CONFIRMED' : 'ESTIMATED',
    adjustmentReview,
  };
}
