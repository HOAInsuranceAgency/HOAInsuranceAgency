/**
 * What a Stripe event means for an invoice. Pure — no Stripe client, no data
 * client — so the rule that decides when money is considered received is
 * testable without either.
 *
 * ## The one thing this must never get wrong
 *
 * An ACH debit is authorised at checkout and clears days later, and it can
 * still fail after the payer has done everything right. Recording money that
 * has not arrived is the worst error a billing system can make: it stops the
 * chasing, it goes in the ledger, and nobody finds out until a reconciliation.
 *
 * So `payment_intent.processing` means PROCESSING, and only
 * `payment_intent.succeeded` means PAID.
 */

export type InvoiceOutcome = "PROCESSING" | "PAID" | "FAILED";

export interface EventDecision {
  /** The invoice this event is about. */
  invoiceId: string;
  outcome: InvoiceOutcome;
  paymentIntentId: string;
}

/** The shape this reads off a Stripe event. Deliberately loose. */
export interface StripeEventLike {
  type?: string;
  data?: { object?: Record<string, unknown> };
}

/**
 * The events worth acting on, and nothing else.
 *
 * `checkout.session.completed` is deliberately absent. It fires when the payer
 * finishes the form, which for a bank debit is before any money has moved —
 * treating it as payment is exactly the mistake above.
 */
const OUTCOMES: Record<string, InvoiceOutcome> = {
  "payment_intent.processing": "PROCESSING",
  "payment_intent.succeeded": "PAID",
  "payment_intent.payment_failed": "FAILED",
};

export function decideEvent(event: StripeEventLike): EventDecision | null {
  const outcome = OUTCOMES[event.type ?? ""];
  if (!outcome) return null;

  const object = event.data?.object;
  if (!object) return null;

  const metadata = object.metadata;
  const invoiceId =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).invoiceId
      : undefined;
  if (typeof invoiceId !== "string" || !invoiceId.trim()) return null;

  const paymentIntentId = typeof object.id === "string" ? object.id : "";
  if (!paymentIntentId) return null;

  return { invoiceId: invoiceId.trim(), outcome, paymentIntentId };
}

/** The fields the update rule reads off the invoice it is about to change. */
export interface InvoiceState {
  status?: string | null;
  stripePaymentIntentId?: string | null;
}

export type InvoiceUpdate =
  | { action: "skip"; reason: string }
  | { action: "set"; status: string; paidAt: string | null; paymentIntentId: string };

/**
 * What to write, given where the invoice already is.
 *
 * Stripe retries a delivery until it gets a 2xx, and it can deliver out of
 * order. Both are ordinary, so this is written to be safe under replay:
 *
 * - A PAID invoice stays PAID. A redelivered success is not a second payment,
 *   and a `processing` arriving late must not walk a settled bill backwards.
 * - A VOID invoice is never revived by a payment. That combination means
 *   something has gone wrong that a person needs to look at, and quietly
 *   marking it paid would hide it.
 * - A failure moves back to SENT rather than to a failed state of its own: the
 *   bill is outstanding again, which is what SENT already means, and the payer
 *   can use the same link.
 */
export function decideUpdate(
  invoice: InvoiceState,
  decision: EventDecision,
  today: string
): InvoiceUpdate {
  if (invoice.status === "VOID") {
    return { action: "skip", reason: "invoice is void" };
  }
  if (invoice.status === "PAID") {
    return { action: "skip", reason: "already paid" };
  }
  if (
    decision.outcome === "PROCESSING" &&
    invoice.status === "PROCESSING" &&
    invoice.stripePaymentIntentId === decision.paymentIntentId
  ) {
    return { action: "skip", reason: "already processing" };
  }

  const status =
    decision.outcome === "PAID"
      ? "PAID"
      : decision.outcome === "PROCESSING"
        ? "PROCESSING"
        : "SENT";

  return {
    action: "set",
    status,
    paidAt: decision.outcome === "PAID" ? today : null,
    paymentIntentId: decision.paymentIntentId,
  };
}
