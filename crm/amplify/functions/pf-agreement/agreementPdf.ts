import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { formatMoney } from "../../../src/lib/invoiceTotals";
import type { ScheduleRow } from "../../../src/lib/premiumFinance/quote";

/**
 * The premium finance agreement, and the board resolution beside it.
 *
 * Drawn with pdf-lib in the send-invoice/pdf.ts manner. Everything legal in
 * here is fixed text reviewed with the spec — the variables are only names,
 * dates and money. The ownership disclosure is VERBATIM from the signed brief
 * and test-pinned; so is the actuarial prepayment method and the absence of
 * any late-charge language.
 */

const PAGE = { w: 612, h: 792 } as const;
const M = { left: 54, right: 558, top: 738, bottom: 64 } as const;
const NAVY = rgb(0.102, 0.212, 0.365);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

// The legal text itself lives in agreementTerms.ts (dependency-free), because
// the election page serves the same paragraphs without wanting pdf-lib.
import {
  OWNERSHIP_DISCLOSURE,
  POWER_OF_ATTORNEY,
  PREPAYMENT_TERMS,
  CANCELLATION_PROCEDURE,
} from "./agreementTerms";
export { OWNERSHIP_DISCLOSURE, POWER_OF_ATTORNEY, PREPAYMENT_TERMS, CANCELLATION_PROCEDURE };

export interface AgreementView {
  loanId: string;
  associationName: string;
  associationAddress: string[];
  policyNumber: string | null;
  carrierName: string | null;
  policyTerm: string | null;
  premium: number;
  downPayment: number;
  amountFinanced: number;
  totalInterest: number;
  totalOfPayments: number;
  apr: number;
  months: number;
  payment: number;
  originationFee: number;
  effectiveDate: string;
  schedule: ScheduleRow[];
  /**
   * W8: the click-wrap signature captured on the election page, printed in
   * the borrower's signature block when present. Absent on a PDF generated
   * before the customer signs (the copy attached to the offer email).
   */
  signedName?: string | null;
  signedRole?: string | null;
  signedAt?: string | null;
  signedIp?: string | null;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [text];
}

function drawRight(page: PDFPage, text: string, right: number, y: number, font: PDFFont, size: number, color = INK) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: right - w, y, size, font, color });
}

/** A titled paragraph; returns the y it finished at. */
function paragraph(page: PDFPage, fonts: Fonts, title: string | null, body: string, y: number): number {
  if (title) {
    page.drawText(title, { x: M.left, y, size: 9, font: fonts.bold, color: NAVY });
    y -= 13;
  }
  for (const row of wrap(body, fonts.regular, 9, M.right - M.left)) {
    page.drawText(row, { x: M.left, y, size: 9, font: fonts.regular, color: INK });
    y -= 11.5;
  }
  return y - 8;
}

