import { expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createBrokerFeeDisclosurePdf } from '../../amplify/functions/broker-fees/disclosurePdf';
import { BROKER_FEE_PURPOSE, BROKER_FEE_REFUND_TERMS, type BrokerFeeAgreement } from '../../../shared/brokerFees';
export const brokerFeePdfFixture = (): BrokerFeeAgreement => ({ id: 'bfa_QAPREVIEW', kind: 'AGREEMENT', accountId: 'private-account-id', accountName: 'Maple Grove Condominium Trust', createdAt: '2026-11-04T15:00:00Z', expiresAt: '2026-11-18T15:00:00Z', jurisdiction: 'MA', version: 1, totalCents: 75000, purpose: BROKER_FEE_PURPOSE, refundTerms: BROKER_FEE_REFUND_TERMS, termsVersion: '2026-11-04.v1:review1',
  quotes: ['Property', 'General Liability', 'Umbrella'].map((line, index) => ({ id: `private-quote-${index}`, accountId: 'private-account-id', carrierName: `Example Mutual ${index + 1}`, carrierId: 'private-carrier-id', lines: [line], premium: 10000 + index * 1000, brokerFee: 250, billType: 'AGENCY', effectiveDate: '2027-01-01', expirationDate: '2028-01-01', terms: 'PRIVATE NOTES commissionPct:15' })),
  stateForms: [{ title: 'State-specific disclosure - QA sample', paragraphs: ['Synthetic text for layout verification. This paragraph is a template preview and does not establish approval for charging fees in any jurisdiction.'] }],
  agencySigner: { name: 'Taylor Agent', title: 'Licensed Broker', licenseNumber: 'QA-0001', authorizedBy: 'private-owner-id', authorizedAt: '2026-11-01T12:00:00Z' }, signature: { name: 'Pat Property Manager', email: 'pat@example.test', role: 'Authorized Property Manager', signedAt: '2026-11-04T15:05:00Z', consent: true, ip: '192.0.2.1' } });
async function extract(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes), pages = pdf.getPages().map(page => {
    const contents = page.node.Contents(); if (!contents) return '';
    return (contents instanceof PDFArray ? contents.asArray() : [contents]).map(part => { const stream = pdf.context.lookup(part); if (!(stream instanceof PDFRawStream)) throw new Error('Missing PDF content stream.'); return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1').replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, hex: string) => Buffer.from(hex, 'hex').toString('latin1')); }).join('\n');
  }); return { pdf, pages, all: pages.join('\n') };
}
it('keeps the signed fee summary on one page with state forms appended and matching signatures', async () => {
  const output = await createBrokerFeeDisclosurePdf(brokerFeePdfFixture()), { pages, all } = await extract(output.bytes);
  expect(pages).toHaveLength(2);
  for (const value of ['Example Mutual 1', 'Example Mutual 2', 'Example Mutual 3', 'TOTAL BROKER FEES: $750.00', 'Pat Property Manager', 'pat@example.test', 'Taylor Agent', 'QA-0001', 'does not authorize binding']) expect(pages[0]).toContain(value);
  expect(pages[1]).toContain('State-specific disclosure'); expect(pages[1]).toContain('Taylor Agent'); expect(pages[1]).toContain('Pat Property Manager');
  expect(all).not.toMatch(/PRIVATE NOTES|commissionPct|private-account-id|private-quote|private-carrier-id|private-owner-id/);
});
it('paginates long required state forms without dropping their text or signature', async () => {
  const fixture = brokerFeePdfFixture(); fixture.stateForms[0].paragraphs = Array.from({ length: 45 }, (_, i) => `Required state paragraph ${i + 1}: ${'A complete state disclosure remains part of the signed agreement. '.repeat(3)}`);
  const { pages, all } = await extract((await createBrokerFeeDisclosurePdf(fixture)).bytes); expect(pages.length).toBeGreaterThan(3); expect(all).toContain('Required state paragraph 45'); expect(pages.at(-1)).toContain('Pat Property Manager');
});
it('renders an unsigned disclosure preview without claiming a client signature', async () => {
  const fixture = brokerFeePdfFixture(); delete fixture.signature;
  const { pages } = await extract((await createBrokerFeeDisclosurePdf(fixture)).bytes); expect(pages[0]).toContain('Unsigned preview'); expect(pages[0]).not.toContain('Pat Property Manager');
});
it('fits 25 concise policy rows on the single summary page', async () => {
  const fixture = brokerFeePdfFixture(); fixture.quotes = Array.from({ length: 25 }, (_, index) => ({ ...fixture.quotes[0], id: `q${index}`, carrierName: `Example Mutual ${index + 1}` })); fixture.totalCents = 25 * 25000;
  const { pages } = await extract((await createBrokerFeeDisclosurePdf(fixture)).bytes); expect(pages).toHaveLength(2); expect(pages[0]).toContain('Example Mutual 25'); expect(pages[0]).toContain('TOTAL BROKER FEES: $6,250.00'); expect(pages[0]).toContain('Pat Property Manager');
});
it('includes per-policy carrier compensation only in the explicitly disclosed projection', async () => {
  const fixture = brokerFeePdfFixture(); fixture.quotes = fixture.quotes.map(quote => ({ ...quote, agencyCommissionPct: 15, agencyCommissionCents: Math.round(quote.premium! * 15) }));
  const { pages } = await extract((await createBrokerFeeDisclosurePdf(fixture)).bytes); expect(pages[0]).toContain('Carrier commission'); expect(pages[0]).toContain('$1,500.00 (15%)'); expect(pages[0]).toContain('$1,800.00 (15%)');
});
