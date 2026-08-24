import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { parseScheduleJson } from "../../src/lib/premiumFinance/quote";

/**
 * The one way an installment posts.
 *
 * Extracted from pf-servicing's POST_PAYMENT when W7 gave the webhook a second
 * road to the ledger (autopay debits clearing). Two writers of money records
 * sharing idempotency by convention is how ledgers fork; sharing the code is
 * how they don't. Sits beside `mailbox.ts` because it is logic two functions
 * must agree on exactly.
 *
 * ── Idempotency, verbatim from the original ────────────────────────────────
 * The ledger row's id is deterministic — pf-pay-{loanId}-{n} — so one row per
 * loan per installment can exist and the second writer fails at the ledger
 * itself. The loan's advance is conditional on the paidThrough the posting was
 * computed from (tolerating the self-healed state), and on status, so a
 * posting racing a cancellation cannot resurrect a terminal loan.
 *
 * ── Decision 5, revised 2026-08-23 ─────────────────────────────────────────
 * Receipts settle to the premium trust on the one Stripe rail. What keeps a
 * loan repayment distinct from premium is this row's interest/principal split
 * and the remittance email — ledger facts, not bank accounts.
 */

/** What `bankAccount` says on rows written since decision 5 was revised. */
export const PF_SETTLEMENT_RAIL = "Premium trust (Stripe rail)";

export interface PostableLoan {
  id: string;
  accountId: string;
  schedule: unknown;
  paidThrough?: number | null;
}

export type PostingResult =
  | {
      ok: true;
      n: number;
      amount: number;
      interest: number;
      principal: number;
      balance: number;
      finished: boolean;
      alreadyPosted: boolean;
    }
  | {
      ok: false;
      code: "unreadable-schedule" | "fully-paid" | "tables-unset" | "state-changed";
      error: string;
    };

export async function postInstallment(opts: {
  ddb: DynamoDBDocumentClient;
  loan: PostableLoan;
  actor: string;
  actorName: string;
  /** Set when the posting came off an autopay debit. */
  stripePaymentIntentId?: string;
  /**
   * Clear the loan's pending-autopay markers in the same advance. The webhook
   * passes true — a debit that posted (or was found already on the ledger) is
   * no longer in flight, and the default sweep may look at the loan again.
   */
  clearAutopayPending?: boolean;
  logContext: string;
}): Promise<PostingResult> {
  const { ddb, loan, actor, actorName, logContext } = opts;
  const now = new Date().toISOString();

  const payTable = process.env.PF_LOAN_PAYMENT_TABLE;
  const loanTable = process.env.PF_LOAN_TABLE;
  if (!payTable || !loanTable) {
    return { ok: false, code: "tables-unset", error: "Servicing tables are not configured." };
  }

  const schedule = parseScheduleJson(loan.schedule);
  if (schedule.length === 0) {
    return { ok: false, code: "unreadable-schedule", error: "The loan's schedule is unreadable." };
  }
  const n = (loan.paidThrough ?? 0) + 1;
  const row = schedule[n - 1];
  if (!row) return { ok: false, code: "fully-paid", error: "The schedule is fully paid." };

  const finished = n >= schedule.length;
  const removes: string[] = [];
  if (!finished) removes.push("defaultedAt");
  // A posting is a cure whoever made it: the failed-installment stand-down
  // ends, and autopay resumes with the next due row.
  removes.push("autopayFailedInstallment");
  if (opts.clearAutopayPending) {
    removes.push("autopayPendingIntentId", "autopayPendingInstallment", "autopayAttemptedAt");
  }
  /**
   * A hand posting must lose to a claim that landed after its read: the
   * cron's debit is already asked for, Stripe will settle it, and a manual
   * advance in between would collect the installment twice. The webhook
   * caller is exempt — its marker names the very intent being posted, and
   * the same update removes it.
   */
  const manualGuard = opts.clearAutopayPending
    ? ""
    : " AND attribute_not_exists(autopayPendingIntentId)";

  /**
   * The advance, shared by both commit shapes below. defaultedAt is ALWAYS
   * removed on a non-final advance — decided by the write, not by the
   * possibly-stale status this invocation read. Status is in the condition
   * because paidThrough alone let a posting racing a cancellation set
   * status back to ACTIVE.
   */
  const advance = {
    TableName: loanTable,
    Key: { id: loan.id },
    UpdateExpression:
      "SET paidThrough = :n, balance = :bal, nextDueAt = :next, #s = :status, updatedAt = :now" +
      (finished ? ", closedAt = :now" : "") +
      (removes.length ? " REMOVE " + removes.join(", ") : ""),
    ConditionExpression:
      "(paidThrough = :seen OR paidThrough = :n) AND (#s = :active OR #s = :defaulted)" +
      manualGuard,
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":n": n,
      ":bal": row.balance,
      ":next": finished ? null : schedule[n].dueDate,
      ":status": finished ? "PAID" : "ACTIVE",
      ":now": now,
      ":seen": loan.paidThrough ?? 0,
      ":active": "ACTIVE",
      ":defaulted": "DEFAULTED",
    },
  };

  /**
   * Ledger row and advance are ONE transaction. The old two-phase shape
   * wrote the row first and advanced second, so a cancellation landing in
   * between stranded an immutable row against a terminal loan with no
   * retry path. Atomic, the race has two clean outcomes: the posting wins
   * whole, or nothing lands and the caller decides how loudly to say that
   * money arrived with nowhere to go.
   */
  let alreadyPosted = false;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
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
                bankAccount: PF_SETTLEMENT_RAIL,
                postedAt: now,
                postedBy: actor,
                postedByName: actorName,
                ...(opts.stripePaymentIntentId
                  ? { stripePaymentIntentId: opts.stripePaymentIntentId }
                  : {}),
              },
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
          { Update: advance },
        ],
      })
    );
  } catch (err) {
    const canceled = err as { name?: string; CancellationReasons?: { Code?: string }[] };
    if (canceled.name !== "TransactionCanceledException") throw err;
    const reasons = canceled.CancellationReasons ?? [];
    const rowExists = reasons[0]?.Code === "ConditionalCheckFailed";
    if (!rowExists) {
      /**
       * The loan moved (or an autopay claim landed) and NOTHING was
       * written. If real money drove this posting, the caller must say so
       * loudly — there is now no ledger row admitting it.
       */
      console.error(
        `[${logContext}] loan ${loan.id} left ACTIVE/DEFAULTED (or took an autopay claim) during posting ${n}; nothing was posted`
      );
      return {
        ok: false,
        code: "state-changed",
        error: `The loan changed underneath posting installment ${n} — a state change, or an autopay debit claiming it. Nothing was posted; look at the loan before anything else.`,
      };
    }
    /**
     * The row exists from an earlier half-state (the pre-transaction shape
     * could strand one) or a redelivery. Re-run the advance alone — its
     * condition tolerates the healed state — and reconcile.
     */
    alreadyPosted = true;
    try {
      await ddb.send(new UpdateCommand(advance));
    } catch (advErr) {
      if ((advErr as { name?: string }).name !== "ConditionalCheckFailedException") throw advErr;
      console.error(
        `[${logContext}] loan ${loan.id} is terminal with ledger row ${n} standing; reconcile by hand`
      );
      return {
        ok: false,
        code: "state-changed",
        error: `The loan changed underneath posting installment ${n}. The payment is on the ledger; reconcile the loan by hand before anything else.`,
      };
    }
  }

  return {
    ok: true,
    n,
    amount: row.payment,
    interest: row.interest,
    principal: row.principal,
    balance: row.balance,
    finished,
    alreadyPosted,
  };
}
