import { AGENCY } from "../../../../shared/agency";
import { formatMoney } from "../../../src/lib/invoiceTotals";

/**
 * Telling corporate finance how a payment divides.
 *
 * ## Why an email and not a report
 *
 * The money is already in the trust account by the time anyone could run a
 * report, and the reconciliation it feeds is done against bank lines as they
 * arrive. A weekly summary would mean holding a stack of unattributed deposits
 * and working backwards; a message per payment arrives in the same order the
 * bank does, and can simply be filed against the line it matches.
 *
 * ## What the split means
 *
 * Almost none of an insurance payment is revenue. An association pays one
 * figure into trust and most of it is premium owed onward to the carrier — the
 * agency's part is the commission baked into it, and, once in-house financing
 * is offered, the interest on the plan. Three destinations, one deposit, and
 * the CRM is the only system that knows which is which.
 *
 * ## Why the figures are not recomputed here
 *
 * They are read off the invoice, where the send wrote them. A Payment Link's
 * price is fixed when it is minted, so an invoice whose lines were edited after
 * sending would divide an amount nobody paid. See the note on
 * `remittanceCarrierCents` in the schema.
 */

export interface RemittanceMail {
  invoiceNumber: string | null;
  associationName: string | null;
  policyNumber: string | null;
  carrierName: string | null;
  /** Stripe's id, so a figure here can be traced to a payout there. */
  paymentIntentId: string;
  paidAt: string;
  carrierCents: number;
  commissionCents: number;
  interestCents: number;
  totalCents: number;
}

const money = (cents: number) => formatMoney(cents / 100);

/** `INV-2026-00042`, or something that still identifies the row. */
const label = (m: RemittanceMail) => m.invoiceNumber ?? m.paymentIntentId;

/**
 * The general ledger accounts each share posts to.
 *
 * Codes and names exactly as they appear in the corporate chart of accounts,
 * so this email can be read straight into a journal entry rather than
 * translated first. Translation is where the error would be: "commission" and
 * "interest" are both agency income and someone working from a description
 * alone will eventually post one to the other, which is a misstatement nobody
 * catches until a reconciliation fails.
 *
 * 224000 is a liability — premium held in trust and owed onward — while 470000
 * and 710000 are income. That is the distinction the email exists to make, and
 * the codes make it in the reader's own vocabulary.
 *
 * If a code changes in the corporate books it changes here; there is no lookup,
 * because a wrong-but-plausible account number is worse than an obvious gap.
 */
const ACCOUNTS = {
  carrier: { code: "224000", name: "Premiums Payable to Carriers" },
  commission: { code: "470000", name: "Insurance Commissions - Income" },
  interest: { code: "710000", name: "Interest earned" },
} as const;

/**
 * The rows of the split, in the order they are read.
 *
 * Carrier first because it is the largest and the one with a deadline attached
 * — premium owed onward has a due date to the carrier that the agency's own
 * income does not.
 */
function rows(m: RemittanceMail): [string, string, number][] {
  return [
    [ACCOUNTS.carrier.code, ACCOUNTS.carrier.name, m.carrierCents],
    [ACCOUNTS.commission.code, ACCOUNTS.commission.name, m.commissionCents],
    [ACCOUNTS.interest.code, ACCOUNTS.interest.name, m.interestCents],
  ];
}

/**
 * A line of detail, or nothing.
 *
 * Unknown values are omitted rather than printed as "—", the same rule the PDF
 * follows: a blank tells finance the CRM has a gap, an absent row tells them
 * nothing, and an invoice for a broker fee has no policy number to give.
 */
function facts(m: RemittanceMail): [string, string][] {
  return [
    ["Invoice", m.invoiceNumber ?? ""],
    ["Association", m.associationName ?? ""],
    ["Policy", m.policyNumber ?? ""],
    ["Carrier", m.carrierName ?? ""],
    ["Paid", m.paidAt],
    ["Stripe payment", m.paymentIntentId],
  ].filter(([, v]) => v.trim() !== "") as [string, string][];
}

