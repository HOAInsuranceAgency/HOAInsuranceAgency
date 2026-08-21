import Stripe from "stripe";
import { decideEvent, decideUpdate } from "./decide";
import { readInvoice, writePaymentState } from "./persist";

/**
 * Stripe → invoice status. See resource.ts for why this is a Function URL.
 *
 * Both the read and the write go straight to the Invoice table. This function
 * has no AppSync configuration — it is not in any `allow.resource()` grant, so
 * the data client cannot be built here at all — and it does not want one: see
 * `readInvoice` for why a strongly-consistent read is what makes the retry loop
 * below terminate.
 */

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

  const decision = decideEvent(parsed as never);
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

      const update = decideUpdate(invoice, decision, today);
      if (update.action === "skip") {
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
        console.log(
          `stripe-webhook ${parsed.type} → ${update.status} on ${invoice.number ?? invoice.id}`
        );
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
