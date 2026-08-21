import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import Stripe from "stripe";
import type { Schema } from "../../data/resource";

/**
 * Custom mutation handler: voidInvoice. See resource.ts for the why.
 *
 * One argument, the invoice id. Deactivates the Stripe Payment Link if there is
 * one, then writes VOID.
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

export const handler = async (event: {
  arguments?: { invoiceId?: string };
}): Promise<{ ok: boolean; error?: string }> => {
  const invoiceId = event.arguments?.invoiceId?.trim();
  if (!invoiceId) return { ok: false, error: "No invoice given." };

  try {
    const client = await getDataClient();
    const { data: invoice } = await client.models.Invoice.get({ id: invoiceId });
    if (!invoice) return { ok: false, error: "That invoice no longer exists." };

    // Already void, and nothing to undo. Idempotent because a producer who
    // pressed it twice should not see an error the second time.
    if (invoice.status === "VOID") return { ok: true };

    /**
     * A paid invoice is a record of money received. Voiding it would say the
     * bill was withdrawn, which is not what happened, and the trust account
     * would disagree.
     */
    if (invoice.status === "PAID") {
      return { ok: false, error: "That invoice has been paid and cannot be voided." };
    }

    /**
     * The link dies before the status changes.
     *
     * This order is the point of the whole function. If deactivation fails and
     * the status had already been written, the result is a void invoice with a
     * live payment link — money collectable against a bill the webhook will
     * ignore, which is exactly the state this exists to prevent. Failing here
     * leaves an ordinary unpaid invoice, which is a state the system already
     * handles and a person can simply try again from.
     */
    const linkId = invoice.stripePaymentLinkId?.trim();
    if (linkId) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) {
        console.error("[void-invoice] STRIPE_SECRET_KEY unset; refusing to void");
        return {
          ok: false,
          error: "Payments are not configured, so the payment link cannot be closed.",
        };
      }
      try {
        await new Stripe(key).paymentLinks.update(linkId, { active: false });
      } catch (err) {
        /**
         * A link Stripe has never heard of is already unpayable, so that is not
         * a reason to refuse. Anything else is, because we cannot tell whether
         * it is still live.
         */
        const code = (err as { code?: string }).code;
        if (code !== "resource_missing") {
          console.error("[void-invoice] could not deactivate the payment link", err);
          return {
            ok: false,
            error: "Couldn't close the payment link, so the invoice was left alone.",
          };
        }
        console.warn(`[void-invoice] link ${linkId} already gone at Stripe`);
      }
    }

    const { errors } = await client.models.Invoice.update({
      id: invoiceId,
      status: "VOID",
      // Cleared so nothing renders a Pay button for a bill that is withdrawn —
      // the URL is dead now, and a dead link in an email is worse than none.
      paymentUrl: null,
      lastWriteBy: "void-invoice",
    });
    if (errors?.length) throw new Error(errors[0].message);

    console.log(`void-invoice voided ${invoice.number ?? invoiceId}`);
    return { ok: true };
  } catch (err) {
    console.error("void-invoice failed", err);
    return { ok: false, error: "We couldn't void that invoice. Please try again." };
  }
};
