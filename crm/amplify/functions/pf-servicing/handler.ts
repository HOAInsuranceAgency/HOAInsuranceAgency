import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Schema } from "../../data/resource";
import {
  addDaysIso,
  canRecordCert,
  canRequestCancellation,
  CARRIER_REFUND_DAYS,
  isRealIsoDay,
  NOTICE_DAYS,
  type NoticeRow,
} from "../../../src/lib/premiumFinance/noticeSequence";
import type { ScheduleRow } from "../../../src/lib/premiumFinance/quote";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/**
 * Custom mutation handler: servicePfLoan. Dispatched on `action`.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * Two overlapping requests must not double-post an installment or double-run
 * a transition. Payments get a DETERMINISTIC id — pf-pay-{loanId}-{n} — so
 * the ledger itself refuses a duplicate atomically, and the loan's advance
 * is a conditional write on the paidThrough it was computed from. Status
 * transitions (activate, cancel) are conditional on the status they leave,
 * so the loser of a race fails cleanly instead of writing twice. The same
 * persist.ts shape as everywhere else money moves in this codebase.
 *
 * Timestamps are server-set on every row this creates. The arguments carry
 * exactly two dates from the outside world — the physical USPS certificate's
 * own date, and the cancellation effective date agreed with the carrier —
 * because those are facts about paper and policy, not about when the operator
 * clicked. The click times are ours, and nothing accepts them as input.
 */

type DataClient = ReturnType<typeof generateClient<Schema>>;
let dataClient: DataClient | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

async function logRow(row: {
  accountId: string;
  jurisdiction: string;
  rule: string;
  outcome: "PASS" | "BLOCK";
  reason?: string;
  inputs: Record<string, unknown>;
  actor: string;
  actorName: string;
}) {
  const table = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!table) return;
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          id: randomUUID(),
          __typename: "PfComplianceLog",
          createdAt: now,
          updatedAt: now,
          ...row,
          reason: row.reason ?? null,
          inputs: JSON.stringify(row.inputs),
          configSha256: PF_CONFIG_SHA256,
          occurredAt: now,
        },
      })
    );
  } catch (err) {
    console.error(`[pf-servicing] log write failed for ${row.rule}`, err);
  }
}

/**
 * A conditional status transition on the loan table: apply the patch only if
 * the status is still what the decision read. Returns false on a lost race.
 */
