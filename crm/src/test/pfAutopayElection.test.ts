import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decidePfEvent } from "../../amplify/functions/stripe-webhook/decide";
/**
 * W7: the election and autopay. The pure pieces are exercised directly; the
 * handler-shaped pieces are source-read like the rest of the money paths —
 * their behaviour is control flow around a Stripe client and conditional
 * DynamoDB writes, and the conditions ARE the guarantees.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

// ── decidePfEvent: loan traffic is told apart by metadata ──────────────────

const pfIntent = (
  type: string,
  metadata: Record<string, unknown>,
  over: Record<string, unknown> = {}
) => ({
  type,
  created: Math.floor(Date.parse("2026-08-24T12:00:00.000Z") / 1000),
  data: {
    object: {
      id: "pi_pf1",
      amount: 2500000,
      customer: "cus_1",
      payment_method: "pm_1",
      metadata,
      ...over,
    },
  },
});

describe("decidePfEvent — which events are loan money", () => {
  it("routes a down payment by pfLoanId/pfKind", () => {
    const d = decidePfEvent(pfIntent("payment_intent.succeeded", { pfLoanId: "loan-1", pfKind: "down" }));
    expect(d).toMatchObject({
      loanId: "loan-1",
      kind: "down",
      installment: null,
      outcome: "PAID",
      paymentIntentId: "pi_pf1",
      amount: 25000,
    });
  });

  it("routes an installment debit with its schedule row", () => {
    const d = decidePfEvent(
      pfIntent("payment_intent.processing", { pfLoanId: "loan-1", pfKind: "installment", installment: "3" })
    );
    expect(d).toMatchObject({ kind: "installment", installment: 3, outcome: "PROCESSING" });
  });

  it("refuses an installment debit that cannot say which installment", () => {
    // Posting "the next one" on faith is how ledgers drift.
    expect(
      decidePfEvent(pfIntent("payment_intent.succeeded", { pfLoanId: "loan-1", pfKind: "installment" }))
    ).toBeNull();
    expect(
      decidePfEvent(
        pfIntent("payment_intent.succeeded", { pfLoanId: "loan-1", pfKind: "installment", installment: "3.5" })
      )
    ).toBeNull();
  });

  it("ignores invoice traffic and unknown kinds", () => {
    expect(decidePfEvent(pfIntent("payment_intent.succeeded", { invoiceId: "inv-1" }))).toBeNull();
    expect(
      decidePfEvent(pfIntent("payment_intent.succeeded", { pfLoanId: "loan-1", pfKind: "mystery" }))
    ).toBeNull();
  });

  it("treats a completed election checkout as the choice, carrying its intent", () => {
    // Manual-entry ACH sits in microdeposit verification for days before
    // `processing` fires; the session completing is what must close the
    // accept button. The invoice path keeps ignoring this event — form
    // completion is still not money.
    const d = decidePfEvent(
      pfIntent(
        "checkout.session.completed",
        { pfLoanId: "loan-1", pfKind: "down" },
        { id: "cs_test_1", payment_intent: "pi_from_session" }
      )
    );
    expect(d).toMatchObject({
      kind: "down",
      outcome: "COMMITTED",
      paymentIntentId: "pi_from_session",
    });
    // A session that cannot name its intent marks nothing.
    expect(
      decidePfEvent(
        pfIntent(
          "checkout.session.completed",
          { pfLoanId: "loan-1", pfKind: "down" },
          { id: "cs_test_1", payment_intent: undefined }
        )
      )
    ).toBeNull();
  });

  it("treats canceled payment intents as failed receipts", () => {
    const d = decidePfEvent(pfIntent("payment_intent.canceled", { pfLoanId: "loan-1", pfKind: "down" }));
    expect(d).toMatchObject({ kind: "down", outcome: "FAILED" });
  });

  it("ignores event types that mean nothing to a loan", () => {
    expect(
      decidePfEvent(pfIntent("charge.refunded", { pfLoanId: "loan-1", pfKind: "down" }))
    ).toBeNull();
  });

  it("refuses an event with no timestamp to order by", () => {
    const e = pfIntent("payment_intent.succeeded", { pfLoanId: "loan-1", pfKind: "down" });
    expect(decidePfEvent({ ...e, created: undefined })).toBeNull();
  });
});

// ── The election token: possession, never authority ────────────────────────

describe("the webhook's loan side", () => {
  const HANDLER = read("amplify/functions/stripe-webhook/handler.ts");
  const PF = read("amplify/functions/stripe-webhook/pf.ts");

  it("checks loan metadata before invoice metadata", () => {
    expect(HANDLER.indexOf("decidePfEvent")).toBeGreaterThan(0);
    expect(HANDLER.indexOf("decidePfEvent(parsed")).toBeLessThan(
      HANDLER.indexOf("decideEvent(parsed")
    );
  });

  it("a paid invoice still cancels QUOTED loans only — money-touched ones alarm instead", () => {
    // ACCEPTED means the association's money moved; auto-cancelling it would
    // orphan a down payment. The cancel's condition keeps naming QUOTED
    // alone, and everything else the scan finds goes to a human, loudly.
    expect(HANDLER).toContain('ExpressionAttributeValues: { ":c": "CANCELLED", ":q": "QUOTED", ":now": now }');
    expect(HANDLER).toContain("alertDoublePath");
    expect(HANDLER).toContain('rule: "exclusive-payment-path"');
    // The lost-race skip is an alarm too — under a payment, leaving QUOTED
    // almost always means the loan just became ACCEPTED.
    expect(HANDLER).toContain("left QUOTED under paid invoice");
  });

  it("posts autopay debits through the shared core and clears the marker", () => {
    expect(PF).toContain("postInstallment({");
    expect(PF).toContain("clearAutopayPending: true");
    expect(PF).toContain('actor: "stripe-autopay"');
  });

  it("a failed debit frees the loan instead of touching its status", () => {
    expect(PF).toContain('ConditionExpression: "autopayPendingIntentId = :pi"');
    expect(PF).not.toContain('":d": "DEFAULTED"');
  });

  it("a debit ahead of the ledger posts nothing and tells a person", () => {
    expect(PF).toContain("reconcile by hand");
  });
});

describe("the autopay cron's exactly-once initiation", () => {
  const CRON = read("amplify/functions/pf-autopay/handler.ts");

  it("claims the loan before Stripe hears anything", () => {
    expect(CRON).toContain('"attribute_not_exists(autopayPendingIntentId)"');
    expect(CRON).toContain('" AND #s = :active AND paidThrough = :seen"');
    expect(CRON.indexOf("attribute_not_exists(autopayPendingIntentId)")).toBeLessThan(
      CRON.indexOf("paymentIntents.create(")
    );
  });

  it("heals a stale claim by asking Stripe, and never releases one on a create error", () => {
    // A claim only the webhook could clear was a permanent wedge: the cron
    // skipped it, the sweep stood down, hand postings refused. Now a day-old
    // claim is re-taken on its exact stale value, and what Stripe says
    // exists decides — adopt, stand down, or retry.
    expect(CRON).toContain("paymentIntents.search");
    expect(CRON).toContain('"autopayPendingIntentId = :stale"');
    expect(CRON).toContain("claim ages into tomorrow's heal");
    // The old release-on-error path is gone: ambiguous failure must not free
    // the loan for a second debit beside a possibly-minted first.
    expect(CRON).not.toContain("REMOVE autopayPendingIntentId, autopayPendingInstallment SET updatedAt");
  });

  it("stands down after a failed debit instead of retrying daily", () => {
    const PF = read("amplify/functions/stripe-webhook/pf.ts");
    expect(PF).toContain("autopayFailedInstallment = :n");
    expect(CRON).toContain("l.autopayFailedInstallment");
    // The cure lives in the shared core: any posting clears the stand-down.
    expect(read("amplify/functions/pfPosting.ts")).toContain('removes.push("autopayFailedInstallment")');
  });

  it("backs the claim with a Stripe idempotency key", () => {
    expect(CRON).toContain("idempotencyKey: `pf-auto-${loan.id}-${n}`");
  });

  it("debits ACTIVE loans only — a default pauses autopay", () => {
    expect(CRON).toContain('status: { eq: "ACTIVE" }');
    // And the claim re-checks it, so a default landing mid-scan still wins.
    expect(CRON).toContain('":active": "ACTIVE"');
  });

  it("attempts once per day, not in a loop", () => {
    expect(CRON).toContain('(l.autopayAttemptedAt ?? "").slice(0, 10) !== today');
  });
});

describe("the default sweep stands down while money is in flight", () => {
  const SWEEP = read("amplify/functions/pf-default-sweep/handler.ts");

  it("skips loans with a pending debit and screams about stale ones", () => {
    expect(SWEEP).toContain("autopayPendingIntentId");
    expect(SWEEP).toContain("reconcile it by hand");
  });
});

describe("invoice billing guards", () => {
  const SEND = read("amplify/functions/send-invoice/handler.ts");

  it("refuses an anchorless invoice and a second live invoice per anchor (W8)", () => {
    expect(SEND).toContain("Every invoice bills a policy or a quote. Set one before sending.");
    expect(SEND).toContain('["DRAFT", "SENT", "PROCESSING"].includes');
    expect(SEND).toMatch(/One live invoice per \$\{anchor\.kind\}/);
  });

  it("sees line-anchored legacy siblings and the policy's own quote (W8 review)", () => {
    // Pre-W8 invoices anchor only through their lines, and a pre-bind
    // invoice whose rollover failed anchors only through its quote — the
    // header scan alone cannot see either, and each is a second live bill
    // for one premium.
    expect(SEND).toContain('client.models.InvoiceLine.list({');
    expect(SEND).toContain("policy?.quoteId ? [{ quoteId: { eq: policy.quoteId } }] : []");
  });

  it("refuses to send against a closed quote", () => {
    // A bound quote's billing belongs to its policy; a lost one bills
    // coverage that will never exist.
    expect(SEND).toContain("isOpenQuoteStatus(quoteAnchor.status)");
    expect(SEND).toContain("This quote has been bound.");
  });
});

describe("quotes can answer the screens the offer runs on (W8 review)", () => {
  it("the coverage form writes none of the retired screens' fields", () => {
    // MEP's screen, auditable, and producer-of-record all retired
    // 2026-08-24 by signed decision — the form must not write the dead
    // fields back (MEP itself stays: underwriting data, not a screen).
    const FORM = read("src/components/CoverageForm.tsx");
    expect(FORM).not.toContain("isAuditable");
    expect(FORM).not.toContain("producerOfRecord");
    expect(FORM).toContain("minimumEarnedPremiumPct");
  });

  it("bind checks its errors and refuses a second policy from one quote", () => {
    const PANEL = read("src/components/QuotesPanel.tsx");
    // The two writes whose silently-swallowed errors left an open quote
    // with an ACTIVE policy, or a live quote-invoice beside a policy bill.
    expect(PANEL).toContain("if (response.errors?.length) throw new Error(response.errors[0].message)");
    expect(PANEL).toContain("client.mutations.bindCommissionPolicy");
    expect(read("amplify/functions/commissions/bind.ts")).toContain("This quote already has a policy.");
    expect(PANEL).toContain('action: "BIND_ROLLOVER"');
  });

  it("bind stamps datePolicyBound automatically — never typed", () => {
    // "Client since" and production reporting read a real bound date; the
    // single Policy.create site is where it can only come from.
    const PANEL = read("src/components/QuotesPanel.tsx");
    expect(PANEL).toContain("client.mutations.bindCommissionPolicy");
    const BIND = read("amplify/functions/commissions/bind.ts");
    expect(BIND).toContain("const at = new Date().toISOString()");
    expect(BIND).toContain("datePolicyBound: at");
  });

  it("bind rolls document links alongside invoices and loans", () => {
    // A quote's paper follows it onto the policy — the link gains the
    // policy id and keeps the quote's, same as every other anchor.
    const PANEL = read("src/components/QuotesPanel.tsx");
    expect(PANEL).toContain("client.models.Document.list");
    expect(PANEL).toContain("client.models.Document.update");
  });


});

describe("bind rolls the anchor, never re-lends (W8)", () => {
  const SERVICING = read("amplify/functions/pf-servicing/handler.ts");

  it("rolls only a live loan whose quote the policy actually descends from", () => {
    expect(SERVICING).toContain("boundPolicy.quoteId !== loan.quoteId");
    expect(SERVICING).toContain(
      '"quoteId = :q AND attribute_not_exists(policyId) AND #s IN (:live1, :live2, :live3, :live4)"'
    );
  });

  it("terminal loans keep the anchor they closed under", () => {
    expect(SERVICING).toContain("does not roll");
  });


});
