import { bindDay } from "./account-history";
import { departureStatement, departureReportFile } from "./departure-report";
import { randomUUID } from "node:crypto";
import {
  day,
  required,
  integer,
  MONEY_MAX,
  batchPaidCents,
  recoveryBalances,
  selectCommissionTerms,
  type CommissionPolicy,
  type CommissionPlan,
  type CommissionAccount,
  type CommissionBatch,
} from "../../../../shared/commissions";
import {
  validateAllocation,
  departureWorklist,
  type CommissionAllocation,
  type CommissionEarning,
  type CommissionDeparture,
  type CommissionAdjustment,
} from "../../../../shared/commissionExceptions";
import type { PayrollCycle } from "../../../../shared/commissionPayroll";
import { payrollDay } from "../../../../shared/commissionPayroll";
import { change, condition } from "./payroll";
import * as store from "./store";
export const exceptionOperations = new Set([
  "commissionExceptions",
  "resolveCommissionEarningReview",
  "downloadDepartureStatement",
  "approvePolicyAllocation",
  "saveCommissionDeparture",
  "approveCommissionDeparture",
  "decideDepartureEarning",
  "closeCommissionDeparture",
  "settleDeparturePolicy",
  "saveCommissionAdjustment",
  "cancelCommissionAdjustment",
  "approveCommissionAdjustment",
]);
const version = (input: store.Data, old?: { version: number }) => {
  if (input.version !== (old?.version ?? 0))
    throw new Error("Commission records changed. Refresh before saving.");
};
async function reconciliation() {
  return store.get<{ id: string; version: number }>(
    "PAYROLL_STATE",
    "reconciliation",
  );
}
async function holdEmployeeCycles(producerId: string) {
  const batches = await store.list<CommissionBatch>("BATCH");
  return (await store.list<PayrollCycle>("PAYROLL_CYCLE"))
    .filter(
      (c) =>
        c.status === "APPROVED" &&
        batches.some(
          (b) => b.producerId === producerId && c.batchIds.includes(b.id),
        ),
    )
    .map((c) =>
      change(
        "PAYROLL_CYCLE",
        {
          ...c,
          reviewRequired:
            "Departure or eligibility terms changed. Review this report with HR and approve a corrected unpaid revision if required.",
        },
        c,
      ),
    );
}
export async function exceptionAction(
  actor: string,
  operation: string,
  input: store.Data,
) {
  if (operation === "commissionExceptions") {
    const [policies, earnings, departures, adjustments, batches, plans] =
      await Promise.all([
        store.list<CommissionPolicy>("POLICY"),
        store.list<CommissionEarning>("EARNING"),
        store.list<CommissionDeparture>("DEPARTURE"),
        store.list<CommissionAdjustment>("ADJUSTMENT"),
        store.list<CommissionBatch>("BATCH"),
        store.list<CommissionPlan>("PLAN"),
      ]);
    return {
      ok: true,
      policies,
      earnings,
      departures: departures.map((c) => ({
        ...c,
        worklist: departureWorklist(c, policies, earnings, batches),
      })),
      adjustments,
      carrierAdjustments: policies.map(p => ({ policyId: p.id, policyNumber: p.policyNumber, accountName: p.accountName, ...recoveryBalances(p, batches) })).filter(r => r.unpaidAdjustment || r.paidRecovery || r.partialAdjustment),
      producers: plans.map((p) => ({ id: p.producerId, name: p.name })),
    };
  }
  const state = await reconciliation();
  const at = new Date().toISOString();
  if (operation === "resolveCommissionEarningReview") {
    const e = await store.get<CommissionEarning>(
      "EARNING",
      required(input.id, "an earnings review"),
    );
    if (!e || e.status !== "REVIEW" || e.batchId)
      throw new Error("Choose an unresolved, unallocated earnings review.");
    version(input, e);
    if (input.confirmed !== true)
      throw new Error("Confirm the documented resolution.");
    const reason = required(
      input.reason,
      "the reviewed agreement and external resolution evidence",
      2000,
    );
    await store.commit(
      [
        change("EARNING", { ...e, status: "RESOLVED" }, e),
        change("EARNING_REVIEW", {
          id: randomUUID(),
          earningId: e.id,
          reason,
          at,
          by: actor,
          amountCents: e.amountCents,
        }),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
      ],
      actor,
    );
    return { ok: true };
  }
  if (operation === "downloadDepartureStatement") {
    const c = await store.get<CommissionDeparture>(
      "DEPARTURE",
      required(input.id, "a departure case"),
    );
    if (!c || c.status === "DRAFT")
      throw new Error(
        "Approve departure terms before creating a review statement.",
      );
    const [policies, earnings, batches] = await Promise.all([
      store.list<CommissionPolicy>("POLICY"),
      store.list<CommissionEarning>("EARNING"),
      store.list<CommissionBatch>("BATCH"),
    ]);
    const worklist = departureWorklist(c, policies, earnings, batches);
    const report = await departureStatement(c, worklist, at),
      id = c.id + ":" + report.snapshotHash;
    const old = await store.get<typeof report>("DEPARTURE_REPORT", id);
    const conditions = [
      condition("DEPARTURE", c),
      ...batches
        .filter((b) => b.producerId === c.producerId)
        .map((b) => condition("BATCH", b)),
    ];
    await store.commit(
      [
        ...(old ? [] : [change("DEPARTURE_REPORT", { ...report, id })]),
        change("DEPARTURE_REPORT_ACCESS", {
          id: randomUUID(),
          reportId: id,
          at,
          actor,
        }),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
      ],
      actor,
      conditions,
    );
    return { ok: true, files: [departureReportFile(old ?? report)] };
  }
  if (operation === "approvePolicyAllocation") {
    if (input.confirmed !== true)
      throw new Error(
        "Confirm the policy allocation and agreement before approval.",
      );
    const policy = await store.get<CommissionPolicy>(
      "POLICY",
      required(input.id, "a policy"),
    );
    if (!policy) throw new Error("Commission policy not found.");
    version(input, policy);
    const from = day(input.from);
    if (policy.entries.some((e) => e.receivedOn >= from))
      throw new Error(
        "A new allocation must start after all posted receipt dates. Use an explicit adjustment for historical corrections.",
      );
    if (policy.allocations?.some((a) => a.from >= from))
      throw new Error(
        "New allocations must follow the last approved allocation date.",
      );
    if ((policy.allocations?.length ?? 0) >= 25)
      throw new Error(
        "Review allocation history before adding another version.",
      );
    if (!Array.isArray(input.participants))
      throw new Error("Choose the policy participants.");
    const participants: CommissionAllocation["participants"] = [],
      checks: store.Transaction = [];
    const account = await store.get<CommissionAccount>(
      "ACCOUNT",
      policy.accountId,
    );
    const frozenAccount = policy.accountClassification
      ? {
          id: policy.accountId,
          version: policy.accountClassification.version,
          name: policy.accountName,
          periods: [policy.accountClassification],
        }
      : account;
    for (const raw of input.participants as store.Data[]) {
      const producerId = required(raw.producerId, "an employee", 128),
        plan = await store.get<CommissionPlan>("PLAN", producerId);
      if (!plan)
        throw new Error("Assign this employee a commission plan first.");
      const selected = selectCommissionTerms(
        plan,
        frozenAccount,
        policy.transaction === "RENEWAL"
          ? policy.effectiveDate
          : day(bindDay(policy.boundAt)),
        policy.transaction,
        policy.eligibility?.accountFirstBoundOn ?? account?.firstBoundOn,
      );
      participants.push({
        producerId,
        producerName: plan.name,
        shareBps: integer(raw.shareBps, 1, 10000, "employee share"),
        producerBps: selected.producerBps,
        planVersion: plan.version,
        agreement: selected.agreement,
        eligible: selected.eligibility?.eligible !== false,
        ...(selected.receiptsFrom
          ? { receiptsFrom: selected.receiptsFrom }
          : {}),
      });
      checks.push(condition("PLAN", plan));
    }
    const allocation = validateAllocation({
      id: randomUUID(),
      from,
      agreement: required(input.agreement, "the allocation agreement", 2000),
      method: "INDIVIDUAL_PLAN_RATE",
      houseBps: integer(input.houseBps, 0, 10000, "house share"),
      participants,
      approvedBy: actor,
      approvedAt: at,
    });
    await store.commit(
      [
        change(
          "POLICY",
          {
            ...policy,
            allocations: [...(policy.allocations ?? []), allocation],
          },
          policy,
        ),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
      ],
      actor,
      checks,
    );
    return { ok: true };
  }
  if (operation === "saveCommissionDeparture") {
    const producerId = required(input.producerId, "an employee", 128),
      old = await store.get<CommissionDeparture>("DEPARTURE", producerId),
      plan = await store.get<CommissionPlan>("PLAN", producerId);
    if (!plan) throw new Error("Choose an employee with a commission plan.");
    version(input, old);
    if (
      !["CONTINUE", "REVIEW"].includes(String(input.laterReceipts)) ||
      !["CONTINUE", "REVIEW"].includes(String(input.renewals))
    )
      throw new Error(
        "Choose how later receipts and renewals will be reviewed.",
      );
    const next: CommissionDeparture = {
      id: producerId,
      producerId,
      producerName: plan.name,
      version: Number(input.version),
      employmentEndOn: day(input.employmentEndOn),
      agreement: required(input.agreement, "the governing departure agreement"),
      evidence: required(input.evidence, "supporting departure evidence", 2000),
      reviewOn: day(input.reviewOn),
      paymentDueOn: day(input.paymentDueOn),
      laterReceipts: input.laterReceipts as "CONTINUE" | "REVIEW",
      renewals: input.renewals as "CONTINUE" | "REVIEW",
      status: "DRAFT",
      decisions: old?.decisions ?? [],
      pendingResolutions: old?.pendingResolutions ?? [],
      ...(input.eligibilityThrough
        ? { eligibilityThrough: day(input.eligibilityThrough) }
        : {}),
      ...(input.accessDisabledOn
        ? { accessDisabledOn: day(input.accessDisabledOn) }
        : {}),
    };
    await store.commit(
      [
        change("DEPARTURE", next, old),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
        ...(await holdEmployeeCycles(producerId)),
      ],
      actor,
    );
    return { ok: true };
  }
  if (
    [
      "approveCommissionDeparture",
      "decideDepartureEarning",
      "closeCommissionDeparture",
      "settleDeparturePolicy",
    ].includes(operation)
  ) {
    const old = await store.get<CommissionDeparture>(
      "DEPARTURE",
      required(input.id, "a departure case"),
    );
    if (!old) throw new Error("Departure case not found.");
    version(input, old);
    if (input.confirmed !== true)
      throw new Error("Confirm the departure decision.");
    if (operation === "approveCommissionDeparture") {
      if (old.status !== "DRAFT")
        throw new Error("Only draft departure terms can be approved.");
      await store.commit(
        [
          change(
            "DEPARTURE",
            { ...old, status: "APPROVED", approvedAt: at, approvedBy: actor },
            old,
          ),
          change("PAYROLL_STATE", { id: "reconciliation" }, state),
        ],
        actor,
      );
      return { ok: true };
    }
    if (old.status === "DRAFT")
      throw new Error("Approve the departure terms first.");
    const [policies, earnings, batches] = await Promise.all([
      store.list<CommissionPolicy>("POLICY"),
      store.list<CommissionEarning>("EARNING"),
      store.list<CommissionBatch>("BATCH"),
    ]);
    const worklist = departureWorklist(old, policies, earnings, batches);
    if (operation === "settleDeparturePolicy") {
      const pending = worklist.pending.find(
          (p) => p.policyId === input.policyId,
        ),
        policy = policies.find((p) => p.id === input.policyId);
      if (!pending || !policy)
        throw new Error(
          "Choose a pending policy balance from this departure worklist.",
        );
      const resolution = {
        policyId: policy.id,
        receiptCount: policy.entries.length,
        reason: required(
          input.reason,
          "evidence that no further carrier receipts are expected",
          2000,
        ),
        at,
        by: actor,
      };
      await store.commit(
        [
          change(
            "DEPARTURE",
            {
              ...old,
              status: "APPROVED",
              pendingResolutions: [
                ...(old.pendingResolutions ?? []),
                resolution,
              ],
            },
            old,
          ),
          change("PAYROLL_STATE", { id: "reconciliation" }, state),
        ],
        actor,
        [condition("POLICY", policy)],
      );
      return { ok: true };
    }
    if (operation === "closeCommissionDeparture") {
      if (
        worklist.pending.length ||
        worklist.adjustments.length ||
        worklist.rows.some(
          (r) =>
            r.decision === "REVIEW" ||
            (r.decision === "PAY" && r.paymentStatus !== "PAID"),
        )
      )
        throw new Error(
          "Resolve pending carrier receipts, eligibility reviews, adjustments, and payments before closing.",
        );
      await store.commit(
        [
          change("DEPARTURE", { ...old, status: "CLOSED" }, old),
          change("PAYROLL_STATE", { id: "reconciliation" }, state),
        ],
        actor,
      );
      return { ok: true };
    }
    const row = worklist.rows.find(
      (r) =>
        r.policyId === input.policyId &&
        r.entryId === input.entryId &&
        r.earningId === input.earningId,
    );
    if (!row)
      throw new Error(
        "Choose an earnings item from this employee’s departure worklist.",
      );
    if (row.batchId)
      throw new Error(
        "Reopen the unpaid payroll report before changing this eligibility decision. Paid history cannot be excluded.",
      );
    if (!["PAY", "EXCLUDE"].includes(String(input.outcome)))
      throw new Error("Choose payable or excluded.");
    if (
      old.decisions.some(
        (d) =>
          d.policyId === row.policyId &&
          d.entryId === row.entryId &&
          d.earningId === row.earningId,
      )
    )
      throw new Error(
        "This item already has an approved decision. Use a linked adjustment for a correction.",
      );
    const sourceEarning = earnings.find((e) => e.id === row.earningId),
      sourcePolicy = policies.find((p) => p.id === row.policyId)!;
    if (input.outcome === "PAY" && sourceEarning?.status === "REVIEW")
      throw new Error(
        "Use an explicit compensation adjustment to resolve proposed restoration or recovery amounts.",
      );
    const decision = {
      policyId: row.policyId,
      entryId: row.entryId,
      ...(row.earningId ? { earningId: row.earningId } : {}),
      outcome: input.outcome as "PAY" | "EXCLUDE",
      reason: required(
        input.reason,
        "the eligibility decision and agreement evidence",
        2000,
      ),
      at,
      by: actor,
    };
    const sourceChanges =
      input.outcome === "EXCLUDE"
        ? [
            sourceEarning
              ? change(
                  "EARNING",
                  { ...sourceEarning, status: "EXCLUDED" },
                  sourceEarning,
                )
              : change(
                  "POLICY",
                  {
                    ...sourcePolicy,
                    entries: sourcePolicy.entries.map((e) =>
                      e.id === row.entryId
                        ? { ...e, excludedByCase: old.id }
                        : e,
                    ),
                  },
                  sourcePolicy,
                ),
          ]
        : [];
    await store.commit(
      [
        change(
          "DEPARTURE",
          {
            ...old,
            status: "APPROVED",
            decisions: [...old.decisions, decision],
          },
          old,
        ),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
        ...sourceChanges,
      ],
      actor,
      sourceChanges.length
        ? []
        : [
            sourceEarning
              ? condition("EARNING", sourceEarning)
              : condition("POLICY", sourcePolicy),
          ],
    );
    return { ok: true };
  }
  if (operation === "cancelCommissionAdjustment") {
    const old = await store.get<CommissionAdjustment>(
      "ADJUSTMENT",
      required(input.id, "an adjustment"),
    );
    if (!old || old.status !== "DRAFT")
      throw new Error("Only a draft adjustment can be cancelled.");
    version(input, old);
    const reason = required(
      input.reason,
      "the draft cancellation reason",
      2000,
    );
    await store.commit(
      [
        change(
          "ADJUSTMENT",
          { ...old, status: "CANCELLED", cancellationReason: reason },
          old,
        ),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
      ],
      actor,
    );
    return { ok: true };
  }
  if (operation === "saveCommissionAdjustment") {
    const id = required(input.id, "a stable adjustment ID", 128),
      old = await store.get<CommissionAdjustment>("ADJUSTMENT", id);
    version(input, old);
    if (old && old.status !== "DRAFT")
      throw new Error(
        "Approved adjustments are immutable. Create a new linked correction.",
      );
    const policy = await store.get<CommissionPolicy>(
      "POLICY",
      required(input.policyId, "the original policy"),
    );
    if (!policy) throw new Error("Original policy not found.");
    const producerId = required(input.producerId, "an employee"),
      plan = await store.get<CommissionPlan>("PLAN", producerId);
    if (!plan) throw new Error("Choose an employee with a commission plan.");
    if (
      !["ADDITIONAL", "UNPAID_CORRECTION", "PAID_RECOVERY"].includes(
        String(input.kind),
      )
    )
      throw new Error("Choose an adjustment type.");
    const targetEarningId = input.targetEarningId
      ? required(input.targetEarningId, "the original earning")
      : undefined;
    const targetEntryId = input.targetEntryId
      ? required(input.targetEntryId, "the original receipt")
      : undefined;
    const earning = targetEarningId
      ? await store.get<CommissionEarning>("EARNING", targetEarningId)
      : undefined;
    const entry = targetEntryId
      ? policy.entries.find((e) => e.id === targetEntryId)
      : undefined;
    if (
      earning &&
      (earning.producerId !== producerId || earning.policyId !== policy.id)
    )
      throw new Error(
        "The original earning belongs to another employee or policy.",
      );
    if (
      (targetEarningId && !earning) ||
      (targetEntryId &&
        (!entry || policy.producerId !== producerId || entry.allocationId))
    )
      throw new Error("Choose the original employee earnings allocation.");
    if (input.kind !== "ADDITIONAL" && !earning && !entry)
      throw new Error(
        "A correction or recovery must link to its original earnings.",
      );
    if (input.kind === "ADDITIONAL" && (earning || entry))
      throw new Error(
        "Use an unpaid correction to replace an original amount.",
      );
    if (
      (earning && (earning.status !== "PAYABLE" || earning.supersededBy)) ||
      (entry &&
        (entry.kind !== "RECEIPT" ||
          !entry.eligible ||
          entry.supersededBy ||
          entry.excludedByCase))
    )
      throw new Error(
        "Choose an eligible, unchanged original earning for a correction or recovery.",
      );
    if (targetEarningId && targetEntryId)
      throw new Error("Choose one original employee earning.");
    const originalCents = earning?.amountCents ?? entry?.producerCents ?? 0;
    const correctedCents = integer(
      input.correctedCents,
      0,
      MONEY_MAX,
      "corrected earnings amount",
    );
    const amountCents = correctedCents - originalCents;
    if (
      (input.kind === "ADDITIONAL" && amountCents <= 0) ||
      (input.kind === "PAID_RECOVERY" && amountCents >= 0) ||
      amountCents === 0
    )
      throw new Error(
        "Enter a nonzero adjustment with the selected direction.",
      );
    const next: CommissionAdjustment = {
      id,
      version: Number(input.version),
      policyId: policy.id,
      producerId,
      adjustmentType: input.kind as CommissionAdjustment["adjustmentType"],
      originalCents,
      correctedCents,
      amountCents,
      effectiveOn: day(input.effectiveOn),
      reason: required(input.reason, "the adjustment reason", 2000),
      evidence: required(input.evidence, "supporting agreement evidence", 2000),
      status: "DRAFT",
      ...(targetEarningId ? { targetEarningId } : {}),
      ...(targetEntryId ? { targetEntryId } : {}),
    };
    await store.commit(
      [
        change("ADJUSTMENT", next, old),
        change("PAYROLL_STATE", { id: "reconciliation" }, state),
        ...(next.adjustmentType === "UNPAID_CORRECTION"
          ? await holdEmployeeCycles(producerId)
          : []),
      ],
      actor,
    );
    return { ok: true };
  }
  if (operation === "approveCommissionAdjustment") {
    const old = await store.get<CommissionAdjustment>(
      "ADJUSTMENT",
      required(input.id, "an adjustment"),
    );
    if (!old) throw new Error("Adjustment not found.");
    version(input, old);
    if (old.status !== "DRAFT" || input.confirmed !== true)
      throw new Error("Review and confirm the draft adjustment.");
    if (old.effectiveOn > payrollDay())
      throw new Error(
        "Approve an earnings adjustment on or after its effective date.",
      );
    const policy = await store.get<CommissionPolicy>("POLICY", old.policyId),
      plan = await store.get<CommissionPlan>("PLAN", old.producerId);
    if (!policy || !plan)
      throw new Error("The policy or employee plan is missing.");
    const target = old.targetEarningId
      ? await store.get<CommissionEarning>("EARNING", old.targetEarningId)
      : undefined;
    const entry = old.targetEntryId
      ? policy.entries.find((e) => e.id === old.targetEntryId)
      : undefined;
    if (
      old.adjustmentType !== "ADDITIONAL" &&
      ((!target && !entry) ||
        (target?.amountCents ?? entry?.producerCents) !== old.originalCents ||
        target?.supersededBy ||
        entry?.supersededBy ||
        (target && target.status !== "PAYABLE") ||
        (entry &&
          (entry.kind !== "RECEIPT" ||
            !entry.eligible ||
            entry.excludedByCase)))
    )
      throw new Error("Original earnings changed. Review a new adjustment.");
    const batchId = target?.batchId ?? entry?.batchId,
      batch = batchId
        ? await store.get<CommissionBatch>("BATCH", batchId)
        : undefined;
    if (old.adjustmentType === "UNPAID_CORRECTION" && batchId)
      throw new Error(
        "Reopen the unpaid payroll report before correcting this amount.",
      );
    if (
      old.adjustmentType === "PAID_RECOVERY" &&
      (!batch || batchPaidCents(batch) === 0)
    )
      throw new Error(
        "A paid recovery must link to a recorded employee payment.",
      );
    if (old.adjustmentType === "PAID_RECOVERY") {
      const prior = (
        await store.list<CommissionAdjustment>("ADJUSTMENT")
      ).filter(
        (a) =>
          a.status === "APPROVED" &&
          a.adjustmentType === "PAID_RECOVERY" &&
          a.policyId === old.policyId &&
          a.producerId === old.producerId &&
          a.targetEntryId === old.targetEntryId &&
          a.targetEarningId === old.targetEarningId,
      );
      if (
        prior.reduce((n, a) => n - a.amountCents, 0) - old.amountCents >
        old.originalCents
      )
        throw new Error(
          "Approved recovery proposals exceed the original employee earnings.",
        );
    }
    const id = "adjustment:" + old.id;
    const earning: CommissionEarning = {
      id,
      version: 0,
      producerId: old.producerId,
      producerName: plan.name,
      policyId: policy.id,
      policyNumber: policy.policyNumber,
      accountName: policy.accountName,
      transaction: policy.transaction,
      entryId: old.targetEntryId ?? target?.entryId ?? old.id,
      receivedOn: old.effectiveOn,
      agencyCents: 0,
      producerBps: 0,
      amountCents:
        old.adjustmentType === "PAID_RECOVERY"
          ? old.amountCents
          : old.correctedCents,
      source: "ADJUSTMENT",
      adjustmentId: old.id,
      status: old.adjustmentType === "PAID_RECOVERY" ? "REVIEW" : "PAYABLE",
      ...(target ? { originalEarningId: target.id } : {}),
    };
    const changes: store.Change[] = [
      change("EARNING", earning),
      change(
        "ADJUSTMENT",
        {
          ...old,
          status: "APPROVED",
          approvedAt: at,
          approvedBy: actor,
          ...(batch
            ? {
                batchId: batch.id,
                paymentIds: batch.payments?.map((p) => p.id) ?? [],
              }
            : {}),
        },
        old,
      ),
      change("PAYROLL_STATE", { id: "reconciliation" }, state),
    ];
    if (old.adjustmentType === "UNPAID_CORRECTION") {
      if (target)
        changes.push(
          change(
            "EARNING",
            { ...target, status: "SUPERSEDED", supersededBy: id },
            target,
          ),
        );
      else
        changes.push(
          change(
            "POLICY",
            {
              ...policy,
              entries: policy.entries.map((e) =>
                e.id === entry!.id ? { ...e, supersededBy: id } : e,
              ),
            },
            policy,
          ),
        );
    }
    await store.commit(changes, actor, [
      ...(old.adjustmentType === "UNPAID_CORRECTION" && !target
        ? []
        : [condition("POLICY", policy)]),
      ...(target && old.adjustmentType !== "UNPAID_CORRECTION"
        ? [condition("EARNING", target)]
        : []),
      ...(batch ? [condition("BATCH", batch)] : []),
    ]);
    return { ok: true };
  }
  throw new Error("Unknown commission exception action.");
}
