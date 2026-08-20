import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { formatMoney, invoiceTotals, type LineLike } from "../../../src/lib/invoiceTotals";

/**
 * The emailed invoice. Pure: no SES, no data client.
 *
 * ── What the insured sees, and does not ─────────────────────────────────────
 * Retail only. `costAmount` is on every line and appears nowhere in this file —
 * what the agency remits to the carrier is not the association's business, and
 * an invoice that leaked it would be handing a client the commission rate.
 * There is one test asserting a cost never reaches the output.
 *
 * ── Why the total is the biggest thing on the page ──────────────────────────
 * Not only taste. Massachusetts' 940 CMR 38.00 requires a total price shown
 * more prominently than other pricing information, with enforcement live since
 * September 2025. This agency bills commission inside the premium and charges
 * no separate fee, which is the case those rules bear on least — but "amount
 * due, large, at the top" costs nothing and is the shape the regulation asks
 * for if a fee is ever added.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

export interface InvoiceLineView extends LineLike {
  description?: string | null;
}

export interface InvoiceView {
  number?: string | null;
  associationName: string;
  /** The person it is addressed to, if we know one. */
  contactFirstName?: string | null;
  policyNumber?: string | null;
  carrierName?: string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  issuedAt?: string | null;
  dueAt?: string | null;
  memo?: string | null;
  paymentUrl?: string | null;
  lines: InvoiceLineView[];
}

