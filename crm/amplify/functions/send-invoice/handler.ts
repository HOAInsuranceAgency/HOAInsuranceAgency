import { customerEmailIdentity } from "../../../../shared/customerEmailIdentity";
import { createDataClientGetter } from "../data-client";
import { captureHandledFailure } from "../monitoring";
import { initialQuotePublicationWrites } from "../quote-source-billing";
import { reserveFeeInvoice, publishFeeInvoiceLink, completeFeeInvoiceSend } from "../broker-fees/payments";
import { closeInvoiceCheckoutSessions } from "../invoiceCheckout";
import { assertBrokerFeeSigned } from "../broker-fees/bindValidation";
import { invoiceBrokerFeeAllocations, brokerFeeInvoiceRefresh } from "./brokerFeeInvoice";
import { validateInvoiceSourceCharges } from "./passThroughInvoice";
import { assertAdjustmentInvoiceProof, assertInitialInvoiceAvailable } from "./adjustmentInvoice";
import { isNonpayableAdjustmentStatement } from "../../../../shared/invoicePaymentStatus";
import { isGroupedInvoice } from "../../../../shared/groupedInvoiceGuard";
import { assertPremiumNotFinanced, assertStandalonePolicyBilling, GroupedDraftBillingBlocked, standalonePolicyBillingGuard } from "../grouped-draft-billing";
import { prepareBrokerFeeAgreement } from "../broker-fees/agreements";
import { authorizedQuoteTerms } from "../../../../shared/quoteAuthorization";
import { brokerFeeCents, feeAllocations, type BrokerFeeAllocation, type BrokerFeeInvoiceSendClaim } from "../../../../shared/brokerFees";
import { getFee, getModel, type Write } from "../broker-fees/store";
import { TransactionalMailClient } from "../transactional-mail/client";
import { MailDeliveryError } from "../transactional-mail/contract";
import { currentContacts, billingContact } from "../../../../shared/contacts";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { listAllPages } from "../../../../shared/pagination";
import { isOpenQuoteStatus } from "../../../../shared/quoteStatus";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import Stripe from "stripe";
import { invoiceTotals, remittanceSplit, type RemittanceSplit } from "../../../../shared/invoiceTotals";
import { renderInvoice, type InvoiceView } from "./invoice";
import { createPaymentLink, InactivePaymentLink, toCents } from "./stripeLink";
import { buildMimeMessage } from "./mime";
import { pdfFilename, renderInvoicePdf } from "./pdf";
import { beginInvoiceSend, completeInvoiceSend, InvoiceSendBlocked } from "./sendOperation";
import { reconcileAcceptedGroupedSend } from "./groupedDelivery";
import type { Schema } from "../../data/resource";

/**
 * Custom mutation handler: sendInvoice. See resource.ts for the why.
 *
 * Arguments are an invoice id and, optionally, an address to override the
 * account's primary contact. Everything else — lines, amounts, policy, carrier —
 * is read here.
 */

const getDataClient = createDataClientGetter();

const ses = new TransactionalMailClient("invoice");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/**
 * A send that must not proceed, with words fit for the screen.
 *
 * Thrown from the payment-link step when carrying on would leave a live link
 * the invoice no longer tracks — the outer catch turns it into `{ok:false}`
 * rather than the generic apology, because "try again" is the actual remedy.
 */
class SendBlocked extends Error {}

/** Invoices come from the mailbox the agency actually reads, not from sales. */
const MAILBOX = process.env.AGENCY_MAILBOX || AGENCY_FMT.emailLower;
const FROM = `${AGENCY.name} <${MAILBOX}>`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The Stripe payment link for this invoice, or null.
 *
 * Reuses an existing link so a resend does not mint a second one — two live
 * links for one bill is how an association pays twice. A producer who pasted
 * their own URL keeps it: an explicit choice beats a generated default.
 *
 * Returns null on any failure, and the invoice sends without a Pay button. A
 * bill with no link is a nuisance; a bill that never arrives because Stripe was
 * down is worse.
 */