export async function renderAgreementPdf(v: AgreementView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Premium Finance Agreement — ${v.associationName}`);
  doc.setProducer(AGENCY.name);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y: number = M.top;

  page.drawText("PREMIUM FINANCE AGREEMENT", {
    x: M.left, y, size: 16, font: fonts.bold, color: NAVY,
  });
  drawRight(page, `Agreement ${v.loanId.slice(0, 8).toUpperCase()}`, M.right, y + 2, fonts.regular, 9, MUTED);
  y -= 26;

  // ── Parties and the policy ────────────────────────────────────────────
  const partyLines = [
    `LENDER: ${AGENCY.name}, ${AGENCY.addressLine1}, ${AGENCY_FMT.addressLine2}`,
    `BORROWER: ${v.associationName}${v.associationAddress.length ? ", " + v.associationAddress.join(", ") : ""}`,
    `POLICY: ${v.policyNumber ?? "(to be assigned)"}${v.carrierName ? " — " + v.carrierName : ""}${v.policyTerm ? " — term " + v.policyTerm : ""}`,
  ];
  for (const l of partyLines) {
    for (const row of wrap(l, fonts.regular, 9.5, M.right - M.left)) {
      page.drawText(row, { x: M.left, y, size: 9.5, font: fonts.regular, color: INK });
      y -= 12;
    }
  }
  y -= 8;

  /**
   * The federal-style disclosure box (TILA-format for commercial credit).
   * APR and finance charge lead, largest — the format exists so these two
   * cannot be buried.
   */
  const boxTop = y;
  const cols = [
    ["ANNUAL PERCENTAGE RATE", `${v.apr.toFixed(2)}%`, "The cost of your credit as a yearly rate"],
    ["FINANCE CHARGE", formatMoney(v.totalInterest), "The dollar amount the credit will cost you"],
    ["AMOUNT FINANCED", formatMoney(v.amountFinanced), "The amount of credit provided to you"],
    ["TOTAL OF PAYMENTS", formatMoney(v.totalOfPayments), "What you will have paid after all payments"],
  ] as const;
  const colW = (M.right - M.left) / 4;
  page.drawRectangle({ x: M.left, y: boxTop - 78, width: M.right - M.left, height: 78, borderColor: NAVY, borderWidth: 1.2 });
  cols.forEach(([label, value, caption], i) => {
    const x = M.left + i * colW + 8;
    let cy = boxTop - 16;
    for (const row of wrap(label, fonts.bold, 7.5, colW - 16)) {
      page.drawText(row, { x, y: cy, size: 7.5, font: fonts.bold, color: NAVY });
      cy -= 9;
    }
    page.drawText(value, { x, y: cy - 4, size: 13, font: fonts.bold, color: INK });
    cy -= 20;
    for (const row of wrap(caption, fonts.regular, 6.5, colW - 16)) {
      page.drawText(row, { x, y: cy, size: 6.5, font: fonts.regular, color: MUTED });
      cy -= 8;
    }
    if (i > 0) {
      page.drawLine({ start: { x: M.left + i * colW, y: boxTop - 78 }, end: { x: M.left + i * colW, y: boxTop }, thickness: 0.75, color: NAVY });
    }
  });
  y = boxTop - 92;

  y = paragraph(page, fonts, null,
    `Total premium ${formatMoney(v.premium)}, paid as ${v.months + 1} payments over the policy year. Payment 1 is the down payment of ${formatMoney(v.downPayment)}, due at inception and paid to the Lender's premium trust account. Payments 2 through ${v.months + 1} are ${v.months} monthly payments of ${formatMoney(v.payment)} (the final payment may differ by cents), first due one month after ${v.effectiveDate}. A flat origination fee of ${formatMoney(v.originationFee)} applies once per agreement and is refundable on prepayment. There are no late fees, delinquency charges, or reinstatement fees under this agreement.`,
    y);

  // ── Payment schedule ──────────────────────────────────────────────────
  page.drawText("PAYMENT SCHEDULE", { x: M.left, y, size: 9, font: fonts.bold, color: NAVY });
  y -= 14;
  page.drawText("#", { x: M.left, y, size: 8, font: fonts.bold, color: MUTED });
  page.drawText("Due", { x: M.left + 30, y, size: 8, font: fonts.bold, color: MUTED });
  drawRight(page, "Payment", M.left + 220, y, fonts.bold, 8, MUTED);
  drawRight(page, "Interest", M.left + 310, y, fonts.bold, 8, MUTED);
  drawRight(page, "Principal", M.left + 410, y, fonts.bold, 8, MUTED);
  drawRight(page, "Balance", M.right, y, fonts.bold, 8, MUTED);
  y -= 4;
  page.drawLine({ start: { x: M.left, y }, end: { x: M.right, y }, thickness: 0.75, color: RULE });
  y -= 12;
  /**
   * Payment 1 is the down payment: due at inception, no finance charge, and
   * it takes the amount owed from the premium down to the amount financed —
   * so the balance column telescopes from the very first row. The financed
   * installments follow as payments 2 through months+1.
   */
  page.drawText("1", { x: M.left, y, size: 8.5, font: fonts.regular, color: INK });
  page.drawText(`${v.effectiveDate} (down payment)`, { x: M.left + 30, y, size: 8.5, font: fonts.regular, color: INK });
  drawRight(page, formatMoney(v.downPayment), M.left + 220, y, fonts.regular, 8.5);
  drawRight(page, formatMoney(0), M.left + 310, y, fonts.regular, 8.5);
  drawRight(page, formatMoney(v.downPayment), M.left + 410, y, fonts.regular, 8.5);
  drawRight(page, formatMoney(v.amountFinanced), M.right, y, fonts.regular, 8.5);
  y -= 12;
  for (const row of v.schedule) {
    if (y < M.bottom + 12) {
      page = doc.addPage([PAGE.w, PAGE.h]);
      y = M.top;
    }
    page.drawText(String(row.n + 1), { x: M.left, y, size: 8.5, font: fonts.regular, color: INK });
    page.drawText(row.dueDate, { x: M.left + 30, y, size: 8.5, font: fonts.regular, color: INK });
    drawRight(page, formatMoney(row.payment), M.left + 220, y, fonts.regular, 8.5);
    drawRight(page, formatMoney(row.interest), M.left + 310, y, fonts.regular, 8.5);
    drawRight(page, formatMoney(row.principal), M.left + 410, y, fonts.regular, 8.5);
    drawRight(page, formatMoney(row.balance), M.right, y, fonts.regular, 8.5);
    y -= 12;
  }
  y -= 10;

  // ── The clauses ───────────────────────────────────────────────────────
  const clause = (title: string | null, body: string) => {
    const needed = (wrap(body, fonts.regular, 9, M.right - M.left).length + 2) * 12 + 20;
    if (y - needed < M.bottom) {
      page = doc.addPage([PAGE.w, PAGE.h]);
      y = M.top;
    }
    y = paragraph(page, fonts, title, body, y);
  };

  // The disclosure is boxed and tinted: prominent is part of the requirement.
  const discRows = wrap(OWNERSHIP_DISCLOSURE, fonts.bold, 9.5, M.right - M.left - 24);
  const discH = discRows.length * 12 + 22;
  if (y - discH < M.bottom) {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = M.top;
  }
  page.drawRectangle({ x: M.left, y: y - discH, width: M.right - M.left, height: discH, color: rgb(0.898, 0.929, 0.965) });
  page.drawRectangle({ x: M.left, y: y - discH, width: 3, height: discH, color: NAVY });
  let dy = y - 16;
  page.drawText("OWNERSHIP DISCLOSURE", { x: M.left + 12, y: dy, size: 8, font: fonts.bold, color: NAVY });
  dy -= 12;
  for (const row of discRows) {
    page.drawText(row, { x: M.left + 12, y: dy, size: 9.5, font: fonts.bold, color: INK });
    dy -= 12;
  }
  y = y - discH - 12;

  clause(null, POWER_OF_ATTORNEY);
  clause(null, PREPAYMENT_TERMS);
  clause(null, CANCELLATION_PROCEDURE);
  clause(
    "SECURITY INTEREST",
    "The unearned premium and unearned dividends under the policy identified above secure this loan. The Borrower represents that the board of the association has authorized this agreement by resolution executed for the current policy term."
  );

  // ── Signatures ────────────────────────────────────────────────────────
  if (y < M.bottom + 110) {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = M.top;
  }
  y -= 12;
  // The borrower's line: the recorded electronic signature when the customer
  // has signed on the election page, a wet-ink line only before that.
  if (v.signedName) {
    const signedDay = (v.signedAt ?? "").slice(0, 10) || "(date on file)";
    page.drawText(`/s/ ${v.signedName}`, { x: M.left, y, size: 11, font: fonts.bold, color: INK });
    page.drawText(signedDay, { x: M.left + 260, y, size: 10, font: fonts.regular, color: INK });
    page.drawText(
      `${v.associationName} — ${v.signedRole ?? "Authorized signatory"}, per board resolution`,
      { x: M.left, y: y - 12, size: 8, font: fonts.regular, color: MUTED }
    );
    page.drawText(
      // The IP is shape-validated at capture; the slice is the belt for any
      // row written before that, so nothing can run off the page edge.
      `Signed electronically ${v.signedAt ?? ""}${v.signedIp ? ` from ${v.signedIp.slice(0, 45)}` : ""}`.trim(),
      { x: M.left, y: y - 22, size: 7.5, font: fonts.regular, color: MUTED }
    );
    y -= 54;
  } else {
    page.drawLine({ start: { x: M.left, y }, end: { x: M.left + 220, y }, thickness: 0.75, color: INK });
    page.drawLine({ start: { x: M.left + 260, y }, end: { x: M.left + 360, y }, thickness: 0.75, color: INK });
    page.drawText(`${v.associationName} — Authorized signatory, per board resolution`, {
      x: M.left, y: y - 12, size: 8, font: fonts.regular, color: MUTED,
    });
    page.drawText("Date", { x: M.left + 260, y: y - 12, size: 8, font: fonts.regular, color: MUTED });
    y -= 44;
  }
  {
    const who = AGENCY.name;
    page.drawLine({ start: { x: M.left, y }, end: { x: M.left + 220, y }, thickness: 0.75, color: INK });
    page.drawLine({ start: { x: M.left + 260, y }, end: { x: M.left + 360, y }, thickness: 0.75, color: INK });
    page.drawText(`${who} — Authorized Representative`, { x: M.left, y: y - 12, size: 8, font: fonts.regular, color: MUTED });
    page.drawText("Date", { x: M.left + 260, y: y - 12, size: 8, font: fonts.regular, color: MUTED });
    y -= 44;
  }

  for (const p of doc.getPages()) {
    p.drawText(`${AGENCY.name} · ${AGENCY.addressLine1}, ${AGENCY_FMT.addressLine2} · ${AGENCY.phone}`, {
      x: M.left, y: M.bottom - 20, size: 7.5, font: fonts.regular, color: MUTED,
    });
  }
  return doc.save();
}

