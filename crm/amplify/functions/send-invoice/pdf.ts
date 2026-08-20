import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { formatMoney, invoiceTotals } from "../../../src/lib/invoiceTotals";
import { formatDay, type InvoiceView } from "./invoice";

/**
 * The invoice as a PDF, for the attachment on the email.
 *
 * ── Why a PDF at all, when the email already shows it ───────────────────────
 * Because the email is read by the person we sent it to and the PDF is what
 * they forward. A treasurer sends it to the board, files it with the minutes,
 * or hands it to a bookkeeper who never saw the message it arrived in. An HTML
 * email printed from a phone is not that document.
 *
 * ── Drawn, not templated ────────────────────────────────────────────────────
 * `acordPdf.ts` fills form fields in an existing PDF; this composes one from
 * nothing, which pdf-lib does perfectly well and which avoids shipping and
 * versioning a template file. Same library either way, so no new dependency.
 *
 * ── Retail only ─────────────────────────────────────────────────────────────
 * As with the email: `costAmount` is on every line and appears nowhere here.
 * This document is the one most likely to be forwarded onward, which makes it
 * the worst possible place to leak what the agency makes.
 */

/* US Letter, in points. */
const PAGE = { w: 612, h: 792 } as const;
const M = { left: 54, right: 558, top: 738, bottom: 64 } as const;

const NAVY = rgb(0.102, 0.212, 0.365);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
const GOLD = rgb(0.82, 0.66, 0.25);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Right-aligned text, which is the only way a column of money reads. */
function drawRight(
  page: PDFPage,
  text: string,
  right: number,
  y: number,
  font: PDFFont,
  size: number,
  color = INK
) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: right - w, y, size, font, color });
}

/**
 * Cut a string to fit a width, with an ellipsis if it had to.
 *
 * Line descriptions are free text a producer typed. One long enough to run past
 * the amount column would overlap the money, and an invoice where the figures
 * are unreadable is worse than one where a description is abbreviated.
 */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/**
 * The logo, or null.
 *
 * Fetched rather than bundled: Amplify's esbuild step bundles TypeScript, not
 * arbitrary binary assets, and a 17KB PNG inlined as base64 in a source file is
 * a thing nobody wants to read a diff of. Cached for the life of the container,
 * so a warm Lambda fetches once.
 *
 * Null on any failure, and the PDF draws the wordmark as text instead. Sending
 * a bill matters more than the logo being on it, so nothing here is allowed to
 * throw.
 */
let logoCache: Uint8Array | null | undefined;
async function loadLogo(): Promise<Uint8Array | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const res = await fetch(AGENCY_FMT.logoUrl);
    if (!res.ok) throw new Error(`logo fetch returned ${res.status}`);
    logoCache = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.warn("[send-invoice] no logo on the PDF", err);
    logoCache = null;
  }
  return logoCache;
}