async function ensurePaymentLink(
  invoice: {
    id: string;
    accountId?: string;
    number?: string | null;
    status?: string | null;
    paymentUrl?: string | null;
    stripePaymentLinkId?: string | null;
    stripeLinkAmountCents?: number | null;
    remittanceBrokerFeeCents?: number | null;
    brokerFeeAllocations?: unknown;
    sourcePricingVersion?: number | null;
  },
  associationName: string,
  total: number,
  split: RemittanceSplit,
  allocations: BrokerFeeAllocation[],
  claim?: BrokerFeeInvoiceSendClaim,
  proofGuards: Write[] = []
): Promise<string | null> {
  const existingUrl = invoice.paymentUrl?.trim() || null;
  const existingLinkId = invoice.stripePaymentLinkId?.trim() || null;

  /**
   * Stripe, or nothing.
   *
   * A pasted URL used to win outright, on the reasoning that an explicit human
   * choice outranks a generated one. It does not, here: nothing knows what such
   * a link charges, so an invoice could show one total and collect another with
   * no way to notice, and the webhook that moves this row to PAID only ever
   * hears about payments Stripe took. A link outside that loop is a bill nobody
   * can tell has been paid.
   *
   * A URL without a link id is therefore treated as absent and replaced. Those
   * are rows from when the field was editable; the override is gone from the UI.
   */
  if (existingUrl && !existingLinkId) {
    console.warn(
      `[send-invoice] replacing a hand-set payment link on ${invoice.number ?? invoice.id}`
    );
  }

  const wantedCents = (() => {
    try {
      return toCents(total);
    } catch {
      return null;
    }
  })();

  const key = process.env.STRIPE_SECRET_KEY;

  /**
   * Reuse only when the link still bills what the invoice says — AND Stripe
   * will still honor it.
   *
   * A Payment Link's Price is fixed at creation. Editing lines and sending
   * again used to return the old link, so the email and the PDF showed the
   * revised total while the button charged the original one — an overpayment or
   * an underpayment, silently. Lines stay editable after sending on purpose,
   * because a carrier revising a premium is ordinary, so this is not a corner.
   *
   * The activity check exists because the link is single-use
   * (`completed_sessions.limit: 1`) and Stripe kills it the moment a checkout
   * SESSION completes — which for ACH is form submission, days before the
   * debit clears or fails. A failed debit puts the invoice back to SENT, and
   * a resend on an amount match alone would mail the dead link forever; the
   * association clicks Pay and gets "no longer active" with no way through.
   * Any doubt about the old link falls through to minting a fresh one.
   */
  if (
    existingUrl &&
    existingLinkId &&
    wantedCents !== null &&
    invoice.stripeLinkAmountCents === wantedCents &&
    (invoice.remittanceBrokerFeeCents ?? 0) === split.brokerFeeCents &&
    JSON.stringify(feeAllocations(invoice.brokerFeeAllocations)) === JSON.stringify(allocations) &&
    key
  ) {
    try {
      const link = await new Stripe(key).paymentLinks.retrieve(existingLinkId);
      if (link.active && link.url === existingUrl) {
        if ((claim || proofGuards.length) && !await storeLink(invoice.id, { linkId: existingLinkId, status: invoice.status ?? null }, { url: existingUrl, linkId: existingLinkId, amountCents: wantedCents, split, allocations, claim, proofGuards })) throw new SendBlocked("The invoice payment setup changed. Retry its existing Send action.");
        return existingUrl;
      }
      console.warn(
        `[send-invoice] link ${existingLinkId} on ${invoice.number ?? invoice.id} is no longer active; minting a fresh one`
      );
    } catch (err) {
      if (err instanceof SendBlocked) throw err;
      console.warn(
        "[send-invoice] could not confirm the old link is live; minting a fresh one",
        err
      );
    }
  }

  if (!key) {
    if (allocations.length) throw new SendBlocked("Payments are not configured. Configure payments, then retry this invoice's Send action.");
    console.warn("[send-invoice] STRIPE_SECRET_KEY unset; sending without a link");
    return null;
  }
  if (total <= 0) return null;

  const stripe = new Stripe(key);

  /**
   * Deactivate the superseded link before minting its replacement — and stop
   * the send if that fails.
   *
   * This used to be best effort, on the reasoning that a stale payable link
   * was a smaller problem than no link. It is not smaller: the row goes on to
   * store the *new* link id, so the stale one becomes live and tracked by
   * nothing. A later void deactivates only what is stored, the untracked link
   * keeps collecting, and the webhook skips the payment because the invoice is
   * VOID — money received and recorded nowhere. Refusing here leaves the old
   * link live *and stored*, which is a state every other part of the system
   * already handles, and the producer just presses Send again.
   */
  if (existingLinkId) {
    try {
      await stripe.paymentLinks.update(existingLinkId, { active: false });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "resource_missing") {
        console.error("[send-invoice] could not deactivate the old link", err);
        throw new SendBlocked(
          "Couldn't replace the previous payment link, so the invoice was not sent. Try again."
        );
      }
      console.warn(`[send-invoice] old link ${existingLinkId} already gone at Stripe`);
    }
    // Missing session/intent state cannot be treated as a missing Payment Link.
    // Existing sessions remain payable even after that link was deactivated.
    if (allocations.length || [1,2].includes(Number(invoice.sourcePricingVersion))) {
      try { await closeInvoiceCheckoutSessions(stripe, existingLinkId); }
      catch { throw new SendBlocked("Couldn't close the previous payment sessions, so the invoice was not sent. Review its payment before trying again."); }
    }
  }

  let minted: { id: string; url: string };
  try {
    minted = await createPaymentLink(stripe, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      associationName,
      total,
      accountId: invoice.accountId,
      brokerFeeAllocations: allocations,
      ...(claim ? { idempotencyToken: claim.token } : {}),
    });
  } catch (err) {
    if (err instanceof InactivePaymentLink) throw new SendBlocked(err.message);
    if (allocations.length) throw new SendBlocked("Payment setup was interrupted. Retry Send on this same invoice to recover its existing payment link.");
    // No link minted, nothing untracked. A bill without a Pay button is still
    // a working bill, so this failure alone does not stop the send.
    console.error("[send-invoice] could not create a payment link", err);
    return null;
  }

  /**
   * Store the new link, only if nobody else has stored one meanwhile.
   *
   * Two producers pressing Send at once both mint a link, and through the data
   * client the last write wins — leaving the loser's link live, collecting the
   * full total, and recorded nowhere. So this write goes to the table with a
   * condition on the link id this send read, the same optimistic shape as
   * stripe-webhook/persist.ts. The loser deactivates its own orphan and tells
   * its producer the other send won.
   */
  const stored = await storeLink(
    invoice.id,
    { linkId: existingLinkId, status: invoice.status ?? null },
    { url: minted.url, linkId: minted.id, amountCents: wantedCents, split, allocations, claim, proofGuards }
  );
  if (!stored) {
    // Stable fee retries can receive the same processor link. A late caller
    // must never deactivate a link another invocation already published.
    const current = claim ? await getModel<Record<string, unknown>>("Invoice", invoice.id) : undefined;
    const currentFees = claim ? await Promise.all(allocations.map(part => getFee(part.quoteId))) : [];
    // Failed publication can leave this same PREPARING owner intact. Its
    // stable processor key must recover a live link on the next Send, rather
    // than replaying an already-disabled link. Missing source state is also
    // insufficient proof that it is safe to destroy the recoverable link.
    const lostOwner = !!claim && currentFees.length > 0 && currentFees.every(fee => fee && (fee.invoiceSendClaim?.invoiceId !== invoice.id || fee.invoiceSendClaim.token !== claim.token));
    try {
      if (!claim || lostOwner && current?.stripePaymentLinkId !== minted.id) {
        await stripe.paymentLinks.update(minted.id, { active: false });
        if (claim || [1,2].includes(Number(invoice.sourcePricingVersion))) await closeInvoiceCheckoutSessions(stripe, minted.id);
      }
    } catch (err) {
      // The orphan survives, but now loudly: someone can kill it by hand.
      console.error(
        `[send-invoice] LOST-RACE ORPHAN: link ${minted.id} on ${invoice.number ?? invoice.id} could not be deactivated`,
        err
      );
    }
    // Another send, a void, or a payment — whichever it was, the row is not
    // what this send read, and the honest move is to stop and let the person
    // look at what it has become.
    throw new SendBlocked(
      "The invoice changed while sending it. Check it and try again."
    );
  }
  return minted.url;
}