/**
 * The board resolution the association executes — re-required at every
 * renewal, because boards turn over annually and a receiver can replace one
 * mid-term. Activation refuses a resolution executed before the financed
 * term began (the staleness rule).
 */
export async function renderBoardResolutionPdf(v: AgreementView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Board Resolution — ${v.associationName}`);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const page = doc.addPage([PAGE.w, PAGE.h]);
  let y: number = M.top;

  page.drawText("RESOLUTION OF THE BOARD", { x: M.left, y, size: 16, font: fonts.bold, color: NAVY });
  y -= 18;
  page.drawText(v.associationName, { x: M.left, y, size: 11, font: fonts.bold, color: INK });
  y -= 28;

  const body = [
    `RESOLVED, that ${v.associationName} (the "Association") is authorized to enter into a premium finance agreement with ${AGENCY.name} to finance ${formatMoney(v.amountFinanced)} of the ${formatMoney(v.premium)} premium for insurance policy ${v.policyNumber ?? "(number pending)"}${v.carrierName ? ` issued by ${v.carrierName}` : ""}, for the policy term beginning ${v.effectiveDate}, with a down payment of ${formatMoney(v.downPayment)} due at inception as payment 1, at ${v.apr.toFixed(2)}% APR over ${v.months} further monthly installments of ${formatMoney(v.payment)};`,
    `RESOLVED FURTHER, that the person named below is authorized to execute the premium finance agreement, including its power of attorney, on the Association's behalf;`,
    `RESOLVED FURTHER, that the board acknowledges the lender is the same company that placed the insurance, earning interest in addition to commission, and that the Association is free to finance elsewhere or pay the premium in full.`,
    `This resolution is executed for the current policy term. A new resolution is required at each renewal.`,
  ];
  for (const para of body) {
    for (const row of wrap(para, fonts.regular, 10, M.right - M.left)) {
      page.drawText(row, { x: M.left, y, size: 10, font: fonts.regular, color: INK });
      y -= 13;
    }
    y -= 8;
  }

  y -= 20;
  for (const label of [
    "Authorized signatory (name and office)",
    "Signature",
    "Date of execution",
    "Certified by (secretary of the association)",
  ]) {
    page.drawLine({ start: { x: M.left, y }, end: { x: M.left + 300, y }, thickness: 0.75, color: INK });
    page.drawText(label, { x: M.left, y: y - 12, size: 8, font: fonts.regular, color: MUTED });
    y -= 42;
  }
  return doc.save();
}
