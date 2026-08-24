import { randomUUID } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { isOpenQuoteStatus } from "../../../src/lib/quoteStatus";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import Stripe from "stripe";
import { invoiceTotals, remittanceSplit } from "../../../src/lib/invoiceTotals";
import { electionExpiry, mintElectionToken } from "../pfElectionToken";
import { originateLoan } from "../pfOrigination";
import {
  PF_DEFAULT_APR,
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
} from "../../../src/lib/premiumFinance/quote";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";
import { renderInvoice } from "./invoice";
import { createPaymentLink, toCents } from "./stripeLink";
import { buildMimeMessage } from "./mime";
import { pdfFilename, renderInvoicePdf } from "./pdf";

/**
 * Custom mutation handler: sendInvoice. See resource.ts for the why.
 *
 * Arguments are an invoice id and, optionally, an address to override the
 * account's primary contact. Everything else — lines, amounts, policy, carrier —
 * is read here.
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

const ses = new SESv2Client();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/**
 * A send that must not proceed, with words fit for the screen.
 *
 * Thrown from the payment-link step when carrying on would leave a live link
 * the invoice no longer tracks — the outer catch turns it into `{ok:false}`
 * rather than the generic apology, because "try again" is the actual remedy.
 */
class SendBlocked extends Error {}

/** The anchor a W8 invoice bills: a policy, or a quote before bind. */
interface FinanceAnchor {
  kind: "policy" | "quote";
  id: string;
  lines: readonly (string | null | undefined)[];
}

/**
 * W8: the financing side of the fork, or null — and since origination moved
 * into the send, this is where loans are BORN. Fixed terms (25% down as
 * payment 1 of 12, 14% APR, 11 installments), financed amount = the
 * invoiced total, schedule anchored at the send date. The core runs every
 * gate and logs every rule; a block means a plain bill, never a stopped
 * send. Null on any failure for the same reason ensurePaymentLink is: a
 * bill that arrives beats an offer that stopped it.
 *
 * Re-pricing supersedes: a QUOTED loan whose premium no longer matches the
 * billed total is conditionally cancelled (`superseded-by-repricing`,
 * logged) and a fresh one originates at the new figure. A loan the
 * association has already committed to — ACCEPTED onward — suppresses any
 * new origination and any offer: the choice was made.
 */