/**
 * The conditional write behind `ensurePaymentLink`, direct to the table
 * because the data client cannot express the condition. `updatedAt` by hand
 * for the same reason — the client normally stamps it. See persist.ts in
 * stripe-webhook for the pattern.
 */
async function storeLink(
  invoiceId: string,
  seen: { linkId: string | null; status: string | null },
  next: { url: string; linkId: string; amountCents: number | null; split: RemittanceSplit; allocations: BrokerFeeAllocation[]; claim?: BrokerFeeInvoiceSendClaim; proofGuards?: Write[] }
): Promise<boolean> {
  const tableName = process.env.INVOICE_TABLE;
  if (!tableName) {
    // Fail closed: an unconditional fallback write is the exact bug this
    // replaces, quietly reintroduced by a missing env var.
    console.error("[send-invoice] INVOICE_TABLE unset; cannot store the link");
    return false;
  }
  const names: Record<string, string> = {
    "#link": "stripePaymentLinkId",
    "#s": "status",
  };
  const values: Record<string, unknown> = {
    ":url": next.url,
    ":link": next.linkId,
    ":cents": next.amountCents,
    ":writer": "send-invoice",
    ":now": new Date().toISOString(),
    ":seenStatus": seen.status,
    ":carrier": next.split.carrierCents,
    ":commission": next.split.commissionCents,
    ":interest": next.split.interestCents,
    ":broker": next.split.brokerFeeCents,
    ":allocations": JSON.stringify(next.allocations),
  };
  /**
   * The link AND the status. The link-only condition had a hole a void could
   * walk through: voiding deactivates the stored link and writes VOID, but
   * leaves `stripePaymentLinkId` in place — so a send that had read the same
   * link id still matched, and stored a fresh live link on the cancelled bill.
   * The status clause makes that send lose instead: VOID is not what it read.
   */
  const clauses: string[] = ["#s = :seenStatus"];
  if (seen.linkId === null) {
    clauses.push("attribute_not_exists(#link)");
  } else {
    clauses.push("#link = :seen");
    values[":seen"] = seen.linkId;
  }
  try {
    const update = {
        TableName: tableName,
        Key: { id: invoiceId },
        UpdateExpression:
          "SET paymentUrl = :url, #link = :link, stripeLinkAmountCents = :cents, remittanceCarrierCents = :carrier, remittanceCommissionCents = :commission, remittanceInterestCents = :interest, remittanceBrokerFeeCents = :broker, brokerFeeAllocations = :allocations, lastWriteBy = :writer, updatedAt = :now",
        ConditionExpression: clauses.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      };
    if (next.allocations.length) {
      if (!next.claim) throw new SendBlocked("The broker fee invoice has no payment setup reservation.");
      return await publishFeeInvoiceLink(invoiceId, next.allocations, next.claim.token, next.linkId, { Update: update }, next.proofGuards);
    }
    if(next.proofGuards?.length)await ddb.send(new TransactWriteCommand({TransactItems:[{Update:update},...next.proofGuards]}));
    else await ddb.send(new UpdateCommand(update));
    return true;
  } catch (err) {
    if (["ConditionalCheckFailedException","TransactionCanceledException"].includes((err as { name?: string }).name??'')) {
      return false;
    }
    throw err;
  }
}

