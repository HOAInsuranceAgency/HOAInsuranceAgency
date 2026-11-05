import { sendCrmWrite } from '../live-write';
import { agencyDay } from "../../../../shared/leadActionGuidance";
import { feeAllocations } from "../../../../shared/brokerFees";
import { syncBrokerFeePayment } from "../broker-fees/payments";
import { TransactionalMailClient } from "../transactional-mail/client";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AGENCY } from "../../../../shared/agency";
import { decideEvent, decidePfEvent, decideUpdate } from "./decide";
import { applyPfEvent } from "./pf";
import { readInvoice, writePaymentState, type InvoiceRow } from "./persist";
import { readPaidContext } from "./lookups";
import {
  remittanceHtml,
  remittanceSubject,
  remittanceText,
} from "./remittance";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/**
 * Stripe → invoice status. See resource.ts for why this is a Function URL.
 *
 * Both the read and the write go straight to the Invoice table. This function
 * has no AppSync configuration — it is not in any `allow.resource()` grant, so
 * the data client cannot be built here at all — and it does not want one: see
 * `readInvoice` for why a strongly-consistent read is what makes the retry loop
 * below terminate.
 */

const ses = new TransactionalMailClient("accounting");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/**
 * Email the split to whoever reconciles the trust account.
 *
 * The figures come off the invoice rather than being recomputed: a Payment
 * Link's price is fixed when it is minted, so the lines as they stand now are
 * not necessarily what was charged. An invoice sent before this field existed
 * has none, and then the total is all that can honestly be reported — the
 * carrier's share is unknown, and guessing it would be a made-up number in a
 * document used for accounting.
 */
async function notifyAccounting(invoice: InvoiceRow, update: { paidAt: string | null }) {
  const to = process.env.ACCOUNTING_MAILBOX;
  if (!to) {
    console.warn("stripe-webhook: ACCOUNTING_MAILBOX unset; not reporting the split");
    return;
  }

  const carrierCents = invoice.remittanceCarrierCents;
  const commissionCents = invoice.remittanceCommissionCents;
  const interestCents = invoice.remittanceInterestCents;
  if (carrierCents === null || commissionCents === null) {
    console.warn(
      `stripe-webhook: no stored split on ${invoice.number ?? invoice.id}; reporting the total only`
    );
  }

  const context = await readPaidContext({
    accountId: invoice.accountId,
    policyId: invoice.policyId,
  });

  const mail = {
    invoiceNumber: invoice.number,
    associationName: context.associationName,
    policyNumber: context.policyNumber,
    carrierName: context.carrierName,
    paymentIntentId: invoice.stripePaymentIntentId ?? "",
    paidAt: update.paidAt ?? new Date().toISOString().slice(0, 10),
    carrierCents: carrierCents ?? 0,
    commissionCents: commissionCents ?? 0,
    interestCents: interestCents ?? 0,
    brokerFeeCents: invoice.remittanceBrokerFeeCents ?? 0,
    totalCents:
      (carrierCents ?? 0) + (commissionCents ?? 0) + (interestCents ?? 0) + (invoice.remittanceBrokerFeeCents ?? 0),
  };

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: `${AGENCY.name} <${process.env.AGENCY_MAILBOX ?? to}>`,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          /**
           * UTF-8 stated on every part. SES's `Simple` content does not assume
           * it, and both the subject and the body carry a middot and an em
           * dash — which arrive as `Â·` and `â€"` if the charset is left to a
           * default. Mojibake in a message about money reads as a broken
           * system, which is not what anyone should be wondering about while
           * reconciling an account.
           */
          Subject: { Data: remittanceSubject(mail), Charset: "UTF-8" },
          Body: {
            Text: { Data: remittanceText(mail), Charset: "UTF-8" },
            Html: { Data: remittanceHtml(mail), Charset: "UTF-8" },
          },
        },
      },
    })
  );
  console.log(
    `stripe-webhook reported the split on ${invoice.number ?? invoice.id} to ${to}`
  );
}

/**
 * Money arrived on a bill the agency withdrew. Someone has to give it back,
 * and the CRM will never show it — the invoice stays VOID on purpose — so this
 * email is the only record pointed at a person.
 */
/**
 * W7: both payment paths collected — a paid-in-full invoice beside a loan
 * that money has already touched. Same channel and reader as the VOID alert:
 * the person reconciling the trust is the person who must untangle this.
 */
