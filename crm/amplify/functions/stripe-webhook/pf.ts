import { formatUsdDollars as money } from '../../../../shared/money';
import { sendCrmWrite } from '../live-write';
import { agencyDay } from "../../../../shared/agencyTime";
import { feeAllocations, type BrokerFeeAllocation } from "../../../../shared/brokerFees";
import { syncBrokerFeePayment } from "../broker-fees/payments";
import { TransactionalMailClient } from "../transactional-mail/client";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { PF_CONFIG_SHA256 } from "../../../../shared/premiumFinance/auditConfig";
import { postInstallment, type PostableLoan } from "../pfPosting";
import type { PfEventDecision } from "./decide";
import { readPaidContext } from "./lookups";
import { initialPaymentReceipt } from "../pfInitialPayment";

/** Record historical initial receipts and collect installments on existing loans. */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());
const ses = new TransactionalMailClient("accounting");

interface LoanRow extends PostableLoan {
  status: string | null;
  state: string;
  policyId: string | null;
  groupedInvoiceId: string | null;
  groupedPolicyAgreementLines: string[];
  months: number;
  downPayment: number;
  originationFee: number;
  brokerFeeCents?: number;
  brokerFeeAllocations?: BrokerFeeAllocation[];
  downPaidAt: string | null;
  autopayPendingIntentId: string | null;
  downPaymentIntentId: string | null;
  electionEmail: string | null;
}

async function readLoan(loanId: string): Promise<LoanRow | null> {
  const table = process.env.PF_LOAN_TABLE;
  // A throw, not a null: missing configuration must 500 into a Stripe
  // redelivery, exactly as the invoice path treats it — a 200 here would
  // drop a real money event permanently.
  if (!table) throw new Error("stripe-webhook: PF_LOAN_TABLE unset");
  const res = await ddb.send(
    new GetCommand({ TableName: table, Key: { id: loanId }, ConsistentRead: true })
  );
  if (!res.Item) return null;
  const item = res.Item;
  return {
    id: String(item.id),
    accountId: String(item.accountId),
    schedule: item.schedule,
    paidThrough: typeof item.paidThrough === "number" ? item.paidThrough : null,
    status: typeof item.status === "string" ? item.status : null,
    state: typeof item.state === "string" ? item.state : "",
    policyId: typeof item.policyId === "string" ? item.policyId : null,
    groupedInvoiceId: typeof item.groupedInvoiceId === "string" ? item.groupedInvoiceId : null,
    groupedPolicyAgreementLines: Array.isArray(item.groupedPolicyAgreementLines)
      ? item.groupedPolicyAgreementLines.filter((line): line is string => typeof line === "string")
      : [],
    months: typeof item.months === "number" ? item.months : 11,
    downPayment: typeof item.downPayment === "number" ? item.downPayment : 0,
    originationFee: typeof item.originationFee === "number" ? item.originationFee : 0,
    brokerFeeCents: typeof item.brokerFeeCents === "number" ? item.brokerFeeCents : 0,
    brokerFeeAllocations: feeAllocations(item.brokerFeeAllocations),
    downPaidAt: typeof item.downPaidAt === "string" ? item.downPaidAt : null,
    autopayPendingIntentId:
      typeof item.autopayPendingIntentId === "string" ? item.autopayPendingIntentId : null,
    downPaymentIntentId:
      typeof item.downPaymentIntentId === "string" ? item.downPaymentIntentId : null,
    electionEmail: typeof item.electionEmail === "string" ? item.electionEmail : null,
  };
}

async function logRow(row: {
  accountId: string;
  jurisdiction: string;
  rule: string;
  outcome: "PASS" | "BLOCK";
  reason: string;
  inputs: Record<string, unknown>;
}) {
  const table = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!table) return;
  const now = new Date().toISOString();
  try {
    await sendCrmWrite(ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          id: randomUUID(),
          __typename: "PfComplianceLog",
          createdAt: now,
          updatedAt: now,
          ...row,
          inputs: JSON.stringify(row.inputs),
          configSha256: PF_CONFIG_SHA256,
          actor: "stripe-webhook",
          actorName: "stripe-webhook",
          occurredAt: now,
        },
      })
    ));
  } catch (err) {
    console.error("stripe-webhook: pf log write failed", err);
  }
}