/**
 * Write the facts of a send — and the DRAFT→SENT flip only if nothing moved.
 *
 * Two passes. The first writes everything, conditional on the status still
 * being what the send read. Losing that means a void, a payment, or another
 * send got there first; the second pass then records the send facts alone,
 * unconditionally, because they are true whatever the row has become — the
 * email is already in the association's inbox — while the status belongs to
 * whoever won.
 */
async function recordSend(
  invoiceId: string,
  seenStatus: string | null,
  facts: Record<string, unknown>,
  flipToSent: boolean
): Promise<boolean> {
  const tableName = process.env.INVOICE_TABLE;
  if (!tableName) {
    console.error("[send-invoice] INVOICE_TABLE unset; cannot record the send");
    return false;
  }
  // Two name maps, because DynamoDB rejects an ExpressionAttributeNames entry
  // the expression does not use, and the fallback write never mentions #s.
  const factNames: Record<string, string> = {};
  const factSets: string[] = [];
  const values: Record<string, unknown> = { ":now2": new Date().toISOString() };
  for (const [i, [k, v]] of Object.entries(facts).entries()) {
    factNames[`#f${i}`] = k;
    values[`:f${i}`] = v;
    factSets.push(`#f${i} = :f${i}`);
  }
  const factExpr = `SET ${factSets.join(", ")}, updatedAt = :now2`;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: invoiceId },
        UpdateExpression: flipToSent ? `${factExpr}, #s = :sent` : factExpr,
        ConditionExpression: "#s = :seenStatus",
        ExpressionAttributeNames: { ...factNames, "#s": "status" },
        ExpressionAttributeValues: {
          ...values,
          ":seenStatus": seenStatus,
          ...(flipToSent ? { ":sent": "SENT" } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      throw err;
    }
  }
  // The row moved. Record the facts, leave the status to whoever won.
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id: invoiceId },
      UpdateExpression: factExpr,
      ExpressionAttributeNames: factNames,
      ExpressionAttributeValues: values,
    })
  );
  return false;
}

async function deliverInvoice({ invoice, view, to, tracked, split, allocations, feeSendClaim, onAccepted }: {
  invoice: Schema["Invoice"]["type"];
  view: InvoiceView;
  to: string[];
  tracked?: Awaited<ReturnType<typeof beginInvoiceSend>>;
  split: RemittanceSplit;
  allocations: BrokerFeeAllocation[];
  feeSendClaim?: BrokerFeeInvoiceSendClaim;
  onAccepted: () => void;
}) {
  const invoiceId = invoice.id;
  const { subject, text, html } = renderInvoice(view);
  const identity = customerEmailIdentity(view.propertyState);
  const from = identity.california ? `${identity.name} <${MAILBOX}>` : FROM;

  /**
   * The PDF, which is the document they will actually forward.
   *
   * Failure here does not stop the send. An invoice that arrives with the
   * amount, the lines and a Pay button but no attachment is still a working
   * bill; one that never arrives because a logo fetch timed out is not.
   */
  let attachment: { filename: string; contentType: string; content: Uint8Array } | undefined;
  try {
    attachment = {
      filename: pdfFilename(invoice.number),
      contentType: "application/pdf",
      content: await renderInvoicePdf(view),
    };
  } catch (err) {
    console.error("[send-invoice] could not render the PDF; sending without it", err);
  }

  /**
   * The agency keeps its own copy, for the reason the lead auto-reply BCCs
   * itself: a producer should be able to find what was sent without opening
   * the CRM. Skipped when the invoice is going to that mailbox anyway, since
   * SES would otherwise deliver it twice.
   */
  const selfAddressed = to.some((a) => a.toLowerCase() === MAILBOX.toLowerCase());
  /**
   * `Raw`, not `Simple`, because Simple cannot carry an attachment. The Bcc
   * stays on `Destination` rather than in a header — a `Bcc:` header travels
   * with the message and is visible to everyone who receives it.
   */
  const raw = buildMimeMessage({
    from,
    // Everyone in the To header, so each recipient can see the others were
    // sent it too — an invoice is not correspondence to keep private from
    // the board members copied on it.
    to: to.join(", "),
    replyTo: MAILBOX,
    subject,
    text,
    html,
    attachment,
  });
  const command = new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: to, ...(selfAddressed ? {} : { BccAddresses: [MAILBOX] }) },
    Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
  });
  const details = { idempotencyKey: tracked?.operation.key ?? `invoice:${invoiceId}:${invoice.updatedAt ?? invoice.sentAt ?? "initial"}:${to.join(",")}`,
    subject, text, html, replyTo: MAILBOX, attachments: attachment ? [attachment] : [] };
  const accepted = await ses.send(command, details);
  if (tracked) onAccepted();
  /**
   * DRAFT becomes SENT; a resend of an already-SENT or PAID invoice leaves
   * the status alone. Marking a paid invoice back to SENT because someone
   * forwarded a copy would be a lie about money.
   */
  /**
   * The division of what this bill collects, stored with the send.
   *
   * The webhook is what tells corporate accounting a payment landed, and it
   * reads the invoice row and nothing else. Written here because this is the
   * moment the amount is fixed: the Payment Link above bills this total, so
   * a split taken from the lines later could describe an amount nobody paid.
   * Rewritten on every send, so a resend after re-costing a line corrects it.
   */
  /**
   * Conditional on the status the send read, because the unconditional form
   * could revive a void: a DRAFT read at the top, a void landing mid-send,
   * and this write flipping it to SENT at the bottom. The email is already
   * gone by this line, so losing the condition must not fail the send —
   * instead the facts of the send are recorded without the status flip.
   * `sentAt` on a VOID invoice is true and useful: it says the association
   * was emailed about a bill that was then withdrawn, which is exactly what
   * whoever handles the confusion will need to know.
   */
  const sentFacts = {
    sentAt: new Date().toISOString(),
    sentTo: to.join(", "),
    ...(invoice.status === "PAID" || invoice.status === "PROCESSING" ? {} : {
      remittanceCarrierCents: split.carrierCents, remittanceCommissionCents: split.commissionCents, remittanceInterestCents: split.interestCents,
      remittanceBrokerFeeCents: split.brokerFeeCents, brokerFeeAllocations: JSON.stringify(allocations), brokerFeeFinanceUrl: null,
    }),
    // Named, because this write does not go through the browser's actor
    // proxy. Without it the activity log would say "System" sent the bill,
    // when a person pressed the button.
    lastWriteBy: "send-invoice",
  };
  const recorded = await recordSend(
    invoiceId,
    invoice.status ?? null,
    sentFacts,
    invoice.status === "DRAFT"
  );
  if (!recorded) {
    console.error(
      `send-invoice: ${invoice.number ?? invoiceId} changed mid-send; recorded the send without touching its status`
    );
  }
  if (feeSendClaim) await completeFeeInvoiceSend(invoiceId, allocations, feeSendClaim.token);

  const result = { ok: true as const, sentTo: to.join(", "), subject, sentAt: sentFacts.sentAt };
  if (tracked) await completeInvoiceSend(invoiceId, tracked.operation, accepted.MessageId, result, { database: ddb });
  console.log(`send-invoice sent ${invoice.number ?? invoiceId} to ${to.join(", ")}`);
  return result;
}

