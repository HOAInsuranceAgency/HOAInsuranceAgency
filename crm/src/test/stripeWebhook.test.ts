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
  intentCreatedAt: "2026-08-21T11:00:00.000Z",
};

const TODAY = "2026-08-21";

describe("which Stripe events mean anything", () => {
  it("treats a succeeded payment as paid", () => {
    expect(decideEvent(intent("payment_intent.succeeded"))).toEqual({
      invoiceId: "inv-1",
      outcome: "PAID",
      paymentIntentId: "pi_123",
      occurredAt: "2026-08-21T12:00:00.000Z",
      intentCreatedAt: null,
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
      intentCreatedAt: decision.intentCreatedAt,
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
   * Records a success from a superseded attempt — and this assertion is the
   * reverse of what it used to be.
   *
   * The old rule skipped it, treating a late `succeeded` from an older intent
   * as stale the way a late `processing` or `payment_failed` is. That was a
   * category error. Those two are claims about what an attempt is *doing*, and
   * a newer claim supersedes an older one. A `succeeded` is a claim that funds
   * settled, and nothing supersedes that: a replacement intent failing later is
   * that intent failing, not this money leaving the account.
   *
   * What the old rule produced: the invoice stayed PROCESSING, the handler
   * returned 200 so Stripe stopped retrying, and money sat in trust recorded as
   * outstanding — the one error this whole module exists to prevent, reached
   * from the direction nobody checked.
   *
   * The plausible sequence is ordinary. An ACH debit is slow, the payer retries
   * under a new intent, and the first one then settles.
   */
  it("records a success from a superseded attempt, however late", () => {
    const update = decideUpdate(
      { status: "PROCESSING", stripePaymentIntentId: "pi_NEW", stripeEventAt: applied },
      { ...decision, outcome: "PAID", paymentIntentId: "pi_OLD", occurredAt: earlier },
      TODAY
    );
    expect(update).toMatchObject({
      action: "set",
      status: "PAID",
      paymentIntentId: "pi_OLD",
    });
  });

  it("still refuses a stale success once the invoice is already paid", () => {
    // Idempotency is unaffected: PAID is terminal and checked before any of it.
    expect(
      decideUpdate(
        { status: "PAID", stripePaymentIntentId: "pi_NEW", stripeEventAt: applied },
        { ...decision, outcome: "PAID", paymentIntentId: "pi_OLD", occurredAt: earlier },
        TODAY
      )
    ).toMatchObject({ action: "skip", reason: "already paid" });
  });

  it("still refuses a success on a voided invoice", () => {
    expect(
      decideUpdate(
        { status: "VOID", stripeEventAt: applied },
        { ...decision, outcome: "PAID", occurredAt: earlier },
        TODAY
      )
    ).toMatchObject({ action: "skip", reason: "invoice is void" });
  });

  it("keeps ordering everything that is not a success", () => {
    // The exemption is only for money arriving. A stale `processing` or a
    // stale `payment_failed` is still a claim a newer one supersedes.
    for (const outcome of ["PROCESSING", "FAILED"] as const) {
      expect(
        decideUpdate(
          { status: "PROCESSING", stripePaymentIntentId: "pi_NEW", stripeEventAt: applied },
          { ...decision, outcome, paymentIntentId: "pi_OLD", occurredAt: earlier },
          TODAY
        ),
        outcome
      ).toMatchObject({ action: "skip" });
    }
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

  /**
   * The case the rank rule alone got wrong: it could not tell a superseded
   * attempt's stale failure from a replacement attempt's real one, refused to
   * regress, and left a failed replacement reading as PROCESSING forever.
   */
  it("lets a newer attempt's failure through, even tied", () => {
    const update = decideUpdate(
      {
        status: "PROCESSING",
        stripePaymentIntentId: "pi_OLD",
        stripeEventAt: sameInstant,
        stripeIntentCreatedAt: "2026-08-21T10:00:00.000Z",
      },
      {
        ...decision,
        outcome: "FAILED",
        paymentIntentId: "pi_NEW",
        occurredAt: sameInstant,
        // Created later, so this is the attempt that replaced the other.
        intentCreatedAt: "2026-08-21T11:30:00.000Z",
      },
      TODAY
    );
    expect(update).toMatchObject({ action: "set", status: "SENT" });
  });

  it("still refuses a superseded attempt's failure, tied", () => {
    const update = decideUpdate(
      {
        status: "PROCESSING",
        stripePaymentIntentId: "pi_NEW",
        stripeEventAt: sameInstant,
        stripeIntentCreatedAt: "2026-08-21T11:30:00.000Z",
      },
      {
        ...decision,
        outcome: "FAILED",
        paymentIntentId: "pi_OLD",
        occurredAt: sameInstant,
        intentCreatedAt: "2026-08-21T10:00:00.000Z",
      },
      TODAY
    );
    expect(update).toMatchObject({ action: "skip" });
  });

  it("falls back to refusing to regress when the attempts cannot be ordered", () => {
    // Both intents created in the same second, or a timestamp missing. Burying
    // a live payment is the worse of the two mistakes.
    for (const intentCreatedAt of [null, "2026-08-21T11:30:00.000Z"]) {
      const update = decideUpdate(
        {
          status: "PROCESSING",
          stripePaymentIntentId: "pi_NEW",
          stripeEventAt: sameInstant,
          stripeIntentCreatedAt: "2026-08-21T11:30:00.000Z",
        },
        {
          ...decision,
          outcome: "FAILED",
          paymentIntentId: "pi_OLD",
          occurredAt: sameInstant,
          intentCreatedAt,
        },
        TODAY
      );
      expect(update, String(intentCreatedAt)).toMatchObject({ action: "skip" });
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
    expect(PERSIST).toContain("attribute_not_exists");
    expect(PERSIST).toContain("ConditionalCheckFailedException");
  });

  /**
   * The condition must cover everything the decision read, not one field of it.
   *
   * Guarding only `stripeEventAt` let a producer's Void — which writes `status`
   * and never touches the event clock — slip between the read and the write and
   * be silently overwritten by a payment state. A check over a subset of the
   * read set is not a check.
   */
  it("guards every field the decision reads", () => {
    const DECIDE = src("decide.ts");
    const read = new Set(
      [...DECIDE.matchAll(/invoice\.(stripe[A-Za-z]+|status)\b/g)].map((m) => m[1])
    );
    // Sanity: the decision really does read several fields.
    expect(read.size).toBeGreaterThanOrEqual(4);
    for (const field of read) {
      expect(PERSIST, `not guarded: ${field}`).toContain(field);
    }
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

/**
 * What corporate finance is told when a payment clears.
 *
 * The email is the only place the trust-account division is stated, and it is
 * read by people who never open the CRM. Two things must hold: the figures add
 * up, and it is never sent twice for one payment.
 */
describe("the remittance email", () => {
  const mail = {
    invoiceNumber: "INV-2026-00042",
    associationName: "Maple Court Condominium Trust",
    policyNumber: "GEP11696-26",
    carrierName: "Atain Specialty Insurance Company",
    paymentIntentId: "pi_3U6r4NB4GRSwcBL61jCJWByV",
    paidAt: "2026-08-21",
    carrierCents: 2_125_000,
    commissionCents: 375_000,
    interestCents: 0,
    totalCents: 2_500_000,
  };

  it("states all three shares and the total", async () => {
    const { remittanceText } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    const text = remittanceText(mail);
    expect(text).toContain("$21,250.00");
    expect(text).toContain("$3,750.00");
    expect(text).toContain("$25,000.00");
  });

  /**
   * The chart of accounts, in the reader's own vocabulary.
   *
   * Codes and names exactly as the corporate books have them, so the email is
   * read into a journal entry rather than translated first. Translation is
   * where the error lives: commission and interest are both agency income, and
   * someone working from a description alone will eventually post one to the
   * other. Asserted literally because a typo here is a misstatement that only
   * surfaces when a reconciliation fails.
   */
  it("posts each share to its ledger account", async () => {
    const { remittanceText, remittanceHtml } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    for (const body of [remittanceText(mail), remittanceHtml(mail)]) {
      expect(body).toContain("224000");
      expect(body).toContain("Premiums Payable to Carriers");
      expect(body).toContain("470000");
      expect(body).toContain("Insurance Commissions - Income");
      expect(body).toContain("710000");
      expect(body).toContain("Interest earned");
    }
  });

  it("keeps each code with its own figure", async () => {
    // The failure this catches is a row shifting: commission posted to the
    // liability account reads as plausible and overstates what is owed onward.
    const { remittanceText } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    const lines = remittanceText(mail).split("\n");
    const row = (code: string) => lines.find((l) => l.startsWith(code)) ?? "";
    expect(row("224000")).toContain("$21,250.00");
    expect(row("470000")).toContain("$3,750.00");
    expect(row("710000")).toContain("$0.00");
  });

  it("lines the figures up on the decimal", async () => {
    // A ledger column that does not align is read wrong at a glance, and this
    // one is read at a glance by someone matching it to a bank line.
    const { remittanceText } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    const lines = remittanceText(mail).split("\n");
    const ends = ["224000", "470000", "710000"].map(
      (c) => (lines.find((l) => l.startsWith(c)) ?? "").length
    );
    expect(new Set(ends).size).toBe(1);
  });

  it("says the carrier's share is not income", async () => {
    // The single sentence that stops the deposit being read as revenue.
    const { remittanceText, remittanceHtml } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    for (const body of [remittanceText(mail), remittanceHtml(mail)]) {
      expect(body).toContain("owed onward");
    }
  });

  it("names the payment in the subject, so it files against a bank line", async () => {
    const { remittanceSubject } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    const subject = remittanceSubject(mail);
    expect(subject).toContain("$25,000.00");
    expect(subject).toContain("INV-2026-00042");
    expect(subject).toContain("Maple Court Condominium Trust");
  });

  it("still identifies an unnumbered invoice by its Stripe payment", async () => {
    const { remittanceSubject } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    expect(remittanceSubject({ ...mail, invoiceNumber: null })).toContain(
      "pi_3U6r4NB4GRSwcBL61jCJWByV"
    );
  });

  it("omits a detail it does not have rather than printing a blank", async () => {
    const { remittanceText } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    const text = remittanceText({ ...mail, policyNumber: null, carrierName: null });
    expect(text).not.toContain("Policy:");
    expect(text).not.toContain("Carrier:");
    // What it does have is still there.
    expect(text).toContain("Association:");
  });

  it("escapes a name that contains markup", async () => {
    const { remittanceHtml } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    const html = remittanceHtml({
      ...mail,
      associationName: "A & B <script>alert(1)</script> Trust",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;script&gt;");
  });
});

/**
 * Sending it exactly once, and never at the cost of the payment record.
 *
 * Asserted against the source: the guarantee is a property of where the call
 * sits in the handler's control flow, and putting it anywhere else would need
 * a way to know whether the mail had already gone.
 */
describe("when accounting is told", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  const SRC = readFileSync(
    resolve(process.cwd(), "amplify/functions/stripe-webhook/handler.ts"),
    "utf8"
  );

  it("only after the conditional write has been won", () => {
    // `written` is true for exactly one invocation per transition. Sending
    // before it, or outside it, would mail every racing invocation.
    const at = SRC.indexOf("notifyAccounting(invoice, update)");
    const won = SRC.indexOf("if (written) {");
    expect(won).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(won);
  });

  it("only on the transition into PAID", () => {
    expect(SRC).toMatch(/if \(update\.status === "PAID"\)/);
  });

  it("never turns a failed send into a Stripe retry", () => {
    // The email is sent after the state is written. A throw escaping here
    // would return 500, Stripe would redeliver, and the redelivery would find
    // the invoice already PAID and skip — so the mail would be lost anyway and
    // a payment would sit in a retry loop for nothing.
    const at = SRC.indexOf("await notifyAccounting");
    const guard = SRC.lastIndexOf("try {", at);
    const rescue = SRC.indexOf("could not tell accounting", at);
    expect(guard).toBeGreaterThan(-1);
    expect(rescue).toBeGreaterThan(at);
  });
});

/**
 * The characters survive the send.
 *
 * Both the subject and the body carry a middot and an em dash. SES's `Simple`
 * content does not assume UTF-8, so without the charset stated they arrive as
 * `Â·` and `â€"` — mojibake in a message about money, which reads as a broken
 * system to the person reconciling an account.
 */
describe("the remittance encoding", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  const SRC = readFileSync(
    resolve(process.cwd(), "amplify/functions/stripe-webhook/handler.ts"),
    "utf8"
  );

  it("states UTF-8 on the subject and both bodies", () => {
    expect(SRC.match(/Charset: "UTF-8"/g) ?? []).toHaveLength(3);
  });

  it("declares it in the HTML too, for whatever opens the message", async () => {
    const { remittanceHtml } = await import(
      "../../amplify/functions/stripe-webhook/remittance"
    );
    expect(remittanceHtml({
      invoiceNumber: "INV-1", associationName: "A", policyNumber: null,
      carrierName: null, paymentIntentId: "pi_1", paidAt: "2026-08-21",
      carrierCents: 1, commissionCents: 1, interestCents: 0, totalCents: 2,
    })).toContain('<meta charset="utf-8">');
  });
});

/**
 * Voiding closes the payment link.
 *
 * The finding: voiding set `status` in the browser and nothing else, so the
 * Stripe link stayed active. An association working from the original email
 * could still pay a bill the agency had withdrawn, and the webhook skips every
 * event for a void invoice — correctly, so a void is not silently undone —
 * which left funds in the trust account with no invoice they belonged to.
 *
 * Asserted against the source because the behaviour is an ordering property of
 * a handler that needs Stripe and a data client to invoke.
 */
describe("voiding an invoice", () => {
  const VOID_FN = readFileSync(
    resolve(process.cwd(), "amplify/functions/void-invoice/handler.ts"),
    "utf8"
  );
  const EDITOR = readFileSync(
    resolve(process.cwd(), "src/components/InvoiceEditor.tsx"),
    "utf8"
  );

  it("does not write the status from the browser any more", () => {
    // The whole bug in one line. If this comes back, the link outlives the void.
    expect(EDITOR).not.toMatch(/patchInvoice\(\{\s*status:\s*"VOID"/);
    expect(EDITOR).toContain("client.mutations.voidInvoice");
  });

  it("deactivates the link before writing the status", () => {
    // This order is the point. Writing VOID first and then failing to close the
    // link produces exactly the state the function exists to prevent: a dead
    // invoice with a live way to pay it. Asserted on the two calls in the
    // handler's loop, where source order is execution order.
    const kill = VOID_FN.indexOf("paymentLinks.update");
    const write = VOID_FN.indexOf("await writeVoid(");
    expect(kill).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(kill);
  });

  it("refuses the void if the link cannot be closed", () => {
    expect(VOID_FN).toContain("Couldn't close the payment link");
  });

  it("treats a link Stripe has forgotten as already closed", () => {
    // Unpayable either way, so refusing would strand the invoice.
    expect(VOID_FN).toContain("resource_missing");
  });

  it("will not void a paid invoice", () => {
    // That is a record of money received, not a bill to withdraw.
    expect(VOID_FN).toMatch(/status === "PAID"/);
    expect(VOID_FN).toContain("cannot be voided");
  });

  it("will not void while a payment is clearing", () => {
    // An in-flight ACH cannot be un-collected: the void would not stop the
    // transfer, and the webhook skips events for a void invoice, so the debit
    // would settle unrecorded. Reachable with no race at all — the button was
    // offered on a PROCESSING invoice — so the guard is in the main path, not
    // the retry.
    expect(VOID_FN).toMatch(/status === "PROCESSING"/);
    expect(VOID_FN).toContain("still clearing");
    const editor = readFileSync(
      resolve(process.cwd(), "src/components/InvoiceEditor.tsx"),
      "utf8"
    );
    expect(editor).toMatch(/invoice\.status !== "PROCESSING" &&/);
  });

  it("clears the dead url so nothing renders a Pay button for it", () => {
    expect(VOID_FN).toContain("REMOVE paymentUrl");
  });

  /**
   * The second-round finding: an unconditional void could bury a PAID written
   * while this handler was off talking to Stripe. Stripe had its 200, so no
   * redelivery; the webhook skips void invoices, so nothing ever corrected it.
   * Money in trust, recorded nowhere.
   */
  it("writes VOID conditionally on the status it read", () => {
    expect(VOID_FN).toContain("ConditionExpression");
    expect(VOID_FN).toMatch(/#s = :seen/);
    expect(VOID_FN).toContain("ConditionalCheckFailedException");
  });

  it("conditions on the link it deactivated, not just the status", () => {
    // A concurrent re-send can mint a fresh link. A void conditioned on status
    // alone would retire the invoice while the new link stayed payable — the
    // same bug, one link over.
    expect(VOID_FN).toMatch(/#link = :seenLink/);
    expect(VOID_FN).toContain("attribute_not_exists(#link)");
  });

  it("re-reads consistently after losing, so the retry can see why", () => {
    expect(VOID_FN).toContain("ConsistentRead: true");
    // The losing path most worth having: the retry finds the payment landed.
    expect(VOID_FN).toContain("cannot be voided");
  });

  it("uses no data client at all", () => {
    // The data client cannot express the condition, and half-and-half is how
    // the read and the write end up trusting different sources. Direct only.
    expect(VOID_FN).not.toContain("generateClient");
    expect(VOID_FN).not.toContain("getAmplifyDataClientConfig");
  });
});
