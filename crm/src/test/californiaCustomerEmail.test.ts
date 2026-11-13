import { describe, expect, it, vi } from "vitest";
import { AGENCY, AGENCY_FMT } from "../../../shared/agency";
import { customerAgencyCopy, customerEmailIdentity } from "../../../shared/customerEmailIdentity";
import { renderReply, systemPrompt } from "../../amplify/functions/lead-reply/email";
import { renderInvoice, type InvoiceView } from "../../amplify/functions/send-invoice/invoice";
import { renderInvoicePdf } from "../../amplify/functions/send-invoice/pdf";
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";

const signature = '<div>Sample Producer<br>California License No. SAMPLE<br><span>HOA</span> Insurance Agency LLC<br><a href="mailto:sample@protectmyhoa.com">sample@protectmyhoa.com</a><br>508-233-2261<img src="https://www.protectmyhoa.com/logo.png"></div>';
const invoice: InvoiceView = {
  associationName: "Seaside Condominium Association", number: "TEST-CA-001", propertyState: "CA",
  billToLines: ["Manager", "Boston, MA 02110"], riskLocation: ["San Diego, CA 92101"],
  issuedAt: "2026-11-13", dueAt: "2026-11-30",
  lines: [{ description: "Sample premium", kind: "PREMIUM", retailAmount: 1200, costAmount: 900 }],
};
const lead = { name: "Seaside Condominium Association", state: "CA", documentNames: [] };
const generated = { subject: "Your review with HOA Insurance Agency", body: "HOA Insurance Agency LLC will review the information you shared." };
const disclosure = customerEmailIdentity("CA").disclosure;

describe("shared California customer email identity", () => {
  it.each(["CA", "ca", " California "])("recognizes the insured property state %s", state => {
    expect(customerEmailIdentity(state)).toMatchObject({ california: true, displayName: "Condo Insurance Agency", disclosure });
  });
  it.each(["MA", "NY", "NV", "", null, undefined])("preserves the original identity for %s", state => {
    expect(customerEmailIdentity(state)).toEqual({ california: false, name: AGENCY.name, displayName: AGENCY_FMT.displayName, disclosure: "" });
    expect(customerAgencyCopy(generated.body, state)).toBe(generated.body);
  });
  it("uses the California identity in generated copy, signature, and both email alternatives", () => {
    const reply = renderReply({ generated, lead, producerName: "Sample Producer", signatureMode: "FRONT", producerSignatureHtml: signature });
    expect(systemPrompt("Sample Producer", "CA")).toContain("a licensed producer at Condo Insurance Agency.");
    expect(reply.subject).toContain("Condo Insurance Agency");
    for (const part of [reply.text, reply.html]) {
      expect(part).toContain("Thank you for contacting Condo Insurance Agency.");
      expect(part).toContain("California License No. SAMPLE");
      expect(part).toContain("sample@protectmyhoa.com");
      expect(part.split(disclosure)).toHaveLength(2);
      expect(part.replace(disclosure, "")).not.toMatch(/HOA\s+Insurance\s+Agency/i);
    }
    expect(reply.html).not.toContain("<img");
  });
  it("does not invent a Front signature if the verified signature is missing or image-only", () => {
    const opts = { generated, lead, producerName: "Sample Producer", signatureMode: "FRONT" as const };
    expect(() => renderReply(opts)).toThrow("verified personal signature");
    expect(() => renderReply({ ...opts, producerSignatureHtml: '<img src="https://example.invalid/signature.png">' })).toThrow("text signature");
  });
  it("keeps non-California Front signature behavior and prose unchanged", () => {
    const reply = renderReply({ generated, lead: { ...lead, state: "MA" }, producerName: "Sample Producer", signatureMode: "FRONT", producerSignatureHtml: signature });
    expect(systemPrompt("Sample Producer", "MA")).toBe(systemPrompt("Sample Producer"));
    expect(reply.subject).toBe(generated.subject);
    expect(reply.text).toContain("Thank you for contacting HOA Insurance Agency.");
    expect(reply.text).toContain(generated.body);
    expect(reply.text).not.toContain("Sample Producer");
    expect(reply.text).not.toContain(disclosure);
    expect(renderInvoice({ ...invoice, propertyState: "MA" })).toEqual(renderInvoice({ ...invoice, propertyState: undefined }));
  });
  it.each([null, { url: "https://example.invalid/finance", downPayment: 300, monthly: 100, months: 9, apr: 5 }])("brands invoices, including the financing variant %j, from the risk state", finance => {
    const rendered = renderInvoice({ ...invoice, finance });
    expect(rendered.subject).toContain("Condo Insurance Agency");
    for (const part of [rendered.text, rendered.html]) {
      expect(part).toContain(disclosure);
      expect(part.replace(disclosure, "")).not.toMatch(/HOA Insurance Agency/);
      expect(part).not.toContain("$900");
    }
    expect(rendered.html).not.toContain(AGENCY_FMT.logoUrl);
    if (finance) expect(rendered.text).toContain(finance.url);
  });
  it("uses a California PDF wordmark and disclosure on every page without fetching the HOA logo", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Should not load the other wordmark"));
    try {
      const pdf = await PDFDocument.load(await renderInvoicePdf(invoice));
      expect(pdf.getAuthor()).toBe("Condo Insurance Agency");
      expect(fetch).not.toHaveBeenCalled();
      for (const page of pdf.getPages()) {
        const contents = page.node.Contents();
        const refs = contents instanceof PDFArray ? contents.asArray() : [contents!];
        const text = refs.map(ref => new TextDecoder().decode(decodePDFRawStream(pdf.context.lookup(ref) as PDFRawStream).decode())).join("");
        const encoded = Buffer.from(disclosure, "latin1").toString("hex").toUpperCase();
        expect(text).toContain(encoded);
      }
    } finally { fetch.mockRestore(); }
  });
  it.each([-250, 0])("preserves nonpayable invoice safeguards with California branding (%s)", amount => {
    const rendered = renderInvoice({
      ...invoice,
      lines: [{ description: "Adjustment", retailAmount: amount, costAmount: 0 }],
      paymentUrl: "https://example.invalid/pay",
      finance: { url: "https://example.invalid/finance", downPayment: 100, monthly: 25, months: 9, apr: 5 },
    });
    expect(rendered.subject).toContain("Condo Insurance Agency");
    expect(rendered.text).toContain("No payment is due");
    expect(rendered.text).not.toContain("https://example.invalid/pay");
    expect(rendered.html).not.toContain("https://example.invalid/finance");
    if (amount < 0) expect(rendered.subject).toContain("$250.00 credit");
  });
  it("retains the separately payable broker fee in California financing correspondence", () => {
    const rendered = renderInvoice({ ...invoice,
      finance: { url: "https://example.invalid/finance", downPayment: 300, brokerFee: 75, monthly: 100, months: 9, apr: 5 },
    });
    expect(rendered.text).toContain("$75.00 broker fee paid in full");
    expect(rendered.html).toContain("broker fee paid in full");
    expect(rendered.text).toContain(disclosure);
  });
});
