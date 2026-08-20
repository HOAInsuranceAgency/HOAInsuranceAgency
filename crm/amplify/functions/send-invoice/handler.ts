import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import Stripe from "stripe";
import { invoiceTotals } from "../../../src/lib/invoiceTotals";
import { renderInvoice } from "./invoice";
import { createPaymentLink } from "./stripeLink";

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
  client: DataClient,
  invoice: { id: string; number?: string | null; paymentUrl?: string | null; stripePaymentLinkId?: string | null },
  associationName: string,
  total: number
): Promise<string | null> {
  if (invoice.paymentUrl?.trim()) return invoice.paymentUrl.trim();

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn("[send-invoice] STRIPE_SECRET_KEY unset; sending without a link");
    return null;
  }
  if (total <= 0) return null;

  try {
    const stripe = new Stripe(key);
    const { id, url } = await createPaymentLink(stripe, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      associationName,
      total,
    });
    await client.models.Invoice.update({
      id: invoice.id,
      paymentUrl: url,
      stripePaymentLinkId: id,
      lastWriteBy: "send-invoice",
    });
    return url;
  } catch (err) {
    console.error("[send-invoice] could not create a payment link", err);
    return null;
  }
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
    const to = (event.arguments?.toEmail || primary?.email || "").trim();
    if (!EMAIL_RE.test(to)) {
      return {
        ok: false,
        error: "No valid email address for this account. Add one, or type one in.",
      };
    }

    const policy = invoice.policyId
      ? (await client.models.Policy.get({ id: invoice.policyId })).data
      : null;
    const carrier = policy?.carrierId
      ? (await client.models.Carrier.get({ id: policy.carrierId })).data
      : null;

    /**
     * Before rendering, so the email carries the button. The total comes from
     * the same `invoiceTotals` the screen ran, over rows read here rather than
     * over anything the caller posted.
     */
    const paymentUrl = await ensurePaymentLink(
      client,
      invoice,
      account.data.name,
      invoiceTotals(lines).retail
    );

    const { subject, text, html } = renderInvoice({
      number: invoice.number,
      associationName: account.data.name,
      contactFirstName: primary?.name?.trim().split(/\s+/)[0] ?? null,
      policyNumber: policy?.policyNumber ?? null,
      carrierName: carrier?.name ?? null,
      effectiveDate: policy?.effectiveDate ?? null,
      expirationDate: policy?.expirationDate ?? null,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      memo: invoice.memo,
      paymentUrl,
      lines: [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    });

    /**
     * The agency keeps its own copy, for the reason the lead auto-reply BCCs
     * itself: a producer should be able to find what was sent without opening
     * the CRM. Skipped when the invoice is going to that mailbox anyway, since
     * SES would otherwise deliver it twice.
     */
    const selfAddressed = to.toLowerCase() === MAILBOX.toLowerCase();
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM,
        Destination: {
          ToAddresses: [to],
          ...(selfAddressed ? {} : { BccAddresses: [MAILBOX] }),
        },
        ReplyToAddresses: [MAILBOX],
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" },
            },
          },
        },
      })
    );

    /**
     * DRAFT becomes SENT; a resend of an already-SENT or PAID invoice leaves
     * the status alone. Marking a paid invoice back to SENT because someone
     * forwarded a copy would be a lie about money.
     */
    await client.models.Invoice.update({
      id: invoiceId,
      ...(invoice.status === "DRAFT" ? { status: "SENT" as const } : {}),
      sentAt: new Date().toISOString(),
      sentTo: to,
      // Named, because this write does not go through the browser's actor
      // proxy. Without it the activity log would say "System" sent the bill,
      // when a person pressed the button.
      lastWriteBy: "send-invoice",
    });

    console.log(`send-invoice sent ${invoice.number ?? invoiceId} to ${to}`);
    return { ok: true, sentTo: to, subject };
  } catch (err) {
    console.error("send-invoice failed", err);
    return { ok: false, error: "We couldn't send that invoice. Please try again." };
  }
};
