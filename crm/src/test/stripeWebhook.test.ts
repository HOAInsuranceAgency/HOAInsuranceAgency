import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideEvent,
  decideUpdate,
  type EventDecision,
} from "../../amplify/functions/stripe-webhook/decide";
import { toCents } from "../../amplify/functions/send-invoice/stripeLink";

const AT = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const intent = (
  type: string,
  over: Record<string, unknown> = {},
  created = AT("2026-08-21T12:00:00.000Z")
) => ({
  type,
  created,
  data: {
    object: {
      id: "pi_123",
      metadata: { invoiceId: "inv-1", invoiceNumber: "INV-2026-00001" },
      ...over,
    },
  },
});

const decision: EventDecision = {
  invoiceId: "inv-1",
  outcome: "PAID",
  paymentIntentId: "pi_123",
  occurredAt: "2026-08-21T12:00:00.000Z",
};

const TODAY = "2026-08-21";

describe("which Stripe events mean anything", () => {
  it("treats a succeeded payment as paid", () => {
    expect(decideEvent(intent("payment_intent.succeeded"))).toEqual({
      invoiceId: "inv-1",
      outcome: "PAID",
      paymentIntentId: "pi_123",
      occurredAt: "2026-08-21T12:00:00.000Z",
    });
  });

  it("treats a processing payment as processing, not as paid", () => {
    expect(decideEvent(intent("payment_intent.processing"))?.outcome).toBe(
      "PROCESSING"
    );
  });

  it("treats a failed payment as failed", () => {
    expect(decideEvent(intent("payment_intent.payment_failed"))?.outcome).toBe(
      "FAILED"
    );
  });

  /**
   * The mistake this whole design exists to avoid.
   *
   * `checkout.session.completed` fires when the payer finishes the form. For a
   * bank debit that is before any money has moved, and it can still fail days
   * later. Acting on it would record money that never arrived.
   */
  it("ignores checkout completion, which is not payment", () => {
    expect(decideEvent(intent("checkout.session.completed"))).toBeNull();
  });

  it("ignores everything else Stripe sends", () => {
    for (const type of [
      "payment_link.created",
      "charge.succeeded",
      "customer.created",
      "",
    ]) {
      expect(decideEvent(intent(type)), type).toBeNull();
    }
  });

  it("ignores an event it cannot tie to an invoice", () => {
    // Without metadata there is no bill to act on, and guessing would be worse
    // than doing nothing.
    expect(decideEvent(intent("payment_intent.succeeded", { metadata: {} }))).toBeNull();
    expect(
      decideEvent(intent("payment_intent.succeeded", { metadata: undefined }))
    ).toBeNull();
    expect(
      decideEvent(intent("payment_intent.succeeded", { metadata: { invoiceId: "  " } }))
    ).toBeNull();
    expect(decideEvent({})).toBeNull();
    expect(decideEvent({ type: "payment_intent.succeeded" })).toBeNull();
  });

  it("ignores an event with no payment intent id to record", () => {
    expect(
      decideEvent(intent("payment_intent.succeeded", { id: undefined }))
    ).toBeNull();
  });
});