async function transition(
  loanId: string,
  fromStatus: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const loanTable = process.env.PF_LOAN_TABLE;
  if (!loanTable) throw new Error("PF_LOAN_TABLE unset");
  const names: Record<string, string> = { "#s": "status" };
  const sets: string[] = ["updatedAt = :now"];
  const values: Record<string, unknown> = {
    ":from": fromStatus,
    ":now": new Date().toISOString(),
  };
  for (const [i, [k, v]] of Object.entries(patch).entries()) {
    names[`#f${i}`] = k;
    values[`:f${i}`] = v;
    sets.push(`#f${i} = :f${i}`);
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: loanTable,
        Key: { id: loanId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export const handler = async (event: {
  arguments?: {
    loanId?: string;
    action?: string;
    boardResolutionExecutedAt?: string;
    boardResolutionDocumentId?: string;
    noticeId?: string;
    certMailedAt?: string;
    certNumber?: string;
    cancellationEffectiveAt?: string;
  };
  identity?: { sub?: string; username?: string; claims?: Record<string, unknown> };
}): Promise<unknown> => {
  const a = event.arguments ?? {};
  const actor = event.identity?.sub ?? "unknown";
  const actorName =
    (typeof event.identity?.claims?.email === "string"
      ? event.identity.claims.email
      : null) ??
    event.identity?.username ??
    actor;
  if (!a.loanId || !a.action) return { ok: false, error: "Missing loan or action." };

  try {
    const client = await getDataClient();
    const { data: loan } = await client.models.PfLoan.get({ id: a.loanId });
    if (!loan) return { ok: false, error: "That loan no longer exists." };
    const now = new Date().toISOString();

    switch (a.action) {
      /**
       * QUOTED → ACTIVE, behind the staleness rule: the executed board
       * resolution must be from the financed term. A resolution executed
       * before the term's effective date is the prior board's paper — boards
       * turn over annually and a receiver can replace one mid-term — and the
       * power of attorney must trace to a body that currently exists.
       */
      case "ACTIVATE": {
        if (loan.status !== "QUOTED") {
          return { ok: false, error: `A ${loan.status.toLowerCase()} loan cannot be activated.` };
        }
        const executed = a.boardResolutionExecutedAt;
        if (!isRealIsoDay(executed)) {
          return { ok: false, error: "The board resolution's execution date is required." };
        }
        const { data: policy } = await client.models.Policy.get({ id: loan.policyId });
        const termStart = policy?.effectiveDate ?? loan.effectiveDate;
        const stale = executed < termStart;
        await logRow({
          accountId: loan.accountId,
          jurisdiction: loan.state,
          rule: "board-resolution",
          outcome: stale ? "BLOCK" : "PASS",
          reason: stale
            ? `Resolution executed ${executed} predates the financed term effective ${termStart}. A current-term resolution is required.`
            : undefined,
          inputs: { loanId: loan.id, executed, termStart },
          actor,
          actorName,
        });
        if (stale) {
          return {
            ok: false,
            error: `That resolution was executed ${executed}, before the financed term began (${termStart}). Boards turn over — obtain a resolution executed for the current term.`,
          };
        }
        const won = await transition(loan.id, "QUOTED", {
          status: "ACTIVE",
          activatedAt: now,
          boardResolutionExecutedAt: executed,
          boardResolutionDocumentId: a.boardResolutionDocumentId ?? null,
        });
        if (!won) return { ok: false, error: "The loan changed underneath this activation. Look at it and try again." };
        return { ok: true };
      }

      /**
       * Post the next scheduled installment, exactly. Partial and irregular
       * amounts are a per-state design of their own; until that exists, a
       * posting is the schedule row or it is refused — which also keeps the
       * interest/principal split beyond argument.
       */
      case "POST_PAYMENT": {
        if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") {
          return { ok: false, error: `A ${loan.status.toLowerCase()} loan cannot take a payment.` };
        }
        const { data: settings } = await client.models.AgencySettings.get({
          id: "AGENCY",
        });
        const bankAccount = settings?.pfLendingAccountName?.trim();
        if (!bankAccount) {
          // The segregation rule with teeth: no designated lending account,
          // no postings. Receipts must never default into the trust.
          return {
            ok: false,
            error: "No designated lending account is configured. Set it under Financing before posting — loan money must not touch the premium trust.",
          };
        }
        const schedule: ScheduleRow[] =
          typeof loan.schedule === "string" ? JSON.parse(loan.schedule) : (loan.schedule as never);
        const n = (loan.paidThrough ?? 0) + 1;
        const row = schedule[n - 1];
        if (!row) return { ok: false, error: "The schedule is fully paid." };

        /**
         * The ledger row's id IS the idempotency key: one row per loan per
         * installment number can exist, and the condition makes the second
         * writer fail at the ledger itself rather than after it.
         */
        const payTable = process.env.PF_LOAN_PAYMENT_TABLE;
        const loanTable = process.env.PF_LOAN_TABLE;
        if (!payTable || !loanTable) {
          return { ok: false, error: "Servicing tables are not configured." };
        }
        try {
          await ddb.send(
            new PutCommand({
              TableName: payTable,
              Item: {
                id: `pf-pay-${loan.id}-${n}`,
                __typename: "PfLoanPayment",
                createdAt: now,
                updatedAt: now,
                loanId: loan.id,
                accountId: loan.accountId,
                n,
                amount: row.payment,
                interest: row.interest,
                principal: row.principal,
                bankAccount,
                postedAt: now,
                postedBy: actor,
                postedByName: actorName,
              },
              ConditionExpression: "attribute_not_exists(id)",
            })
          );
        } catch (err) {
          if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
            return { ok: false, error: `Installment ${n} is already posted.` };
          }
          throw err;
        }

        const finished = n >= schedule.length;
        /**
         * Advance the loan conditionally on the paidThrough this posting was
         * computed from. If the update fails after the ledger row landed, the
         * row stands (it is true — the money posted) and the next POST_PAYMENT
         * attempt self-heals: the ledger refuses n again, and this branch is
         * re-runnable because the condition below tolerates the healed state.
         */
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: loanTable,
              Key: { id: loan.id },
              UpdateExpression:
                "SET paidThrough = :n, balance = :bal, nextDueAt = :next, #s = :status, updatedAt = :now" +
                (finished ? ", closedAt = :now" : "") +
                (loan.status === "DEFAULTED" && !finished ? " REMOVE defaultedAt" : ""),
              ConditionExpression: "paidThrough = :seen OR paidThrough = :n",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":n": n,
                ":bal": row.balance,
                ":next": finished ? null : schedule[n].dueDate,
                ":status": finished ? "PAID" : "ACTIVE",
                ":now": now,
                ":seen": loan.paidThrough ?? 0,
              },
            })
          );
        } catch (err) {
          if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
          console.error(`[pf-servicing] loan ${loan.id} moved during posting ${n}; ledger row stands`);
        }
        return { ok: true, posted: { n, amount: row.payment, balance: row.balance } };
      }

      /** Step one of cancellation: the 15-day clock starts here. */
      case "NOTICE_INTENT": {
        if (loan.status !== "DEFAULTED") {
          return { ok: false, error: "Intent to cancel is sent on a defaulted loan only." };
        }
        const { data: notice, errors } = await client.models.PfNotice.create({
          loanId: loan.id,
          accountId: loan.accountId,
          type: "INTENT_TO_CANCEL",
          occurredAt: now,
          clockExpiresAt: addDaysIso(now, NOTICE_DAYS),
          createdBy: actor,
          createdByName: actorName,
        });
        if (errors?.length || !notice) throw new Error(errors?.[0]?.message);
        return { ok: true, noticeId: notice.id, clockExpiresAt: notice.clockExpiresAt };
      }

      /** The USPS certificate, without which nothing advances. */
      case "RECORD_CERT": {
        if (!a.noticeId || !isRealIsoDay(a.certMailedAt) || !a.certNumber?.trim()) {
          return { ok: false, error: "The certificate needs its notice, mailing date, and USPS number." };
        }
        const { data: noticeRows } = await client.models.PfNotice.list({
          filter: { loanId: { eq: loan.id } },
          limit: 200,
        });
        const verdict = canRecordCert(noticeRows as NoticeRow[], a.noticeId);
        if (!verdict.ok) return { ok: false, error: verdict.reason };
        const { errors } = await client.models.PfNotice.create({
          loanId: loan.id,
          accountId: loan.accountId,
          type: "CERT_OF_MAILING",
          occurredAt: now,
          refNoticeId: a.noticeId,
          certMailedAt: a.certMailedAt,
          certNumber: a.certNumber.trim(),
          createdBy: actor,
          createdByName: actorName,
        });
        if (errors?.length) throw new Error(errors[0].message);
        return { ok: true };
      }

      /**
       * Only after the 15 days expire, with a certificate on file. The
       * sequence check is the pure module the tests exercise; its refusal
       * strings name the missing step.
       */
      case "REQUEST_CANCELLATION": {
        if (loan.status !== "DEFAULTED") {
          return { ok: false, error: "Cancellation is requested on a defaulted loan only." };
        }
        const effective = a.cancellationEffectiveAt;
        if (!isRealIsoDay(effective)) {
          return { ok: false, error: "The cancellation effective date is required." };
        }
        const { data: noticeRows } = await client.models.PfNotice.list({
          filter: { loanId: { eq: loan.id } },
          limit: 200,
        });
        const verdict = canRequestCancellation(noticeRows as NoticeRow[], now);
        await logRow({
          accountId: loan.accountId,
          jurisdiction: loan.state,
          rule: "notice-clock",
          outcome: verdict.ok ? "PASS" : "BLOCK",
          reason: verdict.ok ? undefined : verdict.reason,
          inputs: { loanId: loan.id, effective },
          actor,
          actorName,
        });
        if (!verdict.ok) return { ok: false, error: verdict.reason };

        const intent = (noticeRows as NoticeRow[]).find(
          (r) => r.type === "INTENT_TO_CANCEL"
        );
        /**
         * The transition first, conditionally — the winner of a double-click
         * proceeds to write the notice row; the loser stops here without a
         * second CANCELLATION_REQUEST existing. A notice-row failure after
         * the transition is logged loudly and left: the cancellation stands,
         * and the missing row is visible in the sequence view.
         */
        const wonCancel = await transition(loan.id, "DEFAULTED", {
          status: "CANCELLED",
          cancellationEffectiveAt: effective,
          // The unearned-premium receivable: the carrier owes the refund
          // within 30 days of the cancellation effective date.
          expectedCarrierRefundAt: addDaysIso(`${effective}T00:00:00.000Z`, CARRIER_REFUND_DAYS).slice(0, 10),
          closedAt: now,
        });
        if (!wonCancel) {
          return { ok: false, error: "The loan changed underneath this cancellation. Look at it and try again." };
        }
        const { errors: nErr } = await client.models.PfNotice.create({
          loanId: loan.id,
          accountId: loan.accountId,
          type: "CANCELLATION_REQUEST",
          occurredAt: now,
          refNoticeId: intent?.id ?? null,
          createdBy: actor,
          createdByName: actorName,
        });
        if (nErr?.length) {
          console.error(`[pf-servicing] CANCELLATION stands on ${loan.id} but its notice row failed`, nErr[0].message);
        }
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown action "${a.action}".` };
    }
  } catch (err) {
    console.error("pf-servicing failed", err);
    return { ok: false, error: "Servicing action failed. Try again." };
  }
};