async function alertDoublePath(invoice: InvoiceRow, loanId: string, loanStatus: string) {
  const to = process.env.ACCOUNTING_MAILBOX;
  if (!to) return;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: `${AGENCY.name} <${process.env.AGENCY_MAILBOX ?? to}>`,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: {
            Data: `Paid in full AND financing — untangle needed (${invoice.number ?? invoice.id})`,
            Charset: "UTF-8",
          },
          Body: {
            Text: {
              Data: [
                `Invoice ${invoice.number ?? invoice.id} was just paid in full, but the same`,
                `policy carries financing loan ${loanId} (${loanStatus}) that money has`,
                `already touched. Both payment paths have collected; neither record was`,
                `changed automatically.`,
                ``,
                `One of the two needs refunding, and the loan needs a human decision.`,
              ].join("\n"),
              Charset: "UTF-8",
            },
          },
        },
      },
    })
  );
}

async function alertPaymentOnVoid(invoice: InvoiceRow, paymentIntentId: string) {
  const to = process.env.ACCOUNTING_MAILBOX;
  if (!to) return;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: `${AGENCY.name} <${process.env.AGENCY_MAILBOX ?? to}>`,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: {
            Data: `Payment received on a VOID invoice — refund needed (${invoice.number ?? invoice.id})`,
            Charset: "UTF-8",
          },
          Body: {
            Text: {
              Data: [
                `A payment arrived for an invoice that was voided. The invoice stays VOID;`,
                `the money is in the trust account and needs to be refunded to the payer.`,
                ``,
                `Invoice:         ${invoice.number ?? invoice.id}`,
                `Stripe payment:  ${paymentIntentId}`,
                ``,
                `Refund it from the Stripe dashboard, where the payment id above will find it.`,
              ].join("\n"),
              Charset: "UTF-8",
            },
          },
        },
      },
    })
  );
  console.log(
    `stripe-webhook alerted ${to} about a payment on void invoice ${invoice.number ?? invoice.id}`
  );
}

/**
 * QUOTED loans on the paid invoice's policy become CANCELLED, conditionally —
 * the transition() discipline — with a compliance row naming the payment
 * that superseded them. A Scan, not a query: the loan table holds dozens of
 * rows a year and the webhook has no GSI name to hold onto.
 */
