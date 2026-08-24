import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decidePfEvent } from "../../amplify/functions/stripe-webhook/decide";
import {
  electionExpiry,
  looksLikeElectionToken,
  mintElectionToken,
  ELECTION_TOKEN_TTL_DAYS,
} from "../../amplify/functions/pfElectionToken";
import { renderInvoice, type InvoiceView } from "../../amplify/functions/send-invoice/invoice";

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
      customerId: "cus_1",
      paymentMethodId: "pm_1",
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

  it("treats a canceled intent as failed — an expired verification revives the link", () => {
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

describe("election tokens", () => {
  it("mints 32 bytes of base64url that its own guard accepts", () => {
    const t = mintElectionToken();
    expect(t).toHaveLength(43);
    expect(looksLikeElectionToken(t)).toBe(true);
    expect(mintElectionToken()).not.toBe(t);
  });

  it("the guard refuses everything else", () => {
    for (const bad of ["", "short", null, undefined, 42, "x".repeat(43).replace("x", "!"), `${"a".repeat(42)}=`]) {
      expect(looksLikeElectionToken(bad), String(bad)).toBe(false);
    }
  });

  it("expires on the documented clock", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    const exp = new Date(electionExpiry(from));
    expect((exp.getTime() - from.getTime()) / 86_400_000).toBe(ELECTION_TOKEN_TTL_DAYS);
  });
});

// ── The email fork ─────────────────────────────────────────────────────────

const baseView: InvoiceView = {
  number: "INV-2026-00042",
  associationName: "Test HOA",
  lines: [{ description: "Premium", retailAmount: 100000, kind: "PREMIUM" } as never],
  paymentUrl: "https://buy.stripe.com/test_x",
};

describe("the invoice email's financing fork", () => {
  const finance = {
    url: "https://staging.example/finance/?t=abc",
    downPayment: 25000,
    monthly: 7304.68,
    months: 11,
    apr: 14,
  };

  it("presents both paths when a quote rides along", () => {
    const { text, html } = renderInvoice({ ...baseView, finance });
    expect(text).toContain("Prefer monthly payments?");
    expect(text).toContain("$25,000.00 down (payment 1 of 12)");
    expect(text).toContain("11 monthly payments of $7,304.68 at 14% APR");
    expect(text).toContain(finance.url);
    expect(html).toContain("Set up financing");
    expect(html).toContain("Pay this invoice");
    expect(html).toContain(finance.url);
  });

  it("stays a plain bill when there is no quote", () => {
    const { text, html } = renderInvoice(baseView);
    expect(text).not.toContain("Prefer monthly payments?");
    expect(html).not.toContain("Set up financing");
  });
});

// ── The handlers, by their conditions ──────────────────────────────────────

describe("the webhook's loan side", () => {
  const HANDLER = read("amplify/functions/stripe-webhook/handler.ts");
  const PF = read("amplify/functions/stripe-webhook/pf.ts");

  it("checks loan metadata before invoice metadata", () => {
    expect(HANDLER.indexOf("decidePfEvent")).toBeGreaterThan(0);
    expect(HANDLER.indexOf("decidePfEvent(parsed")).toBeLessThan(
      HANDLER.indexOf("decideEvent(parsed")
    );
  });

  it("accepts a loan only out of QUOTED, and alarms on anything else", () => {
    expect(PF).toContain('ConditionExpression: "#s = :quoted"');
    expect(PF).toContain('":accepted": "ACCEPTED"');
    expect(PF).toContain("refund needed");
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

describe("the election endpoint's ordering", () => {
  const ELECTION = read("amplify/functions/pf-election/handler.ts");

  it("closes the pay-in-full paths before asking for money", () => {
    expect(ELECTION.indexOf("voidInvoice({")).toBeLessThan(
      ELECTION.indexOf("checkout.sessions.create")
    );
    expect(ELECTION).toContain("already been paid in full");
    expect(ELECTION).toContain("already clearing");
  });

  it("stamps the election conditionally on QUOTED under this token", () => {
    expect(ELECTION).toContain('ConditionExpression: "#s = :quoted AND electionToken = :tok"');
  });

  it("advances nothing itself — the webhook flips the loan when money moves", () => {
    // The accept's one loan write is the electedAt stamp; no status value
    // appears in it. (Reading ACCEPTED for the idempotent done view is fine.)
    expect(ELECTION).toContain(
      '"SET electedAt = if_not_exists(electedAt, :now), updatedAt = :now"'
    );
    expect(ELECTION).not.toContain('":accepted"');
  });

  it("marks its intents as loan traffic with a mandate, never as an invoice", () => {
    expect(ELECTION).toContain('setup_future_usage: "off_session"');
    expect(ELECTION).toContain("pfKind: \"down\"");
    // The PaymentIntent's metadata must not carry invoiceId — that routes to
    // the webhook's invoice path. (The void call naming an invoice id is a
    // different thing and fine.)
    expect(ELECTION).not.toMatch(/metadata: \{[^}]*invoiceId/);
  });

  it("fails closed on the kill switch", () => {
    expect(ELECTION).toContain("premiumFinanceEnabled === true");
  });
});

describe("the send offers financing honestly", () => {
  const SEND = read("amplify/functions/send-invoice/handler.ts");

  it("offers only a QUOTED loan with the module on, and never blocks the bill", () => {
    expect(SEND).toContain('status: { eq: "QUOTED" }');
    expect(SEND).toContain("premiumFinanceEnabled !== true) return null");
    expect(SEND).toContain("financing offer omitted");
  });

  it("mints the token conditionally on the loan still being QUOTED", () => {
    expect(SEND).toContain('ConditionExpression: "#s = :quoted"');
  });
});
