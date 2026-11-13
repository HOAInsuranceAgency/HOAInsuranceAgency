/**
 * Offline California customer email review. Renders production templates with fictional data.
 * This script never connects to email providers or creates customer/payment records.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderReply } from "../amplify/functions/lead-reply/email";
import { renderInvoice, type InvoiceView } from "../amplify/functions/send-invoice/invoice";
import { renderInvoicePdf } from "../amplify/functions/send-invoice/pdf";
import { buildMimeMessage } from "../amplify/functions/send-invoice/mime";

const destination = "review@example.invalid";
const directory = resolve(process.cwd(), "../docs/previews/california-email");
await mkdir(directory, { recursive: true });
const signature = '<div>Sample Producer<br>California License No. [SAMPLE ONLY]<br>HOA Insurance Agency LLC<br>insurance@ProtectMyHOA.com<br>508-233-2261<br>ProtectMyHOA.com</div>';
const lead = { name: "Seaside Condominium Association (fictional)", contactFirstName: "Maria", state: "CA", city: "San Diego", documentNames: [] };
const common = { lead, producerName: "Sample Producer", signatureMode: "FRONT" as const, producerSignatureHtml: signature,
  generated: { subject: "Insurance review for Seaside Condominium Association",
    body: "We can review coverage options for Seaside Condominium Association ahead of your upcoming renewal. Reply with any questions or a convenient time for a quick call." } };
const invoice: InvoiceView = {
  propertyState: "CA", number: "TEST-CA-001", associationName: lead.name, contactFirstName: "Maria",
  billToLines: ["Seaside Condominium Association (fictional)", "100 Sample Avenue", "San Diego, CA 92101"],
  riskLocation: ["100 Sample Avenue", "San Diego, CA 92101"],
  policyNumber: "SAMPLE - NOT A POLICY", carrierName: "Example Insurance Company (fictional)",
  coverage: "Property", effectiveDate: "2026-12-01", expirationDate: "2027-12-01",
  issuedAt: "2026-11-13", dueAt: "2026-11-30", memo: "TEST ONLY. Fictional amounts; nothing is due. All links are inactive examples.",
  paymentUrl: "https://example.invalid/test-payment",
  lines: [{ description: "Sample property premium - TEST ONLY", kind: "PREMIUM", retailAmount: 1200 }],
};
const financed: InvoiceView = { ...invoice, number: "TEST-CA-002",
  finance: { url: "https://example.invalid/test-financing", downPayment: 300, monthly: 100, months: 9, apr: 5 } };
const fixtures = [
  { id: "lead-reply", label: "Initial lead reply", mail: renderReply(common), producer: true },
  { id: "lead-reply-documents", label: "Initial lead reply with document request", mail: renderReply({ ...common, uploadUrl: "https://example.invalid/test-document-upload" }), producer: true },
  { id: "invoice", label: "Invoice with payment link and PDF", mail: renderInvoice(invoice), invoice },
  { id: "invoice-financing", label: "Invoice with financing option and PDF", mail: renderInvoice(financed), invoice: financed },
];
const messages = [];
for (const fixture of fixtures) {
  const notice = "TEST ONLY - California branding review. Fictional data, inactive links, and sample license text. No coverage, payment, or customer action is created.";
  const subject = "[TEST - California branding] " + fixture.label;
  const text = notice + "\n\n" + fixture.mail.text;
  const html = fixture.mail.html.replace(/(<body[^>]*>)/i, '$1<p style="font:700 13px/1.5 Arial;color:#7c2d12;padding:12px;background:#fff7ed">' + notice + "</p>");
  const from = (fixture.producer ? "Sample Producer | Condo Insurance Agency" : "Condo Insurance Agency") + " <insurance@protectmyhoa.com>";
  const attachment = fixture.invoice ? { filename: fixture.id + "-TEST.pdf", contentType: "application/pdf", content: await renderInvoicePdf(fixture.invoice) } : undefined;
  if (attachment) await writeFile(resolve(directory, attachment.filename), attachment.content);
  const raw = buildMimeMessage({ from, to: destination, replyTo: "insurance@protectmyhoa.com", subject, text, html, attachment });
  const message = { id: fixture.id, from, to: destination, subject, text, html, rawBase64: Buffer.from(raw, "utf8").toString("base64") };
  messages.push(message);
  await writeFile(resolve(directory, fixture.id + ".html"), html);
  await writeFile(resolve(directory, fixture.id + ".eml"), raw);
}
await writeFile(resolve(directory, "messages.json"), JSON.stringify(messages, null, 2));
await writeFile(resolve(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>California email review</title></head><body style="font:16px/1.6 Arial;max-width:850px;margin:40px auto"><h1>California customer email review</h1><p>Fictional samples rendered from the updated customer templates. All links are inactive. Not sent by this script.</p><ul>' + fixtures.map(f => '<li><a href="' + f.id + '.html">' + f.label + '</a>' + (f.invoice ? ' - <a href="' + f.id + '-TEST.pdf">PDF attachment</a>' : "") + '</li>').join("") + '</ul></body></html>');
console.log(JSON.stringify({ directory, recipient: destination, samples: messages.map(m => ({ id: m.id, subject: m.subject })) }));