async function cancelQuotedLoans(invoice: InvoiceRow) {
  if ((invoice.remittanceBrokerFeeCents ?? 0) > 0 && invoice.remittanceCarrierCents === 0 && invoice.remittanceCommissionCents === 0 && (invoice.remittanceInterestCents ?? 0) === 0) return;
  const loanTable = process.env.PF_LOAN_TABLE;
  const logTable = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!loanTable || (!invoice.policyId && !invoice.quoteId)) return;
  const now = new Date().toISOString();
  // W8: the invoice's anchor may be a policy, a quote, or (after a bind
  // rollover) both — loans on either id are this premium's financing.
  const legs: string[] = [];
  const values: Record<string, unknown> = {
    ":q": "QUOTED",
    ":acc": "ACCEPTED",
    ":act": "ACTIVE",
    ":def": "DEFAULTED",
  };
  if (invoice.policyId) {
    legs.push("policyId = :p");
    values[":p"] = invoice.policyId;
  }
  if (invoice.quoteId) {
    legs.push("quoteId = :qa");
    values[":qa"] = invoice.quoteId;
  }
  const { Items } = await ddb.send(
    new ScanCommand({
      TableName: loanTable,
      // Every loan on the anchor: QUOTED to cancel, and anything money has
      // touched to alarm about — see below.
      FilterExpression: `(${legs.join(" OR ")}) AND #s IN (:q, :acc, :act, :def)`,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: values,
    })
  );
  for (const loan of Items ?? []) {
    /**
     * W7: a paid-in-full invoice beside a loan money has already touched is
     * both payment paths collecting at once. The spec's rule: never
     * auto-cancel it — money moved — but never be quiet about it either.
     * Same alarm channel as a payment on a VOID invoice, same reader.
     * "Money touched" includes a QUOTED loan whose down payment is still
     * clearing: the status flips only at settlement, and cancelling under
     * the clearing debit lands the customer's money on a CANCELLED loan.
     */
    if (loan.status !== "QUOTED" || loan.downPaymentIntentId) {
      console.error(
        `stripe-webhook: invoice ${invoice.number ?? invoice.id} PAID beside ${loan.status} loan ${loan.id} — both payment paths collected`
      );
      try {
        await alertDoublePath(invoice, loan.id as string, loan.status as string);
      } catch (err) {
        console.error("stripe-webhook: could not send the double-path alert", err);
      }
      if (logTable) {
        try {
          await sendCrmWrite(ddb.send(
            new PutCommand({
              TableName: logTable,
              Item: {
                id: randomUUID(),
                __typename: "PfComplianceLog",
                createdAt: now,
                updatedAt: now,
                accountId: invoice.accountId,
                jurisdiction: (loan.state as string) ?? "UNKNOWN",
                rule: "exclusive-payment-path",
                outcome: "BLOCK",
                reason: `Invoice ${invoice.number ?? invoice.id} paid in full beside ${loan.status} loan ${loan.id} — refund/untangle needed.`,
                inputs: JSON.stringify({ loanId: loan.id, invoiceId: invoice.id }),
                configSha256: PF_CONFIG_SHA256,
                actor: "stripe-webhook",
                actorName: "stripe-webhook",
                occurredAt: now,
              },
            })
          ));
        } catch (err) {
          console.error("stripe-webhook: double-path log write failed", err);
        }
      }
      continue;
    }
    try {
      await sendCrmWrite(ddb.send(
        new UpdateCommand({
          TableName: loanTable,
          Key: { id: loan.id },
          UpdateExpression: "SET #s = :c, closedAt = :now, updatedAt = :now",
          // The read-time money-touched check above races this webhook's own
          // down-payment stamp on another delivery; the condition is the law.
          ConditionExpression: "#s = :q AND attribute_not_exists(downPaymentIntentId)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":c": "CANCELLED", ":q": "QUOTED", ":now": now },
        })
      ));
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        /**
         * The loan left QUOTED between the scan and the cancel — under a
         * payment, that almost always means it just became ACCEPTED: the
         * association elected while their pay-in-full cleared. That is the
         * double-path case, not a quiet skip.
         */
        console.error(
          `stripe-webhook: loan ${loan.id} left QUOTED under paid invoice ${invoice.number ?? invoice.id} — both payment paths may have collected`
        );
        try {
          await alertDoublePath(invoice, loan.id as string, "no longer QUOTED");
        } catch (alertErr) {
          console.error("stripe-webhook: could not send the double-path alert", alertErr);
        }
        continue;
      }
      throw err;
    }
    if (logTable) {
      try {
        await sendCrmWrite(ddb.send(
          new PutCommand({
            TableName: logTable,
            Item: {
              id: randomUUID(),
              __typename: "PfComplianceLog",
              createdAt: now,
              updatedAt: now,
              accountId: invoice.accountId,
              jurisdiction: (loan.state as string) ?? "UNKNOWN",
              rule: "superseded-by-payment",
              outcome: "BLOCK",
              reason: `Quote cancelled: invoice ${invoice.number ?? invoice.id} was paid in full.`,
              inputs: JSON.stringify({ loanId: loan.id, invoiceId: invoice.id }),
              configSha256: PF_CONFIG_SHA256,
              actor: "stripe-webhook",
              actorName: "stripe-webhook",
              occurredAt: now,
            },
          })
        ));
      } catch (err) {
        console.error("stripe-webhook: supersede log write failed", err);
      }
    }
    console.log(`stripe-webhook: cancelled QUOTED loan ${loan.id} — invoice paid in full`);
  }
}

let stripe: Stripe | undefined;
const getStripe = () => (stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY as string));

/** Anything 2xx tells Stripe to stop retrying. */
const ok = (body: string) => ({ statusCode: 200, body });
const refused = (body: string) => ({ statusCode: 400, body });

