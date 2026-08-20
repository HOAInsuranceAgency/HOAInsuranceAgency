import Stripe from "stripe";

/**
 * The Stripe payment link behind an invoice's Pay button.
 *
 * ── ACH only, deliberately ──────────────────────────────────────────────────
 * `us_bank_account` and nothing else. Massachusetts bans credit card
 * surcharging outright (MGL c. 140D s.28A), so a card payment's ~2.9% comes out
 * of the agency's commission rather than the payer's pocket: on a $33,000
 * premium that is about $968, close to a fifth of the commission on it. ACH is
 * $5 flat at Stripe's 0.8%-capped-at-$5 rate, and a board paying a five-figure
 * premium pays from a bank account anyway. An association that cannot pay in
 * full wants premium finance, not a credit card.
 *
 * ── A link, not a checkout session ──────────────────────────────────────────
 * Sessions expire, at most thirty days out. An invoice can sit with a board
 * until they next meet, and a dead link on a bill is a phone call. Payment
 * links do not expire; `completed_sessions.limit = 1` is what stops one being
 * paid twice.
 */

/** Cents, as Stripe counts money. Rejects anything that is not a real amount. */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error("That total is not a number.");
  const cents = Math.round(dollars * 100);
  if (cents <= 0) throw new Error("An invoice must be for more than zero.");
  // Stripe's own ceiling is 99,999,999 cents. A premium above that is a typo.
  if (cents > 99_999_999) throw new Error("That total is too large to bill online.");
  return cents;
}

export interface LinkRequest {
  invoiceId: string;
  invoiceNumber: string | null;
  associationName: string;
  /** Retail total, in dollars. */
  total: number;
}

/**
 * Create the link. Returns its id and url.
 *
 * `metadata` is set twice on purpose: once on the link, and once under
 * `payment_intent_data` so it lands on the PaymentIntent itself. The webhook
 * reads the PaymentIntent, and a link's own metadata does not reach it — which
 * would leave the webhook holding a payment it could not attribute to a bill.
 */
export async function createPaymentLink(
  stripe: Stripe,
  req: LinkRequest
): Promise<{ id: string; url: string }> {
  const label = req.invoiceNumber
    ? `${req.associationName} — invoice ${req.invoiceNumber}`
    : `${req.associationName} — insurance premium`;

  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: toCents(req.total),
    product_data: { name: label },
  });

  const metadata = {
    invoiceId: req.invoiceId,
    invoiceNumber: req.invoiceNumber ?? "",
  };

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    payment_method_types: ["us_bank_account"],
    // One payment per bill. Without this a link is reusable and an association
    // that forwards it internally can pay the same premium twice.
    restrictions: { completed_sessions: { limit: 1 } },
    metadata,
    payment_intent_data: { metadata },
    after_completion: {
      type: "hosted_confirmation",
      hosted_confirmation: {
        // Said plainly because it is true and it is the thing people ring about:
        // an ACH debit is authorised now and clears over the following days.
        custom_message:
          "Thank you. Your bank transfer has been submitted and usually clears " +
          "within a few business days. We'll email a receipt once it settles.",
      },
    },
  });

  if (!link.url) throw new Error("Stripe returned a link with no URL.");
  return { id: link.id, url: link.url };
}