/** `2026-09-30` → `September 30, 2026`. Anything unparseable passes through. */
export function formatDay(day: string | null | undefined): string {
  if (!day) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return day;
  // Built in UTC and read in UTC: `new Date("2026-09-30")` is midnight UTC, and
  // formatting it in a western timezone would print the 29th.
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  /**
   * The 31st of February rolls forward to the 3rd of March rather than failing,
   * so a stored impossible date would print as a real one. On a due date that
   * is worse than printing the raw string: nobody chases "2026-02-31", but
   * everybody acts on "March 3, 2026". Round-trip and hand back what we were
   * given if it does not survive.
   */
  if (d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) return day;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export interface RenderedInvoice {
  subject: string;
  text: string;
  html: string;
}

export function renderInvoice(inv: InvoiceView): RenderedInvoice {
  const totals = invoiceTotals(inv.lines);
  const due = formatMoney(totals.retail);
  const number = inv.number?.trim() || "";
  const greeting = inv.contactFirstName?.trim()
    ? `Hi ${inv.contactFirstName.trim()},`
    : "Hello,";

  const subject = number
    ? `Invoice ${number} from ${AGENCY_FMT.displayName} — ${due} due`
    : `Invoice from ${AGENCY_FMT.displayName} — ${due} due`;

  const meta: [string, string][] = [
    ["Invoice", number],
    ["Association", inv.associationName],
    ["Policy", inv.policyNumber ?? ""],
    ["Carrier", inv.carrierName ?? ""],
    [
      "Term",
      inv.effectiveDate && inv.expirationDate
        ? `${formatDay(inv.effectiveDate)} to ${formatDay(inv.expirationDate)}`
        : "",
    ],
    ["Issued", formatDay(inv.issuedAt)],
    ["Due", formatDay(inv.dueAt)],
  ].filter(([, v]) => v !== "") as [string, string][];

  const lines = inv.lines.filter(
    (l) => (l.description ?? "").trim() !== "" || (l.retailAmount ?? 0) !== 0
  );

  const text = [
    greeting,
    "",
    `Amount due: ${due}`,
    ...(inv.dueAt ? [`Payable by ${formatDay(inv.dueAt)}.`] : []),
    "",
    ...meta.map(([k, v]) => `${k}: ${v}`),
    "",
    ...lines.map(
      (l) => `  ${(l.description ?? "").trim() || "Premium"}  ${formatMoney(l.retailAmount)}`
    ),
    `  ${"Total".padEnd(0)}  ${due}`,
    ...(inv.memo?.trim() ? ["", inv.memo.trim()] : []),
    ...(inv.paymentUrl?.trim() ? ["", "Pay online:", inv.paymentUrl.trim()] : []),
    "",
    `${AGENCY.name}`,
    `${AGENCY.phone} · ${AGENCY.email}`,
  ].join("\n");

  const font = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
  const pay = inv.paymentUrl?.trim();

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden">

        <tr><td style="padding:24px 28px 0">
          <img src="${AGENCY_FMT.logoUrl}" width="230" height="45" alt="${escapeHtml(AGENCY_FMT.displayName)}" style="display:block;border:0;max-width:100%;height:auto">
        </td></tr>

        <tr><td style="padding:22px 28px 6px">
          <p style="font:400 15px/1.6 ${font};color:#334155;margin:0 0 18px">${escapeHtml(greeting)}</p>
          <!-- The total, larger than anything else on the page. See the note at
               the top of this file for why that is not only a design choice. -->
          <div style="font:400 12px/1.4 ${font};color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin:0 0 2px">Amount due</div>
          <div style="font:800 34px/1.15 ${font};color:#0f172a;margin:0 0 4px">${escapeHtml(due)}</div>
          ${inv.dueAt ? `<div style="font:400 14px/1.5 ${font};color:#64748b;margin:0 0 18px">Payable by ${escapeHtml(formatDay(inv.dueAt))}</div>` : `<div style="height:14px"></div>`}
          ${
            pay
              ? `<a href="${escapeHtml(pay)}" style="display:inline-block;padding:13px 26px;border-radius:6px;background:#e5c16a;color:#1a365d;font:700 15px/1 ${font};text-decoration:none;margin:0 0 6px">Pay this invoice</a>`
              : ""
          }
        </td></tr>

        <tr><td style="padding:14px 28px 0">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e2e8f0;padding-top:14px">
${meta
  .map(
    ([k, v]) =>
      `            <tr><td style="padding:3px 14px 3px 0;font:400 13px/1.5 ${font};color:#64748b;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:3px 0;font:600 13px/1.5 ${font};color:#0f172a">${escapeHtml(v)}</td></tr>`
  )
  .join("\n")}
          </table>
        </td></tr>

        <tr><td style="padding:18px 28px 0">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
            <tr>
              <th align="left" style="padding:0 0 8px;border-bottom:1px solid #e2e8f0;font:600 12px/1.4 ${font};color:#64748b;text-transform:uppercase;letter-spacing:.06em">Description</th>
              <th align="right" style="padding:0 0 8px;border-bottom:1px solid #e2e8f0;font:600 12px/1.4 ${font};color:#64748b;text-transform:uppercase;letter-spacing:.06em">Amount</th>
            </tr>
${lines
  .map(
    (l) =>
      `            <tr><td style="padding:9px 12px 9px 0;font:400 14px/1.5 ${font};color:#334155;border-bottom:1px solid #f1f5f9">${escapeHtml((l.description ?? "").trim() || "Premium")}</td><td align="right" style="padding:9px 0;font:400 14px/1.5 ${font};color:#0f172a;border-bottom:1px solid #f1f5f9;white-space:nowrap">${escapeHtml(formatMoney(l.retailAmount))}</td></tr>`
  )
  .join("\n")}
            <tr><td style="padding:12px 12px 0 0;font:700 15px/1.5 ${font};color:#0f172a">Total</td><td align="right" style="padding:12px 0 0;font:700 15px/1.5 ${font};color:#0f172a;white-space:nowrap">${escapeHtml(due)}</td></tr>
          </table>
        </td></tr>

${
  inv.memo?.trim()
    ? `        <tr><td style="padding:18px 28px 0"><p style="font:400 14px/1.6 ${font};color:#475569;margin:0">${escapeHtml(inv.memo.trim())}</p></td></tr>`
    : ""
}

        <tr><td style="padding:22px 28px 26px">
          <div style="border-top:1px solid #e2e8f0;padding-top:14px;font:400 12.5px/1.7 ${font};color:#94a3b8">
            ${escapeHtml(AGENCY.name)}<br>
            ${escapeHtml(AGENCY.addressLine1)}, ${escapeHtml(AGENCY_FMT.addressLine2)}<br>
            ${escapeHtml(AGENCY.phone)} · <a href="${AGENCY_FMT.emailHref}" style="color:#94a3b8">${escapeHtml(AGENCY.email)}</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