/**
 * Decision 5, revised: everything settles to the trust, so corporate
 * accounting hears about every loan receipt with its character spelled out —
 * this email IS the segregation now. Fails soft like the invoice remittance:
 * the money state is already written, and a retry storm over a mail is worse
 * than a missing mail someone notices.
 */
async function mailAccounting(subject: string, lines: string[]) {
  const to = process.env.ACCOUNTING_MAILBOX;
  const from = process.env.AGENCY_MAILBOX;
  if (!to || !from) {
    console.warn("stripe-webhook: accounting mailbox unset; not reporting the loan receipt");
    return;
  }
  const sent = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: lines.join("\n") } },
        },
      },
    })
  );
  console.log(`stripe-webhook: accounting email accepted by SES ${sent.MessageId ?? "(no id)"}: ${subject}`);
}



/**
 * The names accounting reconciles by. A loan UUID identifies nothing to the
 * person dividing the trust; the association and the policy do. Fail-soft
 * like every read that follows a money write — a missing name costs a line
 * of detail, never a retry storm.
 */
async function dealNames(loan: LoanRow): Promise<{ name: string; billingLines: string[] }> {
  let name = "(unknown association)";
  let policy = "(no policy number)";
  try {
    const ctx = await readPaidContext({
      accountId: loan.accountId,
      policyId: loan.policyId,
    });
    name = ctx.associationName ?? name;
    policy = ctx.policyNumber ?? policy;
  } catch { /* The frozen group or loan ID can still identify the receipt. */ }
  if (!loan.groupedInvoiceId) return { name, billingLines: [`Policy: ${policy}`] };
  let invoiceNumber = loan.groupedInvoiceId;
  if (process.env.INVOICE_TABLE) {
    try {
      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.INVOICE_TABLE,
        Key: { id: loan.groupedInvoiceId },
        ProjectionExpression: 'accountId, #number',
        ExpressionAttributeNames: { '#number': 'number' },
        ConsistentRead: true,
      }));
      if (Item?.accountId === loan.accountId && typeof Item.number === 'string') invoiceNumber = Item.number;
    } catch { /* Receipt reporting can fall back to the invoice ID. */ }
  }
  return { name, billingLines: [`Invoice: ${invoiceNumber}`, ...loan.groupedPolicyAgreementLines] };
}

/** No earnings while ACH clears; retries recover a hook after the loan state was recorded. */
async function syncLoanBrokerFee(d: PfEventDecision, loan: LoanRow, status: "PROCESSING" | "PAID" | "FAILED") {
  const allocations = feeAllocations(loan.brokerFeeAllocations);
  if (!allocations.length || d.billingVersion !== 3) return;
  if (allocations.reduce((sum, part) => sum + part.amountCents, 0) !== (loan.brokerFeeCents ?? 0)) throw new Error("Broker fee loan allocation is incomplete.");
  if (status !== "FAILED") initialPaymentReceipt(loan, d.amount, d.billingVersion);
  await syncBrokerFeePayment({ sourceId: d.paymentIntentId, accountId: loan.accountId, allocations, status, receivedOn: agencyDay(d.occurredAt) });
}

