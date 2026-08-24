import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/** Daily: an ACTIVE loan past its next due date is in default. See resource.ts. */

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
const ses = new SESv2Client();

export const handler = async () => {
  const client = await getDataClient();
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
   * A loan with a pending autopay debit is NOT in default — the money is in
   * flight, and ACH takes days. The webhook clears the marker on succeeded
   * (posting the installment) or failed (freeing this sweep to mark it next
   * run). A marker that has sat longer than the longest plausible clearing
   * window means the webhook missed the outcome; defaulting on money that
   * may be mid-air is still the worse error, so the sweep stands down and
   * says so loudly instead.
   */
  const STALE_PENDING_DAYS = 10;
  const stale: typeof loans = [];
  const missed = loans.filter((l) => {
    if (!l.nextDueAt || l.nextDueAt >= today) return false;
    if (!l.autopayPendingIntentId) return true;
    const age = Date.now() - new Date(l.autopayAttemptedAt ?? now).getTime();
    if (age > STALE_PENDING_DAYS * 24 * 60 * 60 * 1000) {
      // Standing down is still right — defaulting money possibly mid-air is
      // the worse error — but ten days of it is an alarm, not a log line.
      stale.push(l);
    } else {
      console.log(`pf-default-sweep: ${l.id} has a debit clearing; not marking`);
    }
    return false;
  });

  /**
   * The alarm for a marker nothing has cleared in ten days: the webhook
   * missed the outcome, or the debit is genuinely lost. A compliance row and
   * the accounting mailbox — the channels a person actually reads — once per
   * sweep until someone reconciles it.
   */
  for (const l of stale) {
    console.error(
      `pf-default-sweep: ${l.id} has a pending autopay debit ${l.autopayPendingIntentId} older than ${STALE_PENDING_DAYS} days — reconcile it by hand; not marking default`
    );
    const logTable = process.env.PF_COMPLIANCE_LOG_TABLE;
    if (logTable) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: logTable,
            Item: {
              id: randomUUID(),
              __typename: "PfComplianceLog",
              createdAt: now,
              updatedAt: now,
              accountId: l.accountId,
              jurisdiction: l.state,
              rule: "autopay-attempt",
              outcome: "BLOCK",
              reason: `Debit ${l.autopayPendingIntentId} for installment ${l.autopayPendingInstallment ?? "?"} has been pending over ${STALE_PENDING_DAYS} days; the sweep is standing down and a human must reconcile.`,
              inputs: JSON.stringify({
                loanId: l.id,
                paymentIntentId: l.autopayPendingIntentId,
                attemptedAt: l.autopayAttemptedAt,
              }),
              configSha256: PF_CONFIG_SHA256,
              actor: "pf-default-sweep",
              actorName: "pf-default-sweep",
              occurredAt: now,
            },
          })
        );
      } catch (err) {
        console.error("pf-default-sweep: stale-marker log write failed", err);
      }
    }
    const to = process.env.ACCOUNTING_MAILBOX;
    const from = process.env.AGENCY_MAILBOX;
    if (to && from) {
      try {
        await ses.send(
          new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
              Simple: {
                Subject: {
                  Data: `Autopay debit stuck ${STALE_PENDING_DAYS}+ days — reconcile loan ${l.id}`,
                },
                Body: {
                  Text: {
                    Data: [
                      `Debit ${l.autopayPendingIntentId} for installment ${l.autopayPendingInstallment ?? "?"}`,
                      `was started ${l.autopayAttemptedAt ?? "(unknown)"} and no outcome ever arrived.`,
                      `Until it is reconciled the loan cannot be debited, hand-posted, or defaulted.`,
                      ``,
                      `Check the payment in the Stripe dashboard, then reconcile the loan.`,
                    ].join("\n"),
                  },
                },
              },
            },
          })
        );
      } catch (err) {
        console.error("pf-default-sweep: stale-marker alert failed", err);
      }
    } else {
      console.warn("pf-default-sweep: accounting mailbox unset; stale-marker alert not sent");
    }
  }

  const loanTable = process.env.PF_LOAN_TABLE;
  for (const loan of missed) {
    /**
     * Conditional on the state the sweep decided from: still ACTIVE, still
     * the same overdue date. The unconditional form clobbered concurrent
     * postings — worst case flipping a just-PAID loan to DEFAULTED, which
     * then admitted the statutory cancellation sequence on a fully paid
     * loan and wrote a false compliance row under it. Losing the condition
     * means the operator got there first; that is the good outcome.
     */
    if (!loanTable) {
      console.error("pf-default-sweep: PF_LOAN_TABLE unset");
      break;
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: loanTable,
          Key: { id: loan.id },
          UpdateExpression: "SET #s = :d, defaultedAt = :now, updatedAt = :now",
          /**
           * The pending-marker check above ran at read time; this clause
           * re-runs it at write time. Without it, an autopay claim landing
           * between the scan and this mark leaves DEFAULTED coexisting with
           * a debit in flight — and the notice sequence could open on money
           * already moving. The mark loses to the claim; tomorrow's sweep
           * sees whatever the debit's outcome left behind.
           */
          ConditionExpression:
            "#s = :active AND nextDueAt = :seen AND attribute_not_exists(autopayPendingIntentId)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":d": "DEFAULTED",
            ":now": now,
            ":active": "ACTIVE",
            ":seen": loan.nextDueAt,
          },
        })
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        console.log(`pf-default-sweep: ${loan.id} was serviced or claimed mid-sweep; not marking`);
        continue;
      }
      console.error(`pf-default-sweep: could not mark ${loan.id}`, err);
      continue;
    }
    const table = process.env.PF_COMPLIANCE_LOG_TABLE;
    if (table) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              id: randomUUID(),
              __typename: "PfComplianceLog",
              createdAt: now,
              updatedAt: now,
              accountId: loan.accountId,
              jurisdiction: loan.state,
              rule: "default-detected",
              outcome: "BLOCK",
              reason: `Installment due ${loan.nextDueAt} not posted by ${today}.`,
              inputs: JSON.stringify({ loanId: loan.id, nextDueAt: loan.nextDueAt }),
              configSha256: PF_CONFIG_SHA256,
              actor: "pf-default-sweep",
              actorName: "pf-default-sweep",
              occurredAt: now,
            },
          })
        );
      } catch (err) {
        console.error("pf-default-sweep: log write failed", err);
      }
    }
    console.log(`pf-default-sweep: ${loan.id} defaulted (due ${loan.nextDueAt})`);
  }
  console.log(`pf-default-sweep: ${missed.length} of ${loans.length} active loans in default`);
};
