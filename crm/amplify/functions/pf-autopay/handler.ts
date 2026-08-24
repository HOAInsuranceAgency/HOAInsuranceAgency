import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { parseScheduleJson } from "../../../src/lib/premiumFinance/quote";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";
import { postInstallment } from "../pfPosting";

/**
 * Daily: one off-session debit attempt per due installment, for ACTIVE loans
 * whose association saved a mandate at election. See resource.ts for the
 * timing relative to the default sweep.
 *
 * The handler only STARTS money moving — the webhook posts the ledger row
 * when Stripe reports the debit cleared, through the same shared posting
 * core hand postings use. What this function must get right is exactly-once
 * initiation:
 *
 *  - The loan is CLAIMED before Stripe hears anything: a conditional write
 *    sets the pending marker only if none exists and the loan is still
 *    ACTIVE at the paidThrough the debit was computed for. Losing the
 *    condition means someone else got there — a hand posting, a concurrent
 *    run — and the answer is to do nothing.
 *  - The PaymentIntent create carries an idempotency key derived from
 *    (loan, installment), so even a crash between claim and create cannot
 *    double-charge on the retry path.
 *  - DEFAULTED loans are not debited: the notice sequence governs a default,
 *    and a cure is a human's act. PAUSED is not a status — it is the absence
 *    of ACTIVE.
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

async function log(row: {
  accountId: string;
  jurisdiction: string;
  outcome: "PASS" | "BLOCK";
  reason: string;
  inputs: Record<string, unknown>;
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
          accountId: row.accountId,
          jurisdiction: row.jurisdiction,
          rule: "autopay-attempt",
          outcome: row.outcome,
          reason: row.reason,
          inputs: JSON.stringify(row.inputs),
          configSha256: PF_CONFIG_SHA256,
          actor: "pf-autopay",
          actorName: "pf-autopay",
          occurredAt: now,
        },
      })
    );
  } catch (err) {
    console.error("pf-autopay: log write failed", err);
  }
}

export const handler = async () => {
  const client = await getDataClient();
  const loanTable = process.env.PF_LOAN_TABLE;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!loanTable || !key) {
    console.error("pf-autopay: PF_LOAN_TABLE or STRIPE_SECRET_KEY unset; doing nothing");
    return;
  }
  const stripe = new Stripe(key);
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const loans = await listAllPages((nextToken) =>
    client.models.PfLoan.list({
      filter: { status: { eq: "ACTIVE" } },
      limit: 200,
      nextToken,
    })
  );

  /**
   * Who gets an attempt today:
   *  - a due loan with no marker and no failed attempt for the next
   *    installment (a failure stands autopay down for that installment —
   *    the sweep flips the loan and the notice sequence governs; a posting
   *    of any kind clears the stand-down and resumes the schedule);
   *  - a loan wearing a STALE CLAIM — a `claim-…` marker from a run that
   *    died between its claim and its create, aged at least a day. The
   *    claim is re-taken conditionally on its exact stale value and healed
   *    below, because a marker only the webhook can clear, on a loan the
   *    sweep stands down for, is otherwise a wedge no path can reach.
   */
  const staleClaim = (l: (typeof loans)[number]) =>
    (l.autopayPendingIntentId ?? "").startsWith("claim-") &&
    (l.autopayAttemptedAt ?? "").slice(0, 10) < today;
  const due = loans.filter(
    (l) =>
      l.stripePaymentMethodId &&
      l.stripeCustomerId &&
      l.nextDueAt &&
      l.nextDueAt <= today &&
      (l.autopayPendingIntentId ? staleClaim(l) : true) &&
      ((l.paidThrough ?? 0) + 1 !== l.autopayFailedInstallment ||
        staleClaim(l)) &&
      // One attempt per day, whatever kind it is.
      (l.autopayAttemptedAt ?? "").slice(0, 10) !== today
  );

  let started = 0;
  for (const loan of due) {
    const schedule = parseScheduleJson(loan.schedule);
    const n = (loan.paidThrough ?? 0) + 1;
    const row = schedule[n - 1];
    if (!row) {
      console.error(`pf-autopay: ${loan.id} is due but its schedule has no row ${n}`);
      continue;
    }

    /**
     * Healing a stale claim: before anything else, ask Stripe whether the
     * dead run's create actually went through. Adopt what exists — the
     * idempotency key only spans 24 hours, so "create again and let the key
     * dedupe" is not safe a day later. Search is eventually consistent by
     * about a minute, which is nothing against a day-old claim.
     */
    if (staleClaim(loan)) {
      let adopted: Stripe.PaymentIntent | null = null;
      try {
        const found = await stripe.paymentIntents.search({
          query: `metadata['pfLoanId']:'${loan.id}' AND metadata['installment']:'${n}'`,
        });
        adopted = found.data[0] ?? null;
      } catch (err) {
        console.error(`pf-autopay: could not search intents for ${loan.id}; retrying tomorrow`, err);
        continue;
      }
      if (adopted) {
        if (adopted.status === "succeeded") {
          // The debit landed and the webhook's story was lost. Post it now —
          // the shared core is idempotent, and clearing the marker frees
          // every other path.
          const result = await postInstallment({
            ddb,
            loan,
            actor: "pf-autopay",
            actorName: "Autopay (reconciled)",
            stripePaymentIntentId: adopted.id,
            clearAutopayPending: true,
            logContext: "pf-autopay",
          });
          console.log(
            `pf-autopay: adopted succeeded intent ${adopted.id} for ${loan.id} installment ${n}: ${result.ok ? "posted" : result.error}`
          );
          await log({
            accountId: loan.accountId,
            jurisdiction: loan.state,
            outcome: result.ok ? "PASS" : "BLOCK",
            reason: `Stale claim healed: adopted ${adopted.id} (${adopted.status}) for installment ${n}.`,
            inputs: { loanId: loan.id, installment: n, paymentIntentId: adopted.id },
          });
          continue;
        }
        if (adopted.status === "processing") {
          // In flight after all: point the marker at it and let the webhook
          // finish the story.
          try {
            await ddb.send(
              new UpdateCommand({
                TableName: loanTable,
                Key: { id: loan.id },
                UpdateExpression:
                  "SET autopayPendingIntentId = :pi, autopayPendingInstallment = :n, updatedAt = :now",
                ConditionExpression: "autopayPendingIntentId = :stale",
                ExpressionAttributeValues: {
                  ":pi": adopted.id,
                  ":n": n,
                  ":stale": loan.autopayPendingIntentId,
                  ":now": now,
                },
              })
            );
            console.log(`pf-autopay: stale claim on ${loan.id} adopted clearing intent ${adopted.id}`);
          } catch (err) {
            console.error(`pf-autopay: could not adopt ${adopted.id} onto ${loan.id}`, err);
          }
          continue;
        }
        // Created but going nowhere (canceled, requires_action…): treat it
        // as a failed attempt — clear the wedge, stand down, let the sweep
        // see the loan again.
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: loanTable,
              Key: { id: loan.id },
              UpdateExpression:
                "SET autopayFailedInstallment = :n, updatedAt = :now REMOVE autopayPendingIntentId, autopayPendingInstallment",
              ConditionExpression: "autopayPendingIntentId = :stale",
              ExpressionAttributeValues: {
                ":n": n,
                ":stale": loan.autopayPendingIntentId,
                ":now": now,
              },
            })
          );
        } catch (err) {
          console.error(`pf-autopay: could not clear the dead claim on ${loan.id}`, err);
        }
        await log({
          accountId: loan.accountId,
          jurisdiction: loan.state,
          outcome: "BLOCK",
          reason: `Stale claim healed: intent ${adopted.id} is ${adopted.status}; installment ${n} stands down for the sweep.`,
          inputs: { loanId: loan.id, installment: n, paymentIntentId: adopted.id },
        });
        continue;
      }
      // No intent was ever created — fall through and make the attempt, but
      // re-claim on the stale value rather than on absence.
    }

    /** Claim before Stripe hears anything. */
    const claim = `claim-${randomUUID()}`;
    const reclaiming = staleClaim(loan);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: loanTable,
          Key: { id: loan.id },
          UpdateExpression:
            "SET autopayPendingIntentId = :claim, autopayPendingInstallment = :n, autopayAttemptedAt = :now, updatedAt = :now",
          ConditionExpression:
            (reclaiming
              ? "autopayPendingIntentId = :stale"
              : "attribute_not_exists(autopayPendingIntentId)") +
            " AND #s = :active AND paidThrough = :seen",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":claim": claim,
            ":n": n,
            ":now": now,
            ":active": "ACTIVE",
            ":seen": loan.paidThrough ?? 0,
            ...(reclaiming ? { ":stale": loan.autopayPendingIntentId } : {}),
          },
        })
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        console.log(`pf-autopay: ${loan.id} moved before the claim; skipping`);
        continue;
      }
      console.error(`pf-autopay: could not claim ${loan.id}`, err);
      continue;
    }

    let intentId: string | null = null;
    try {
      const intent = await stripe.paymentIntents.create(
        {
          amount: Math.round(row.payment * 100),
          currency: "usd",
          customer: loan.stripeCustomerId!,
          payment_method: loan.stripePaymentMethodId!,
          payment_method_types: ["us_bank_account"],
          off_session: true,
          confirm: true,
          metadata: {
            pfLoanId: loan.id,
            pfKind: "installment",
            installment: String(n),
          },
          description: `Financing payment ${n + 1} of ${loan.months + 1}`,
        },
        // Same-run retries dedupe on this; a day-later retry goes through
        // the stale-claim heal above instead, because the key only spans 24h.
        { idempotencyKey: `pf-auto-${loan.id}-${n}` }
      );
      intentId = intent.id;
    } catch (err) {
      /**
       * The claim is deliberately NOT released here. A create error is
       * ambiguous — a timeout may have minted the intent — and releasing
       * would let tomorrow's run create a second debit beside it. The claim
       * ages into tomorrow's stale-claim heal, which asks Stripe what
       * actually exists and adopts, stands down, or retries accordingly.
       */
      console.error(
        `pf-autopay: debit for ${loan.id} installment ${n} failed to start; claim ages into tomorrow's heal`,
        err
      );
      await log({
        accountId: loan.accountId,
        jurisdiction: loan.state,
        outcome: "BLOCK",
        reason: `Autopay debit for installment ${n} could not be started; the claim heals tomorrow.`,
        inputs: { loanId: loan.id, installment: n, error: String(err) },
      });
      continue;
    }

    /** The claim becomes the real intent id the webhook will clear. */
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: loanTable,
          Key: { id: loan.id },
          UpdateExpression: "SET autopayPendingIntentId = :intent, updatedAt = :now",
          ConditionExpression: "autopayPendingIntentId = :claim",
          ExpressionAttributeValues: {
            ":intent": intentId,
            ":claim": claim,
            ":now": new Date().toISOString(),
          },
        })
      );
    } catch (err) {
      // The webhook may already have cleared it (an instant failure event).
      console.error(`pf-autopay: could not record intent ${intentId} on ${loan.id}`, err);
    }

    await log({
      accountId: loan.accountId,
      jurisdiction: loan.state,
      outcome: "PASS",
      reason: `Autopay debit started for installment ${n} (payment ${n + 1} of ${loan.months + 1}).`,
      inputs: { loanId: loan.id, installment: n, paymentIntentId: intentId, amount: row.payment },
    });
    started++;
    console.log(`pf-autopay: started ${intentId} for ${loan.id} installment ${n}`);
  }
  console.log(`pf-autopay: ${started} debit(s) started; ${due.length} due of ${loans.length} active`);
};