/** A late initial settlement records only the money received, even on a signed offer. */
async function applyDownPayment(d: PfEventDecision, loan: LoanRow): Promise<string> {
  const table = process.env.PF_LOAN_TABLE as string;
  if (loan.downPaymentIntentId === d.paymentIntentId && loan.downPaidAt) {
    await syncLoanBrokerFee(d, loan, "PAID");
    return "initial receipt already recorded";
  }
  const receipt = initialPaymentReceipt(loan, d.amount, d.billingVersion ?? null);
  const now = new Date().toISOString();
  try {
    await sendCrmWrite(ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: loan.id },
        UpdateExpression: "SET downPaidAt = :settled, downPaymentIntentId = :pi, " +
          "initialPaymentAmount = :received, originationFeeCollected = :fee, updatedAt = :now",
        ConditionExpression: "#s IN (:quoted, :accepted) AND attribute_exists(agreementSignedAt) " +
          "AND attribute_exists(electedAt) AND attribute_not_exists(downPaidAt) " +
          "AND (attribute_not_exists(downPaymentIntentId) OR downPaymentIntentId = :pi)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":received": receipt.initialPaymentAmount, ":fee": receipt.originationFeeCollected,
          ":quoted": "QUOTED", ":accepted": "ACCEPTED", ":pi": d.paymentIntentId,
          ":settled": d.occurredAt, ":now": now,
        },
      })
    ));
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    /**
     * Lost the condition. First rule it out as a replay racing its own first
     * delivery: re-read, and if the stored intent IS this intent, the money
     * is recorded and there is nothing to say.
     */
    const fresh = await readLoan(loan.id);
    if (fresh?.downPaymentIntentId === d.paymentIntentId && fresh.downPaidAt) {
      await syncLoanBrokerFee(d, fresh, "PAID");
      return "initial receipt already recorded";
    }
    /**
     * Genuinely stray: a second checkout session, a cancellation that raced
     * the payment, a full payment that superseded the quote while the down
     * payment cleared. The money is real and the state cannot admit it: a
     * person refunds this, so a person hears now.
     */
    await mailAccounting("Financing down payment needs reconciliation", [
      `A Stripe deposit of ${money(receipt.initialPaymentAmount)} cleared for loan ${loan.id}.`,
      `The existing loan record could not accept this receipt. Review its payment history and any refund due.`,
      `Payment intent: ${d.paymentIntentId}`,
    ]);
    return "unmatched down payment; alerted";
  }
  await logRow({
    accountId: loan.accountId, jurisdiction: loan.state, rule: "down-payment", outcome: "PASS",
    reason: "Received a historical financing down payment after origination closed.",
    inputs: { loanId: loan.id, paymentIntentId: d.paymentIntentId, amount: receipt.initialPaymentAmount },
  });
  try {
    const deal = await dealNames(loan);
    await mailAccounting(
      `Financing initial payment received — ${deal.name} — ${money(receipt.initialPaymentAmount)} (payment 1 of ${loan.months + 1})`,
      [
        `Association: ${deal.name}`,
        ...deal.billingLines,
        ``,
        `Total received: ${money(receipt.initialPaymentAmount)}`,
        `Premium down payment: ${money(loan.downPayment)}`,
        `Origination fee collected: ${money(receipt.originationFeeCollected)}`,
        `Broker fee collected: ${money(receipt.brokerFeeCollectedCents / 100)}`,
        `Broker fee is separate agency revenue and does not reduce financed principal.`,
        `Loan principal repayment: ${money(0)}`,
        `Interest received: ${money(0)}`,
        ...(receipt.originationFeeCollected < loan.originationFee
          ? [`Legacy checkout: ${money(loan.originationFee - receipt.originationFeeCollected)} of the contractual origination fee was not collected.`]
          : []),
        `Premium and fee settle to the trust on the Stripe rail; keep the fee separate from premium.`,
        `Reconcile this deposit with the financing provider. Monthly collections were not started.`,
        ``,
        `Loan: ${loan.id}`,
        `Payment intent: ${d.paymentIntentId}`,
        `Payer: ${loan.electionEmail ?? "(unknown)"}`,
      ]
    );
  } catch (err) {
    console.error("stripe-webhook: could not mail the down-payment split", err);
  }
  await syncLoanBrokerFee(d, loan, "PAID");
  return "initial receipt recorded";
}

/** Clear the pending marker, if it still names this debit. */
async function clearPending(loanId: string, intentId: string) {
  const table = process.env.PF_LOAN_TABLE;
  if (!table) return;
  try {
    await sendCrmWrite(ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: loanId },
        UpdateExpression:
          "REMOVE autopayPendingIntentId, autopayPendingInstallment SET updatedAt = :now",
        ConditionExpression: "autopayPendingIntentId = :pi",
        ExpressionAttributeValues: { ":pi": intentId, ":now": new Date().toISOString() },
      })
    ));
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      console.error(`stripe-webhook: could not clear the pending debit on ${loanId}`, err);
    }
  }
}

