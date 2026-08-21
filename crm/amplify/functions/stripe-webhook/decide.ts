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
  /** Stripe's `created`, as an ISO instant. The ordering key. */
  occurredAt: string;
}

/** The shape this reads off a Stripe event. Deliberately loose. */
export interface StripeEventLike {
  type?: string;
  /** Unix seconds. Stripe stamps every event with when it happened. */
  created?: number;
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

  /**
   * No timestamp means no way to order this against what we have already
   * applied, and acting on an event that might be stale is how a failed
   * payment comes back to life. Refused rather than guessed.
   */
  if (typeof event.created !== "number" || !Number.isFinite(event.created)) {
    return null;
  }

  return {
    invoiceId: invoiceId.trim(),
    outcome,
    paymentIntentId,
    occurredAt: new Date(event.created * 1000).toISOString(),
  };
}

/** The fields the update rule reads off the invoice it is about to change. */
export interface InvoiceState {
  status?: string | null;
  stripePaymentIntentId?: string | null;
  /** When the last applied event happened. See `stripeEventAt` on the model. */
  stripeEventAt?: string | null;
}

export type InvoiceUpdate =
  | { action: "skip"; reason: string }
  | {
      action: "set";
      status: string;
      paidAt: string | null;
      paymentIntentId: string;
      occurredAt: string;
    };

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
/**
 * How far along a payment is, for breaking ties between same-second events.
 *
 * `SENT` is the resting state both before any attempt and after a failed one,
 * which is why a failure ranks alongside it: neither is money in transit.
 */
const statusRank = (status: string | null | undefined): number =>
  status === "PAID" ? 2 : status === "PROCESSING" ? 1 : 0;

const outcomeRank = (outcome: InvoiceOutcome): number =>
  outcome === "PAID" ? 2 : outcome === "PROCESSING" ? 1 : 0;

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
  /**
   * Anything older than what we have already applied is ignored.
   *
   * This is the whole ordering rule, and it replaces a narrower guard that only
   * caught a repeated `processing` on the same intent. That guard read as though
   * ordering were handled and it was not: a `payment_failed` landing before a
   * delayed `processing` left a dead payment looking like it was clearing, and a
   * redelivered `payment_failed` from a superseded attempt buried a debit that
   * was still on its way. Both misstate whether money is coming, which is the
   * one thing this function exists to get right.
   *
   * Comparing instants rather than reasoning per transition also covers the
   * permutations nobody has enumerated — including retries under a second
   * PaymentIntent, where matching on the id would have told us nothing.
   */
  if (invoice.stripeEventAt && decision.occurredAt < invoice.stripeEventAt) {
    return { action: "skip", reason: "event is older than the last one applied" };
  }

  /**
   * A PaymentIntent never goes backwards.
   *
   * `SENT` with an intent id recorded means that intent failed — it is the only
   * way both are set at once. A `processing` for the same intent afterwards is
   * therefore a delayed copy of an earlier moment, whatever its timestamp says,
   * and applying it would show a dead attempt as still clearing.
   *
   * This is deliberately independent of the clock, because the case it covers
   * is exactly the one where the clock cannot separate the two events.
   */
  if (
    decision.outcome === "PROCESSING" &&
    invoice.status === "SENT" &&
    invoice.stripePaymentIntentId === decision.paymentIntentId
  ) {
    return { action: "skip", reason: "that payment already failed" };
  }

  /**
   * Equal timestamps do not order themselves.
   *
   * Stripe's `created` is in whole seconds, so two genuinely distinct events can
   * carry the same instant and the comparison above lets the second through. On
   * a tie the tiebreak is direction: a state may advance but never regress.
   *
   * ── Only across PaymentIntents ──────────────────────────────────────────────
   * Scoped deliberately, and the first version was not. Within one intent the
   * lifecycle *is* processing then succeeded-or-failed, so a `payment_failed`
   * tied with its own `processing` is forward motion, not a regression. Ranking
   * it blindly skipped it and left a dead debit reading as clearing — the exact
   * misstatement this whole function exists to prevent, arrived at from the
   * other direction.
   *
   * Between intents there is no shared lifecycle, so a tie is genuinely
   * ambiguous and refusing to regress is the safe reading: a superseded
   * attempt's failure must not undo the one that replaced it.
   */
  const sameIntent = invoice.stripePaymentIntentId === decision.paymentIntentId;
  if (
    invoice.stripeEventAt &&
    decision.occurredAt === invoice.stripeEventAt &&
    !sameIntent &&
    outcomeRank(decision.outcome) <= statusRank(invoice.status)
  ) {
    return {
      action: "skip",
      reason: "same instant as an event from another payment, and not an advance",
    };
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
    occurredAt: decision.occurredAt,
  };
}
