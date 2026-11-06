import {
  day,
  integer,
  required,
  sum,
  ratio,
  MONEY_MAX,
  batchPaidCents,
  type CommissionPolicy,
  type CommissionEntry,
  type CommissionBatch,
} from "./commissions";

/** One agency cash entry can have several private employee earnings records. */
export interface CommissionAllocation {
  id: string;
  from: string;
  agreement: string;
  approvedBy: string;
  approvedAt: string;
  method: "INDIVIDUAL_PLAN_RATE";
  houseBps: number;
  participants: {
    producerId: string;
    producerName: string;
    shareBps: number;
    producerBps: number;
    planVersion: number;
    agreement: string;
    receiptsFrom?: string;
    eligible: boolean;
  }[];
}
export interface CommissionEarning {
  id: string;
  version: number;
  producerId: string;
  producerName: string;
  policyId: string;
  policyNumber: string;
  accountName: string;
  transaction: "NEW" | "RENEWAL";
  entryId: string;
  receivedOn: string;
  agencyCents: number;
  producerBps: number;
  amountCents: number;
  shareBps?: number;
  allocationId?: string;
  adjustmentId?: string;
  source: "SHARED_RECEIPT" | "ADJUSTMENT";
  status: "PAYABLE" | "REVIEW" | "RESOLVED" | "EXCLUDED" | "SUPERSEDED";
  originalEarningId?: string;
  supersededBy?: string;
  batchId?: string;
}
export interface CommissionAdjustment {
  id: string;
  version: number;
  policyId: string;
  producerId: string;
  targetEntryId?: string;
  targetEarningId?: string;
  adjustmentType: "ADDITIONAL" | "UNPAID_CORRECTION" | "PAID_RECOVERY";
  originalCents: number;
  correctedCents: number;
  amountCents: number;
  effectiveOn: string;
  reason: string;
  evidence: string;
  status: "DRAFT" | "APPROVED" | "CANCELLED";
  cancellationReason?: string;
  approvedAt?: string;
  approvedBy?: string;
  batchId?: string;
  paymentIds?: string[];
}
export interface CommissionDeparture {
  id: string;
  version: number;
  producerId: string;
  producerName: string;
  employmentEndOn: string;
  eligibilityThrough?: string;
  accessDisabledOn?: string;
  agreement: string;
  evidence: string;
  reviewOn: string;
  paymentDueOn: string;
  laterReceipts: "CONTINUE" | "REVIEW";
  renewals: "CONTINUE" | "REVIEW";
  status: "DRAFT" | "APPROVED" | "CLOSED";
  approvedAt?: string;
  approvedBy?: string;
  pendingResolutions?: {
    policyId: string;
    receiptCount: number;
    reason: string;
    at: string;
    by: string;
  }[];
  decisions: {
    policyId: string;
    entryId: string;
    earningId?: string;
    outcome: "PAY" | "EXCLUDE";
    reason: string;
    at: string;
    by: string;
  }[];
}
export function allocationFor(
  policy: CommissionPolicy,
  entry: Pick<CommissionEntry, "receivedOn" | "allocationId">,
) {
  return entry.allocationId
    ? policy.allocations?.find((a) => a.id === entry.allocationId)
    : policy.allocations?.filter((a) => a.from <= entry.receivedOn).at(-1);
}
export function validateAllocation(allocation: CommissionAllocation) {
  day(allocation.from);
  required(allocation.agreement, "the shared-production agreement");
  if (allocation.method !== "INDIVIDUAL_PLAN_RATE")
    throw new Error("Use each employee’s own plan rate on their policy share.");
  integer(allocation.houseBps, 0, 10000, "retained house share");
  if (!allocation.participants.length || allocation.participants.length > 10)
    throw new Error(
      "Choose between one and ten employees for the policy allocation.",
    );
  if (
    new Set(allocation.participants.map((p) => p.producerId)).size !==
    allocation.participants.length
  )
    throw new Error("Each employee may appear only once in an allocation.");
  for (const p of allocation.participants) {
    required(p.producerId, "an employee");
    integer(p.shareBps, 1, 10000, "employee share");
    integer(p.producerBps, 0, 10000, "employee plan rate");
  }
  if (
    sum(allocation.participants.map((p) => p.shareBps)) +
      allocation.houseBps !==
    10000
  )
    throw new Error(
      "Employee shares and the retained house share must total 100%.",
    );
  return allocation;
}
/** Rates differ per employee: round each employee’s cumulative entitlement, not a common pool. */
export function receiptEarnings(
  policy: CommissionPolicy,
  entry: CommissionEntry,
  existing: CommissionEarning[],
): CommissionEarning[] {
  if (!entry.allocationId) return [];
  const allocation = policy.allocations?.find(
    (a) => a.id === entry.allocationId,
  );
  if (!allocation)
    throw new Error("The receipt’s approved shared allocation is missing.");
  validateAllocation(allocation);
  return allocation.participants.map((p) => {
    const prior = existing.filter(
      (e) =>
        e.policyId === policy.id &&
        e.producerId === p.producerId &&
        e.allocationId === allocation.id &&
        e.source === "SHARED_RECEIPT" &&
        policy.entries.some(r => r.id === e.entryId && (r.revenueKind ?? "CARRIER_COMMISSION") === (entry.revenueKind ?? "CARRIER_COMMISSION")),
    );
    let amountCents = 0,
      originalEarningId: string | undefined;
    const eligible =
      entry.eligible &&
      p.eligible &&
      (!p.receiptsFrom || entry.receivedOn >= p.receiptsFrom);
    if (entry.kind === "RECEIPT" && eligible) {
      const eligibleReceipts = policy.entries.filter(
        (e) =>
          e.kind === "RECEIPT" &&
          e.allocationId === allocation.id &&
          (e.revenueKind ?? "CARRIER_COMMISSION") === (entry.revenueKind ?? "CARRIER_COMMISSION") &&
          e.eligible &&
          (!p.receiptsFrom || e.receivedOn >= p.receiptsFrom),
      );
      const cash = sum(eligibleReceipts.map((e) => e.agencyCents));
      amountCents =
        ratio(cash, p.shareBps * p.producerBps, 100_000_000) -
        sum(
          prior
            .filter((e) =>
              policy.entries.some(
                (r) => r.id === e.entryId && r.kind === "RECEIPT",
              ),
            )
            .map((e) => e.amountCents),
        );
    } else if (entry.kind !== "RECEIPT") {
      const original = prior.find((e) => e.entryId === entry.originalId);
      const source = policy.entries.find((e) => e.id === entry.originalId);
      if (!original || !source)
        throw new Error("The original shared earnings allocation is missing.");
      originalEarningId = original.id;
      const adjustments = policy.entries.filter(
        (e) => e.originalId === source.id && e.id !== entry.id,
      );
      const used = sum(adjustments.map((e) => Math.abs(e.agencyCents)));
      const share =
        ratio(
          used + Math.abs(entry.agencyCents),
          Math.abs(original.amountCents),
          Math.abs(source.agencyCents),
        ) -
        sum(
          prior
            .filter((e) => e.originalEarningId === original.id)
            .map((e) => Math.abs(e.amountCents)),
        );
      amountCents = entry.kind === "REVERSAL" ? -share : share;
    }
    integer(amountCents, -MONEY_MAX, MONEY_MAX, "shared employee earnings");
    return {
      id: "receipt:" + JSON.stringify([policy.id, entry.id, p.producerId]),
      version: 0,
      producerId: p.producerId,
      producerName: p.producerName,
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      accountName: policy.accountName,
      transaction: policy.transaction,
      entryId: entry.id,
      receivedOn: entry.receivedOn,
      agencyCents: entry.agencyCents,
      producerBps: p.producerBps,
      shareBps: p.shareBps,
      allocationId: allocation.id,
      source: "SHARED_RECEIPT",
      amountCents,
      status:
        entry.kind !== "RECEIPT" ? "REVIEW" : eligible ? "PAYABLE" : "EXCLUDED",
      ...(originalEarningId ? { originalEarningId } : {}),
    };
  });
}
export function validateEarnings(
  earnings: readonly CommissionEarning[],
  batches: readonly CommissionBatch[],
) {
  const fail = () => {
    throw new Error(
      "Employee earnings allocations changed or are incomplete. Refresh before proceeding.",
    );
  };
  for (const e of earnings)
    if (e.batchId) {
      const b = batches.find((b) => b.id === e.batchId);
      if (
        !b ||
        b.status === "CANCELLED" ||
        b.producerId !== e.producerId ||
        e.status !== "PAYABLE" ||
        !b.lines.some(
          (l) =>
            l.earningId === e.id &&
            l.policyId === e.policyId &&
            l.amountCents === e.amountCents,
        )
      )
        fail();
    }
  for (const b of batches.filter((b) => b.status !== "CANCELLED"))
    for (const l of b.lines)
      if (l.earningId) {
        const e = earnings.find((e) => e.id === l.earningId);
        if (
          !e ||
          e.batchId !== b.id ||
          e.producerId !== b.producerId ||
          e.status !== "PAYABLE" ||
          e.amountCents !== l.amountCents ||
          e.policyId !== l.policyId
        )
          fail();
      }
}
export function departureDecision(
  c: CommissionDeparture,
  policyId: string,
  entryId: string,
  receivedOn: string,
  transaction: "NEW" | "RENEWAL",
  earningId?: string,
) {
  const decision = c.decisions.find(
    (d) =>
      d.policyId === policyId &&
      d.entryId === entryId &&
      d.earningId === earningId,
  );
  if (decision) return decision.outcome;
  if (c.status === "DRAFT") return "REVIEW";
  if (c.eligibilityThrough && receivedOn > c.eligibilityThrough)
    return "REVIEW";
  if (
    receivedOn > c.employmentEndOn &&
    (c.laterReceipts === "REVIEW" ||
      (transaction === "RENEWAL" && c.renewals === "REVIEW"))
  )
    return "REVIEW";
  return "PAY";
}
export function departureWorklist(
  c: CommissionDeparture,
  policies: CommissionPolicy[],
  earnings: CommissionEarning[],
  batches: CommissionBatch[],
) {
  const rows = [
    ...policies
      .filter((p) => p.producerId === c.producerId)
      .flatMap((p) =>
        p.entries
          .filter(
            (e) =>
              e.kind === "RECEIPT" &&
              !e.allocationId &&
              !e.supersededBy &&
              e.producerCents > 0,
          )
          .map((e) => ({
            policyId: p.id,
            policyNumber: p.policyNumber,
            entryId: e.id,
            earningId: undefined as string | undefined,
            receivedOn: e.receivedOn,
            transaction: p.transaction,
            amountCents: e.producerCents,
            batchId: e.batchId,
          })),
      ),
    ...earnings
      .filter(
        (e) =>
          e.producerId === c.producerId &&
          (e.status === "PAYABLE" || e.status === "EXCLUDED") &&
          e.amountCents > 0,
      )
      .map((e) => ({
        policyId: e.policyId,
        policyNumber: e.policyNumber,
        entryId: e.entryId,
        earningId: e.id,
        receivedOn: e.receivedOn,
        transaction: e.transaction,
        amountCents: e.amountCents,
        batchId: e.batchId,
      })),
  ].map((r) => {
    const b = batches.find(
      (b) => b.id === r.batchId && b.status !== "CANCELLED",
    );
    return {
      ...r,
      decision: departureDecision(
        c,
        r.policyId,
        r.entryId,
        r.receivedOn,
        r.transaction,
        r.earningId,
      ),
      paymentStatus: b?.status ?? "UNALLOCATED",
      ...(b
        ? { batchPaidCents: batchPaidCents(b), batchTotalCents: b.totalCents }
        : {}),
    };
  });
  const pending = policies
    .filter(
      (p) =>
        p.producerId === c.producerId ||
        p.allocations?.some((a) =>
          a.participants.some((p) => p.producerId === c.producerId),
        ),
    )
    .map((p) => ({
      policyId: p.id,
      policyNumber: p.policyNumber,
      receiptCount: p.entries.length,
      expectedAgencyCents: ratio(p.premiumCents, p.agencyRateUnits, 1_000_000),
      receivedAgencyCents: sum(p.entries.map((e) => e.agencyCents)),
    }))
    .filter(
      (p) =>
        p.expectedAgencyCents > p.receivedAgencyCents &&
        !c.pendingResolutions?.some(
          (r) => r.policyId === p.policyId && r.receiptCount === p.receiptCount,
        ),
    );
  return {
    rows,
    pending,
    adjustments: earnings.filter(
      (e) => e.producerId === c.producerId && e.status === "REVIEW",
    ),
  };
}
