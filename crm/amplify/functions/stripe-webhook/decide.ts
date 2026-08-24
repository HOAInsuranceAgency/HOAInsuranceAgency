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
  /** Stripe's event `created`, as an ISO instant. The ordering key. */
  occurredAt: string;
  /**
   * When the PaymentIntent itself was created, as an ISO instant, or null.
   *
   * The discriminator for events that tie: a replacement intent is created
   * after the one it replaces, so this says which attempt is current when the
   * event clock cannot.
   */
  intentCreatedAt: string | null;
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

  const intentCreated = object.created;

  return {
    invoiceId: invoiceId.trim(),
    outcome,
    paymentIntentId,
    occurredAt: new Date(event.created * 1000).toISOString(),
    intentCreatedAt:
      typeof intentCreated === "number" && Number.isFinite(intentCreated)
        ? new Date(intentCreated * 1000).toISOString()
        : null,
  };
}

/**
 * W7: what a Stripe event means for a premium-finance loan. Same three event
 * types, told apart from invoice traffic by metadata: the election checkout
 * and the autopay cron stamp `pfLoanId`/`pfKind` on their PaymentIntents and
 * never `invoiceId`, so an event is one or the other, never both.
 */
export interface PfEventDecision {
  loanId: string;
  kind: "down" | "installment";
  /** Which schedule row an installment debit was FOR. Null on a down payment. */
  installment: number | null;
  outcome: InvoiceOutcome;
  paymentIntentId: string;
  occurredAt: string;
  /** The saved mandate, present on the down payment's succeeded event. */
  customerId: string | null;
  paymentMethodId: string | null;
  /** Dollars, from the intent's amount — for the accounting email. */
  amount: number | null;
}

export function decidePfEvent(event: StripeEventLike): PfEventDecision | null {
  const outcome = OUTCOMES[event.type ?? ""];
  if (!outcome) return null;
  const object = event.data?.object;
  if (!object) return null;
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const loanId = metadata?.pfLoanId;
  const kind = metadata?.pfKind;
  if (typeof loanId !== "string" || !loanId.trim()) return null;
  if (kind !== "down" && kind !== "installment") return null;

  const paymentIntentId = typeof object.id === "string" ? object.id : "";
  if (!paymentIntentId) return null;
  if (typeof event.created !== "number" || !Number.isFinite(event.created)) {
    return null;
  }

  const rawN = metadata?.installment;
  const installment =
    typeof rawN === "string" && /^\d+$/.test(rawN) ? Number(rawN) : null;
  // An installment debit that cannot say which installment it was for is not
  // actionable — posting "the next one" on faith is how ledgers drift.
  if (kind === "installment" && installment === null) return null;

  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const cents = object.amount;
  return {
    loanId: loanId.trim(),
    kind,
    installment,
    outcome,
    paymentIntentId,
    occurredAt: new Date(event.created * 1000).toISOString(),
    customerId: str(object.customer),
    paymentMethodId: str(object.payment_method),
    amount:
      typeof cents === "number" && Number.isFinite(cents) ? cents / 100 : null,
  };
}

/** The fields the update rule reads off the invoice it is about to change. */
export interface InvoiceState {
  status?: string | null;
  stripePaymentIntentId?: string | null;
  /** When the last applied event happened. See `stripeEventAt` on the model. */
  stripeEventAt?: string | null;
  /** When the PaymentIntent the state reflects was created. */
  stripeIntentCreatedAt?: string | null;
}

export type InvoiceUpdate =
  | { action: "skip"; reason: string }
  | {
      action: "set";
      status: string;
      paidAt: string | null;
      paymentIntentId: string;
      occurredAt: string;
      intentCreatedAt: string | null;
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
   * Money arriving is a fact, not a state transition to be ordered.
   *
   * Every rule below this weighs one event against another to decide which
   * describes the invoice now. A `succeeded` is not that kind of claim: it says
   * funds settled, and no later event un-settles them — a subsequent failure on
   * a different attempt is that attempt failing, not this money leaving.
   *
   * So it is applied whatever the clock says. The case that forced this: an
   * older PaymentIntent succeeding in the same second a replacement began
   * processing was discarded as superseded, the handler returned 200 so Stripe
   * stopped retrying, and the invoice sat at PROCESSING with the money already
   * in the account. Every ordering heuristic below could produce that outcome
   * from some permutation, and recording received money as outstanding is the
   * one error this file exists to prevent.
   *
   * Safe to place above the ordering rules because PAID is terminal: the guard
   * at the top of this function skips everything once it is set, so letting the
   * event clock go backwards here cannot admit anything afterwards.
   */
  if (decision.outcome === "PAID") {
    return {
      action: "set",
      status: "PAID",
      paidAt: today,
      paymentIntentId: decision.paymentIntentId,
      occurredAt: decision.occurredAt,
      intentCreatedAt: decision.intentCreatedAt,
    };
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
    !sameIntent
  ) {
    /**
     * Which attempt is current, when the event clock cannot say.
     *
     * The rank rule alone could not tell a *superseded* attempt's stale failure
     * from a *replacement* attempt's real one, and refusing to regress got the
     * second case wrong: a replacement that failed in the same second stayed
     * PROCESSING forever.
     *
     * A PaymentIntent carries its own `created`, and a replacement is always
     * created after what it replaces — so this is the fact that answers the
     * question rather than another heuristic about it. Newer attempt wins,
     * whatever it says.
     */
    const mine = decision.intentCreatedAt;
    const theirs = invoice.stripeIntentCreatedAt;
    if (mine && theirs && mine !== theirs) {
      if (mine < theirs) {
        return { action: "skip", reason: "event belongs to a superseded payment" };
      }
      // A newer attempt: let it through, including a failure.
    } else {
      /**
       * Both intents created in the same second, or one of the timestamps
       * missing. Nothing orders them — so nothing moves.
       *
       * This used to refuse only regressions, which is half a rule: it still
       * let an unorderable PROCESSING advance over SENT, and in one delivery
       * permutation that stuck — the dead attempt's terminal event had already
       * been acknowledged, so nothing ever corrected it. Freezing is safe
       * where guessing is not, because the truth always outranks this branch:
       * money arriving bypasses ordering entirely, a same-intent event walks
       * its own lifecycle above, and any event a second later orders cleanly.
       * The only cost is a status that stays put for the moment the clock
       * cannot see into, which is also the only honest reading of it.
       */
      return {
        action: "skip",
        reason: "same instant as another payment, and nothing to order them by",
      };
    }
  }

  if (
    decision.outcome === "PROCESSING" &&
    invoice.status === "PROCESSING" &&
    invoice.stripePaymentIntentId === decision.paymentIntentId
  ) {
    return { action: "skip", reason: "already processing" };
  }

  /**
   * Only PROCESSING or FAILED reach here — the compiler knows it, because the
   * success branch returned near the top. A failed attempt puts the bill back
   * to SENT, which is what "outstanding again" means.
   */
  return {
    action: "set",
    status: decision.outcome === "PROCESSING" ? "PROCESSING" : "SENT",
    // Never a paid date on either of these, and no longer a ternary that reads
    // as though one of them might produce one.
    paidAt: null,
    paymentIntentId: decision.paymentIntentId,
    occurredAt: decision.occurredAt,
    intentCreatedAt: decision.intentCreatedAt,
  };
}
