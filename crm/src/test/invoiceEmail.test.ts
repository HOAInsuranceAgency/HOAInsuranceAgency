import { describe, expect, it } from "vitest";
import {
  formatDay,
  renderInvoice,
  type InvoiceView,
} from "../../amplify/functions/send-invoice/invoice";
import { formatMoney } from "../lib/invoiceTotals";

const base: InvoiceView = {
  number: "INV-2026-00001",
  associationName: "Robin Hollow Condominium Trust",
  contactFirstName: "Pat",
  policyNumber: "CP-1001",
  carrierName: "Acadia",
  effectiveDate: "2026-09-30",
  expirationDate: "2027-09-30",
  issuedAt: "2026-08-20",
  dueAt: "2026-09-15",
  memo: null,
  paymentUrl: "https://pay.example.com/i/abc123",
  lines: [
    { description: "Commercial property premium", kind: "PREMIUM", retailAmount: 10000, costAmount: 8500 },
    { description: "General liability premium", kind: "PREMIUM", retailAmount: 2400, costAmount: 2040 },
    { description: "Surplus lines tax", kind: "SURPLUS_LINES", retailAmount: 496, costAmount: 496 },
  ],
};

describe("the emailed invoice", () => {
  /**
   * The single most important assertion in this file.
   *
   * Every line carries what the agency owes the carrier. None of it is the
   * association's business, and an invoice that leaked it would be handing a
   * client the commission rate on their own policy.
   */
  it("never shows the insured what the agency pays the carrier", () => {
    const { text, html } = renderInvoice(base);
    for (const cost of ["8500", "8,500", "2040", "2,040"]) {
      expect(text, cost).not.toContain(cost);
      expect(html, cost).not.toContain(cost);
    }
    // Nor the margin figure itself.
    for (const derived of ["1500", "1,500", "1860", "1,860"]) {
      expect(text, derived).not.toContain(derived);
      expect(html, derived).not.toContain(derived);
    }
    // The words, checked against the text part only: "margin" is also a CSS
    // property and appears all over the HTML as `margin:0 0 18px`.
    for (const word of ["margin", "Margin", "commission", "Commission", "cost", "Cost"]) {
      expect(text, word).not.toContain(word);
    }
  });

  it("bills the retail total, not the cost total", () => {
    const { text, html, subject } = renderInvoice(base);
    // 10000 + 2400 + 496
    const due = formatMoney(12896);
    expect(due).toBe("$12,896.00");
    expect(subject).toContain(due);
    expect(text).toContain(`Amount due: ${due}`);
    expect(html).toContain(due);
  });

  it("makes the total the largest thing on the page", () => {
    // Not only taste: 940 CMR 38.00 requires the total shown more prominently
    // than other pricing information. Cheap to honour, so honoured.
    const { html } = renderInvoice(base);
    const totalSize = /font:800 (\d+)px[^"]*"[^>]*>\$12,896\.00/.exec(html);
    expect(totalSize, "the amount due should be rendered at a stated size").not.toBeNull();
    const px = Number(totalSize![1]);
    const others = [...html.matchAll(/font:[^;"]*?(\d\d)px/g)].map((m) => Number(m[1]));
    expect(px).toBeGreaterThan(Math.max(...others.filter((n) => n !== px)));
  });

  it("carries the payment link on the button and in the text part", () => {
    const { text, html } = renderInvoice(base);
    expect(html).toContain(`href="${base.paymentUrl}"`);
    expect(html).toContain("Pay this invoice");
    // text/plain cannot hyperlink, so the URL itself has to be there.
    expect(text).toContain(base.paymentUrl!);
  });

  it("still renders when no payment link has been pasted in yet", () => {
    const { html, text } = renderInvoice({ ...base, paymentUrl: null });
    expect(html).not.toContain("Pay this invoice");
    expect(text).not.toContain("Pay online");
    // The invoice is still a complete, sendable document.
    expect(html).toContain("$12,896.00");
    expect(text).toContain("Amount due");
  });

  it("names the association and the policy it bills", () => {
    const { text, html } = renderInvoice(base);
    for (const out of [text, html]) {
      expect(out).toContain("Robin Hollow Condominium Trust");
      expect(out).toContain("CP-1001");
      expect(out).toContain("Acadia");
      expect(out).toContain("INV-2026-00001");
    }
  });

  it("greets by name, and falls back to something that is not blank", () => {
    expect(renderInvoice(base).text.startsWith("Hi Pat,")).toBe(true);
    expect(
      renderInvoice({ ...base, contactFirstName: null }).text.startsWith("Hello,")
    ).toBe(true);
  });

  it("leaves out rows it has nothing to say for", () => {
    const bare = renderInvoice({
      ...base,
      policyNumber: null,
      carrierName: null,
      effectiveDate: null,
      expirationDate: null,
    });
    // No "Policy:" label with an empty value beside it.
    expect(bare.text).not.toMatch(/Policy:\s*$/m);
    expect(bare.text).not.toMatch(/Carrier:\s*$/m);
    expect(bare.text).toContain("Association: Robin Hollow Condominium Trust");
  });

  it("shows a memo when there is one, and nothing when there is not", () => {
    expect(renderInvoice({ ...base, memo: "Renewal term." }).html).toContain(
      "Renewal term."
    );
    const none = renderInvoice({ ...base, memo: "   " });
    expect(none.html).not.toContain("<p style=\"font:400 14px/1.6");
  });

  it("escapes markup in anything a person typed", () => {
    const { html } = renderInvoice({
      ...base,
      associationName: "<script>alert(1)</script>",
      memo: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("declares a charset", () => {
    expect(renderInvoice(base).html).toContain('<meta charset="utf-8">');
  });

  it("adds up an empty invoice to zero rather than to nothing", () => {
    const { text, subject } = renderInvoice({ ...base, lines: [] });
    expect(subject).toContain("$0.00");
    expect(text).toContain("Amount due: $0.00");
  });
});

describe("formatDay", () => {
  it("reads an ISO day the way a person writes it", () => {
    expect(formatDay("2026-09-30")).toBe("September 30, 2026");
  });

  /**
   * `new Date("2026-09-30")` is midnight UTC. Formatted in a western timezone
   * it prints the 29th, which on an invoice due date is a real problem.
   */
  it("does not slip a day in a western timezone", () => {
    expect(formatDay("2026-01-01")).toBe("January 1, 2026");
    expect(formatDay("2026-12-31")).toBe("December 31, 2026");
  });

  it("passes through anything it cannot read, rather than printing garbage", () => {
    expect(formatDay("next Tuesday")).toBe("next Tuesday");
    expect(formatDay("2026-02-31")).toBe("2026-02-31");
    expect(formatDay(null)).toBe("");
    expect(formatDay(undefined)).toBe("");
  });
});