export const handler = async (event: {
  arguments?: { invoiceId?: string; toEmail?: string; expectedSentAt?: string | null };
}) => {
  const invoiceId = event.arguments?.invoiceId;
  if (!invoiceId) return { ok: false, error: "No invoice was named." };

  const client = await getDataClient();
  let acceptedForReview = false;

  try {
    const { data: initial } = await client.models.Invoice.get({ id: invoiceId });
    if (!initial) return { ok: false, error: "That invoice no longer exists." };
    if (initial.status === "VOID") {
      return { ok: false, error: "That invoice has been voided." };
    }
    const invoice = initial;
    if (isGroupedInvoice(invoice)) {
      // A delivery accepted before cutover may still need its original receipt.
      // Reconciliation never sends mail or creates a new loan or payment link.
      if (initial.status === "DRAFT" && invoice.groupedFinanceLoanId && !invoice.sentAt) {
        const recovered = await reconcileAcceptedGroupedSend(invoiceId, event.arguments?.expectedSentAt, ddb);
        if (recovered) return recovered;
      }
      throw new SendBlocked("In-house financing has ended. This combined financing invoice cannot be sent.");
    }

    const [account, lines] = await Promise.all([
      client.models.Account.get({ id: invoice.accountId }),
      listAllPages((nextToken) =>
        client.models.InvoiceLine.list({
          filter: { invoiceId: { eq: invoiceId } },
          limit: 1000,
          nextToken,
        })
      ),
    ]);
    if (!account.data) return { ok: false, error: "That account no longer exists." };

    /**
     * Where it goes: the override if one was given, otherwise the account's
     * primary contact. Never a guess — an invoice sent to the wrong address is
     * worse than one not sent.
     */
    const allContacts = await listAllPages((nextToken) =>
      client.models.Contact.list({
        filter: { accountId: { eq: invoice.accountId } },
        limit: 1000,
        nextToken,
      })
    );
    const contacts = currentContacts(allContacts);
    const primary = billingContact(contacts);
    /**
     * One or several. The app sends a comma-separated list because an invoice
     * routinely goes to a manager and a treasurer at once, and splitting here
     * rather than changing the mutation's shape keeps every existing caller —
     * including a resend with no argument at all — working unchanged.
     *
     * Every address is validated, and one bad one fails the send rather than
     * being dropped: a bill that quietly reached three of four people is the
     * failure that gets noticed a month later.
     */
    const requested = (event.arguments?.toEmail || primary?.email || "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const activeEmails = new Set(contacts.map(c => c.email?.trim().toLowerCase()).filter(Boolean));
    const formerEmails = new Set(allContacts.filter(c => c.validUntil).map(c => c.email?.trim().toLowerCase()).filter(Boolean));
    if (requested.some(email => formerEmails.has(email.toLowerCase()) && !activeEmails.has(email.toLowerCase()))) return { ok: false, error: 'A selected recipient no longer represents this account. Refresh the invoice contacts before sending.' };
    const to = [...new Set(requested)];
    if (!to.length || !to.every((a) => EMAIL_RE.test(a))) {
      return {
        ok: false,
        error: "No valid email address for this account. Add one on the account.",
      };
    }

    /**
     * The policy the header block describes.
     *
     * `Invoice.policyId` when it is set. Otherwise the lines decide: a seeded
     * invoice carries a `policyId` per line, and when every one of them names
     * the same policy the invoice is about that policy whether or not anyone
     * set the field. When they name several, there is no single answer and the
     * block is left off — the line descriptions already carry a policy number
     * each, and a header claiming one of three would be wrong about the others.
     */
    const linePolicyIds = [
      ...new Set(lines.map((l) => l.policyId).filter((id): id is string => !!id)),
    ];
    const headerPolicyId =
      invoice.policyId ?? (linePolicyIds.length === 1 ? linePolicyIds[0] : null);
    const policy = headerPolicyId
      ? await getModel<Schema["Policy"]["type"] & { sourcePricingLoanId?: string }>("Policy", headerPolicyId)
      : null;
    if (headerPolicyId && (!policy || policy.accountId !== invoice.accountId)) throw new SendBlocked("The invoice policy could not be verified.");
    if (policy) await assertStandalonePolicyBilling(policy);

    /**
     * W8: every invoice bills exactly one anchor — a policy, or a quote
     * before bind. Both ids may stand after a bind rollover; the policy
     * then speaks for the anchor. Neither is a bill nothing can reconcile,
     * and the send refuses it.
     */
    const quoteAnchor =
      !headerPolicyId && invoice.quoteId
        ? await getModel<Schema["Quote"]["type"] & { sourcePricingLoanId?: string }>("Quote", invoice.quoteId) ?? null
        : null;
    if (quoteAnchor && quoteAnchor.accountId !== invoice.accountId) throw new SendBlocked("The invoice quote could not be verified.");
    if (!headerPolicyId && !quoteAnchor) {
      return {
        ok: false,
        error: invoice.quoteId
          ? "That quote no longer exists."
          : linePolicyIds.length > 1
            ? `This invoice's lines bill ${linePolicyIds.length} policies. One invoice bills one policy now — remove the other policies' lines, or void this and bill each policy on its own invoice.`
            : "Every invoice bills a policy or a quote. Set one before sending.",
      };
    }
    /**
     * A quote anchor must still be OPEN. A bound quote's billing belongs to
     * its policy — a stranded pre-bind invoice re-anchors through the bind
     * rollover, not through a send against paper that already became a
     * policy — and a lost or declined quote bills coverage that will never
     * exist.
     */
    if (quoteAnchor && !isOpenQuoteStatus(quoteAnchor.status)) {
      return {
        ok: false,
        error:
          quoteAnchor.status === "BOUND"
            ? "This quote has been bound. The invoice should have rolled to the policy at bind — re-run the rollover from the quote's panel, or void this and bill the policy."
            : `This quote is ${(quoteAnchor.status ?? "closed").toLowerCase()} — there is no coverage to bill. Void the invoice.`,
      };
    }
    const billsPremium = lines.some(line => line.kind !== "BROKER_FEE" && (line.retailAmount ?? 0) > 0);
    if (billsPremium && invoice.sourcePricingVersion !== 2) {
      await assertPremiumNotFinanced(invoice.accountId,
        headerPolicyId ? [...linePolicyIds, headerPolicyId] : linePolicyIds,
        policy?.quoteId ?? invoice.quoteId, policy?.sourcePricingLoanId ?? quoteAnchor?.sourcePricingLoanId);
    }
    const anchor = headerPolicyId
      ? { kind: "policy", id: headerPolicyId }
      : { kind: "quote", id: invoice.quoteId! };

    /**
     * One live invoice per anchor (W8): a DRAFT/SENT/PROCESSING sibling on
     * the same policy or quote refuses the send — PAID and VOID free the
     * slot for endorsement and audit billing later. Three scans make the
     * rule airtight where one would leak:
     * - header ids, the W8 anchor;
     * - the policy's own quoteId, so a pre-bind invoice whose rollover
     *   failed still holds the slot against the policy it billed;
     * - line-level policy ids, because invoices from before the header
     *   existed anchor only through their lines.
     */
    const siblingFilters: Record<string, unknown>[] =
      anchor.kind === "policy"
        ? [
            { policyId: { eq: anchor.id } },
            ...(policy?.quoteId ? [{ quoteId: { eq: policy.quoteId } }] : []),
          ]
        : [{ quoteId: { eq: anchor.id } }];
    const siblingInvoices = await listAllPages((nextToken) =>
      client.models.Invoice.list({
        filter: siblingFilters.length === 1 ? siblingFilters[0] : { or: siblingFilters },
        nextToken,
      })
    );
    if (anchor.kind === "policy") {
      const anchorLines = await listAllPages((nextToken) =>
        client.models.InvoiceLine.list({
          filter: { policyId: { eq: anchor.id } },
          nextToken,
        })
      );
      const known = new Set(siblingInvoices.map((i) => i.id));
      const extraIds = [...new Set(anchorLines.map((l) => l.invoiceId))].filter(
        (id) => id !== invoice.id && !known.has(id)
      );
      for (const id of extraIds) {
        const { data: extra } = await client.models.Invoice.get({ id });
        if (extra) siblingInvoices.push(extra);
      }
    }
    const liveSibling = siblingInvoices.find(
      (i) =>
        i.id !== invoice.id &&
        ["DRAFT", "SENT", "PROCESSING"].includes(i.status ?? "") && !isNonpayableAdjustmentStatement(i)
    );
    if (liveSibling) {
      return {
        ok: false,
        error: `Invoice ${liveSibling.number ?? liveSibling.id} already bills this ${anchor.kind} and is still ${(liveSibling.status ?? "open").toLowerCase()}. One live invoice per ${anchor.kind} — void it or collect it first.`,
      };
    }

    await assertInitialInvoiceAvailable(invoice);
    const adjustmentProof=await assertAdjustmentInvoiceProof(invoice);
    const policyGuard = policy ? standalonePolicyBillingGuard(policy) : undefined;
    const feeSource = policy ?? quoteAnchor;
    const sourceQuoteId = policy?.quoteId ?? quoteAnchor?.id;
    const expectedFeeCents = brokerFeeCents(feeSource?.brokerFee);
    const existingFee = sourceQuoteId && expectedFeeCents > 0 ? await getFee(sourceQuoteId) : null;
    const feeAlreadySubmitted = !!existingFee && (existingFee.submittedCents > 0 || existingFee.collectedCents > 0 || existingFee.refundedCents > 0);
    const issuedAllocations = feeAllocations(invoice.brokerFeeAllocations);
    if (invoice.status === "SENT" && issuedAllocations.length) {
      const issuedFeeCents = issuedAllocations.reduce((sum, part) => sum + part.amountCents, 0);
      const issuedTotalCents = invoice.stripeLinkAmountCents ?? (invoice.remittanceCarrierCents ?? 0) + (invoice.remittanceCommissionCents ?? 0) + (invoice.remittanceInterestCents ?? 0) + (invoice.remittanceBrokerFeeCents ?? 0);
      if (Math.round(invoiceTotals(lines).retail * 100) !== issuedTotalCents || expectedFeeCents !== issuedFeeCents) return { ok: false, error: "This broker fee invoice has already been issued. Void it before changing its charges, then issue the updated invoice." };
    }
    const refresh = brokerFeeInvoiceRefresh({ invoice, source: feeSource, quoteId: sourceQuoteId, policyId: headerPolicyId, lines, alreadySubmitted: feeAlreadySubmitted });
    for (const id of refresh.remove) {
      const deleted = await client.models.InvoiceLine.delete({ id });
      if (deleted.errors?.length) throw new SendBlocked("The invoice could not refresh its generated broker fee. Retry sending.");
      const at = lines.findIndex(line => line.id === id); if (at >= 0) lines.splice(at, 1);
    }
    if (refresh.upsert) {
      const existing = lines.some(line => line.id === refresh.upsert!.id);
      const saved = existing ? await client.models.InvoiceLine.update(refresh.upsert) : await client.models.InvoiceLine.create(refresh.upsert);
      if (saved.errors?.length || !saved.data) throw new SendBlocked("The invoice could not refresh its generated broker fee. Retry sending.");
      const at = lines.findIndex(line => line.id === saved.data!.id); if (at >= 0) lines[at] = saved.data; else lines.push(saved.data);
    }
    if (!lines.length) return { ok: false, error: "This invoice no longer has a charge. Review its source quote." };
    let allocations: BrokerFeeAllocation[];
    try { allocations = invoiceBrokerFeeAllocations({ invoice, source: feeSource, quoteId: sourceQuoteId, policyId: headerPolicyId, lines, alreadySubmitted: feeAlreadySubmitted }); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The broker fee invoice could not be verified." }; }
    validateInvoiceSourceCharges({ invoice, source: adjustmentProof?{id:String(adjustmentProof.policy.id),accountId:String(adjustmentProof.policy.accountId),billType:adjustmentProof.policy.billType as string|undefined}:feeSource, lines });
    const split = remittanceSplit(lines);
    const carrierId = policy?.carrierId ?? quoteAnchor?.carrierId ?? null;
    const carrier = carrierId
      ? (await client.models.Carrier.get({ id: carrierId })).data
      : null;

    // Known-local payment failures must not create an unknown processor hold.
    // A missing key or unsupported amount created no external link to recover.
    let feeChargeCents: number | undefined;
    if (allocations.length && invoice.status !== "PAID" && invoice.status !== "PROCESSING") {
      if (!process.env.STRIPE_SECRET_KEY) throw new SendBlocked("Payments are not configured. Configure payments, then retry this invoice's Send action.");
      try { feeChargeCents = toCents(invoiceTotals(lines).retail); }
      catch (error) { throw new SendBlocked(error instanceof Error ? error.message : "This invoice total cannot be collected online."); }
    }

    // Completed retries must return before starting another fee link claim.
    // This lease also serializes same-invoice Stripe retries in production.
    const tracked = ["resend", "ses"].includes(process.env.HOA_TRANSACTIONAL_MAIL_PROVIDER ?? "")
      ? await beginInvoiceSend(invoice, to, event.arguments?.expectedSentAt, { database: ddb })
      : undefined;
    if (tracked?.completed) return tracked.completed;

    let disclosureUrl: string | undefined;
    let paymentLabel: string | undefined;
    let feeSendClaim: BrokerFeeInvoiceSendClaim | undefined;
    if (allocations.length && invoice.status !== "PAID" && invoice.status !== "PROCESSING") {
      const sourceQuote = quoteAnchor ?? (sourceQuoteId ? (await client.models.Quote.get({ id: sourceQuoteId })).data : null);
      if (!sourceQuote) return { ok: false, error: "The original quote is required for this broker fee disclosure." };
      const terms = authorizedQuoteTerms(sourceQuote as unknown as Record<string,unknown>);
      let feeSigned = !!existingFee?.signedAt && existingFee.terms === terms && existingFee.amountCents === expectedFeeCents;
      if (feeSigned) { try { await assertBrokerFeeSigned(sourceQuote); } catch { feeSigned = false; } }
      if (!feeSigned) {
        const agreement = await prepareBrokerFeeAgreement(invoice.accountId, [{ id: sourceQuote.id, accountId: sourceQuote.accountId, carrierId: sourceQuote.carrierId, carrierName: carrier?.name ?? undefined, lines: sourceQuote.lines, premium: sourceQuote.premium, brokerFee: sourceQuote.brokerFee, billType: sourceQuote.billType, effectiveDate: sourceQuote.effectiveDate, expirationDate: sourceQuote.expirationDate, terms }], undefined, { reuseContainingAgreement: true });
        disclosureUrl = agreement.url;
        paymentLabel = "Review and sign broker fee disclosure";
      }
      feeSendClaim = await reserveFeeInvoice(sourceQuote, invoice.id, feeChargeCents!);
    }

    /**
     * Before rendering, so the email carries the button. The total comes from
     * the same `invoiceTotals` the screen ran, over rows read here rather than
     * over anything the caller posted.
     */
    const paymentUrl = invoice.status === "PAID" || invoice.status === "PROCESSING" ? null : await ensurePaymentLink(
      invoice,
      account.data.name,
      invoiceTotals(lines).retail,
      split,
      allocations,
      feeSendClaim,
      adjustmentProof
        ? [...adjustmentProof.guards, standalonePolicyBillingGuard(adjustmentProof.policy as { id: string; updatedAt: string }, true)]
        : policyGuard ? [policyGuard] : invoice.sourcePricingVersion === 1 && quoteAnchor && !allocations.length
          ? await initialQuotePublicationWrites(invoice, quoteAnchor) : []
    );

    /**
     * The envelope, in the order it would be typed.
     *
     * "Attn:" names whoever this went to rather than the primary contact,
     * because on a bill addressed to the treasurer the manager's name at the
     * top is a small lie about who owes an answer. Blanks are dropped here so
     * the renderer never has to decide whether a line is worth printing.
     */
    const addressee = contacts.find((c) => to.includes((c.email ?? "").trim()));
    const cityStateZip = [
      account.data.city,
      [account.data.state, account.data.zip].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(", ");
    const billToLines = [
      addressee?.name ? `Attn: ${addressee.name}` : "",
      account.data.address ?? "",
      cityStateZip,
    ].filter((l) => l.trim());

    const view = {
      number: invoice.number,
      associationName: account.data.name,
      propertyState: account.data.state,
      contactFirstName: primary?.name?.trim().split(/\s+/)[0] ?? null,
      billToLines,
      policyNumber: policy?.policyNumber ?? null,
      carrierName: carrier?.name ?? null,
      coverage:
        ((policy?.lines ?? quoteAnchor?.lines ?? []) as (string | null)[])
          .filter(Boolean)
          .join(", ") || null,
      // The insured location. Same address as the bill-to in most cases, and
      // printed anyway: an association managed off-site is billed at the
      // manager's office and insured at its own, and an invoice that shows
      // only one of the two cannot be matched to a policy without opening it.
      riskLocation: [account.data.address ?? "", cityStateZip].filter((l) => l.trim()),
      effectiveDate: policy?.effectiveDate ?? quoteAnchor?.effectiveDate ?? null,
      expirationDate: policy?.expirationDate ?? quoteAnchor?.expirationDate ?? null,
      coverageBound: Boolean(policy?.datePolicyBound),
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      memo: invoice.memo,
      paymentUrl: disclosureUrl ?? paymentUrl,
      paymentLabel,
      lines: [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    };
    return await deliverInvoice({ invoice, view, to, tracked, split, allocations, feeSendClaim,
      onAccepted: () => { acceptedForReview = true; } });
  } catch (err) {
    if (err instanceof SendBlocked || err instanceof GroupedDraftBillingBlocked || err instanceof InvoiceSendBlocked || err instanceof MailDeliveryError) {
      return { ok: false, error: err.message };
    }
    captureHandledFailure(err);
    if (acceptedForReview) return { ok: false, error: "The invoice email was accepted, but its send details need review. Do not send a replacement." };
    console.error("send-invoice failed", err);
    return { ok: false, error: "We couldn't send that invoice. Please try again." };
  }
};
