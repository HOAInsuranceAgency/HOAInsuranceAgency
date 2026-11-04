import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import type { BrokerFeeAgreement } from '../../../../shared/brokerFees';
import { brokerFeeCents } from '../../../../shared/brokerFees';
import { AGENCY } from '../../../../shared/agency';

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
/** Exactly one summary page; approved jurisdiction forms follow in the same signed PDF. */
export async function createBrokerFeeDisclosurePdf(agreement: BrokerFeeAgreement) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(.08, .19, .29), ink = rgb(.16, .20, .25), muted = rgb(.38, .43, .48);
  const clean = (value: string) => {
    if (typeof value !== 'string' || value.length > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('The fee disclosure contains invalid text.');
    const output = value.replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
    try { regular.encodeText(output.replace(/\n/g, ' ')); } catch { throw new Error('The fee disclosure contains text this PDF font cannot display.'); }
    return output;
  };
  const wrapped = (value: string, width: number, size = 9) => {
    const output: string[] = [];
    for (const paragraph of clean(value).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (regular.widthOfTextAtSize(word, size) > width) throw new Error('A disclosure word is too long to render.');
        if (line && regular.widthOfTextAtSize(`${line} ${word}`, size) > width) { output.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      output.push(line);
    }
    return output;
  };
  let page!: PDFPage, y = 0;
  const newPage = () => { page = pdf.addPage([612, 792]); y = 747; page.drawText('HOA INSURANCE AGENCY', { x: 44, y, font: bold, size: 10, color: navy }); y -= 26; };
  const text = (value: string, size = 9, strong = false) => {
    for (const line of wrapped(value, 524, size)) { if (y < 58) throw new Error('The one-page fee disclosure summary is too long. Shorten the recorded policy labels before preparing it.'); page.drawText(line, { x: 44, y, font: strong ? bold : regular, size, color: ink }); y -= size + 3; }
  };
  newPage();
  text('Broker fee disclosure and agreement', 19, true); y -= 7;
  text(agreement.accountName, 12, true);
  text(`Agency: ${AGENCY.name}`); text(`State: ${agreement.jurisdiction} | Agreement: ${agreement.id}`, 8); y -= 6;
  text('The following agency broker fees are separate from insurance premium, carrier taxes and other third-party charges. The agency may also receive compensation from the insurer.');
  y -= 9;
  page.drawText('Policy / carrier and coverage', { x: 44, y, font: bold, size: 9, color: navy });
  const discloseCommission = agreement.quotes.some(quote => quote.agencyCommissionPct !== undefined);
  const termX = discloseCommission ? 280 : 355;
  page.drawText('Policy term', { x: termX, y, font: bold, size: 9, color: navy });
  if (discloseCommission) page.drawText('Carrier commission', { x: 395, y, font: bold, size: 8, color: navy });
  page.drawText('Broker fee', { x: 514, y, font: bold, size: 9, color: navy }); y -= 16;
  if (!agreement.quotes.length || agreement.quotes.length > 25) throw new Error('A fee disclosure must identify 1 to 25 policies.');
  const compact = agreement.quotes.length > 12;
  for (const [index, quote] of agreement.quotes.entries()) {
    const size = compact ? 7.8 : 8.5, leading = compact ? 10 : 11;
    const labels = wrapped(`${index + 1}. ${quote.carrierName || 'Carrier'} - ${(quote.lines ?? []).filter(Boolean).join(', ')}`, discloseCommission ? 225 : 300, size);
    const height = compact ? labels.length * leading + 2 : Math.max(22, labels.length * leading + 6);
    if (y - height < 283) throw new Error('The policy list does not fit on the one-page fee summary. Shorten the recorded coverage labels before preparing it.');
    labels.forEach((label, line) => page.drawText(label, { x: 44, y: y - line * leading, font: regular, size, color: ink }));
    if (compact) page.drawText(clean(`${quote.effectiveDate || ''} - ${quote.expirationDate || ''}`), { x: termX, y, font: regular, size: discloseCommission ? 6.8 : 7.2, color: ink });
    else {
      page.drawText(clean(quote.effectiveDate || ''), { x: termX, y, font: regular, size: 8, color: ink });
      page.drawText(clean(quote.expirationDate || ''), { x: termX, y: y - 10, font: regular, size: 8, color: muted });
    }
    if (quote.agencyCommissionPct !== undefined) {
      if (!Number.isSafeInteger(quote.agencyCommissionCents) || quote.agencyCommissionCents! < 0 || !Number.isFinite(quote.agencyCommissionPct) || quote.agencyCommissionPct < 0 || quote.agencyCommissionPct > 100) throw new Error('The required carrier commission disclosure needs review.');
      page.drawText(`${money(quote.agencyCommissionCents!)} (${quote.agencyCommissionPct}%)`, { x: 395, y, font: regular, size: 7.5, color: ink });
    }
    const fee = money(brokerFeeCents(quote.brokerFee)); page.drawText(fee, { x: 568 - bold.widthOfTextAtSize(fee, 9), y, font: bold, size: 9, color: ink });
    y -= height;
  }
  y -= 4; text(`TOTAL BROKER FEES: ${money(agreement.totalCents)}`, 15, true); y -= 6;
  text(`Services: ${agreement.purpose}`);
  text(`Payment and refunds: The broker fee is payable upfront and is not financed. ${agreement.refundTerms}`);
  text('Signing this agreement accepts only the stated broker fees and appended state disclosures. It does not authorize binding or establish insurance coverage. Client binding authorization and carrier confirmation remain separate.');
  if (agreement.stateForms.length) text(`${agreement.stateForms.length} approved state disclosure form(s) follow and are part of this agreement.`, 8);
  y -= 8;
  if (agreement.agencySigner) {
    text(`Agency electronic signature: /s/ ${agreement.agencySigner.name}`, 9, true);
    text(`${agreement.agencySigner.title} | License ${agreement.agencySigner.licenseNumber} | ${agreement.createdAt}`, 8);
  }
  if (agreement.signature) {
    text(`Electronically signed: ${agreement.signature.name}`, 10, true);
    text(`Email: ${agreement.signature.email} | Role: ${agreement.signature.role}`, 8);
    text(`Signed at: ${agreement.signature.signedAt}`, 8);
    text('The signer consented to electronic records and signature and represented authority to act for the client.', 8);
  } else text('Unsigned preview - client electronic signature is required.', 10, true);
  for (const form of agreement.stateForms) {
    newPage(); text(form.title, 15, true); y -= 10;
    for (const paragraph of form.paragraphs) {
      for (const line of wrapped(paragraph, 524, 10)) {
        if (y < 80) newPage();
        page.drawText(line, { x: 44, y, font: regular, size: 10, color: ink }); y -= 14;
      }
      y -= 10;
    }
    if ((agreement.agencySigner || agreement.signature) && y < 125) newPage();
    if (agreement.agencySigner) text(`Agency electronic signature: /s/ ${agreement.agencySigner.name}, ${agreement.agencySigner.title}, license ${agreement.agencySigner.licenseNumber}.`, 8);
    if (agreement.signature) text(`Accepted electronically by ${agreement.signature.name} on ${agreement.signature.signedAt}.`, 8);
  }
  const pages = pdf.getPages();
  pages.forEach((item, index) => { item.drawLine({ start: { x: 44, y: 44 }, end: { x: 568, y: 44 }, thickness: .5, color: muted }); item.drawText(`Agreement ${agreement.id} | ${agreement.termsVersion}`, { x: 44, y: 31, font: regular, size: 7, color: muted }); item.drawText(`${index + 1} / ${pages.length}`, { x: 540, y: 31, font: regular, size: 8, color: muted }); });
  pdf.setTitle(`Broker fee agreement - ${clean(agreement.accountName)}`); pdf.setAuthor('HOA Insurance Agency'); pdf.setCreationDate(new Date(agreement.signature?.signedAt ?? agreement.createdAt));
  return { bytes: await pdf.save(), filename: 'Broker fee disclosure.pdf', contentType: 'application/pdf' as const };
}