export function remittanceSubject(m: RemittanceMail): string {
  const who = m.associationName ? ` · ${m.associationName}` : "";
  return `Payment received ${money(m.totalCents)} — ${label(m)}${who}`;
}

export function remittanceText(m: RemittanceMail): string {
  const width = 22;
  const detail = facts(m)
    .map(([k, v]) => `${`${k}:`.padEnd(width)}${v}`)
    .join("\n");
  /**
   * Columns, so this reads as a ledger rather than as prose with numbers in it.
   *
   * The names pad to the widest of them and the figures pad from the left to
   * the widest of those — right-aligned, which is the only way a column of
   * money lines up on its decimal in a fixed-width client. `$25,000.00` and
   * `$0.00` starting in the same place do not.
   */
  const nameWidth = Math.max(...rows(m).map(([, name]) => name.length)) + 2;
  const moneyWidth = Math.max(
    ...rows(m).map(([, , cents]) => money(cents).length),
    money(m.totalCents).length
  );
  const split = rows(m)
    .map(
      ([code, name, cents]) =>
        `${code}  ${name.padEnd(nameWidth)}${money(cents).padStart(moneyWidth)}`
    )
    .join("\n");
  return [
    `A payment cleared into the trust account and divides as follows.`,
    "",
    detail,
    "",
    split,
    `${"".padEnd(6)}  ${"Total collected".padEnd(nameWidth)}${money(
      m.totalCents
    ).padStart(moneyWidth)}`,
    "",
    // Said plainly, because the whole point of the message is that the deposit
    // is not revenue and the larger part of it is spoken for.
    `The carrier remittance is owed onward and is not agency income.`,
    "",
    `${AGENCY.name} · sent automatically when Stripe confirmed the payment.`,
  ].join("\n");
}

export function remittanceHtml(m: RemittanceMail): string {
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const detail = facts(m)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:3px 16px 3px 0;color:#64748b;font-size:13px;white-space:nowrap">${esc(
          k
        )}</td><td style="padding:3px 0;font-size:13px">${esc(v)}</td></tr>`
    )
    .join("");

  const cell = "padding:7px 0;border-bottom:1px solid #e2e8f0;font-size:14px";
  const split = rows(m)
    .map(
      ([code, name, cents]) =>
        `<tr><td style="${cell};color:#64748b;font-variant-numeric:tabular-nums;padding-right:14px;white-space:nowrap">${esc(
          code
        )}</td><td style="${cell}">${esc(
          name
        )}</td><td style="${cell};text-align:right;white-space:nowrap">${money(
          cents
        )}</td></tr>`
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#f4f6f9;font-family:Segoe UI,system-ui,-apple-system,sans-serif;color:#1c2634">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#64748b">Payment received</p>
<p style="margin:0 0 18px;font-size:26px;font-weight:700;color:#142a4c">${money(m.totalCents)}</p>
<table style="border-collapse:collapse;margin-bottom:20px">${detail}</table>
<table style="width:100%;border-collapse:collapse">
<tr><th style="text-align:left;padding:0 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;border-bottom:2px solid #142a4c">Account</th><th colspan="2" style="text-align:left;padding:0 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;border-bottom:2px solid #142a4c">Split</th></tr>
${split}
<tr><td style="padding:9px 0"></td><td style="padding:9px 0;font-size:15px;font-weight:700">Total collected</td><td style="padding:9px 0;font-size:15px;font-weight:700;text-align:right">${money(
    m.totalCents
  )}</td></tr>
</table>
<p style="margin:18px 0 0;font-size:13px;color:#64748b">The carrier remittance is owed onward and is not agency income.</p>
<p style="margin:16px 0 0;font-size:11px;color:#94a3b8">${esc(
    AGENCY.name
  )} · sent automatically when Stripe confirmed the payment.</p>
</div></body></html>`;
}