/**
 * A failed debit: clear the marker AND stand autopay down for the
 * installment. The marker clause matches the real intent id, or — when the
 * failure raced the cron's claim→intent swap — a still-unclaimed `claim-…`
 * marker for the same installment; the failed intent proves the create
 * happened, so the claim is this debit's, just never swapped.
 */
async function failInstallment(loanId: string, intentId: string, installment: number | null) {
  const table = process.env.PF_LOAN_TABLE;
  if (!table) return;
  const patch = (condition: string, values: Record<string, unknown>) =>
    sendCrmWrite(ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { id: loanId },
        UpdateExpression:
          "SET autopayFailedInstallment = :n, updatedAt = :now REMOVE autopayPendingIntentId, autopayPendingInstallment",
        ConditionExpression: condition,
        ExpressionAttributeValues: {
          ":n": installment,
          ":now": new Date().toISOString(),
          ...values,
        },
      })
    ));
  try {
    await patch("autopayPendingIntentId = :pi", { ":pi": intentId });
    return;
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      console.error(`stripe-webhook: could not stand down ${loanId}`, err);
      return;
    }
  }
  if (installment === null) return;
  try {
    await patch(
      "begins_with(autopayPendingIntentId, :claim) AND autopayPendingInstallment = :inst",
      { ":claim": "claim-", ":inst": installment }
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      console.error(`stripe-webhook: could not stand down ${loanId}`, err);
    }
    // Neither matched: the marker already moved on. The stand-down field
    // still matters — write it alone, unconditionally.
    try {
      await sendCrmWrite(ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { id: loanId },
          UpdateExpression: "SET autopayFailedInstallment = :n, updatedAt = :now",
          ExpressionAttributeValues: { ":n": installment, ":now": new Date().toISOString() },
        })
      ));
    } catch (err2) {
      console.error(`stripe-webhook: could not record the failed installment on ${loanId}`, err2);
    }
  }
}

