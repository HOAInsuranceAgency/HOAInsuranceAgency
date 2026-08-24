import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One payment path at a time (2026-08-23): an association either pays the
 * premium in full through a Stripe link or signs a finance agreement — never
 * both at once. The exclusion runs in both directions, and both directions
 * are load-bearing enough to pin structurally, the premiumFinanceFlag.test.ts
 * way:
 *
 *  - Full payment wins retroactively: the webhook, on PAID, cancels any
 *    QUOTED loan on the invoice's policy. QUOTED only — an ACTIVE loan means
 *    money already moved, which is a human's problem, loudly.
 *  - Activation refuses proactively: while an invoice on the policy still
 *    offers pay-in-full (PROCESSING, or SENT with a live link), the loan
 *    cannot activate.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("full payment supersedes quoted loans", () => {
  const WEBHOOK = read("amplify/functions/stripe-webhook/handler.ts");

  it("cancels QUOTED loans only, and only conditionally — never under a clearing down payment", () => {
    expect(WEBHOOK).toContain('":q": "QUOTED"');
    // The condition carries the money guard since the W8 review: a QUOTED
    // loan whose down payment is clearing is money-touched, and cancelling
    // it would land the customer's debit on a CANCELLED loan.
    expect(WEBHOOK).toContain(
      'ConditionExpression: "#s = :q AND attribute_not_exists(downPaymentIntentId)"'
    );
    expect(WEBHOOK).toContain('loan.status !== "QUOTED" || loan.downPaymentIntentId');
    expect(WEBHOOK).toContain('":c": "CANCELLED"');
    // An ACTIVE loan is never auto-cancelled by a payment.
    expect(WEBHOOK).not.toMatch(/":q": "ACTIVE"/);
  });

  it("runs in the PAID branch, best-effort — a failure never un-PAYs", () => {
    const at = WEBHOOK.indexOf("await cancelQuotedLoans(invoice)");
    expect(at).toBeGreaterThan(-1);
    // Wrapped in its own try/catch: the invoice's PAID write already landed.
    const before = WEBHOOK.slice(at - 200, at);
    expect(before).toContain("try {");
    expect(WEBHOOK.slice(at, at + 400)).toContain("catch");
  });

  it("logs the supersession with the ruleset hash", () => {
    expect(WEBHOOK).toContain('rule: "superseded-by-payment"');
    expect(WEBHOOK).toContain("configSha256: PF_CONFIG_SHA256");
  });

  it("the webhook carries its loan-table grant", () => {
    // The env var without the grant is the original stripe-webhook failure
    // class: it deploys, then dies at runtime. Both tables, both wired.
    const BACKEND = read("amplify/backend.ts");
    expect(BACKEND).toMatch(
      /"PF_LOAN_TABLE",\s*backend\.data\.resources\.tables\.PfLoan\.tableName\s*\);\s*backend\.data\.resources\.tables\.PfLoan\.grantReadWriteData\(\s*backend\.stripeWebhook/
    );
    expect(BACKEND).toMatch(
      /"PF_COMPLIANCE_LOG_TABLE",\s*backend\.data\.resources\.tables\.PfComplianceLog\.tableName\s*\);\s*backend\.data\.resources\.tables\.PfComplianceLog\.grantWriteData\(\s*backend\.stripeWebhook/
    );
  });
});

describe("activation refuses while pay-in-full is open", () => {
  const SERVICING = read("amplify/functions/pf-servicing/handler.ts");

  it("blocks on PROCESSING and on SENT with a live link", () => {
    expect(SERVICING).toContain('inv.status === "PROCESSING"');
    expect(SERVICING).toMatch(
      /inv\.status === "SENT" && inv\.stripePaymentLinkId\?\.trim\(\)/
    );
  });

  it("logs the refusal as a compliance row", () => {
    expect(SERVICING).toContain('rule: "exclusive-payment-path"');
  });

  it("sweeps every invoice page — a filter after pagination can miss", () => {
    const at = SERVICING.indexOf('rule: "exclusive-payment-path"');
    const guard = SERVICING.slice(at - 2000, at);
    expect(guard).toContain("listAllPages");
  });

  it("PROCESSING means they already chose — the message says cancel, not retry", () => {
    expect(SERVICING).toContain("this quote should be cancelled");
    expect(SERVICING).toContain("Void it first");
  });
});