export async function renderInvoicePdf(inv: InvoiceView): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(inv.number ? `Invoice ${inv.number}` : "Invoice");
  doc.setAuthor(AGENCY.name);
  doc.setSubject(`Insurance premium for ${inv.associationName}`);
  doc.setProducer(AGENCY.name);

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = M.top;

  /* ── Letterhead ────────────────────────────────────────────────────── */
  const logo = await loadLogo();
  if (logo) {
    try {
      const png = await doc.embedPng(logo);
      // 750x148 native; 200pt wide keeps the aspect ratio honest.
      const w = 200;
      const h = (png.height / png.width) * w;
      page.drawImage(png, { x: M.left, y: y - h + 10, width: w, height: h });
    } catch {
      // A corrupt image must not cost the invoice. Fall through to text.
      page.drawText(AGENCY_FMT.displayName.toUpperCase(), {
        x: M.left, y: y - 4, size: 16, font: fonts.bold, color: NAVY,
      });
    }
  } else {
    page.drawText(AGENCY_FMT.displayName.toUpperCase(), {
      x: M.left, y: y - 4, size: 16, font: fonts.bold, color: NAVY,
    });
  }

  drawRight(page, "INVOICE", M.right, y + 4, fonts.bold, 22, NAVY);
  if (inv.number) {
    drawRight(page, inv.number, M.right, y - 14, fonts.regular, 10.5, MUTED);
  }

  y -= 54;
  page.drawLine({
    start: { x: M.left, y }, end: { x: M.right, y },
    thickness: 2, color: GOLD,
  });

  /* ── Who it is for, and what it is about ───────────────────────────── */
  y -= 26;
  const blockTop = y;
  page.drawText("BILL TO", { x: M.left, y, size: 8, font: fonts.bold, color: MUTED });
  y -= 15;
  page.drawText(fit(inv.associationName, fonts.bold, 12, 250), {
    x: M.left, y, size: 12, font: fonts.bold, color: INK,
  });

  const meta: [string, string][] = [
    ["Issued", formatDay(inv.issuedAt)],
    ["Due", formatDay(inv.dueAt)],
    ["Policy", inv.policyNumber ?? ""],
    ["Carrier", inv.carrierName ?? ""],
    [
      // Abbreviated months here and nowhere else: spelled out, a full term runs
      // past the column and gets cut, and "September 30, 2026 to Septembe…" is
      // worse than a short date that fits.
      "Term",
      inv.effectiveDate && inv.expirationDate
        ? `${formatDayShort(inv.effectiveDate)} to ${formatDayShort(inv.expirationDate)}`
        : "",
    ],
  ].filter(([, v]) => v !== "") as [string, string][];

  /**
   * Left-aligned and wrapped, not right-aligned and cut.
   *
   * Carrier names are long — "Tri-State Insurance Company of Minnesota
   * (Acadia)" does not fit any single-line column at a readable size — and an
   * invoice that truncates the carrier is not one you would send a board.
   */
  const META_LABEL_X = 330;
  const META_VALUE_X = 392;
  const META_VALUE_W = M.right - META_VALUE_X;

  let my = blockTop;
  for (const [k, v] of meta) {
    page.drawText(k, {
      x: META_LABEL_X, y: my, size: 9, font: fonts.regular, color: MUTED,
    });
    // Two lines is enough for every real value and keeps the block from
    // pushing the line items down the page.
    const rows = wrap(v, fonts.bold, 9, META_VALUE_W).slice(0, 2);
    for (const row of rows) {
      page.drawText(fit(row, fonts.bold, 9, META_VALUE_W), {
        x: META_VALUE_X, y: my, size: 9, font: fonts.bold, color: INK,
      });
      my -= 12;
    }
    my -= 2;
  }

  y = Math.min(y, my) - 30;

  /* ── Lines ─────────────────────────────────────────────────────────── */
  const AMOUNT_COL = M.right;
  const DESC_MAX = 330;

  const header = () => {
    page.drawText("DESCRIPTION", {
      x: M.left, y, size: 8, font: fonts.bold, color: MUTED,
    });
    drawRight(page, "AMOUNT", AMOUNT_COL, y, fonts.bold, 8, MUTED);
    y -= 8;
    page.drawLine({
      start: { x: M.left, y }, end: { x: M.right, y },
      thickness: 1, color: RULE,
    });
    y -= 18;
  };
  header();

  const lines = inv.lines.filter(
    (l) => (l.description ?? "").trim() !== "" || (l.retailAmount ?? 0) !== 0
  );

  for (const line of lines) {
    /**
     * A new page rather than a truncated one. An invoice that silently drops
     * lines does not add up to its own total, which is the single most
     * damaging thing this document could do.
     */
    if (y < M.bottom + 90) {
      page = doc.addPage([PAGE.w, PAGE.h]);
      y = M.top;
      header();
    }
    page.drawText(fit((line.description ?? "").trim() || "Premium", fonts.regular, 10.5, DESC_MAX), {
      x: M.left, y, size: 10.5, font: fonts.regular, color: INK,
    });
    drawRight(page, formatMoney(line.retailAmount), AMOUNT_COL, y, fonts.regular, 10.5);
    y -= 10;
    page.drawLine({
      start: { x: M.left, y }, end: { x: M.right, y },
      thickness: 0.5, color: RULE,
    });
    y -= 16;
  }

  /* ── Total, which is the point of the page ─────────────────────────── */
  const total = invoiceTotals(inv.lines).retail;
  y -= 6;
  page.drawRectangle({
    x: 330, y: y - 30, width: M.right - 330, height: 38,
    color: rgb(0.965, 0.973, 0.98),
  });
  page.drawText("AMOUNT DUE", {
    x: 344, y: y - 8, size: 9, font: fonts.bold, color: MUTED,
  });
  drawRight(page, formatMoney(total), M.right - 14, y - 12, fonts.bold, 17, NAVY);

  /* ── Memo and how to pay ───────────────────────────────────────────── */
  y -= 62;
  if (inv.memo?.trim()) {
    for (const chunk of wrap(inv.memo.trim(), fonts.regular, 10, M.right - M.left)) {
      page.drawText(chunk, { x: M.left, y, size: 10, font: fonts.regular, color: MUTED });
      y -= 14;
    }
    y -= 8;
  }

  if (inv.paymentUrl?.trim()) {
    page.drawText("Pay by bank transfer", {
      x: M.left, y, size: 10.5, font: fonts.bold, color: NAVY,
    });
    y -= 14;
    // The URL in full, not a masked link: this is a printed document and a
    // hyperlink nobody can read is no use on paper.
    for (const chunk of wrap(inv.paymentUrl.trim(), fonts.regular, 9, M.right - M.left)) {
      page.drawText(chunk, { x: M.left, y, size: 9, font: fonts.regular, color: MUTED });
      y -= 12;
    }
  }

  /* ── Footer, on every page ─────────────────────────────────────────── */
  for (const p of doc.getPages()) {
    p.drawLine({
      start: { x: M.left, y: M.bottom + 24 }, end: { x: M.right, y: M.bottom + 24 },
      thickness: 0.5, color: RULE,
    });
    p.drawText(
      `${AGENCY.name} · ${AGENCY.addressLine1}, ${AGENCY_FMT.addressLine2}`,
      { x: M.left, y: M.bottom + 12, size: 8, font: fonts.regular, color: MUTED }
    );
    p.drawText(`${AGENCY.phone} · ${AGENCY.email}`, {
      x: M.left, y: M.bottom + 2, size: 8, font: fonts.regular, color: MUTED,
    });
  }

  return doc.save();
}

/** `2026-09-30` → `Sep 30, 2026`. For columns a spelled-out month overflows. */
function formatDayShort(day: string | null | undefined): string {
  const long = formatDay(day);
  if (!long) return "";
  const m = /^([A-Z][a-z]+) (\d{1,2}, \d{4})$/.exec(long);
  return m ? `${m[1].slice(0, 3)} ${m[2]}` : long;
}

/** Greedy word wrap to a pixel width, since pdf-lib draws single lines only. */
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
  // A single unbreakable token longer than the line still has to go somewhere.
  return out.length ? out : [text];
}

/**
 * `INV-2026-00001` → `Invoice-INV-2026-00001.pdf`, safe for a filename.
 *
 * Path separators and quotes are dropped, which is what makes it safe. Runs of
 * dots are collapsed and trimmed as well, which is only tidiness: stripping the
 * slashes out of `../../etc/passwd` leaves `....etcpasswd`, a name that is
 * harmless but is hidden on unix and reads like a bug.
 */
export function pdfFilename(number: string | null | undefined): string {
  const clean = (number ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  return clean ? `Invoice-${clean}.pdf` : "Invoice.pdf";
}