async function financeOffer(
  client: DataClient,
  account: {
    id: string;
    state: string | null | undefined;
    type: string | null | undefined;
    incorporated: boolean | null | undefined;
  },
  anchor: FinanceAnchor | null,
  retailTotal: number,
  recipientEmail: string | null
): Promise<{ url: string; downPayment: number; monthly: number; months: number; apr: number } | null> {
  if (!anchor || retailTotal <= 0) return null;
  const loanTable = process.env.PF_LOAN_TABLE;
  const siteUrl = process.env.SITE_URL;
  if (!loanTable || !siteUrl) return null;
  try {
    const { data: settings } = await client.models.AgencySettings.get({ id: "AGENCY" });
    if (settings?.premiumFinanceEnabled !== true) return null;

    const anchorFilter =
      anchor.kind === "policy"
        ? { policyId: { eq: anchor.id } }
        : { quoteId: { eq: anchor.id } };
    const loans = await listAllPages((nextToken) =>
      client.models.PfLoan.list({ filter: anchorFilter, nextToken })
    );
    if (
      loans.some((l) =>
        ["ACCEPTED", "ACTIVE", "DEFAULTED", "PAID"].includes(l.status ?? "")
      )
    ) {
      return null;
    }
    // Annotated: the backend tsconfig lacks noUncheckedIndexedAccess, so
    // `[0] ?? null` would otherwise infer the element type WITHOUT null.
    let loan: (typeof loans)[number] | null =
      [...loans]
        .filter((l) => l.status === "QUOTED")
        .sort((a, b) => (b.quotedAt ?? "").localeCompare(a.quotedAt ?? ""))[0] ?? null;

    /**
     * An election is COMMITTED before the loan leaves QUOTED: the customer
     * signs and accepts, their down payment can be clearing for days
     * (ACH), and only settlement flips the status. A committed loan is
     * never superseded and never quietly replaced — cancelling it would
     * land the customer's money on a CANCELLED loan. Committed means money
     * is in flight or could be within minutes: a stamped down-payment
     * intent, or a live Checkout session/claim the customer may be sitting
     * on right now. A bill re-priced over a committed election is a human's
     * knot to untie; the email goes out with pay-in-full only.
     */
    const nowIso = new Date().toISOString();
    const committed =
      loan &&
      (loan.downPaymentIntentId ||
        (loan.electionCheckoutUrl &&
          loan.electionCheckoutExpiresAt &&
          loan.electionCheckoutExpiresAt > nowIso));
    if (loan && committed && loan.premium !== retailTotal) {
      console.error(
        `[send-invoice] invoice re-priced to ${retailTotal} over committed election on loan ${loan.id} (quoted ${loan.premium}) — offering nothing; resolve by hand`
      );
      return null;
    }

    const today = new Date().toISOString().slice(0, 10);
    const stale = loan && (loan.effectiveDate ?? today) < today;
    if (loan && !committed && (loan.premium !== retailTotal || stale)) {
      /**
       * The bill changed under the offer, or the offer aged past its send
       * day (the spec anchors the schedule at the send date — a resend
       * weeks later must not offer a schedule already in arrears). The old
       * quote's terms are dead, so it cancels — conditionally on still
       * being QUOTED at the premium the decision read AND still
       * uncommitted at write time, because the customer can be electing in
       * this very second — and a fresh quote takes its place.
       */
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: loanTable,
            Key: { id: loan.id },
            UpdateExpression: "SET #s = :c, closedAt = :now, updatedAt = :now",
            ConditionExpression:
              "#s = :q AND premium = :seen AND attribute_not_exists(downPaymentIntentId) AND (attribute_not_exists(electionCheckoutUrl) OR electionCheckoutExpiresAt < :now)",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":c": "CANCELLED",
              ":q": "QUOTED",
              ":seen": loan.premium,
              ":now": nowIso,
            },
          })
        );
        await logSupersession(loan, retailTotal, account.id);
      } catch (err) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
        // The loan moved mid-send — a payment landed, or an election
        // committed under this write. Offer nothing; the next send
        // re-reads the world.
        return null;
      }
      loan = null;
    }

    if (!loan) {
      const result = await originateLoan(
        ddb,
        {
          // Paginated to exhaustion: a list filter is applied AFTER the
          // page is read, so a capped single page can silently miss the
          // one opinion or override that matters once the table grows.
          listOpinions: async (code) => {
            const rows = await listAllPages((nextToken) =>
              client.models.PfCounselOpinion.list({
                filter: { jurisdiction: { eq: code } },
                nextToken,
              })
            );
            return rows.map((o) => ({ effectiveAt: o.effectiveAt, reviewBy: o.reviewBy }));
          },
        },
        settings?.premiumFinanceEnabled === true,
        {
          account,
          anchor,
          premium: retailTotal,
          downPct: PF_DEFAULT_DOWN_PCT,
          months: PF_DEFAULT_MONTHS,
          apr: PF_DEFAULT_APR,
          effectiveDate: today,
          actor: "send-invoice",
          actorName: "send-invoice (auto-origination)",
        }
      );
      if (!result.ok || !result.loanId) {
        if (result.ok) {
          console.log(
            `[send-invoice] financing not offered on ${anchor.kind} ${anchor.id}: ${result.blocks
              .map((b) => b.rule)
              .join(", ")}`
          );
        } else {
          console.warn(`[send-invoice] origination failed: ${result.error}`);
        }
        return null;
      }
      /**
       * Straight off the table, strongly: the AppSync read is eventually
       * consistent and a miss here would drop the offer from the very email
       * that originated the loan.
       */
      const created = await ddb
        .send(
          new GetCommand({ TableName: loanTable, Key: { id: result.loanId }, ConsistentRead: true })
        )
        .then((r) => r.Item as typeof loan | undefined);
      loan = created ?? null;
      if (!loan) return null;
    }

    let token = loan.electionToken ?? null;
    const fresh =
      token &&
      loan.electionTokenExpiresAt &&
      new Date(loan.electionTokenExpiresAt).getTime() > Date.now() + 7 * 24 * 60 * 60 * 1000;
    if (!fresh) {
      const seenToken = token;
      token = mintElectionToken();
      // Conditional on the token this decision read: two concurrent sends
      // must not last-write-win each other's mint, or the first email
      // carries a link that is already dead. The loser's email goes out
      // without the offer — honest, and the next send self-heals.
      await ddb.send(
        new UpdateCommand({
          TableName: loanTable,
          Key: { id: loan.id },
          UpdateExpression:
            "SET electionToken = :tok, electionTokenExpiresAt = :exp, electionEmail = :email, updatedAt = :now",
          ConditionExpression: seenToken
            ? "#s = :quoted AND electionToken = :seenTok"
            : "#s = :quoted AND attribute_not_exists(electionToken)",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":tok": token,
            ":exp": electionExpiry(new Date()),
            ":email": recipientEmail ?? null,
            ":quoted": "QUOTED",
            ":now": new Date().toISOString(),
            ...(seenToken ? { ":seenTok": seenToken } : {}),
          },
        })
      );
    }
    return {
      url: `${siteUrl}/finance/?t=${token}`,
      downPayment: loan.downPayment,
      monthly: loan.payment,
      months: loan.months,
      apr: loan.apr,
    };
  } catch (err) {
    console.warn("[send-invoice] financing offer omitted", err);
    return null;
  }
}

