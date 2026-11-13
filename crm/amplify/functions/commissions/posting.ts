import { createHash } from "node:crypto";
import {
  appendEntry,
  type CommissionPolicy,
  type CommissionStatement,
} from "../../../../shared/commissions";
import {
  receiptEarnings,
  type CommissionEarning,
} from "../../../../shared/commissionExceptions";
import * as store from "./store";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const change = (
  kind: string,
  value: unknown,
  previous?: unknown,
): store.Change => ({
  kind,
  value: value as store.Change["value"],
  ...(previous ? { previous: previous as store.Data } : {}),
});
/** Shared posting engine: inbox settlements and legacy reconciliation calculate identically. */
export async function statementPostingChanges(
  statement: CommissionStatement,
  actor: string,
  previous?: CommissionStatement,
) {
  const earnings = await store.list<CommissionEarning>("EARNING");
  const changes: store.Change[] = [],
    originals = new Map<string, CommissionPolicy>(),
    updated = new Map<string, CommissionPolicy>();
  for (const line of statement.lines) {
    const original =
      originals.get(line.policyId) ??
      (await store.get<CommissionPolicy>("POLICY", line.policyId));
    if (!original || original.carrierId !== statement.carrierId)
      throw new Error("A policy match is no longer available.");
    originals.set(original.id, original);
    updated.set(
      original.id,
      appendEntry(
        updated.get(original.id) ?? original,
        line,
        statement,
        `${statement.id}:${line.lineRef}`,
      ),
    );
    const postedPolicy = updated.get(original.id)!;
    const postedEntry = postedPolicy.entries.at(-1)!;
    const allocations = receiptEarnings(postedPolicy, postedEntry, earnings);
    earnings.push(...allocations);
    changes.push(...allocations.map((e) => change("EARNING", e)));
    changes.push(
      change("CARRIER_TRANSACTION", {
        id: hash(`${statement.carrierId}|${line.lineRef.toLowerCase()}`),
        statementId: statement.id,
      }),
    );
  }
  for (const [id, value] of updated)
    changes.push(change("POLICY", value, originals.get(id)));
  changes.push(
    change("SETTLEMENT", {
      id: hash(
        `${statement.carrierId}|${statement.settlementRef.toLowerCase()}`,
      ),
      statementId: statement.id,
      amount: statement.totalCents,
    }),
  );
  changes.push(
    change(
      "STATEMENT",
      {
        ...statement,
        status: "POSTED",
        postedAt: new Date().toISOString(),
        postedBy: actor,
      },
      previous,
    ),
  );
  return changes;
}

/** Validate the entire settlement before locking or posting its first chunk. */
export function assertStatementPostingPlan(
  statement: CommissionStatement,
  policies: CommissionPolicy[],
  savedEarnings: CommissionEarning[],
) {
  const updated = new Map(policies.map((p) => [p.id, p]));
  const earnings = [...savedEarnings];
  const calculations: { policyId: string; lineRef: string; producerId: string; producerName: string; agencyCents: number; producerBps: number; shareBps?: number; amountCents: number; reviewOnly: boolean }[] = [];
  for (const [index, line] of statement.lines.entries()) {
    const policy = updated.get(line.policyId);
    if (!policy || policy.carrierId !== statement.carrierId)
      throw new Error("A policy match is no longer available.");
    const next = appendEntry(
      policy,
      line,
      statement,
      "preflight:" + statement.id + ":" + index,
    );
    const entry = next.entries.at(-1)!;
    const created = receiptEarnings(next, entry, earnings);
    earnings.push(...created);
    if (!entry.allocationId) calculations.push({ policyId: policy.id, lineRef: line.lineRef, producerId: policy.producerId, producerName: policy.producerName, agencyCents: line.agencyCents, producerBps: policy.producerBps, amountCents: entry.producerCents, reviewOnly: line.kind !== 'RECEIPT' });
    for (const earning of created) calculations.push({ policyId: policy.id, lineRef: line.lineRef, producerId: earning.producerId, producerName: earning.producerName, agencyCents: line.agencyCents, producerBps: earning.producerBps, shareBps: earning.shareBps, amountCents: earning.amountCents, reviewOnly: earning.status !== 'PAYABLE' });
    updated.set(policy.id, next);
  }
  return { calculations, employeeCents: calculations.filter(c => !c.reviewOnly).reduce((n,c) => n+c.amountCents,0) };
}
