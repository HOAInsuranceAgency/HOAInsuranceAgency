import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { formatMoney, invoiceTotals } from "../../../src/lib/invoiceTotals";
import { formatDay, invoiceTerms, type InvoiceView } from "./invoice";

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
/** Panel fills. Light enough to survive a monochrome office printer. */
const PANEL = rgb(0.973, 0.976, 0.984);
const TINT = rgb(0.898, 0.929, 0.965);

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
  let y: number = M.top;

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

  // The agency's own address, under the wordmark where a letterhead puts it.
  // It was only in the footer, which is where a reader looks last and where a
  // cheque-writer does not look at all.
  let ly = y - 46;
  for (const row of [
    AGENCY.addressLine1,
    AGENCY_FMT.addressLine2,
    `${AGENCY.phone} | ${AGENCY.email} | ${AGENCY.siteLabel}`,
  ]) {
    page.drawText(row, { x: M.left, y: ly, size: 8, font: fonts.regular, color: MUTED });
    ly -= 10;
  }

  drawRight(page, "INVOICE", M.right, y + 4, fonts.bold, 22, NAVY);

  /**
   * The four facts a treasurer reads before anything else: which invoice, when
   * it was raised, when it is due, and on what terms. Stacked as label/value
   * pairs rather than one line of number, because that is the block an
   * accounts-payable clerk copies into their system.
   */
  let hy = y - 18;
  for (const [k, v] of [
    ["Invoice No.:", inv.number ?? ""],
    ["Invoice Date:", formatDayShort(inv.issuedAt)],
    ["Due Date:", formatDayShort(inv.dueAt)],
    ["Terms:", invoiceTerms(inv.issuedAt, inv.dueAt)],
  ] as [string, string][]) {
    if (!v) continue;
    const value = fit(v, fonts.bold, 9, 130);
    const vw = fonts.bold.widthOfTextAtSize(value, 9);
    page.drawText(value, {
      x: M.right - vw, y: hy, size: 9, font: fonts.bold, color: INK,
    });
    drawRight(page, k, M.right - vw - 5, hy, fonts.regular, 9, MUTED);
    hy -= 13;
  }

  y = Math.min(ly, hy) - 12;
  /**
   * Navy running into gold, the way the website's rules do. Two rectangles
   * rather than one line so the proportion is deliberate rather than whatever
   * a dashed stroke happens to produce.
   */
  const SPLIT = M.left + (M.right - M.left) * 0.72;
  page.drawRectangle({ x: M.left, y, width: SPLIT - M.left, height: 3, color: NAVY });
  page.drawRectangle({ x: SPLIT, y, width: M.right - SPLIT, height: 3, color: GOLD });

  /* ── Who it is for, and what it is about ───────────────────────────── */
  /**
   * Two panels side by side: the envelope on the left, the placement on the
   * right. Boxed and filled, because these are reference details someone
   * returns to rather than prose they read once — and a bordered block is what
   * makes them findable on a page that has been photocopied twice.
   *
   * Both are measured before either is drawn. They share a height, so the pair
   * reads as one band rather than two ragged columns, and the height is
   * whichever side has more to say.
   */
  y -= 20;
  const panelTop = y;
  const GAP = 12;
  const MID = M.left + (M.right - M.left) * 0.5 - GAP / 2;
  const leftInner = { x: M.left + 12, w: MID - M.left - 24 };
  const rightInner = { x: MID + GAP + 12, w: M.right - MID - GAP - 24 };

  const billTo: string[] = [
    ...wrap(inv.associationName, fonts.bold, 10, leftInner.w),
    ...(inv.billToLines ?? []).flatMap((l) => wrap(l, fonts.regular, 9, leftInner.w)),
  ];

  /**
   * Only what is known. A row reading "Policy Number: —" tells a reader the
   * system has a gap; leaving it out tells them nothing, which is correct,
   * because an invoice for a broker fee genuinely has no policy number.
   */
  const placement: [string, string][] = [
    ["Coverage", inv.coverage ?? ""],
    ["Policy Number", inv.policyNumber ?? ""],
    ["Insurer", inv.carrierName ?? ""],
    [
      "Policy Term",
      inv.effectiveDate && inv.expirationDate
        ? `${formatDayShort(inv.effectiveDate)} - ${formatDayShort(inv.expirationDate)}`
        : "",
    ],
    ["Risk Location", (inv.riskLocation ?? []).join(", ")],
  ].filter(([, v]) => v.trim() !== "") as [string, string][];

  const placementRows = placement.flatMap(([k, v]) =>
    wrap(`${k}: ${v}`, fonts.regular, 9, rightInner.w)
  );

  const panelH = Math.max(
    26 + billTo.length * 12,
    16 + placementRows.length * 12,
    64
  );

  page.drawRectangle({
    x: M.left, y: panelTop - panelH, width: MID - M.left, height: panelH,
    color: PANEL, borderColor: RULE, borderWidth: 0.75,
  });
  page.drawRectangle({
    x: MID + GAP, y: panelTop - panelH, width: M.right - MID - GAP, height: panelH,
    color: PANEL, borderColor: RULE, borderWidth: 0.75,
  });

  let by = panelTop - 16;
  page.drawText("BILL TO", {
    x: leftInner.x, y: by, size: 8, font: fonts.bold, color: MUTED,
  });
  by -= 14;
  for (const [i, row] of billTo.entries()) {
    // The first line is the insured's name and is the one a filing clerk reads.
    const isName = i < wrap(inv.associationName, fonts.bold, 10, leftInner.w).length;
    page.drawText(row, {
      x: leftInner.x, y: by,
      size: isName ? 10 : 9,
      font: isName ? fonts.bold : fonts.regular,
      color: isName ? INK : MUTED,
    });
    by -= 12;
  }

  let ry = panelTop - 16;
  for (const row of placementRows) {
    page.drawText(row, {
      x: rightInner.x, y: ry, size: 9, font: fonts.regular, color: INK,
    });
    ry -= 12;
  }

  y = panelTop - panelH - 24;

  /* ── Lines ─────────────────────────────────────────────────────────── */
  const AMOUNT_COL = M.right - 12;
  const DESC_MAX = 380;
  const ROW_H = 26;

  const header = () => {
    page.drawRectangle({
      x: M.left, y: y - 8, width: M.right - M.left, height: 22, color: TINT,
    });
    page.drawText("Description", {
      x: M.left + 12, y, size: 8.5, font: fonts.bold, color: NAVY,
    });
    drawRight(page, "Amount", AMOUNT_COL, y, fonts.bold, 8.5, NAVY);
    y -= 8 + 20;
  };
  y -= 6;
  header();

  const lines = inv.lines.filter(
    (l) => (l.description ?? "").trim() !== "" || (l.retailAmount ?? 0) !== 0
  );

  for (const [i, line] of lines.entries()) {
    /**
     * A new page rather than a truncated one. An invoice that silently drops
     * lines does not add up to its own total, which is the single most
     * damaging thing this document could do. The reserve is larger now, so a
     * break cannot land between the last line and the total it belongs to.
     */
    if (y < M.bottom + 120) {
      page = doc.addPage([PAGE.w, PAGE.h]);
      y = M.top;
      header();
    }
    // Banded, so the eye carries across a wide row from a description on the
    // left to a figure on the right without a leader dot.
    if (i % 2 === 1) {
      page.drawRectangle({
        x: M.left, y: y - 9, width: M.right - M.left, height: ROW_H,
        color: rgb(0.984, 0.988, 0.992),
      });
    }
    page.drawText(
      fit((line.description ?? "").trim() || "Premium", fonts.regular, 10, DESC_MAX),
      { x: M.left + 12, y, size: 10, font: fonts.regular, color: INK }
    );
    drawRight(page, formatMoney(line.retailAmount), AMOUNT_COL, y, fonts.regular, 10);
    page.drawLine({
      start: { x: M.left, y: y - 9 }, end: { x: M.right, y: y - 9 },
      thickness: 0.5, color: RULE,
    });
    y -= ROW_H;
  }

  /* ── Total, which is the point of the page ─────────────────────────── */
  const total = invoiceTotals(inv.lines).retail;
  y -= 6;
  const TOTAL_LEFT = 360;
  page.drawLine({
    start: { x: TOTAL_LEFT, y: y + 12 }, end: { x: M.right, y: y + 12 },
    thickness: 1.5, color: NAVY,
  });
  page.drawText("TOTAL DUE", {
    x: TOTAL_LEFT, y: y - 6, size: 10, font: fonts.bold, color: NAVY,
  });
  drawRight(page, formatMoney(total), AMOUNT_COL, y - 8, fonts.bold, 15, NAVY);
  y -= 40;

  /* ── How to pay, and what this document is not ─────────────────────── */
  /**
   * Both blocks are drawn on the last page and both need room. If what is left
   * cannot hold them they move to a page of their own rather than being split
   * across a break — payment instructions with the address on one page and the
   * account details on the next is how money goes to the wrong place.
   */
  const needed = 190 + (inv.memo?.trim() ? 26 : 0);
  if (y - needed < M.bottom + 30) {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = M.top;
  }

  y = drawStatementBox(page, fonts, {
    title: "PAYMENT INSTRUCTIONS",
    left: M.left,
    right: M.right,
    top: y,
    emphasis: true,
    body: [
      `Make checks payable to ${AGENCY.name} and mail to:`,
      `${AGENCY.addressLine1}, ${AGENCY_FMT.addressLine2}`,
      ...(inv.paymentUrl?.trim()
        ? [
            // In full, not as a masked link: this is a printed document, and a
            // hyperlink nobody can read is no use on paper.
            `To pay by bank transfer, visit ${inv.paymentUrl.trim()}`,
          ]
        : [
            `For secure ACH or electronic payment instructions, contact ${AGENCY.email} or ${AGENCY.phone}.`,
          ]),
      inv.number
        ? `Please reference invoice ${inv.number} and the named insured with payment.`
        : "Please reference the named insured with payment.",
      // Business email compromise is the fraud this document is a vector for:
      // an intercepted invoice with altered remittance details is the standard
      // form of it, and the only defence a paper bill can carry is a printed
      // instruction to phone before acting on a change.
      "Fraud prevention: verify any change to payment instructions by calling the agency before sending funds.",
    ],
  });

  y -= 14;
  drawStatementBox(page, fonts, {
    title: "IMPORTANT NOTES",
    left: M.left,
    right: M.right,
    top: y,
    bullets: true,
    body: [
      ...(inv.memo?.trim() ? [inv.memo.trim()] : []),
      ...(inv.effectiveDate
        ? [`Coverage was bound effective ${formatDay(inv.effectiveDate)}.`]
        : []),
      // The disclaimer this document must always carry: an invoice is evidence
      // of a debt, and a treasurer who reads its policy block as the terms of
      // their coverage has been misled by us rather than by their carrier.
      "This invoice is not a binder or policy and does not amend the terms, conditions, limits, or exclusions of coverage.",
    ],
  });

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

