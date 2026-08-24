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
  CARRIER_REFUND_DAYS,
  isRealIsoDay,
  NOTICE_DAYS,
  type NoticeRow,
} from "../../../src/lib/premiumFinance/noticeSequence";
import { listAllPages } from "../../../src/lib/pagination";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";
import { postInstallment } from "../pfPosting";

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
       * QUOTED/ACCEPTED → ACTIVE, behind the staleness rule: the executed
       * board resolution must be from the financed term. A resolution
       * executed before the term's effective date is the prior board's paper
       * — boards turn over annually and a receiver can replace one mid-term —
       * and the power of attorney must trace to a body that currently exists.
       *
       * ACCEPTED (W7) activates through the same gate as QUOTED: the
       * association's election moved money and saved a mandate, but the
       * paper rule is the paper rule. Activation from ACCEPTED is what turns
       * the mandate on — the autopay cron only debits ACTIVE loans.
       */
      case "ACTIVATE": {
        if (loan.status !== "QUOTED" && loan.status !== "ACCEPTED") {
          return { ok: false, error: `A ${loan.status.toLowerCase()} loan cannot be activated.` };
        }
        /**
         * The kill switch reaches activation. Activation is the last
         * origination act — the moment the lending relationship commences
         * and (W7) the mandate turns on — not servicing, which the gate
         * never touches. Before W7 this hole was cosmetic; a standing
         * inventory of money-committed ACCEPTED loans makes it real.
         */
        const { data: activateSettings } = await client.models.AgencySettings.get({
          id: "AGENCY",
        });
        if (activateSettings?.premiumFinanceEnabled !== true) {
          await logRow({
            accountId: loan.accountId,
            jurisdiction: loan.state,
            rule: "module-flag",
            outcome: "BLOCK",
            reason: "Premium finance is switched off; activation refused.",
            inputs: { loanId: loan.id, status: loan.status },
            actor,
            actorName,
          });
          return {
            ok: false,
            error:
              loan.status === "ACCEPTED"
                ? "Premium finance is switched off. This loan's down payment is already in — resolve the module state or refund the association; activation stays refused."
                : "Premium finance is switched off.",
          };
        }
        const executed = a.boardResolutionExecutedAt;
        if (!isRealIsoDay(executed)) {
          return { ok: false, error: "The board resolution's execution date is required." };
        }
        if (!a.boardResolutionDocumentId?.trim()) {
          // The power of attorney must trace to an artifact on file, not to a
          // date someone typed. Upload the executed resolution to Documents
          // first; the id is the proof.
          return {
            ok: false,
            error: "The executed board resolution must be on file first — upload it to Documents and reference it here.",
          };
        }
        /**
         * And "on file" is checked POSITIVELY, not attested: the id is
         * pasted by hand (FinancingTab), and a typo'd or wrong-document id
         * would activate a lending agreement whose power-of-attorney
         * evidence points at the wrong paper — silently, forever. Nothing
         * short of a Document filed under this account AS an executed
         * board resolution passes: "some document on the account" proves
         * nothing, and the generated PF_BOARD_RESOLUTION draft — filed on
         * this very account, named for this very loan — is the likeliest
         * wrong paste there is.
         */
        const documentId = a.boardResolutionDocumentId.trim();
        const { data: resolutionDoc, errors: docErrs } =
          await client.models.Document.get({ id: documentId });
        if (docErrs?.length) {
          // A failed read is not a missing document — no BLOCK row claiming
          // "not on file" over a registry that merely didn't answer.
          console.error(`[pf-servicing] document lookup failed for ${documentId}`, docErrs[0].message);
          return { ok: false, error: "Couldn't look up that document. Try again." };
        }
        const docProblem = !resolutionDoc
          ? {
              reason: `Document ${documentId} is not on file.`,
              error:
                "That document id is not on file. Upload the executed resolution to Documents and paste its id.",
            }
          : resolutionDoc.entityId !== loan.accountId
            ? {
                reason: `Document ${documentId} belongs to a different account.`,
                error:
                  "That document belongs to a different account. Reference the executed resolution filed under this association.",
              }
            : resolutionDoc.category === "PF_BOARD_RESOLUTION" ||
                resolutionDoc.category === "PF_AGREEMENT"
              ? {
                  reason: `Document ${documentId} is the generated draft, not an executed resolution.`,
                  error:
                    "That is the generated draft, not an executed resolution. Print it, have the board sign it, and upload the signed copy under “Executed board resolution”.",
                }
              : resolutionDoc.category !== "PF_RESOLUTION_EXECUTED"
                ? {
                    reason: `Document ${documentId} is not filed as an executed board resolution (category ${resolutionDoc.category ?? "none"}).`,
                    error:
                      "That document isn't filed as an executed board resolution. Upload the signed copy under “Executed board resolution” — or re-categorize it there if this is it.",
                  }
                : null;
        if (docProblem) {
          await logRow({
            accountId: loan.accountId,
            jurisdiction: loan.state,
            rule: "board-resolution",
            outcome: "BLOCK",
            reason: docProblem.reason,
            inputs: { loanId: loan.id, documentId },
            actor,
            actorName,
          });
          return { ok: false, error: docProblem.error };
        }
        /**
         * One payment path at a time. If an invoice billing this policy still
         * has a live Stripe link (SENT), or a payment already clearing on it
         * (PROCESSING), the association has an open pay-in-full route — and
         * activating the loan would open the financed route beside it. The
         * fix is one click away: voiding the invoice kills its link through
         * the path that already knows how. PROCESSING refuses outright,
         * because money in flight means they already chose.
         */
        const policyInvoices = await listAllPages((nextToken) =>
          client.models.Invoice.list({
            filter: { policyId: { eq: loan.policyId } },
            limit: 200,
            nextToken,
          })
        );
        /**
         * PAID is in the scan since W7: before ACCEPTED existed, a paid
         * invoice had already cancelled every QUOTED loan, so this case was
         * unreachable. An ACCEPTED loan survives payment by design — which
         * makes "premium already collected in full" a state activation can
         * now meet, and must refuse.
         */
        const paidInvoice = policyInvoices.find((inv) => inv.status === "PAID");
        if (paidInvoice) {
          await logRow({
            accountId: loan.accountId,
            jurisdiction: loan.state,
            rule: "exclusive-payment-path",
            outcome: "BLOCK",
            reason: `Invoice ${paidInvoice.number ?? paidInvoice.id} is PAID — the premium is already collected in full.`,
            inputs: { loanId: loan.id, invoiceId: paidInvoice.id },
            actor,
            actorName,
          });
          return {
            ok: false,
            error: `Invoice ${paidInvoice.number ?? paidInvoice.id} on this policy is PAID — the premium is already collected in full. This loan should be cancelled and any down payment refunded, not activated.`,
          };
        }
        const openInvoice = policyInvoices.find(
          (inv) =>
            inv.status === "PROCESSING" ||
            (inv.status === "SENT" && inv.stripePaymentLinkId?.trim())
        );
        if (openInvoice) {
          await logRow({
            accountId: loan.accountId,
            jurisdiction: loan.state,
            rule: "exclusive-payment-path",
            outcome: "BLOCK",
            reason: `Invoice ${openInvoice.number ?? openInvoice.id} (${openInvoice.status}) still offers pay-in-full on this policy.`,
            inputs: { loanId: loan.id, invoiceId: openInvoice.id },
            actor,
            actorName,
          });
          return {
            ok: false,
            error:
              openInvoice.status === "PROCESSING"
                ? `A pay-in-full payment on invoice ${openInvoice.number ?? openInvoice.id} is already clearing. The association chose to pay in full — this quote should be cancelled, not activated.`
                : `Invoice ${openInvoice.number ?? openInvoice.id} still has a live payment link for the full premium. Void it first — the association cannot have both a pay-in-full link and a signed finance agreement open at once.`,
          };
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
          inputs: { loanId: loan.id, executed, termStart, documentId },
          actor,
          actorName,
        });
        if (stale) {
          return {
            ok: false,
            error: `That resolution was executed ${executed}, before the financed term began (${termStart}). Boards turn over — obtain a resolution executed for the current term.`,
          };
        }
        const won = await transition(loan.id, loan.status, {
          status: "ACTIVE",
          activatedAt: now,
          boardResolutionExecutedAt: executed,
          boardResolutionDocumentId: documentId,
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

        const intent = (noticeRows as NoticeRow[]).find(
          (r) => r.type === "INTENT_TO_CANCEL"
        );
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
                    ConditionExpression: "#s = :from",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: {
                      ":to": "CANCELLED",
                      ":from": "DEFAULTED",
                      ":eff": effective,
                      // The unearned-premium receivable: the carrier owes
                      // the refund within 30 days of the effective date.
                      ":ref": expectedCarrierRefundAt,
                      ":now": now,
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
