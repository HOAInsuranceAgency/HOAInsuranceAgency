import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PublicProposalQuote } from '../../../../shared/frontBusinessDelivery';
import { validCalendarDate } from '../../../../shared/renewalPolicy';

export interface BusinessProposalInput {
  account: { name: string; legalName?: string | null; address?: string | null; city?: string | null; state?: string | null; zip?: string | null };
  packageName: string;
  requiredLines: string[];
  quotes: PublicProposalQuote[];
  reference?: string;
  preparedAt?: string;
}
const NAVY = rgb(0.08, 0.19, 0.29), GOLD = rgb(0.66, 0.49, 0.21), INK = rgb(0.16, 0.20, 0.25), MUTED = rgb(0.38, 0.43, 0.48);
const WIDTH = 612, HEIGHT = 792, MARGIN = 44, CONTENT = WIDTH - MARGIN * 2;
const dollars = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value);
const words = (value: string) => value.toLowerCase().replace(/_/g, ' ').replace(/^\w/, first => first.toUpperCase());

/** A dedicated customer projection: never serialize a Quote, plan, or UI object. */
export async function createBusinessProposalPdf(input: BusinessProposalInput) {
  if (!input.quotes.length || input.quotes.length > 50) throw new Error('Choose a reviewed package with 1 to 50 quotes.');
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = (value: string, label = 'Proposal text') => {
    if (typeof value !== 'string' || value.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${label} needs review before preparing the proposal.`);
    const clean = value.replace(/\r\n?/g, '\n').trim();
    try { regular.encodeText(clean.replace(/\n/g, ' ')); }
    catch { throw new Error(`${label} contains a character this proposal font cannot display. Review it before preparing the draft.`); }
    return clean;
  };
  const accountName = text(input.account.legalName?.trim() || input.account.name, 'Account name');
  const packageName = text(input.packageName, 'Package name');
  if (!accountName || !packageName) throw new Error('Account and reviewed package names are required.');
  const reference = input.reference ? text(input.reference, 'Proposal reference') : undefined;
  if (input.requiredLines.length > 50) throw new Error('The package has too many coverage lines.');
  const requiredLines = input.requiredLines.map(value => text(value, 'Coverage line'));
  const issueTime = input.preparedAt ? new Date(input.preparedAt) : undefined;
  if (issueTime && !Number.isFinite(issueTime.getTime())) throw new Error('The proposal preparation date is invalid.');
  pdf.setTitle(`Insurance proposal - ${packageName}`); pdf.setAuthor('HOA Insurance Agency');
  pdf.setProducer('HOA Insurance Agency CRM'); pdf.setCreator('HOA Insurance Agency CRM');
  if (issueTime) { pdf.setCreationDate(issueTime); pdf.setModificationDate(issueTime); }
  let page: PDFPage, y = 0;
  function newPage() {
    page = pdf.addPage([WIDTH, HEIGHT]);
    page.drawText('HOA INSURANCE AGENCY', { x: MARGIN, y: HEIGHT - 43, size: 10, font: bold, color: NAVY });
    page.drawLine({ start: { x: MARGIN, y: HEIGHT - 54 }, end: { x: WIDTH - MARGIN, y: HEIGHT - 54 }, thickness: 1.5, color: GOLD });
    y = HEIGHT - 78;
  }
  function room(height: number) { if (y - height < 62) newPage(); }
  function wrap(value: string, font: PDFFont, size: number, width: number) {
    const output: string[] = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (font.widthOfTextAtSize(word, size) > width) {
          if (line) { output.push(line); line = ''; }
          let segment = '';
          for (const character of word) {
            if (font.widthOfTextAtSize(segment + character, size) > width) { output.push(segment); segment = ''; }
            segment += character;
          }
          line = segment;
        } else if (line && font.widthOfTextAtSize(`${line} ${word}`, size) > width) { output.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      output.push(line);
    }
    return output;
  }
  function line(value: string, size = 10, strong = false, muted = false) {
    const font = strong ? bold : regular;
    for (const item of wrap(value, font, size, CONTENT)) {
      room(size + 5); page.drawText(item, { x: MARGIN, y, font, size, color: muted ? MUTED : strong ? NAVY : INK }); y -= size + 5;
    }
  }
  function gap(size = 8) { y -= size; }
  function rule() { room(12); page.drawLine({ start: { x: MARGIN, y }, end: { x: WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.84, 0.87, 0.89) }); gap(14); }
  function number(value: unknown, label: string, percent = false) {
    if (value == null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (percent && value > 100)) throw new Error(`${label} needs review before preparing the proposal.`);
    return percent ? `${value}%` : dollars(value);
  }
  newPage();
  line('Insurance proposal', 23, true); gap(6);
  line(accountName, 14, true);
  const address = [input.account.address, [input.account.city, input.account.state, input.account.zip].filter(Boolean).join(' ')].filter(Boolean);
  for (const value of address) line(text(value!, 'Account address'), 10, false, true);
  gap(11); line(packageName, 13, true);
  if (requiredLines.length) line(`Coverage needs: ${requiredLines.join(', ')}`, 10);
  if (issueTime) line(`Prepared ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'long' }).format(issueTime)}`, 9, false, true);
  if (reference) line(`Proposal reference: ${reference}`, 9, false, true);
  gap(8); rule();
  let subtotal = 0;
  for (const [index, quote] of input.quotes.entries()) {
    if (!validCalendarDate(quote.effectiveDate) || !validCalendarDate(quote.expirationDate) || quote.expirationDate <= quote.effectiveDate || (quote.offerExpiresAt && !validCalendarDate(quote.offerExpiresAt))) throw new Error('Review the recorded quote dates before preparing the proposal.');
    const premium = number(quote.premium, 'Quoted premium');
    if (!premium || quote.premium <= 0 || !Number.isSafeInteger(Math.round(quote.premium * 100))) throw new Error('Record a valid quoted premium before preparing the proposal.');
    const carrier = text(quote.carrierName, 'Carrier name');
    if (!carrier || !quote.lines.length || quote.lines.length > 50) throw new Error('Record the carrier and quoted coverages before preparing the proposal.');
    subtotal += Math.round(quote.premium * 100);
    if (!Number.isSafeInteger(subtotal)) throw new Error('The package premium total needs review.');
    room(100); line(`${index + 1}. ${carrier}`, 13, true);
    line(quote.lines.map(value => text(value, 'Quoted coverage')).join(', '), 10);
    line(`Quoted premium: ${premium}`, 11, true);
    line(`Policy term: ${quote.effectiveDate} to ${quote.expirationDate}`, 10);
    line(`Offer valid through: ${quote.offerExpiresAt || 'Not recorded - confirm with the carrier'}`, 10, false, true);
    const terms: [string, unknown, boolean?][] = [
      ['Property blanket limit', quote.blanketLimit], ['Per-occurrence deductible', quote.perOccurrenceDeductible],
      ['Per-unit deductible', quote.perUnitDeductible], ['Coinsurance', quote.coinsurancePct, true],
      ['GL each occurrence', quote.glEachOccurrence], ['GL damage to rented premises', quote.glDamageToRentedPremises],
      ['GL medical expense', quote.glMedicalExpense], ['GL personal/advertising injury', quote.glPersonalAdvInjury],
      ['GL general aggregate', quote.glGeneralAggregate], ['GL products/completed operations', quote.glProductsCompletedOps],
      ['Minimum earned premium', quote.minimumEarnedPremiumPct, true],
    ];
    for (const [label, value, percent] of terms) {
      const formatted = number(value, label, percent);
      if (formatted !== undefined) line(`${label}: ${formatted}`, 9);
    }
    if (quote.replacementCostType) line(`Property valuation: ${text(words(quote.replacementCostType), 'Property valuation')}`, 9);
    if (quote.glClaimsMade != null) line(`GL coverage form: ${quote.glClaimsMade ? 'Claims made' : 'Occurrence'}`, 9);
    if (quote.glAggregateAppliesTo) line(`GL aggregate applies to: ${text(words(quote.glAggregateAppliesTo), 'GL aggregate basis')}`, 9);
    gap(9); rule();
  }
  room(150); line(`Recorded premium subtotal: ${dollars(subtotal / 100)}`, 13, true); gap(8);
  line('Review the attached carrier quotations for full terms, taxes, fees, exclusions, conditions, and payment requirements. Values not recorded here are not represented as included coverage.', 9, false, true);
  gap(5); line('This proposal and its email do not bind insurance. Client authorization and carrier confirmation remain separate steps.', 9, false, true);
  const pages = pdf.getPages();
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: MARGIN, y: 45 }, end: { x: WIDTH - MARGIN, y: 45 }, thickness: 0.5, color: rgb(0.84, 0.87, 0.89) });
    item.drawText('Proposal snapshot - review with attached carrier quotations', { x: MARGIN, y: 31, font: regular, size: 8, color: MUTED });
    item.drawText(`${index + 1} / ${pages.length}`, { x: WIDTH - MARGIN - 35, y: 31, font: regular, size: 8, color: MUTED });
  });
  const filename = `Insurance proposal - ${accountName.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 70).trim() || 'account'}.pdf`;
  return { bytes: await pdf.save(), filename, contentType: 'application/pdf' as const };
}