describe("what to write, given where the invoice already is", () => {
  it("marks a sent invoice paid, and dates it", () => {
    expect(decideUpdate({ status: "SENT" }, decision, TODAY)).toEqual({
      action: "set",
      status: "PAID",
      paidAt: TODAY,
      paymentIntentId: "pi_123",
      occurredAt: decision.occurredAt,
    });
  });

  it("moves a sent invoice to processing without dating it paid", () => {
    const update = decideUpdate(
      { status: "SENT" },
      { ...decision, outcome: "PROCESSING" },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "PROCESSING", paidAt: null });
  });

  it("puts a failed payment back to sent, so the bill is outstanding again", () => {
    const update = decideUpdate(
      { status: "PROCESSING" },
      { ...decision, outcome: "FAILED" },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "SENT", paidAt: null });
  });

  /**
   * Stripe retries until it gets a 2xx and can deliver out of order, so every
   * one of these is an ordinary Tuesday rather than an edge case.
   */
  it("leaves a paid invoice alone, however many times the event arrives", () => {
    expect(decideUpdate({ status: "PAID" }, decision, TODAY)).toMatchObject({
      action: "skip",
    });
  });

  it("does not walk a paid invoice back when a late processing event lands", () => {
    const update = decideUpdate(
      { status: "PAID" },
      { ...decision, outcome: "PROCESSING" },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  it("never revives a void invoice by paying it", () => {
    // Something has gone wrong that a person needs to see. Quietly marking it
    // paid would hide it.
    for (const outcome of ["PAID", "PROCESSING", "FAILED"] as const) {
      expect(
        decideUpdate({ status: "VOID" }, { ...decision, outcome }, TODAY),
        outcome
      ).toMatchObject({ action: "skip", reason: "invoice is void" });
    }
  });

  it("does not rewrite an invoice already processing the same payment", () => {
    expect(
      decideUpdate(
        { status: "PROCESSING", stripePaymentIntentId: "pi_123" },
        { ...decision, outcome: "PROCESSING" },
        TODAY
      )
    ).toMatchObject({ action: "skip", reason: "already processing" });
  });

  it("does act on a different payment for the same invoice", () => {
    // A first attempt failed and they tried again. That is a real event.
    expect(
      decideUpdate(
        { status: "PROCESSING", stripePaymentIntentId: "pi_OLD" },
        { ...decision, outcome: "PROCESSING" },
        TODAY
      )
    ).toMatchObject({ action: "set", status: "PROCESSING" });
  });

  it("pays a draft that somehow got a link, rather than refusing", () => {
    // Not expected, but money arriving is money arriving.
    expect(decideUpdate({ status: "DRAFT" }, decision, TODAY)).toMatchObject({
      action: "set",
      status: "PAID",
    });
  });
});

describe("out-of-order events cannot misstate whether money is coming", () => {
  const applied = "2026-08-21T12:00:00.000Z";
  const earlier = "2026-08-21T11:00:00.000Z";
  const later = "2026-08-21T13:00:00.000Z";

  /**
   * `payment_failed` lands first and returns the invoice to SENT. The delayed
   * `processing` for the same intent then arrives. Before the ordering rule it
   * fell through every guard and set PROCESSING, so a dead payment looked like
   * it was clearing and nobody chased it.
   */
  it("does not revive a failed payment with a delayed processing event", () => {
    const update = decideUpdate(
      { status: "SENT", stripePaymentIntentId: "pi_123", stripeEventAt: applied },
      { ...decision, outcome: "PROCESSING", occurredAt: earlier },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  /**
   * A first attempt fails, the payer retries under a new PaymentIntent, and
   * Stripe redelivers the old failure. Before the rule this reset the invoice
   * to SENT *and* overwrote the intent id with the failed one, so a debit still
   * on its way looked outstanding.
   */
  it("does not bury a live retry under a redelivered old failure", () => {
    const update = decideUpdate(
      { status: "PROCESSING", stripePaymentIntentId: "pi_NEW", stripeEventAt: applied },
      { ...decision, outcome: "FAILED", paymentIntentId: "pi_OLD", occurredAt: earlier },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  /**
   * The permutation nobody named. Matching on the PaymentIntent id would have
   * missed it, because the ids differ; comparing instants does not.
   */
  it("does not let a stale success from a superseded attempt land late", () => {
    const update = decideUpdate(
      { status: "PROCESSING", stripePaymentIntentId: "pi_NEW", stripeEventAt: applied },
      { ...decision, outcome: "PAID", paymentIntentId: "pi_OLD", occurredAt: earlier },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  it("still applies anything newer than what it has", () => {
    const update = decideUpdate(
      { status: "PROCESSING", stripePaymentIntentId: "pi_123", stripeEventAt: applied },
      { ...decision, outcome: "PAID", occurredAt: later },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "PAID", occurredAt: later });
  });

  it("applies the first event, when there is nothing to compare against", () => {
    expect(
      decideUpdate({ status: "SENT" }, { ...decision, occurredAt: earlier }, TODAY)
    ).toMatchObject({ action: "set", status: "PAID" });
  });

  it("refuses an event with no timestamp rather than guessing its place", () => {
    // Acting on an event that might be stale is how a failed payment revives.
    expect(decideEvent({ ...intent("payment_intent.succeeded"), created: undefined })).toBeNull();
    expect(decideEvent({ ...intent("payment_intent.succeeded"), created: Number.NaN })).toBeNull();
  });

  it("carries the timestamp forward so the next comparison has a floor", () => {
    const update = decideUpdate({ status: "SENT" }, decision, TODAY);
    expect(update).toMatchObject({ occurredAt: decision.occurredAt });
  });
});

describe("events sharing one second cannot regress the state", () => {
  /**
   * Stripe's `created` is in whole seconds, so two genuinely distinct events can
   * carry the same instant and a strict "older than" comparison lets the second
   * one through. The tiebreak is direction: advance, never regress.
   */
  const sameInstant = "2026-08-21T12:00:00.000Z";

  it("does not let a tied failure undo a clearing payment", () => {
    const update = decideUpdate(
      {
        status: "PROCESSING",
        stripePaymentIntentId: "pi_NEW",
        stripeEventAt: sameInstant,
      },
      { ...decision, outcome: "FAILED", paymentIntentId: "pi_OLD", occurredAt: sameInstant },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  it("does not let a tied failure undo a received payment", () => {
    const update = decideUpdate(
      { status: "PAID", stripePaymentIntentId: "pi_1", stripeEventAt: sameInstant },
      { ...decision, outcome: "FAILED", occurredAt: sameInstant },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  it("lets a payment fail in the same second it started clearing", () => {
    /**
     * The first version of the tie rule ranked this as a regression and skipped
     * it, leaving a dead debit reading as clearing — the same misstatement this
     * function exists to prevent, reached from the other direction. Within one
     * PaymentIntent the lifecycle *is* processing then failed.
     */
    const update = decideUpdate(
      {
        status: "PROCESSING",
        stripePaymentIntentId: "pi_1",
        stripeEventAt: sameInstant,
      },
      {
        ...decision,
        outcome: "FAILED",
        paymentIntentId: "pi_1",
        occurredAt: sameInstant,
      },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "SENT" });
  });

  it("still lets a tied event advance the state", () => {
    // processing and succeeded inside one second is ordinary, and dropping the
    // success would be recording money that arrived as outstanding.
    const update = decideUpdate(
      {
        status: "PROCESSING",
        stripePaymentIntentId: "pi_1",
        stripeEventAt: sameInstant,
      },
      { ...decision, outcome: "PAID", occurredAt: sameInstant },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "PAID" });
  });

  /**
   * Independent of the clock, because this is the case the clock cannot
   * separate: `SENT` with an intent recorded means that intent failed, and a
   * PaymentIntent never goes back to processing.
   */
  it("never revives an intent it has already recorded as failed", () => {
    for (const at of [sameInstant, "2026-08-21T12:00:05.000Z"]) {
      const update = decideUpdate(
        { status: "SENT", stripePaymentIntentId: "pi_1", stripeEventAt: sameInstant },
        { ...decision, outcome: "PROCESSING", paymentIntentId: "pi_1", occurredAt: at },
        TODAY
      );
      expect(update, at).toMatchObject({ action: "skip" });
    }
  });

  it("does let a different intent start clearing after one failed", () => {
    // The payer retried. That is a real event and must not be swallowed.
    const update = decideUpdate(
      { status: "SENT", stripePaymentIntentId: "pi_1", stripeEventAt: sameInstant },
      {
        ...decision,
        outcome: "PROCESSING",
        paymentIntentId: "pi_2",
        occurredAt: "2026-08-21T12:00:05.000Z",
      },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "PROCESSING" });
  });
});

describe("the write is conditional on what was read", () => {
  // `process.cwd()` is `crm/` under vitest. `import.meta.url` is not reliably a
  // file: URL here — activityLog.test.ts resolves paths this way for the same
  // reason, and this is the third time that trap has cost a run.
  const src = (rel: string) =>
    readFileSync(resolve(process.cwd(), "amplify/functions/stripe-webhook", rel), "utf8");
  const PERSIST = src("persist.ts");
  const HANDLER = src("handler.ts");

  /**
   * Ordering decided from a snapshot is only ordering if the write still holds
   * when it lands. Two concurrent events would otherwise both decide from the
   * same pre-state and the last writer would win regardless of which is newer.
   */
  it("carries the read forward as a condition", () => {
    expect(PERSIST).toContain("ConditionExpression");
    expect(PERSIST).toContain("#eventAt = :seenEventAt");
    expect(PERSIST).toContain("attribute_not_exists(#eventAt)");
    expect(PERSIST).toContain("ConditionalCheckFailedException");
  });

  it("re-reads and decides again when it loses the race", () => {
    expect(HANDLER).toMatch(/attempt <= 2/);
    expect(HANDLER).toContain("writePaymentState");
  });

  it("no longer writes payment state through the data client", () => {
    expect(HANDLER).not.toMatch(/models\.Invoice\.update/);
  });
});

describe("an event that cannot be placed is retried, not acknowledged", () => {
  const HANDLER = readFileSync(
    resolve(process.cwd(), "amplify/functions/stripe-webhook/handler.ts"),
    "utf8"
  );

  /**
   * With three events in flight, the winner of the second conditional write can
   * be an *older* one — so exhausting the passes does not mean a newer event
   * owns the state. Acknowledging with 200 there stops Stripe retrying and can
   * leave an invoice PROCESSING with the money already received.
   */
  it("returns 500 after exhausting its attempts", () => {
    const tail = HANDLER.slice(HANDLER.indexOf("Twice beaten"));
    expect(tail).toContain("statusCode: 500");
    expect(tail.slice(0, tail.indexOf("statusCode: 500"))).not.toContain('ok("');
  });

  it("no longer claims a lost race means a newer event won", () => {
    expect(HANDLER).not.toContain("A newer event owns the state");
  });
});

describe("toCents", () => {
  it("converts dollars to the integer Stripe wants", () => {
    expect(toCents(33384)).toBe(3338400);
    expect(toCents(12480.37)).toBe(1248037);
    // 19.99 * 100 is 1998.9999... in floating point.
    expect(toCents(19.99)).toBe(1999);
  });

  it("refuses an amount that is not billable", () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toCents(bad), String(bad)).toThrow();
    }
  });

  it("refuses an amount past Stripe's ceiling, which is a typo not a premium", () => {
    expect(() => toCents(1_000_000)).toThrow(/too large/);
    expect(toCents(999_999.99)).toBe(99999999);
  });
});
