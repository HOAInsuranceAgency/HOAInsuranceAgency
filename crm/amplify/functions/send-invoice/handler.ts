import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import Stripe from "stripe";
import { invoiceTotals, remittanceSplit } from "../../../src/lib/invoiceTotals";
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
  invoice: {
    id: string;
    number?: string | null;
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

  /**
   * Reuse only when the link still bills what the invoice says.
   *
   * A Payment Link's Price is fixed at creation. Editing lines and sending
   * again used to return the old link, so the email and the PDF showed the
   * revised total while the button charged the original one — an overpayment or
   * an underpayment, silently. Lines stay editable after sending on purpose,
   * because a carrier revising a premium is ordinary, so this is not a corner.
   */
  if (existingUrl && existingLinkId && wantedCents !== null) {
    if (invoice.stripeLinkAmountCents === wantedCents) return existingUrl;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn("[send-invoice] STRIPE_SECRET_KEY unset; sending without a link");
    return null;
  }
  if (total <= 0) return null;

  try {
    const stripe = new Stripe(key);

    /**
     * Deactivate the superseded link before minting its replacement, so the
     * amount the invoice no longer claims cannot still be paid. Best effort: a
     * failure here must not stop the correct link being issued, and a stale
     * link that stays payable is a smaller problem than no link at all.
     */
    if (existingLinkId) {
      try {
        await stripe.paymentLinks.update(existingLinkId, { active: false });
      } catch (err) {
        console.warn("[send-invoice] could not deactivate the old link", err);
      }
    }

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
      // What it bills, so the next send can tell whether it is still right.
      stripeLinkAmountCents: wantedCents,
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
      coverage: (policy?.lines ?? []).filter(Boolean).join(", ") || null,
      // The insured location. Same address as the bill-to in most cases, and
      // printed anyway: an association managed off-site is billed at the
      // manager's office and insured at its own, and an invoice that shows
      // only one of the two cannot be matched to a policy without opening it.
      riskLocation: [account.data.address ?? "", cityStateZip].filter((l) => l.trim()),
      effectiveDate: policy?.effectiveDate ?? null,
      expirationDate: policy?.expirationDate ?? null,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      memo: invoice.memo,
      paymentUrl,
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

    await client.models.Invoice.update({
      id: invoiceId,
      ...(invoice.status === "DRAFT" ? { status: "SENT" as const } : {}),
      sentAt: new Date().toISOString(),
      sentTo: to.join(", "),
      remittanceCarrierCents: split.carrierCents,
      remittanceCommissionCents: split.commissionCents,
      remittanceInterestCents: split.interestCents,
      // Named, because this write does not go through the browser's actor
      // proxy. Without it the activity log would say "System" sent the bill,
      // when a person pressed the button.
      lastWriteBy: "send-invoice",
    });

    console.log(`send-invoice sent ${invoice.number ?? invoiceId} to ${to.join(", ")}`);
    return { ok: true, sentTo: to.join(", "), subject };
  } catch (err) {
    console.error("send-invoice failed", err);
    return { ok: false, error: "We couldn't send that invoice. Please try again." };
  }
};