/** The processor metadata preserves the allocation of the charge even after an invoice is resent. */
async function syncInvoiceBrokerFee(invoice: InvoiceRow, decision: ReturnType<typeof decideEvent> & {}, object: Record<string, unknown>, validateOnly = false) {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const allocations = feeAllocations(metadata?.brokerFeeAllocations ?? invoice.brokerFeeAllocations);
  if (!allocations.length) return;
  const amount = decision.outcome === "PAID" ? (object.amount_received ?? object.amount) : object.amount;
  const frozen = metadata?.invoiceTotalCents;
  if (frozen != null && (typeof frozen !== "string" || !/^\d+$/.test(frozen))) throw new Error("Invalid frozen broker fee charge amount.");
  // Processor amounts and issued metadata describe the actual charge. Current
  // invoice display fields can never redefine an older, real payment.
  const chargeCents = frozen == null ? object.amount : Number(frozen);
  if (decision.outcome !== "FAILED" && (typeof amount !== "number" || !Number.isSafeInteger(amount) || !Number.isSafeInteger(chargeCents) || amount !== chargeCents || allocations.reduce((sum, part) => sum + part.amountCents, 0) > Number(chargeCents))) throw new Error("Broker fee charge does not match the frozen invoice amount.");
  if (!invoice.accountId) throw new Error("Broker fee payment is missing its account.");
  if (validateOnly) return;
  await syncBrokerFeePayment({ sourceId: decision.paymentIntentId, accountId: invoice.accountId, allocations, status: decision.outcome, receivedOn: agencyDay(decision.occurredAt) });
}

/** Gross partial refunds do not identify the refunded broker fee; require an explicit fee allocation. */
async function syncRefund(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return;
  const intent = await getStripe().paymentIntents.retrieve(intentId);
  const allocations = feeAllocations(intent.metadata.brokerFeeAllocations);
  if (!allocations.length) return;
  const totalFee = allocations.reduce((sum, part) => sum + part.amountCents, 0);
  let refundedCents = charge.refunded && charge.amount_refunded === charge.amount ? totalFee : 0;
  if (!refundedCents) {
    const refunds: Stripe.Refund[] = [];
    if (charge.refunds?.has_more) {
      for await (const refund of getStripe().refunds.list({ charge: charge.id, limit: 100 })) refunds.push(refund);
    } else refunds.push(...(charge.refunds?.data ?? []));
    for (const refund of refunds) {
      const amount = refund.metadata?.brokerFeeRefundCents;
      if (refund.status === "succeeded" && amount != null) {
        if (!/^\d+$/.test(amount) || Number(amount) > refund.amount) throw new Error("Invalid verified broker fee refund allocation.");
        refundedCents += Number(amount);
      }
    }
  }
  if (!refundedCents) return;
  if (!Number.isSafeInteger(refundedCents) || refundedCents > totalFee || refundedCents > charge.amount_refunded) throw new Error("Broker fee refund exceeds the verified refund.");
  const accountId = intent.metadata.brokerFeeAccountId;
  if (!accountId) throw new Error("Broker fee refund is missing its account.");
  // A refund can precede success delivery. The ledger waits for the verified settlement date.
  await syncBrokerFeePayment({ sourceId: intentId, accountId, allocations, status: "REFUNDED", refundedCents, receivedOn: agencyDay(new Date(event.created * 1000).toISOString()) });
}

/** A final lost dispute is an actual loss; opening or winning one is not. */
async function syncLostDispute(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  if (dispute.status !== "lost") return;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!chargeId) throw new Error("The lost dispute is missing its original charge.");
  const charge = await getStripe().charges.retrieve(chargeId);
  const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return;
  const intent = await getStripe().paymentIntents.retrieve(intentId);
  const allocations = feeAllocations(intent.metadata.brokerFeeAllocations);
  if (!allocations.length) return;
  const disputeIntent = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (charge.id !== chargeId || intent.id !== intentId || intent.amount !== charge.amount || !charge.paid || charge.currency !== "usd" || intent.currency !== "usd" || dispute.currency !== "usd" || !Number.isSafeInteger(dispute.amount) || dispute.amount <= 0 || dispute.amount > charge.amount || (disputeIntent && disputeIntent !== intentId)) throw new Error("The lost broker fee dispute does not match its verified charge.");
  const totalFee = allocations.reduce((sum, part) => sum + part.amountCents, 0);
  const fullLoss = dispute.amount === charge.amount || dispute.amount === charge.amount - charge.amount_refunded;
  let refundedCents = fullLoss ? totalFee : 0;
  if (!fullLoss && dispute.metadata?.brokerFeeRefundCents != null) {
    // On a dispute this is the reviewed cumulative fee loss on the original
    // payment, including prior fee refunds. Gross partial losses are ambiguous.
    const amount = dispute.metadata.brokerFeeRefundCents;
    if (!/^\d+$/.test(amount)) throw new Error("Invalid broker fee dispute allocation.");
    refundedCents = Number(amount);
  }
  if (!refundedCents) {
    console.warn(`Broker fee allocation needs review for partial lost dispute ${dispute.id}`);
    return;
  }
  if (!Number.isSafeInteger(refundedCents) || refundedCents > totalFee || refundedCents > dispute.amount + charge.amount_refunded) throw new Error("The broker fee dispute allocation exceeds the verified loss.");
  const accountId = intent.metadata.brokerFeeAccountId;
  if (!accountId) throw new Error("The disputed broker fee is missing its account.");
  await syncBrokerFeePayment({ sourceId: intentId, accountId, allocations, status: "REFUNDED", refundedCents, receivedOn: agencyDay(new Date(event.created * 1000).toISOString()) });
}