/**
 * A labelled block of statements in a box — payment instructions, and the
 * notes under them.
 *
 * Boxed rather than run on as paragraphs because both are read by someone
 * looking for one specific thing: where to send a cheque, or what they are
 * being told about cancellation. A wall of small print is where those go to be
 * missed, and the fraud-prevention line in particular is only worth printing if
 * it is seen.
 *
 * Returns the y it finished at, so the caller stacks without measuring.
 */
function drawStatementBox(
  page: PDFPage,
  fonts: Fonts,
  opts: {
    title: string;
    body: string[];
    top: number;
    left: number;
    right: number;
    /** Tinted with a navy spine, for the block that must not be skimmed past. */
    emphasis?: boolean;
    /**
     * Prefix each statement with a dash and hang its wrapped continuation.
     *
     * For the notes, which are a list of separate assertions — earned premium,
     * what the bill covers, what the document is not. Run together as
     * paragraphs they read as one long caveat and the individual terms stop
     * being visible, which matters when one of them is "no flat cancellations".
     */
    bullets?: boolean;
  }
): number {
  const { title, body, top, left, right, emphasis, bullets } = opts;
  const innerLeft = left + 12;
  const width = right - innerLeft - 12;
  const HANG = 9;

  // Measured before drawing: the fill has to be behind the text, and its
  // height is only known once the body has been wrapped.
  const rows: { text: string; indent: number }[] = body.flatMap((para) => {
    if (!bullets) {
      return wrap(para, fonts.regular, 8.5, width).map((text) => ({ text, indent: 0 }));
    }
    const wrapped = wrap(para, fonts.regular, 8.5, width - HANG);
    return wrapped.map((text, i) => ({
      text: i === 0 ? `- ${text}` : text,
      indent: i === 0 ? 0 : HANG,
    }));
  });
  const height = 18 + rows.length * 11 + 10;

  page.drawRectangle({
    x: left, y: top - height, width: right - left, height,
    color: emphasis ? TINT : rgb(1, 1, 1),
    borderColor: emphasis ? NAVY : RULE,
    borderWidth: emphasis ? 0 : 0.75,
  });
  if (emphasis) {
    // The spine, drawn over the fill's left edge.
    page.drawRectangle({ x: left, y: top - height, width: 3, height, color: NAVY });
  }

  let y = top - 16;
  page.drawText(title, { x: innerLeft, y, size: 8, font: fonts.bold, color: NAVY });
  y -= 13;
  for (const row of rows) {
    page.drawText(row.text, {
      x: innerLeft + row.indent, y, size: 8.5, font: fonts.regular, color: INK,
    });
    y -= 11;
  }
  return top - height;
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
