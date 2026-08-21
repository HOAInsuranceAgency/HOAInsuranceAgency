import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  encodeHeader,
} from "../../amplify/functions/send-invoice/mime";
import { pdfFilename } from "../../amplify/functions/send-invoice/pdf";
import { invoiceTerms } from "../../amplify/functions/send-invoice/invoice";

const boundaries = { mixed: "MIXEDBOUNDARY", alternative: "ALTBOUNDARY" };

const base = {
  from: "HOA Insurance Agency LLC <insurance@protectmyhoa.com>",
  to: "board@example.com",
  replyTo: "insurance@protectmyhoa.com",
  subject: "Invoice INV-2026-00001, $33,384.00 due",
  text: "Amount due: $33,384.00",
  html: "<p>Amount due: $33,384.00</p>",
  boundaries,
};

const decodePart = (message: string, marker: string): string => {
  const after = message.split(marker)[1] ?? "";
  const body = after.split("\r\n\r\n")[1]?.split("\r\n--")[0] ?? "";
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("the invoice MIME message", () => {
  it("nests the alternative inside the mixed part, not beside it", () => {
    /**
     * Flat, a client picks one of three siblings and shows the message or the
     * PDF, never both. The attachment is a different kind of thing from the
     * body and only this nesting says so.
     */
    const m = buildMimeMessage({
      ...base,
      attachment: {
        filename: "Invoice-INV-2026-00001.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([1, 2, 3]),
      },
    });
    const mixedAt = m.indexOf('boundary="MIXEDBOUNDARY"');
    const altAt = m.indexOf('boundary="ALTBOUNDARY"');
    expect(mixedAt).toBeGreaterThan(-1);
    expect(altAt).toBeGreaterThan(mixedAt);
    // The alternative closes before the attachment part opens.
    expect(m.indexOf("--ALTBOUNDARY--")).toBeLessThan(
      m.indexOf("Content-Disposition: attachment")
    );
  });

  it("carries both bodies, decodable", () => {
    const m = buildMimeMessage(base);
    expect(decodePart(m, "Content-Type: text/plain")).toBe("Amount due: $33,384.00");
    expect(decodePart(m, "Content-Type: text/html")).toBe(
      "<p>Amount due: $33,384.00</p>"
    );
  });

  it("attaches the PDF as a named, base64 attachment", () => {
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const m = buildMimeMessage({
      ...base,
      attachment: {
        filename: "Invoice-INV-2026-00001.pdf",
        contentType: "application/pdf",
        content,
      },
    });
    expect(m).toContain("Content-Type: application/pdf;");
    expect(m).toContain(
      'Content-Disposition: attachment; filename="Invoice-INV-2026-00001.pdf"'
    );
    expect(m).toContain(Buffer.from(content).toString("base64"));
  });

  it("wraps base64 at 76 characters, as RFC 2045 requires", () => {
    const big = new Uint8Array(1000).fill(65);
    const m = buildMimeMessage({
      ...base,
      attachment: { filename: "a.pdf", contentType: "application/pdf", content: big },
    });
    const encoded = m.split("Content-Transfer-Encoding: base64").pop() ?? "";
    const lines = encoded.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]+$/.test(l));
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("uses CRLF throughout, which some MTAs are strict about", () => {
    const m = buildMimeMessage(base);
    // No bare LF anywhere.
    expect(/[^\r]\n/.test(m)).toBe(false);
  });

  it("sends fine with no attachment at all", () => {
    // The PDF is allowed to fail without costing the bill.
    const m = buildMimeMessage(base);
    expect(m).not.toContain("Content-Disposition: attachment");
    expect(m).toContain("--MIXEDBOUNDARY--");
    expect(decodePart(m, "Content-Type: text/plain")).toContain("33,384.00");
  });

  /**
   * The one header that must never appear.
   *
   * SES takes envelope recipients from `Destination`. A `Bcc:` header travels
   * with the message and is visible to everyone who receives it, which is the
   * one thing a blind copy must not be.
   */
  it("never writes a Bcc header", () => {
    const m = buildMimeMessage(base);
    expect(m.toLowerCase()).not.toContain("bcc:");
  });

  it("gives each message unique boundaries when none are supplied", () => {
    const a = buildMimeMessage({ ...base, boundaries: undefined });
    const b = buildMimeMessage({ ...base, boundaries: undefined });
    const boundaryOf = (m: string) =>
      /boundary="(mixed_[0-9a-f]+)"/.exec(m)?.[1] ?? "";
    expect(boundaryOf(a)).not.toBe("");
    expect(boundaryOf(a)).not.toBe(boundaryOf(b));
  });
});

describe("encodeHeader", () => {
  it("leaves ASCII alone, so a logged message stays readable", () => {
    expect(encodeHeader("Invoice INV-2026-00001, $33,384.00 due")).toBe(
      "Invoice INV-2026-00001, $33,384.00 due"
    );
  });

  it("encodes non-ASCII rather than letting it arrive as mojibake", () => {
    // The failure a missing charset caused in the licence alerts, in a header.
    const encoded = encodeHeader("Côte Village premium");
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    expect(encoded.endsWith("?=")).toBe(true);
    const payload = encoded.slice("=?UTF-8?B?".length, -2);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(
      "Côte Village premium"
    );
  });

  it("strips newlines, which would otherwise inject a header", () => {
    const out = encodeHeader("Invoice\r\nBcc: attacker@example.com");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
  });
});

describe("pdfFilename", () => {
  it("names the file after the invoice", () => {
    expect(pdfFilename("INV-2026-00001")).toBe("Invoice-INV-2026-00001.pdf");
  });

  it("falls back when the invoice has no number", () => {
    expect(pdfFilename(null)).toBe("Invoice.pdf");
    expect(pdfFilename("")).toBe("Invoice.pdf");
  });

  it("refuses anything that could escape a filename", () => {
    expect(pdfFilename("../../etc/passwd")).toBe("Invoice-etcpasswd.pdf");
    expect(pdfFilename('a"b')).toBe("Invoice-ab.pdf");
  });
});

/**
 * The terms line in the header block.
 *
 * A due date alone does not tell a treasurer whether they were given terms or
 * whether the bill is payable now, and that difference decides whether it goes
 * in this week's cheque run or next month's.
 */
describe("invoiceTerms", () => {
  it("counts the days allowed", () => {
    expect(invoiceTerms("2026-08-21", "2026-09-04")).toBe("Net 14 days");
    expect(invoiceTerms("2026-08-21", "2026-08-22")).toBe("Net 1 days");
  });

  it("reads same-day as due on receipt, not as zero days", () => {
    expect(invoiceTerms("2026-08-21", "2026-08-21")).toBe("Due upon receipt");
  });

  it("reads a due date in the past as due on receipt, not as negative days", () => {
    // Back-dating happens: an invoice raised late for a policy that bound
    // weeks ago. "Net -12 days" would be a nonsense on a document about money.
    expect(invoiceTerms("2026-08-21", "2026-08-09")).toBe("Due upon receipt");
  });

  it("falls back rather than printing a gap", () => {
    for (const [a, b] of [
      [null, "2026-09-04"],
      ["2026-08-21", null],
      [null, null],
      ["not a date", "2026-09-04"],
      ["2026-08-21", "not a date"],
    ] as [string | null, string | null][]) {
      expect(invoiceTerms(a, b), `${a} → ${b}`).toBe("Due upon receipt");
    }
  });

  it("counts across a month boundary and a leap day", () => {
    expect(invoiceTerms("2026-12-24", "2027-01-07")).toBe("Net 14 days");
    expect(invoiceTerms("2028-02-20", "2028-03-05")).toBe("Net 14 days");
  });
});

/**
 * What the attachment must never contain.
 *
 * The PDF is the document most likely to be forwarded to a board, a bookkeeper
 * or a management company, which makes it the worst possible place to leak
 * what the agency makes. Rendered for real and read back, rather than asserted
 * against the source: the failure would be a `costAmount` reaching a draw call,
 * and only the bytes prove it did not.
 */
describe("the invoice PDF", () => {
  const view = {
    number: "INV-2026-00042",
    associationName: "Maple Court Condominium Trust",
    billToLines: ["Attn: Dana Whitfield", "18 Maple Court", "Marlborough, MA 01752"],
    policyNumber: "GEP11696-26",
    carrierName: "Atain Specialty Insurance Company",
    coverage: "Property, General Liability",
    riskLocation: ["18 Maple Court", "Marlborough, MA 01752"],
    effectiveDate: "2026-08-15",
    expirationDate: "2027-08-15",
    issuedAt: "2026-08-21",
    dueAt: "2026-09-04",
    memo: "A 35% minimum earned premium applies.",
    paymentUrl: "https://buy.stripe.com/test_abc123",
    lines: [
      { description: "Commercial Property Premium", retailAmount: 25000, costAmount: 21250 },
      { description: "Surplus Lines Tax", retailAmount: 1000, costAmount: 1000 },
    ],
  };

  /**
   * The drawn text, recovered from the PDF.
   *
   * Two layers of encoding sit between `drawText` and the bytes, and both fail
   * in the dangerous direction — silently, and toward every `not.toContain`
   * passing for the wrong reason. The cost-leak assertion below is the entire
   * point of this block, so it has to actually be able to see the words.
   *
   * Content streams are Flate-compressed, so they are inflated. Then pdf-lib
   * writes every string as a hex literal — `<544f54414c>` rather than
   * `(TOTAL)` — so those are decoded too. What comes back is the text as drawn.
   */
  const text = async () => {
    const { inflateSync } = await import("node:zlib");
    const { renderInvoicePdf } = await import("../../amplify/functions/send-invoice/pdf");
    const buf = Buffer.from(await renderInvoicePdf(view as never));

    let streams = "";
    let i = 0;
    for (;;) {
      const at = buf.indexOf("stream", i);
      if (at === -1) break;
      // "endstream" contains "stream"; skip those rather than reading backwards
      // from one and landing mid-object.
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
        // Not everything is deflated — the embedded PNG is not.
        streams += chunk.toString("latin1");
      }
      i = end + 9;
    }

    return streams.replace(/<([0-9A-Fa-f]+)>/g, (whole, hex: string) =>
      hex.length % 2
        ? whole
        : Buffer.from(hex, "hex").toString("latin1")
    );
  };

  it("shows the retail figures and the total", async () => {
    const pdf = await text();
    for (const want of ["25,000.00", "1,000.00", "26,000.00", "TOTAL DUE"]) {
      expect(pdf, want).toContain(want);
    }
  });

  it("shows no cost and no margin, anywhere", async () => {
    const pdf = await text();
    // 21,250 is the cost of the first line and 3,750 its margin. Neither is
    // the association's business, and neither is on this page.
    for (const leak of ["21,250", "3,750", "Costs us", "Margin", "Agency only"]) {
      expect(pdf, leak).not.toContain(leak);
    }
  });

  it("carries the placement details a treasurer matches against", async () => {
    const pdf = await text();
    for (const want of [
      "GEP11696-26",
      "Atain Specialty Insurance Company",
      "BILL TO",
      "Dana Whitfield",
      "Coverage",
      "Policy Term",
    ]) {
      expect(pdf, want).toContain(want);
    }
  });

  it("carries the payment instructions and the fraud warning", async () => {
    const pdf = await text();
    expect(pdf).toContain("PAYMENT INSTRUCTIONS");
    expect(pdf).toContain("Fraud prevention");
    expect(pdf).toContain("buy.stripe.com");
    // The reference number, without which a cheque cannot be applied.
    expect(pdf).toContain("INV-2026-00042");
  });

  it("always says it is not a binder", async () => {
    // The one line that must survive every future edit to this layout: an
    // invoice carries a policy block, and a treasurer reading it as the terms
    // of their coverage would have been misled by us, not by their carrier.
    expect(await text()).toContain("not a binder or policy");
  });
});