/** The supersession's audit row — same shape every pf writer uses. */
async function logSupersession(
  loan: { id: string; premium: number; state?: string | null },
  retailTotal: number,
  accountId: string
) {
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
          accountId,
          jurisdiction: loan.state ?? "UNKNOWN",
          rule: "superseded-by-repricing",
          outcome: "BLOCK",
          reason: `Quote for $${loan.premium.toLocaleString("en-US")} superseded: the invoice now bills $${retailTotal.toLocaleString("en-US")}.`,
          inputs: JSON.stringify({ loanId: loan.id, was: loan.premium, now: retailTotal }),
          configSha256: PF_CONFIG_SHA256,
          actor: "send-invoice",
          actorName: "send-invoice (auto-origination)",
          occurredAt: now,
        },
      })
    );
  } catch (err) {
    console.error("[send-invoice] supersession log write failed", err);
  }
}

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
    number?: string | null;
    status?: string | null;
    paymentUrl?: string | null;
    stripePaymentLinkId?: string | null;
    stripeLinkAmountCents?: number | null;
  },
  associationName: string,
  total: number
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
    key
  ) {
    try {
      const link = await new Stripe(key).paymentLinks.retrieve(existingLinkId);
      if (link.active) return existingUrl;
      console.warn(
        `[send-invoice] link ${existingLinkId} on ${invoice.number ?? invoice.id} is no longer active; minting a fresh one`
      );
    } catch (err) {
      console.warn(
        "[send-invoice] could not confirm the old link is live; minting a fresh one",
        err
      );
    }
  }

  if (!key) {
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
  }

  let minted: { id: string; url: string };
  try {
    minted = await createPaymentLink(stripe, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      associationName,
      total,
    });
  } catch (err) {
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
    { url: minted.url, linkId: minted.id, amountCents: wantedCents }
  );
  if (!stored) {
    try {
      await stripe.paymentLinks.update(minted.id, { active: false });
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
  next: { url: string; linkId: string; amountCents: number | null }
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
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: invoiceId },
        UpdateExpression:
          "SET paymentUrl = :url, #link = :link, stripeLinkAmountCents = :cents, lastWriteBy = :writer, updatedAt = :now",
        ConditionExpression: clauses.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
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
  facts: Record<string, string | number | null>,
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

export const handler = async (event: {
  arguments?: { invoiceId?: string; toEmail?: string };
}) => {
  const invoiceId = event.arguments?.invoiceId;
  if (!invoiceId) return { ok: false, error: "No invoice was named." };

  const client = await getDataClient();

  try {
    const { data: invoice } = await client.models.Invoice.get({ id: invoiceId });
    if (!invoice) return { ok: false, error: "That invoice no longer exists." };
    if (invoice.status === "VOID") {
      return { ok: false, error: "That invoice has been voided." };
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
    if (!lines.length) {
      return { ok: false, error: "Add at least one line before sending." };
    }

    /**
     * Where it goes: the override if one was given, otherwise the account's
     * primary contact. Never a guess — an invoice sent to the wrong address is
     * worse than one not sent.
     */
    const contacts = await listAllPages((nextToken) =>
      client.models.Contact.list({
        filter: { accountId: { eq: invoice.accountId } },
        limit: 1000,
        nextToken,
      })
    );
    const primary = contacts.find((c) => c.isPrimary) ?? contacts[0];
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
      ? (await client.models.Policy.get({ id: headerPolicyId })).data
      : null;

    /**
     * W8: every invoice bills exactly one anchor — a policy, or a quote
     * before bind. Both ids may stand after a bind rollover; the policy
     * then speaks for the anchor. Neither is a bill nothing can reconcile,
     * and the send refuses it.
     */
    const quoteAnchor =
      !headerPolicyId && invoice.quoteId
        ? (await client.models.Quote.get({ id: invoice.quoteId })).data
        : null;
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
    const anchor: FinanceAnchor = headerPolicyId
      ? {
          kind: "policy",
          id: headerPolicyId,
          lines: policy?.lines ?? [],
        }
      : {
          kind: "quote",
          id: invoice.quoteId!,
          lines: quoteAnchor!.lines ?? [],
        };

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
        ["DRAFT", "SENT", "PROCESSING"].includes(i.status ?? "")
    );
    if (liveSibling) {
      return {
        ok: false,
        error: `Invoice ${liveSibling.number ?? liveSibling.id} already bills this ${anchor.kind} and is still ${(liveSibling.status ?? "open").toLowerCase()}. One live invoice per ${anchor.kind} — void it or collect it first.`,
      };
    }

    const carrierId = policy?.carrierId ?? quoteAnchor?.carrierId ?? null;
    const carrier = carrierId
      ? (await client.models.Carrier.get({ id: carrierId })).data
      : null;

    /**
     * Before rendering, so the email carries the button. The total comes from
     * the same `invoiceTotals` the screen ran, over rows read here rather than
     * over anything the caller posted.
     */
    const paymentUrl = await ensurePaymentLink(
      invoice,
      account.data.name,
      invoiceTotals(lines).retail
    );

    // W8: the other side of the fork originates HERE, at fixed terms on
    // the billed total, through every gate — or rides an existing QUOTED
    // offer whose premium still matches.
    const finance = await financeOffer(
      client,
      {
        id: account.data.id,
        state: account.data.state,
        type: account.data.type,
        incorporated: account.data.incorporated,
      },
      anchor,
      invoiceTotals(lines).retail,
      to[0] ?? null
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
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      memo: invoice.memo,
      paymentUrl,
      finance,
      lines: [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    };
    const { subject, text, html } = renderInvoice(view);

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
      from: FROM,
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
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM,
        Destination: {
          ToAddresses: to,
          ...(selfAddressed ? {} : { BccAddresses: [MAILBOX] }),
        },
        Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
      })
    );

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
    const split = remittanceSplit(lines);

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
      remittanceCarrierCents: split.carrierCents,
      remittanceCommissionCents: split.commissionCents,
      remittanceInterestCents: split.interestCents,
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

    console.log(`send-invoice sent ${invoice.number ?? invoiceId} to ${to.join(", ")}`);
    return { ok: true, sentTo: to.join(", "), subject };
  } catch (err) {
    if (err instanceof SendBlocked) {
      return { ok: false, error: err.message };
    }
    console.error("send-invoice failed", err);
    return { ok: false, error: "We couldn't send that invoice. Please try again." };
  }
};