/** An autopay debit cleared: post it through the shared core. */
async function applyInstallment(d: PfEventDecision, loan: LoanRow): Promise<string> {
  const expected = (loan.paidThrough ?? 0) + 1;
  if (d.installment !== null && d.installment <= (loan.paidThrough ?? 0)) {
    /**
     * The installment is already on the ledger. A redelivery of the SAME
     * debit is routine; a DIFFERENT intent that also charged it means the
     * customer paid twice, and silence is exactly what the header forbids.
     * The deterministic ledger id makes the check one read.
     */
    const payTable = process.env.PF_LOAN_PAYMENT_TABLE;
    if (payTable) {
      try {
        const row = await ddb.send(
          new GetCommand({
            TableName: payTable,
            Key: { id: `pf-pay-${loan.id}-${d.installment}` },
          })
        );
        const postedIntent = row.Item?.stripePaymentIntentId;
        if (postedIntent && postedIntent !== d.paymentIntentId) {
          console.error(
            `stripe-webhook: intent ${d.paymentIntentId} also charged installment ${d.installment} on ${loan.id} (posted: ${postedIntent}) — refund needed`
          );
          try {
            await mailAccounting(
              `Duplicate autopay debit — refund needed (loan ${loan.id})`,
              [
                `Installment ${d.installment} was posted from ${postedIntent},`,
                `and a second debit ${d.paymentIntentId} has now also cleared for it.`,
                `The second collection needs a refund, not a journal entry.`,
              ]
            );
          } catch (err) {
            console.error("stripe-webhook: could not send the duplicate-debit alert", err);
          }
          await logRow({
            accountId: loan.accountId,
            jurisdiction: loan.state,
            rule: "autopay-posted",
            outcome: "BLOCK",
            reason: `Duplicate debit for installment ${d.installment}: ${d.paymentIntentId} beside ${postedIntent}.`,
            inputs: { loanId: loan.id, installment: d.installment },
          });
          await clearPending(loan.id, d.paymentIntentId);
          return "duplicate debit; alerted";
        }
      } catch (err) {
        console.error("stripe-webhook: could not check the posted intent", err);
      }
    }
    // A redelivery of a debit already posted. The marker may still point at
    // it if the earlier delivery cleared the ledger but lost the marker race.
    await clearPending(loan.id, d.paymentIntentId);
    return "already posted";
  }
  if (d.installment !== null && d.installment > expected) {
    /**
     * A debit for an installment ahead of the ledger — the postings between
     * it and paidThrough are missing. Posting it as "the next one" would
     * record the wrong split against the wrong row; a person reconciles.
     */
    console.error(
      `stripe-webhook: debit ${d.paymentIntentId} is for installment ${d.installment} but loan ${loan.id} is paid through ${loan.paidThrough ?? 0} — reconcile by hand`
    );
    try {
      await mailAccounting(`Autopay debit ahead of the ledger — reconcile loan ${loan.id}`, [
        `Debit ${d.paymentIntentId} cleared for installment ${d.installment},`,
        `but the loan is paid through ${loan.paidThrough ?? 0}. Nothing was posted.`,
      ]);
    } catch (err) {
      console.error("stripe-webhook: could not send the reconcile alert", err);
    }
    return "debit ahead of ledger; alerted";
  }

  const result = await postInstallment({
    ddb,
    loan,
    actor: "stripe-autopay",
    actorName: "Autopay (Stripe)",
    stripePaymentIntentId: d.paymentIntentId,
    clearAutopayPending: true,
    logContext: "stripe-webhook",
  });
  if (!result.ok) {
    // Whatever refused it, the marker must not wedge the loan.
    await clearPending(loan.id, d.paymentIntentId);
    console.error(`stripe-webhook: autopay posting on ${loan.id} refused: ${result.error}`);
    if (result.code === "state-changed") {
      /**
       * Real money cleared and the loan could not take it — a cancellation
       * or payoff won the race. Whether a ledger row stands or nothing was
       * written, a person must reconcile and likely refund; this is the
       * same alarm class as a payment on a VOID invoice.
       */
      try {
        await mailAccounting(`Autopay debit cleared on a moved loan — reconcile ${loan.id}`, [
          `Debit ${d.paymentIntentId} for installment ${d.installment ?? "?"} cleared,`,
          `but the loan changed state before it could post. ${result.error}`,
          ``,
          `Check the loan and the Stripe payment; this likely needs a refund.`,
        ]);
      } catch (err) {
        console.error("stripe-webhook: could not send the moved-loan alert", err);
      }
      await logRow({
        accountId: loan.accountId,
        jurisdiction: loan.state,
        rule: "autopay-posted",
        outcome: "BLOCK",
        reason: `Debit ${d.paymentIntentId} cleared for installment ${d.installment ?? "?"} but the loan moved; reconcile by hand.`,
        inputs: { loanId: loan.id, paymentIntentId: d.paymentIntentId },
      });
    }
    return `posting refused: ${result.code}`;
  }

  await logRow({
    accountId: loan.accountId,
    jurisdiction: loan.state,
    rule: "autopay-posted",
    outcome: "PASS",
    reason: `Installment ${result.n} posted off autopay (payment ${result.n + 1} of ${loan.months + 1}).`,
    inputs: { loanId: loan.id, n: result.n, paymentIntentId: d.paymentIntentId },
  });
  try {
    const deal = await dealNames(loan);
    await mailAccounting(
      `Financing installment received — ${deal.name} — ${money(result.amount)} (payment ${result.n + 1} of ${loan.months + 1})`,
      [
        `Association: ${deal.name}`,
        ...deal.billingLines,
        ``,
        `Character: loan repayment, NOT premium. Settles to the trust on the Stripe rail;`,
        `the split below is what keeps it distinct there.`,
        ``,
        `Principal: ${money(result.principal)}`,
        `Interest: ${money(result.interest)}`,
        `Remaining balance: ${money(result.balance)}`,
        result.finished ? `This was the final installment — the loan is PAID.` : ``,
        ``,
        `Loan: ${loan.id}`,
        `Payment intent: ${d.paymentIntentId}`,
      ].filter((l, i, arr) => l !== `` || arr[i - 1] !== ``)
    );
  } catch (err) {
    console.error("stripe-webhook: could not mail the installment split", err);
  }
  console.log(
    `stripe-webhook: posted installment ${result.n} on ${loan.id} from ${d.paymentIntentId}${result.finished ? "; loan PAID" : ""}`
  );
  return "posted";
}