export const handler = async (event: {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
}) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than accept: a 200 here would tell Stripe the event was
    // handled and it would never be redelivered.
    console.error("stripe-webhook has no signing secret");
    return refused("not configured");
  }

  /**
   * The raw bytes, exactly as sent.
   *
   * The signature is computed over the body Stripe transmitted, so it must not
   * be parsed, re-serialised or re-encoded before verification. A Function URL
   * may base64 the body, which is why this decodes rather than trusting it.
   */
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  // Header names arrive lower-cased through a Function URL, but not every proxy
  // agrees, so both spellings are checked.
  const signature =
    event.headers?.["stripe-signature"] ?? event.headers?.["Stripe-Signature"];
  if (!signature) return refused("missing signature");

  let parsed: Stripe.Event;
  try {
    parsed = getStripe().webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    /**
     * Shape only, never contents.
     *
     * A mismatch has two causes that look identical from the error: the wrong
     * secret, or a body altered between Stripe and here. Lengths and prefixes
     * separate them and reveal nothing — an out-by-one on the body says
     * mangling, a secret that is not `whsec_` says wrong value. That is not
     * hypothetical: every delivery from the first real payment failed here
     * because the secret had been set to the endpoint's own URL, and this is
     * the line that said so.
     */
    console.warn(
      "stripe-webhook rejected an unverified payload",
      JSON.stringify({
        rawBodyLength: raw.length,
        secretLength: secret.length,
        secretPrefix: secret.slice(0, 6),
        secretHasWhitespace: secret !== secret.trim(),
      }),
      err
    );
    // Nothing below this line runs on an unverified payload.
    return refused("bad signature");
  }

  /**
   * W7: loan money first. The election checkout and the autopay cron stamp
   * `pfLoanId` (never `invoiceId`) on their PaymentIntents, so an event is
   * loan traffic or invoice traffic by metadata alone.
   */
  if (parsed.type === "charge.refunded") {
    try { await syncRefund(parsed); return ok("refund recorded"); }
    catch (err) { console.error("stripe-webhook: broker fee refund failed", err); return { statusCode: 500, body: "retry" }; }
  }
  if (parsed.type === "charge.dispute.closed") {
    try { await syncLostDispute(parsed); return ok("dispute reviewed"); }
    catch (error) { console.error("stripe-webhook: broker fee dispute failed", error); return { statusCode: 500, body: "retry" }; }
  }
  const pfDecision = decidePfEvent(parsed as never);
  if (pfDecision) {
    try {
      if (pfDecision.outcome === "COMMITTED" && pfDecision.kind === "down") {
        const session = parsed.data.object as Stripe.Checkout.Session;
        if (feeAllocations(session.metadata?.brokerFeeAllocations).length) {
          const intent = await getStripe().paymentIntents.retrieve(pfDecision.paymentIntentId);
          if (session.mode !== "payment" || session.status !== "complete" || session.amount_total !== intent.amount || session.currency !== "usd" || intent.currency !== "usd" || intent.metadata.pfLoanId !== pfDecision.loanId || intent.metadata.pfKind !== "down" || JSON.stringify(feeAllocations(session.metadata?.brokerFeeAllocations)) !== JSON.stringify(feeAllocations(intent.metadata.brokerFeeAllocations))) throw new Error("The completed financing fee checkout does not match its payment intent.");
          if (["canceled", "requires_payment_method"].includes(intent.status)) return ok("financing payment is no longer submitted");
          const pending = decidePfEvent({ type: "payment_intent.processing", created: parsed.created, data: { object: intent as unknown as Record<string, unknown> } });
          if (!pending) throw new Error("The completed financing fee checkout is missing its payment metadata.");
          await applyPfEvent(pfDecision);
          return ok(await applyPfEvent(pending));
        }
      }
      return ok(await applyPfEvent(pfDecision));
    } catch (err) {
      console.error(`stripe-webhook: pf event ${parsed.type} failed`, err);
      // Real event, failed application: ask Stripe to redeliver, exactly as
      // the invoice path does below.
      return { statusCode: 500, body: "retry" };
    }
  }

  let paymentObject = parsed.data.object as unknown as Record<string, unknown>;
  let decision = decideEvent(parsed as never);
  let completedLinkId: string | undefined;
  // ACH checkout can wait for microdeposit verification before the intent
  // starts processing. Record its authorized fee, without recording cash.
  if (parsed.type === "checkout.session.completed") {
    const session = parsed.data.object as Stripe.Checkout.Session;
    const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!intentId || session.mode !== "payment" || session.status !== "complete") return ok("ignored checkout");
    try {
      const intent = await getStripe().paymentIntents.retrieve(intentId);
      if (!feeAllocations(intent.metadata.brokerFeeAllocations).length) return ok("checkout without broker fee");
      if (session.amount_total !== intent.amount || session.currency !== "usd" || intent.currency !== "usd" || (session.metadata?.invoiceId && session.metadata.invoiceId !== intent.metadata.invoiceId)) throw new Error("The completed fee checkout does not match its payment intent.");
      if (["canceled", "requires_payment_method"].includes(intent.status)) return ok("checkout payment is no longer submitted");
      completedLinkId = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id;
      if (!completedLinkId) throw new Error("The fee checkout is missing its issued payment link.");
      paymentObject = intent as unknown as Record<string, unknown>;
      decision = decideEvent({ type: "payment_intent.processing", created: parsed.created, data: { object: paymentObject } });
    } catch (error) {
      console.error("stripe-webhook: submitted broker fee checkout could not be recorded", error);
      return { statusCode: 500, body: "retry" };
    }
  }
  if (!decision) {
    // An event we do not act on is still an event we received. 200, or Stripe
    // retries it forever.
    return ok("ignored");
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    /**
     * Read, decide, write-if-unchanged — and if it changed, do it again.
     *
     * The ordering rules in `decideUpdate` run against a snapshot, so two events
     * delivered at once would both decide from the same pre-state and the last
     * writer would win regardless of which event is newer. The condition on the
     * write is what makes the decision hold; this loop is what happens when it
     * does not.
     *
     * Two passes here, and Stripe's own retry beyond that. The reasoning for
     * stopping at two was wrong: it assumed a lost race means a *newer* event
     * won, when with three in flight the winner of the second race can be an
     * older one — so the newest event could be dropped while the invoice sat at
     * an earlier state. Exhausting the passes now returns 500, not 200.
     */
    for (let attempt = 1; attempt <= 2; attempt++) {
      const invoice = await readInvoice(
        process.env.INVOICE_TABLE as string,
        decision.invoiceId
      );
      if (!invoice) {
        console.warn(`stripe-webhook: no invoice ${decision.invoiceId}`);
        return ok("unknown invoice");
      }
      if (completedLinkId && invoice.stripePaymentLinkId !== completedLinkId && !(paymentObject.metadata as Record<string, unknown> | undefined)?.invoiceTotalCents) throw new Error("The completed fee checkout belongs to a different invoice payment link.");
      await syncInvoiceBrokerFee(invoice, decision, paymentObject, true);
      const update = decideUpdate(invoice, decision, today);
      if (update.action === "skip") {
        if (invoice.stripePaymentIntentId === decision.paymentIntentId && ((decision.outcome === "PAID" && invoice.status === "PAID") || (decision.outcome === "PROCESSING" && invoice.status === "PROCESSING") || (decision.outcome === "FAILED" && invoice.status === "SENT"))) {
          await syncInvoiceBrokerFee(invoice, decision, paymentObject);
        }
        /**
         * Money arriving on a voided bill is not a skip, it is an alarm.
         *
         * The decision is still right — VOID stays VOID, because reviving it
         * would hide that something went wrong — but the money is real and in
         * the trust account, and every path that leads here is one where no
         * record of it exists: a link that escaped tracking, a payment racing
         * a void. Silence was how those stayed invisible. The alert goes to
         * the same mailbox as the splits, because the person reconciling the
         * account is the person who will otherwise find an unexplained
         * deposit — and this needs a refund, not a journal entry.
         */
        if (update.reason === "invoice is void" && decision.outcome === "PAID") {
          console.error(
            `stripe-webhook: payment ${decision.paymentIntentId} received on VOID invoice ${invoice.number ?? invoice.id}`
          );
          try {
            await alertPaymentOnVoid(invoice, decision.paymentIntentId);
          } catch (err) {
            console.error("stripe-webhook could not send the void-payment alert", err);
          }
        }
        console.log(
          `stripe-webhook skipped ${invoice.number ?? invoice.id}: ${update.reason}`
        );
        return ok("skipped");
      }

      const written = await writePaymentState({
        tableName: process.env.INVOICE_TABLE as string,
        invoiceId: invoice.id,
        seen: invoice,
        status: update.status,
        paidAt: update.paidAt,
        paymentIntentId: update.paymentIntentId,
        occurredAt: update.occurredAt,
        intentCreatedAt: update.intentCreatedAt,
      });

      if (written) {
        // Durable hook failures return 500. Replays above finish this even after PAID was saved.
        await syncInvoiceBrokerFee(invoice, decision, paymentObject);
        console.log(
          `stripe-webhook ${parsed.type} → ${update.status} on ${invoice.number ?? invoice.id}`
        );
        /**
         * Corporate finance hears about it here, and only here.
         *
         * This is the one place in the system that knows a payment cleared and
         * has won the right to say so: the conditional write above succeeded,
         * so exactly one invocation reaches this line for a given transition
         * into PAID. Sending from anywhere else — a stream handler, a sweep —
         * would have to work out whether the mail had already gone.
         *
         * After the write, and never allowed to undo it. A failure to send is
         * logged and swallowed: returning 500 would ask Stripe to redeliver an
         * event that has already been applied, and the retry would find the
         * invoice already PAID, skip, and send nothing anyway. A missing email
         * is a gap someone notices; a payment stuck in a retry loop is worse.
         */
        if (update.status === "PAID") {
          try {
            await notifyAccounting(invoice, update);
          } catch (err) {
            console.error(
              `stripe-webhook could not tell accounting about ${invoice.number ?? invoice.id}`,
              err
            );
          }
          /**
           * Paying in full is choosing. Any QUOTED finance loan on the same
           * policy is now a road not taken and is cancelled — QUOTED only:
           * an ACTIVE loan means money already went out the door, and a full
           * payment on top of it is a human's problem to untangle, loudly,
           * not something to auto-cancel. Best effort after the payment
           * record: a failure here never un-PAYs the invoice.
           */
          try {
            await cancelQuotedLoans(invoice);
          } catch (err) {
            console.error(
              `stripe-webhook could not supersede quotes for ${invoice.number ?? invoice.id}`,
              err
            );
          }
        }
        return ok("ok");
      }
      console.log(
        `stripe-webhook lost a race on ${invoice.number ?? invoice.id}, attempt ${attempt}`
      );
    }

    /**
     * Twice beaten, and we cannot tell whether the winner was newer or older.
     *
     * A 200 here would tell Stripe this event is handled and stop the retries,
     * which is how a `succeeded` gets dropped and an invoice stays PROCESSING
     * with the money already in the account. A 500 costs a redelivery a few
     * seconds later, by which time the burst has settled and the event either
     * applies cleanly or is correctly recognised as stale.
     */
    console.warn(
      `stripe-webhook could not place ${parsed.type} for ${decision.invoiceId}; asking Stripe to retry`
    );
    return { statusCode: 500, body: "retry" };
  } catch (err) {
    /**
     * A 500 is correct here. The signature was good and the event is real, so
     * this is our failure and Stripe should try again — swallowing it with a
     * 200 would lose a payment record permanently.
     */
    console.error("stripe-webhook failed to record", err);
    return { statusCode: 500, body: "retry" };
  }
};
