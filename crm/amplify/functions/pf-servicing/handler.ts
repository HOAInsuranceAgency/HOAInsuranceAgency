import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Schema } from "../../data/resource";
import {
  addDaysIso,
  canRecordCert,
  canRequestCancellation,
  latestIntent,
  CARRIER_REFUND_DAYS,
  isRealIsoDay,
  NOTICE_DAYS,
  type NoticeRow,
} from "../../../src/lib/premiumFinance/noticeSequence";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";
import { postInstallment } from "../pfPosting";

/**
 * Custom mutation handler: servicePfLoan. Dispatched on `action`.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * Two overlapping requests must not double-post an installment or double-run
 * a transition. Payments get a DETERMINISTIC id — pf-pay-{loanId}-{n} — so
 * the ledger itself refuses a duplicate atomically, and the loan's advance
 * is a conditional write on the paidThrough it was computed from. Cancellation
 * transitions are conditional on the status they leave,
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

export const handler = async (event: {
  arguments?: {
    loanId?: string;
    action?: string;
    /** Deprecated compatibility arguments; no document-based activation exists. */
    boardResolutionExecutedAt?: string;
    boardResolutionDocumentId?: string;
    noticeId?: string;
    certMailedAt?: string;
    certNumber?: string;
    cancellationEffectiveAt?: string;
    policyId?: string;
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
      // Kept as a refusal for older clients. Only settlement enables collection.
      case "ACTIVATE":
        return { ok: false, error: "Financing starts automatically when the initial payment settles after the financing agreement is signed. No separate activation is needed." };

      /**
       * W8: a quote became a policy — the loan follows it. Clients cannot
       * write loans, so the bind flow calls this; the write is conditional
       * on the loan still anchoring the quote the policy descends from, and
       * the policy's own quoteId is checked so a wrong policy id cannot
       * re-anchor someone else's loan. quoteId stays on the loan (history,
       * and every anchor scan matches either id). Terminal loans do not
       * roll: a cancelled or paid loan's record keeps the anchor it closed
       * under.
       */
      case "BIND_ROLLOVER": {
        const newPolicyId = a.policyId?.trim();
        if (!newPolicyId) return { ok: false, error: "The bound policy's id is required." };
        if (!loan.quoteId) {
          return { ok: false, error: "This loan is not anchored to a quote — nothing to roll." };
        }
        if (loan.policyId === newPolicyId) return { ok: true, note: "Already rolled." };
        if (loan.status === "PAID" || loan.status === "CANCELLED") {
          return { ok: false, error: `A ${loan.status.toLowerCase()} loan does not roll — its record keeps the anchor it closed under.` };
        }
        const { data: boundPolicy } = await client.models.Policy.get({ id: newPolicyId });
        if (!boundPolicy) return { ok: false, error: "That policy no longer exists." };
        if (boundPolicy.quoteId !== loan.quoteId) {
          return {
            ok: false,
            error: "That policy was not bound from this loan's quote. The loan stays where it is.",
          };
        }
        const rollLoanTable = process.env.PF_LOAN_TABLE;
        if (!rollLoanTable) throw new Error("PF_LOAN_TABLE unset");
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: rollLoanTable,
              Key: { id: loan.id },
              UpdateExpression: "SET policyId = :p, updatedAt = :now",
              ConditionExpression:
                "quoteId = :q AND attribute_not_exists(policyId) AND #s IN (:live1, :live2, :live3, :live4)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":p": newPolicyId,
                ":q": loan.quoteId,
                ":now": now,
                ":live1": "QUOTED",
                ":live2": "ACCEPTED",
                ":live3": "ACTIVE",
                ":live4": "DEFAULTED",
              },
            })
          );
        } catch (err) {
          if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
            // A concurrent roll may have landed the same answer; re-read
            // before calling it a conflict.
            const { data: fresh } = await client.models.PfLoan.get({ id: loan.id });
            if (fresh?.policyId === newPolicyId) return { ok: true, note: "Already rolled." };
            return { ok: false, error: "The loan changed underneath this rollover. Look at it and try again." };
          }
          throw err;
        }
        await logRow({
          accountId: loan.accountId,
          jurisdiction: loan.state,
          rule: "bind-rollover",
          outcome: "PASS",
          reason: `Loan rolled from quote ${loan.quoteId} to policy ${newPolicyId} at bind.`,
          inputs: { loanId: loan.id, quoteId: loan.quoteId, policyId: newPolicyId },
          actor,
          actorName,
        });
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
        /**
         * A hand posting while an autopay debit is clearing would collect the
         * installment twice: the ledger's deterministic id refuses the
         * debit's posting when it lands, but Stripe still settles the money.
         * The debit's webhook outcome — succeeded or failed — clears this
         * marker; until then, the answer is to wait, exactly as it is for a
         * PROCESSING invoice.
         */
        if (loan.autopayPendingIntentId) {
          return {
            ok: false,
            error: `An autopay debit for installment ${
              loan.autopayPendingInstallment ?? (loan.paidThrough ?? 0) + 1
            } is already clearing. Wait for it to land or fail — a hand posting now would collect the money twice.`,
          };
        }
        const result = await postInstallment({
          ddb,
          loan,
          actor,
          actorName,
          logContext: "pf-servicing",
        });
        if (!result.ok) return { ok: false, error: result.error };
        return {
          ok: true,
          posted: { n: result.n, amount: result.amount, balance: result.balance },
          ...(result.alreadyPosted
            ? { note: `Installment ${result.n} was already on the ledger; loan state reconciled.` }
            : {}),
        };
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
        const verdict = canRequestCancellation(
          noticeRows as NoticeRow[],
          now,
          loan.defaultedAt
        );
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

        /**
         * The SAME intent the verdict validated: episode-filtered, latest.
         * An unfiltered first-match could name a cured, earlier default's
         * intent on the immutable CANCELLATION_REQUEST row — paper proving
         * the wrong notice was given.
         */
        const episodeNotices = loan.defaultedAt
          ? (noticeRows as NoticeRow[]).filter(
              (n) => n.type !== "INTENT_TO_CANCEL" || n.occurredAt >= loan.defaultedAt!
            )
          : (noticeRows as NoticeRow[]);
        const { intent } = latestIntent(episodeNotices);
        /**
         * The transition and its notice row are ONE write. Cancellation is
         * the moment lender liability attaches, and the CANCELLATION_REQUEST
         * row is the record proving the carrier request followed the 15-day
         * clock — a loan terminally CANCELLED without that row has no
         * supported repair path (PfNotice takes no client writes, and no
         * other action creates this type). A transaction forecloses the
         * half-state instead of logging it: both land or neither does, and
         * the loser of a double-click fails the status condition cleanly.
         */
        const noticeTable = process.env.PF_NOTICE_TABLE;
        const cancelLoanTable = process.env.PF_LOAN_TABLE;
        if (!noticeTable || !cancelLoanTable) {
          console.error("[pf-servicing] PF_NOTICE_TABLE or PF_LOAN_TABLE unset");
          return { ok: false, error: "Servicing is not fully configured." };
        }
        const expectedCarrierRefundAt = addDaysIso(
          `${effective}T00:00:00.000Z`,
          CARRIER_REFUND_DAYS
        ).slice(0, 10);
        try {
          await ddb.send(
            new TransactWriteCommand({
              /**
               * Stable across the SDK's own transport retries, fresh for a
               * human's: a retried delivery of a landed commit returns
               * success instead of failing its own status condition.
               */
              ClientRequestToken: randomUUID(),
              TransactItems: [
                {
                  Update: {
                    TableName: cancelLoanTable,
                    Key: { id: loan.id },
                    UpdateExpression:
                      "SET #s = :to, cancellationEffectiveAt = :eff, expectedCarrierRefundAt = :ref, closedAt = :now, updatedAt = :now",
                    /**
                     * Status alone is not enough: a loan can cure and
                     * re-default between the read and this commit, and
                     * DEFAULTED would still be true — of a DIFFERENT
                     * episode, whose 15-day clock this request never ran.
                     * Pinning defaultedAt makes the condition name the
                     * exact default the verdict validated.
                     */
                    ConditionExpression: loan.defaultedAt
                      ? "#s = :from AND defaultedAt = :epoch"
                      : "#s = :from AND attribute_not_exists(defaultedAt)",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: {
                      ":to": "CANCELLED",
                      ":from": "DEFAULTED",
                      ":eff": effective,
                      // The unearned-premium receivable: the carrier owes
                      // the refund within 30 days of the effective date.
                      ":ref": expectedCarrierRefundAt,
                      ":now": now,
                      ...(loan.defaultedAt ? { ":epoch": loan.defaultedAt } : {}),
                    },
                  },
                },
                {
                  Put: {
                    TableName: noticeTable,
                    Item: {
                      id: randomUUID(),
                      __typename: "PfNotice",
                      createdAt: now,
                      updatedAt: now,
                      loanId: loan.id,
                      accountId: loan.accountId,
                      type: "CANCELLATION_REQUEST",
                      occurredAt: now,
                      refNoticeId: intent?.id ?? null,
                      createdBy: actor,
                      createdByName: actorName,
                    },
                  },
                },
              ],
            })
          );
        } catch (err) {
          const canceled = err as { name?: string; CancellationReasons?: { Code?: string }[] };
          if (canceled.name === "TransactionCanceledException") {
            // "Changed underneath" only when the status condition actually
            // lost — a throttled or conflicted transaction changed nothing,
            // and saying otherwise fabricates a state change.
            const statusLost =
              canceled.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed";
            return {
              ok: false,
              error: statusLost
                ? "The loan changed underneath this cancellation. Look at it and try again."
                : "The cancellation didn't commit — nothing changed. Try again.",
            };
          }
          throw err;
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