/** The entry the handler calls. Returns a short reason for the 200 body. */
export async function applyPfEvent(d: PfEventDecision): Promise<string> {
  const loan = await readLoan(d.loanId);
  if (!loan) {
    console.warn(`stripe-webhook: no loan ${d.loanId}`);
    return "unknown loan";
  }

  if (d.outcome === "COMMITTED" || d.outcome === "PROCESSING") {
    // A completed Checkout can precede bank verification. Keep its reference
    // for reconciliation without treating pending money as a receipt.
    if (d.kind !== "down" || loan.downPaidAt || !["QUOTED", "ACCEPTED"].includes(loan.status ?? "")) return "clearing";
    try {
      await sendCrmWrite(ddb.send(new UpdateCommand({
        TableName: process.env.PF_LOAN_TABLE as string,
        Key: { id: loan.id },
        UpdateExpression: "SET downPaymentIntentId = :pi, updatedAt = :now",
        ConditionExpression: "#s IN (:quoted, :accepted) AND attribute_not_exists(downPaidAt) " +
          "AND (attribute_not_exists(downPaymentIntentId) OR downPaymentIntentId = :pi)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":pi": d.paymentIntentId, ":quoted": "QUOTED", ":accepted": "ACCEPTED", ":now": new Date().toISOString(),
        },
      })));
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
      return "historical receipt already advanced";
    }
    if (d.outcome === "PROCESSING") await syncLoanBrokerFee(d, loan, "PROCESSING");
    return "down payment pending";
  }

  if (d.outcome === "FAILED") {
    if (d.kind === "installment") {
      /**
       * Free the sweep and the hand-posting path — and stand autopay down
       * for this installment. One failed attempt hands the loan to the
       * default machinery; a daily retry loop would keep re-arming the
       * marker ahead of the sweep and make DEFAULTED unreachable (and run
       * afoul of re-presentment limits besides). A posting of any kind
       * clears the stand-down.
       */
      await failInstallment(loan.id, d.paymentIntentId, d.installment);
      await logRow({
        accountId: loan.accountId,
        jurisdiction: loan.state,
        rule: "autopay-attempt",
        outcome: "BLOCK",
        reason: `Autopay debit for installment ${d.installment ?? "?"} failed; autopay stands down for it.`,
        inputs: { loanId: loan.id, paymentIntentId: d.paymentIntentId },
      });
      return "debit failed; stood down";
    }
    // Only clear a pending receipt. Failure events may arrive after success.
    try {
      await sendCrmWrite(ddb.send(
        new UpdateCommand({
          TableName: process.env.PF_LOAN_TABLE as string,
          Key: { id: loan.id },
          UpdateExpression: "REMOVE downPaymentIntentId SET updatedAt = :now",
          ConditionExpression: "downPaymentIntentId = :pi AND #s IN (:quoted, :accepted) AND attribute_not_exists(downPaidAt)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":pi": d.paymentIntentId,
            ":quoted": "QUOTED",
            ":accepted": "ACCEPTED",
            ":now": new Date().toISOString(),
          },
        })
      ));
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    }
    const current = await readLoan(loan.id);
    if (current && !current.downPaidAt && (!current.downPaymentIntentId || current.downPaymentIntentId === d.paymentIntentId)) {
      await syncLoanBrokerFee(d, current, "FAILED");
    }
    console.log(`stripe-webhook: down payment ${d.paymentIntentId} failed for ${loan.id}`);
    return "down payment failed";
  }

  return d.kind === "down" ? applyDownPayment(d, loan) : applyInstallment(d, loan);
}
