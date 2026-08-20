import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  encodeHeader,
} from "../../amplify/functions/send-invoice/mime";
import { pdfFilename } from "../../amplify/functions/send-invoice/pdf";

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
