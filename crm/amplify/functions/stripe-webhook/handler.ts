import Stripe from "stripe";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { decideEvent, decideUpdate } from "./decide";

/**
 * Stripe → invoice status. See resource.ts for why this is a Function URL.
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

let stripe: Stripe | undefined;
const getStripe = () => (stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY as string));

/** Anything 2xx tells Stripe to stop retrying. */
const ok = (body: string) => ({ statusCode: 200, body });
const refused = (body: string) => ({ statusCode: 400, body });

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
    // Nothing below this line runs on an unverified payload.
    console.warn("stripe-webhook rejected an unverified payload", err);
    return refused("bad signature");
  }

  const decision = decideEvent(parsed as never);
  if (!decision) {
    // An event we do not act on is still an event we received. 200, or Stripe
    // retries it forever.
    return ok("ignored");
  }

  try {
    const client = await getDataClient();
    const { data: invoice } = await client.models.Invoice.get({
      id: decision.invoiceId,
    });
    if (!invoice) {
      console.warn(`stripe-webhook: no invoice ${decision.invoiceId}`);
      return ok("unknown invoice");
    }

    const today = new Date().toISOString().slice(0, 10);
    const update = decideUpdate(invoice, decision, today);
    if (update.action === "skip") {
      console.log(
        `stripe-webhook skipped ${invoice.number ?? invoice.id}: ${update.reason}`
      );
      return ok("skipped");
    }

    const { errors } = await client.models.Invoice.update({
      id: invoice.id,
      status: update.status as Schema["Invoice"]["type"]["status"],
      ...(update.paidAt ? { paidAt: update.paidAt } : {}),
      stripePaymentIntentId: update.paymentIntentId,
      // The ordering key for every event after this one.
      stripeEventAt: update.occurredAt,
      // Named, so the activity log says the payment did this rather than a
      // person. Whoever reads the timeline should see where the change came
      // from without going to Stripe to find out.
      lastWriteBy: "stripe-payment",
    });
    if (errors?.length) throw new Error(errors[0].message);

    console.log(
      `stripe-webhook ${parsed.type} → ${update.status} on ${invoice.number ?? invoice.id}`
    );
    return ok("ok");
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
