import { expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createBusinessProposalPdf, type BusinessProposalInput } from '../../amplify/functions/communications/businessProposalPdf';

const fixture = (): BusinessProposalInput => ({
  account: { name: 'Maple Grove Condominium', legalName: 'Maple Grove Condominium Trust', address: '100 Example Street', city: 'Worcester', state: 'MA', zip: '01608' },
  packageName: 'Reviewed property and liability', requiredLines: ['Property', 'General Liability'], reference: 'HOA-TESTPUBLIC1', preparedAt: '2026-11-04T03:00:00Z',
  quotes: [{ id: 'private-quote-id', carrierName: 'Example Mutual', lines: ['Property', 'General Liability'], premium: 12500.25, effectiveDate: '2027-01-01', expirationDate: '2028-01-01', offerExpiresAt: '2026-12-20', blanketLimit: 5000000, perOccurrenceDeductible: 10000, glEachOccurrence: 1000000, glClaimsMade: false }],
});
async function contents(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages().map(page => {
    const value = page.node.Contents();
    if (!value) return '';
    const parts = value instanceof PDFArray ? value.asArray() : [value];
    return parts.map(part => {
      const stream = pdf.context.lookup(part);
      if (!(stream instanceof PDFRawStream)) throw new Error('Expected an actual PDF content stream.');
      return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
        .replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, hex: string) => Buffer.from(hex, 'hex').toString('latin1'));
    }).join('\n');
  });
  return { pdf, pages, all: pages.join('\n') };
}
it('produces the complete public proposal with recorded terms and separate binding disclaimer', async () => {
  const output = await createBusinessProposalPdf(fixture());
  expect(output.contentType).toBe('application/pdf');
  expect(output.filename).toBe('Insurance proposal - Maple Grove Condominium Trust.pdf');
  const { all, pdf } = await contents(output.bytes);
  for (const expected of ['Maple Grove Condominium Trust', 'Example Mutual', '$12,500.25', '2027-01-01 to 2028-01-01', '$5,000,000.00', '$10,000.00', 'Occurrence', 'HOA-TESTPUBLIC1', 'November 3, 2026', 'Recorded premium subtotal:', 'do not bind insurance']) expect(all).toContain(expected);
  expect(pdf.getTitle()).toBe('Insurance proposal - Reviewed property and liability');
  expect(all).not.toContain('private-quote-id');
});
it('never exports extra model fields containing commissions, internal notes, or private identifiers', async () => {
  const input = fixture();
  Object.assign(input.quotes[0], { commissionPct: 88.876543, notes: 'PRIVATE UNDERWRITING NOTE', bindAuthorizedBy: 'PRIVATE STAFF IDENTIFIER' });
  Object.assign(input, { estimatedCents: 9876543, commissionCents: 456789, notes: 'PRIVATE PACKAGE NOTE' });
  const { all } = await contents((await createBusinessProposalPdf(input)).bytes);
  for (const privateValue of ['88.876543', '9876543', '456789', 'PRIVATE UNDERWRITING NOTE', 'PRIVATE STAFF IDENTIFIER', 'PRIVATE PACKAGE NOTE', 'Commission']) expect(all).not.toContain(privateValue);
});
it('paginates long multi-carrier proposals with every quote, subtotal, and page footer intact', async () => {
  const input = fixture();
  input.quotes = Array.from({ length: 12 }, (_, index) => ({ ...input.quotes[0], id: `q${index}`, carrierName: `Carrier ${index + 1} with a long but readable association insurance name`, premium: 100.01 + index }));
  const { pages, all } = await contents((await createBusinessProposalPdf(input)).bytes);
  expect(pages.length).toBeGreaterThan(2);
  for (let i = 1; i <= 12; i++) expect(all).toContain(`Carrier ${i} with a long`);
  pages.forEach((page, index) => expect(page).toContain(`${index + 1} / ${pages.length}`));
  expect(all).toContain('$1,266.12');
});
it.each<[string, (input: BusinessProposalInput) => void]>([
  ['invalid quote dates', (input: BusinessProposalInput) => { input.quotes[0].effectiveDate = '2026-02-30'; }],
  ['invalid financial terms', (input: BusinessProposalInput) => { input.quotes[0].perOccurrenceDeductible = -1; }],
  ['invalid percentages', (input: BusinessProposalInput) => { input.quotes[0].coinsurancePct = 101; }],
  ['missing carrier', (input: BusinessProposalInput) => { input.quotes[0].carrierName = ''; }],
  ['nonpositive premium', (input: BusinessProposalInput) => { input.quotes[0].premium = 0; }],
  ['unsupported account glyphs', (input: BusinessProposalInput) => { input.account.legalName = '東京 Condominium'; }],
])('refuses %s rather than generating a misleading PDF', async (_, change) => {
  const input = fixture(); change(input);
  await expect(createBusinessProposalPdf(input)).rejects.toThrow();
});
