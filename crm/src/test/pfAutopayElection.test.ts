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

  it("a funded election supersedes sibling quotes on the anchor", () => {
    // The accept-time sibling check is read-time; two QUOTED loans can hold
    // payable sessions until one down payment LANDS — so the landing is
    // where the race serializes: siblings cancel (QUOTED only, conditional,
    // logged), their election links go cold, and a sibling's own clearing
    // down payment resolves through the not-QUOTED refund alarm. Since W8
    // the scan matches every anchor id the loan carries — policy, quote,
    // or both after a bind rollover — so no twin escapes on a technicality.
    expect(PF).toContain('"superseded-by-election"');
    expect(PF).toContain('legs.push("policyId = :p")');
    expect(PF).toContain('legs.push("quoteId = :qa")');
    expect(PF).toContain('AND #s = :q AND id <> :self');
    expect(PF).toContain("a sibling financing election on the same policy was funded");
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

  it("stamps the election conditionally on QUOTED under this token, before the clock runs out", () => {
    // Expiry rides the write's own condition — the read-time check sits
    // before the invoice scans, and a token submitted seconds before its
    // expiry must not finish electing after it. Since the review of W8,
    // the same write also refuses while a down payment is clearing: the
    // read-time "already clearing" check races the webhook's stamp, and a
    // late-delivered settlement must fail the election, not run beside it.
    expect(ELECTION).toContain(
      '"#s = :quoted AND electionToken = :tok AND electionTokenExpiresAt > :now AND attribute_not_exists(downPaymentIntentId)"'
    );
    expect(ELECTION).toContain(
      "electionTokenExpiresAt > :now AND attribute_not_exists(downPaymentIntentId) AND (attribute_not_exists(electionCheckoutUrl)"
    );
  });

  it("binds the stamp to the kill switch in one transaction", () => {
    // The moduleEnabled read is advice; the ConditionCheck is the law —
    // pf-originate's pattern. A disable that is durable when the stamp
    // commits fails the whole election, and the Checkout mint only follows
    // a stamp that transacted with the flag. (The window is generous: the
    // signature stamps grew this block.)
    const at = ELECTION.indexOf("SET electedAt = if_not_exists(electedAt, :now)");
    expect(at).toBeGreaterThan(-1);
    const branch = ELECTION.slice(at - 1500, at + 3500);
    expect(branch).toContain("TransactWriteCommand");
    expect(branch).toContain("ConditionCheck");
    expect(branch).toContain('ConditionExpression: "premiumFinanceEnabled = :on"');
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
    // W8: the send lists every loan on the anchor, suppresses when money
    // already touched one, and rides only the newest QUOTED offer.
    expect(SEND).toContain('l.status === "QUOTED"');
    expect(SEND).toContain('["ACCEPTED", "ACTIVE", "DEFAULTED", "PAID"].includes');
    expect(SEND).toContain("premiumFinanceEnabled !== true) return null");
    expect(SEND).toContain("financing offer omitted");
  });

  it("re-pricing supersedes the stale quote conditionally — and never a committed election", () => {
    // The bill changed under the offer: the cancel names the QUOTED
    // status, the premium the decision saw, AND the absence of commitment
    // — a clearing down payment or a live Checkout session the customer
    // may be sitting on. A committed election racing the send loses
    // nothing: the condition fails, the send offers nothing, and the
    // customer's money never lands on a CANCELLED loan.
    expect(SEND).toContain(
      '"#s = :q AND premium = :seen AND attribute_not_exists(downPaymentIntentId) AND (attribute_not_exists(electionCheckoutUrl) OR electionCheckoutExpiresAt < :now)"'
    );
    expect(SEND).toContain('"superseded-by-repricing"');
    // And the read-time half: a committed loan at a mismatched premium is
    // a human's knot — nothing is cancelled, nothing new originates.
    expect(SEND).toContain("offering nothing; resolve by hand");
  });

  it("mints the token conditionally on the loan still being QUOTED and holding the token it read", () => {
    // Two concurrent sends must not last-write-win each other's mint, or
    // the first email carries a link that is already dead.
    expect(SEND).toContain('"#s = :quoted AND electionToken = :seenTok"');
    expect(SEND).toContain('"#s = :quoted AND attribute_not_exists(electionToken)"');
  });

  it("originates at the product's fixed terms and nothing else (W8)", () => {
    // Down 25 / APR 14 / months 11 come from quote.ts constants — the send
    // passes them by name, so nobody can quietly hand-tune a term here.
    expect(SEND).toContain("downPct: PF_DEFAULT_DOWN_PCT");
    expect(SEND).toContain("apr: PF_DEFAULT_APR");
    expect(SEND).toContain("months: PF_DEFAULT_MONTHS");
    expect(SEND).toContain("premium: retailTotal");
    expect(SEND).not.toMatch(/downPct: \d/);
  });

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

describe("the origination mutation holds the product's fixed terms", () => {
  it("refuses caller-chosen terms — the API is not a back door", () => {
    const ORIGINATE = read("amplify/functions/pf-originate/handler.ts");
    expect(ORIGINATE).toContain("a.downPct !== PF_DEFAULT_DOWN_PCT");
    expect(ORIGINATE).toContain("a.apr !== PF_DEFAULT_APR");
    expect(ORIGINATE).toContain("a.months !== PF_DEFAULT_MONTHS");
  });

  it("never writes the kill-switch story for a transaction that merely conflicted", () => {
    // A TransactionConflict or throttle cancels with the flag untouched;
    // blaming the switch would fabricate an audit record for examiners.
    const CORE = read("amplify/functions/pfOrigination.ts");
    expect(CORE).toContain('CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"');
    expect(CORE).toContain("without a flag refusal");
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
    expect(PANEL).toContain("if (bErr?.length) throw new Error(bErr[0].message)");
    expect(PANEL).toContain("Binding it twice would bill one premium twice.");
    expect(PANEL).toContain('action: "BIND_ROLLOVER"');
  });

  it("bind stamps datePolicyBound automatically — never typed", () => {
    // "Client since" and production reporting read a real bound date; the
    // single Policy.create site is where it can only come from.
    const PANEL = read("src/components/QuotesPanel.tsx");
    expect(PANEL).toContain("datePolicyBound: new Date().toISOString()");
  });

  it("bind rolls document links alongside invoices and loans", () => {
    // A quote's paper follows it onto the policy — the link gains the
    // policy id and keeps the quote's, same as every other anchor.
    const PANEL = read("src/components/QuotesPanel.tsx");
    expect(PANEL).toContain("client.models.Document.list");
    expect(PANEL).toContain("client.models.Document.update");
  });

  it("activation requires a policy — no mandate turns on against unplaced coverage", () => {
    const SERVICING = read("amplify/functions/pf-servicing/handler.ts");
    expect(SERVICING).toContain("This loan is anchored to a quote. Bind the quote first");
  });
});

describe("the agreement is signed before money moves (W8)", () => {
  const ELECTION = read("amplify/functions/pf-election/handler.ts");

  it("an unsigned accept is refused before anything is scanned or voided", () => {
    expect(ELECTION).toContain("Type your full name and your role to sign the agreement first.");
    expect(ELECTION.indexOf("sign the agreement first")).toBeLessThan(
      ELECTION.indexOf("exclusive-payment-path")
    );
  });

  it("the signature rides the election transaction itself", () => {
    // Same UpdateExpression as electedAt, inside the TransactWriteCommand
    // that carries the kill-switch ConditionCheck: no Checkout session can
    // exist for an unsigned agreement, and no signature can post-date a
    // committed disable.
    expect(ELECTION).toContain(
      'agreementSignedAt = if_not_exists(agreementSignedAt, :now)'
    );
    expect(ELECTION).toContain(
      'agreementSignedName = if_not_exists(agreementSignedName, :signerName)'
    );
    expect(ELECTION.indexOf("agreementSignedAt = if_not_exists")).toBeLessThan(
      ELECTION.indexOf("stripe.checkout.sessions.create")
    );
  });

  it("first writer wins — a revived link keeps its original signer", () => {
    expect(ELECTION).toContain("agreementSignedRole = if_not_exists(agreementSignedRole, :signerRole)");
    expect(ELECTION).toContain("agreementSignedIp = if_not_exists(agreementSignedIp, :signerIp)");
  });

  it("serves the agreement's own paragraphs — the page can never drift from the PDF", () => {
    expect(ELECTION).toContain('from "../pf-agreement/agreementTerms"');
    for (const c of ["OWNERSHIP_DISCLOSURE", "POWER_OF_ATTORNEY", "PREPAYMENT_TERMS", "CANCELLATION_PROCEDURE"]) {
      expect(ELECTION).toContain(c);
    }
  });

  it("the PDF prints the recorded signature in the borrower's block", () => {
    const PDF = read("amplify/functions/pf-agreement/agreementPdf.ts");
    expect(PDF).toContain("/s/ ");
    expect(PDF).toContain("Signed electronically");
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

  it("every anchor scan matches policy or quote — the activation exclusion too", () => {
    expect(SERVICING).toContain("anchorLegs");
    expect(SERVICING).toContain('{ quoteId: { eq: loan.quoteId } }');
  });
});
