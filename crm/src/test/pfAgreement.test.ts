import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CANCELLATION_PROCEDURE,
  OWNERSHIP_DISCLOSURE,
  POWER_OF_ATTORNEY,
  PREPAYMENT_TERMS,
  renderAgreementPdf,
  renderBoardResolutionPdf,
  type AgreementView,
} from "../../amplify/functions/pf-agreement/agreementPdf";
import { buildQuote } from "../lib/premiumFinance/quote";

/**
 * The agreement is a legal document; these tests pin its load-bearing text.
 * Rendered for real and read back — content streams are deflated and pdf-lib
 * writes strings as hex, so both layers are undone (the invoiceMime.test.ts
 * technique) before asserting. A `not.toContain` against raw bytes passes
 * vacuously, which for a lending document is the dangerous direction.
 */

const quote = buildQuote({
  premium: 1_000_000,
  downPct: 25,
  months: 9,
  apr: 14.0,
  effectiveDate: "2026-09-01",
});

const view: AgreementView = {
  loanId: "pf-test-12345678",
  associationName: "Maple Court Condominium Trust",
  associationAddress: ["18 Maple Court", "Marlborough, MA 01752"],
  policyNumber: "GEP11696-26",
  carrierName: "Atain Specialty Insurance Company",
  policyTerm: "2026-09-01 to 2027-09-01",
  premium: 1_000_000,
  downPayment: quote.downPayment,
  amountFinanced: quote.amountFinanced,
  totalInterest: quote.totalInterest,
  totalOfPayments: Math.round((quote.amountFinanced + quote.totalInterest) * 100) / 100,
  apr: 14.0,
  months: 9,
  payment: quote.payment,
  originationFee: 10,
  effectiveDate: "2026-09-01",
  schedule: quote.schedule,
};

function decode(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let streams = "";
  let i = 0;
  for (;;) {
    const at = buf.indexOf("stream", i);
    if (at === -1) break;
    if (buf.subarray(Math.max(0, at - 3), at).toString("latin1") === "end") {
      i = at + 6;
      continue;
    }
    let from = at + 6;
    if (buf[from] === 0x0d) from++;
    if (buf[from] === 0x0a) from++;
    const end = buf.indexOf("endstream", from);
    if (end === -1) break;
    const chunk = buf.subarray(from, end);
    try {
      streams += inflateSync(chunk).toString("latin1");
    } catch {
      streams += chunk.toString("latin1");
    }
    i = end + 9;
  }
  /**
   * The drawn strings, joined in stream order with single spaces. wrap()
   * splits paragraphs at spaces only, so a phrase broken across lines
   * reassembles exactly — which is what lets these tests assert sentences
   * longer than one printed line.
   */
  const parts: string[] = [];
  for (const m of streams.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 === 0) parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return parts.join(" ").replace(/\s+/g, " ");
}

describe("the premium finance agreement", () => {
  it("carries the ownership disclosure verbatim", async () => {
    const text = decode(await renderAgreementPdf(view));
    // pdf-lib may encode the em dash oddly; assert the load-bearing clauses.
    expect(text).toContain("the same company that placed your insurance");
    expect(text).toContain("We earn interest on this loan in addition to commission");
    expect(text).toContain("free to finance elsewhere or pay the premium in full");
    // And the constant itself is the signed sentence, character for character.
    expect(OWNERSHIP_DISCLOSURE).toBe(
      "The lender under this agreement is HOA Insurance Agency LLC, the same company that placed your insurance. We earn interest on this loan in addition to commission on the policy. You are free to finance elsewhere or pay the premium in full."
    );
  });

  it("carries the power of attorney, scoped to default", async () => {
    const text = decode(await renderAgreementPdf(view));
    expect(text).toContain("POWER OF ATTORNEY");
    expect(POWER_OF_ATTORNEY).toContain("effective only upon default");
    expect(POWER_OF_ATTORNEY).toContain("unearned premium");
    expect(text).toContain("attorney-in-fact");
  });

  it("shows the federal-style disclosure block with the signed figures", async () => {
    const text = decode(await renderAgreementPdf(view));
    for (const want of [
      "ANNUAL PERCENTAGE RATE",
      "14.00%",
      "FINANCE CHARGE",
      "$44,426.49",
      "AMOUNT FINANCED",
      "$750,000.00",
      "TOTAL OF PAYMENTS",
    ]) {
      expect(text, want).toContain(want);
    }
  });

  it("prints the full schedule", async () => {
    const text = decode(await renderAgreementPdf(view));
    expect(text).toContain("PAYMENT SCHEDULE");
    for (const row of view.schedule) {
      expect(text, row.dueDate).toContain(row.dueDate);
    }
    expect(text).toContain("$88,269.61");
  });

  it("states the actuarial method and the fee refund, and no late anything", async () => {
    const text = decode(await renderAgreementPdf(view));
    expect(PREPAYMENT_TERMS).toContain("actuarial method");
    expect(text).toContain("actuarial method");
    expect(text).toContain("origination fee is refunded in full");
    expect(text).toContain("no late fees, delinquency charges, or reinstatement fees");
    // The Rule of 78s appears nowhere, in any casing.
    expect(text.toLowerCase()).not.toContain("rule of 78");
    expect(text.toLowerCase()).not.toContain("sum of digits");
  });

  it("describes the cancellation procedure the servicing code enforces", async () => {
    const text = decode(await renderAgreementPdf(view));
    expect(CANCELLATION_PROCEDURE).toContain("15 days");
    expect(CANCELLATION_PROCEDURE).toContain("certificate of mailing");
    expect(CANCELLATION_PROCEDURE).toContain("within 30 days");
    expect(text).toContain("certificate of mailing");
  });
});

describe("the board resolution", () => {
  it("authorizes the financing, names a signatory line, and expires with the term", async () => {
    const text = decode(await renderBoardResolutionPdf(view));
    expect(text).toContain("RESOLUTION OF THE BOARD");
    expect(text).toContain("Maple Court Condominium Trust");
    expect(text).toContain("$750,000.00");
    expect(text).toContain("Authorized signatory");
    expect(text).toContain("Date of execution");
    // The staleness rule's other half: the paper says a new one is required.
    expect(text).toContain("new resolution is required at each renewal");
    // The board acknowledges the conflict too.
    expect(text).toContain("same company that placed the insurance");
  });
});

describe("the generation handler", () => {
  const SRC = readFileSync(
    resolve(process.cwd(), "amplify/functions/pf-agreement/handler.ts"),
    "utf8"
  );

  it("renders from the loan's frozen terms, not the live policy", () => {
    expect(SRC).toContain("loan.premium");
    expect(SRC).toContain("loan.apr");
    expect(SRC).not.toMatch(/premium:\s*policy\.premium/);
  });

  it("re-checks the kill switch — counsel's stop reaches paperwork", () => {
    expect(SRC).toContain("premiumFinanceEnabled !== true");
  });

  it("files under generated/, skipping OCR, like the ACORD output", () => {
    expect(SRC).toContain("generated/pf/");
    expect(SRC).toContain('ocrStatus: "SKIPPED"');
  });
});
