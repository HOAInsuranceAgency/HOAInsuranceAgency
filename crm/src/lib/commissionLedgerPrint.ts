import { commissionLogo } from '../../../shared/commissionBrand';
import type { DashboardReport, ReportSnapshot, ReportValue } from './reportDownload';

export interface CommissionLedgerSummary {
  scope: string;
  agencyReceivedCents: number;
  earnedCents: number;
  paidCents: number;
  proposedPaidRecoveryCents: number;
  unpaidAdjustmentCents: number;
  partialAdjustmentCents: number;
}
const text = (value: ReportValue) => value == null ? '' : String(value);
const escape = (value: ReportValue) => text(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (cents: number) => escape((cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const amount = (value: ReportValue) => typeof value === 'number' ? money(Math.round(value * 100)) : '—';
const percent = (value: ReportValue) => typeof value === 'number' ? escape(value) + '%' : '—';
const date = (value: ReportValue) => /^\d{4}-\d{2}-\d{2}$/.test(text(value))
  ? escape(new Date(text(value) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))
  : escape(value);
const line = (value: ReportValue, className = 'detail') => text(value) ? '<span class="' + className + '">' + escape(value) + '</span>' : '';
const badge = (value: ReportValue) => '<span class="badge">' + escape(value) + '</span>';

/** Shares the approved payroll PDF branding. Grouped columns retain all source fields.
 * Totals come from the ledger calculation, never by subtracting proposed reversals.
 */
export function commissionLedgerHtml(report: DashboardReport, snapshot: ReportSnapshot): string {
  const summary = report.commissionLedger!;
  const transactions = report.sections[0]?.rows ?? [];
  const earnings = report.sections[1]?.rows ?? [];
  const at = snapshot.asOf.toLocaleString('en-US', {
    timeZone: snapshot.timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const brandHeader = '<header class="brand-header"><img src="data:image/png;base64,' + commissionLogo + '" alt="HOA Insurance Agency"><div><strong>COMMISSION LEDGER</strong><span>420 Lakeside Ave, Suite 202</span><span>Marlborough, MA 01752</span></div></header>';
  const receiptRows = transactions.map(r => {
    const shared = text(r[4]).includes('shared allocation');
    return '<tr><td><strong>' + escape(r[1]) + '</strong>' + line(r[2], 'policy') + line(r[0]) + '</td>'
      + '<td><strong>' + date(r[3]) + '</strong>' + line(r[4]) + line(r[5]) + '</td>'
      + '<td class="number">' + amount(r[6]) + '</td>'
      + '<td class="number">' + (shared ? '<span class="shared-note">See employee allocations</span>' : '<strong>' + amount(r[8]) + '</strong><span class="detail">' + percent(r[7]) + ' frozen rate</span>') + '</td>'
      + '<td>' + (r[9] ? escape(r[9]) : '<span class="muted">Not assigned</span>') + '</td></tr>';
  }).join('');
  const earningRows = earnings.map(r => '<tbody class="allocation-group"><tr><td><strong>' + escape(r[0]) + '</strong>' + line(r[1]) + line(r[2], 'policy') + '</td>'
    + '<td><strong>' + date(r[3]) + '</strong>' + line(text(r[4]).replaceAll('_', ' ')) + (typeof r[5] === 'number' ? '<span class="detail">' + percent(r[5]) + ' share × ' + percent(r[6]) + ' plan rate</span>' : '') + '</td>'
    + '<td class="number"><strong>' + amount(r[7]) + '</strong></td>'
    + '<td>' + badge(r[8]) + line(r[9] || 'Unallocated') + '</td></tr>'
    + '<tr class="reference-row"><td colspan="4"><span>Source receipt / adjustment</span> ' + escape(r[11]) + '<br><span>Earning ID</span> ' + escape(r[10]) + '</td></tr></tbody>').join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escape(report.title) + '</title><style>'
    + ledgerCss + '</style></head><body>'
    + '<div class="print-toolbar"><div><strong>Commission ledger</strong><span>Letter paper · Save as PDF · All displayed records</span></div><button type="button" onclick="window.print()">Print / save PDF</button></div>'
    + '<main class="document">' + (snapshot.isTest ? '<div class="watermark" aria-hidden="true">TEST DATA</div><div class="test-banner"><strong>TEST DATA — DO NOT PAY</strong><span>Fictional records for visual review</span></div>' : '')
    + brandHeader
    + '<div class="title-row"><span class="eyebrow">EARNINGS &amp; AGENCY RECEIPTS</span>' + badge('LEDGER SNAPSHOT') + '</div><h1>' + escape(report.title) + '</h1><p class="subtitle">Actual receipts, frozen rates, and recorded employee earnings.</p>'
    + '<div class="facts"><div><span>DATA AS OF</span><strong>' + escape(at) + '</strong><small>' + escape(snapshot.timezone) + '</small></div><div><span>REPORT SCOPE</span><strong>' + escape(summary.scope) + '</strong><small>Amounts in USD</small></div></div>'
    + '<section class="amount-panel" aria-label="Ledger totals"><div class="primary-amount"><span>RECORDED EMPLOYEE EARNINGS</span><strong>' + money(summary.earnedCents) + '</strong><small>Includes payable shared allocations</small></div><dl><div><dt>Agency received</dt><dd>' + money(summary.agencyReceivedCents) + '</dd></div><div><dt>Recorded paid</dt><dd>' + money(summary.paidCents) + '</dd></div><div><dt>Unpaid earnings</dt><dd>' + money(summary.earnedCents - summary.paidCents) + '</dd></div></dl></section>'
    + '<aside class="notice"><strong>Ledger review only · Not a payroll approval</strong><p>Proposed adjustments do not reduce the earnings shown above. Payment requires a separately approved payroll report.</p><div class="adjustments"><span>Unpaid adjustments <b>' + money(summary.unpaidAdjustmentCents) + '</b></span><span>Partially paid <b>' + money(summary.partialAdjustmentCents) + '</b></span><span>Proposed paid recoveries <b>' + money(summary.proposedPaidRecoveryCents) + '</b></span></div></aside>'
    + '<section class="report-section"><div class="section-heading"><span>01</span><h2>Agency receipts &amp; transactions</h2><small>' + transactions.length + ' ' + (transactions.length === 1 ? 'row' : 'rows') + '</small></div><p class="section-note">Agency cash is recorded once. Reversals remain separate proposed adjustments.</p>'
    + '<table class="transactions"><colgroup><col style="width:28%"><col style="width:23%"><col style="width:15%"><col style="width:19%"><col style="width:15%"></colgroup><thead><tr><th>Account / policy / producer</th><th>Receipt date / type</th><th class="number">Agency amount</th><th class="number">Producer amount / rate</th><th>Payment batch</th></tr></thead><tbody>' + (receiptRows || '<tr><td colspan="5">No matching records.</td></tr>') + '</tbody></table></section>'
    + '<section class="report-section allocations"><div class="continuation">' + brandHeader + '<p>Producer commission ledger · Continued · ' + escape(at) + '</p></div><div class="section-heading"><span>02</span><h2>Employee earnings allocations</h2><small>' + earnings.length + ' ' + (earnings.length === 1 ? 'row' : 'rows') + '</small></div><p class="section-note">Shared commissions and compensation adjustments. These rows do not add to agency cash.</p><table><colgroup><col style="width:29%"><col style="width:32%"><col style="width:17%"><col style="width:22%"></colgroup><thead><tr><th>Employee / account / policy</th><th>Date / source / calculation</th><th class="number">Employee amount</th><th>Status / payment batch</th></tr></thead>' + (earningRows || '<tbody><tr><td colspan="4">No matching records.</td></tr></tbody>') + '</table></section>'
    + '<footer><span>HOA Insurance Agency · Private commission ledger</span><span>Snapshot ' + escape(snapshot.asOf.toISOString()) + '</span></footer></main></body></html>';
}

const ledgerCss = String.raw`
@page{size:Letter;margin:14mm}
*{box-sizing:border-box}
body{margin:0;background:#eef2f6;color:#101a2b;font:13px/1.45 Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.print-toolbar{max-width:816px;margin:24px auto 16px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 4px;color:#1b3658}
.print-toolbar strong,.print-toolbar span{display:block}.print-toolbar span{font-size:12px;color:#526683;margin-top:3px}
button{border:0;border-radius:6px;background:#1b3658;color:#fff;font:700 13px Arial,sans-serif;padding:12px 18px;cursor:pointer;white-space:nowrap}
button:focus-visible{outline:3px solid #d6a845;outline-offset:3px}
.document{position:relative;isolation:isolate;max-width:816px;margin:0 auto 30px;padding:42px 44px;background:#fff;border:1px solid #d4deeb;border-radius:8px;box-shadow:0 5px 20px #1b36580b}
.watermark{position:fixed;top:45%;left:50%;transform:translate(-50%,-50%) rotate(-32deg);font-size:90px;font-weight:700;color:rgba(190,51,51,.045);z-index:-1;pointer-events:none;white-space:nowrap}
.test-banner{display:flex;justify-content:space-between;gap:10px;background:#fff6f6;border:1px solid #ffbdbd;padding:7px 10px;color:#a52324;font-size:9px;margin-bottom:18px}
.brand-header{display:flex;justify-content:space-between;align-items:center;gap:20px;position:relative;border-bottom:1px solid #d4deeb;padding-bottom:18px;margin-bottom:24px}
.brand-header:after{content:"";position:absolute;bottom:-1px;left:0;width:86px;height:3px;background:#d6a845}
.brand-header img{width:221px;height:auto;max-width:43%}.brand-header div{text-align:right;font-size:10px;color:#526683}.brand-header span,.brand-header strong{display:block}.brand-header strong{font-size:9px;letter-spacing:1.2px;color:#a66e0a;margin-bottom:6px}
.title-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.eyebrow{font-size:9px;font-weight:700;letter-spacing:1.1px;color:#a66e0a}
h1{font-size:27px;line-height:1.2;margin:12px 0 7px;color:#1b3658}p{margin:0}.subtitle{color:#526683;font-size:13px;margin-bottom:19px}
.badge{display:inline-block;border:1px solid #d4deeb;background:#f7f9fb;border-radius:20px;padding:3px 8px;color:#1b3658;font-size:8px;letter-spacing:.35px;font-weight:700;max-width:100%;overflow-wrap:anywhere}
.facts{display:grid;grid-template-columns:1fr 1fr;border:1px solid #d4deeb;border-radius:6px;margin-bottom:14px}.facts>div{padding:12px 14px}.facts>div+div{border-left:1px solid #d4deeb}.facts span,.facts strong,.facts small{display:block}.facts span{font-size:9px;letter-spacing:.7px;color:#526683;font-weight:700;margin-bottom:5px}.facts strong{font-size:12px;color:#1b3658}.facts small{font-size:10px;color:#526683;margin-top:3px}
.amount-panel{display:flex;justify-content:space-between;gap:22px;background:#1b3658;border-radius:8px;color:white;padding:20px 22px;margin-bottom:16px;break-inside:avoid}.primary-amount span,.primary-amount strong,.primary-amount small{display:block}.primary-amount span{color:#e2ba62;font-size:9px;letter-spacing:.6px;font-weight:700}.primary-amount strong{font-size:36px;line-height:1.2;margin:5px 0}.primary-amount small{font-size:10px;color:#dbe8f7}
dl{margin:0;min-width:210px;align-self:center}dl>div{display:flex;justify-content:space-between;gap:20px;margin:7px 0;font-size:11px}dt{color:#dbe8f7}dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}
.notice{background:#f7f9fb;border:1px solid #d4deeb;border-left:3px solid #d6a845;border-radius:5px;padding:12px 14px;margin-bottom:23px;break-inside:avoid}.notice>strong{font-size:11px;color:#1b3658}.notice p{font-size:10px;color:#526683;margin-top:5px}.adjustments{display:flex;gap:12px;justify-content:space-between;font-size:9px;color:#526683;margin-top:10px;padding-top:8px;border-top:1px solid #d4deeb}.adjustments b{display:block;margin-top:2px;color:#1b3658;font-size:11px;font-variant-numeric:tabular-nums}
.continuation{display:none}.report-section{margin-top:24px}.section-heading{display:flex;align-items:baseline;gap:10px;break-after:avoid}.section-heading>span{color:#d6a845;font-size:21px;font-weight:700}.section-heading h2{font-size:15px;line-height:1.3;color:#1b3658;margin:0}.section-heading small{margin-left:auto;color:#526683;font-size:10px;white-space:nowrap}.section-note{color:#526683;font-size:10px;margin:4px 0 11px;break-after:avoid}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11px}
thead{display:table-header-group}
th{font-size:8px;letter-spacing:.4px;text-transform:uppercase;color:#526683;background:#f7f9fb;text-align:left;border-top:1px solid #d4deeb}
th,td{padding:10px 9px;border-bottom:1px solid #d4deeb;vertical-align:top;overflow-wrap:anywhere}
tr,.allocation-group{break-inside:avoid}td>strong{color:#1b3658}.number{text-align:right;font-variant-numeric:tabular-nums}.detail,.policy{display:block;color:#526683;font-size:10px;margin-top:4px}.policy{font-weight:700;color:#1b3658}.shared-note{font-size:10px;color:#526683}.muted{color:#526683}
.reference-row td{background:#fafbfd;font-size:8px;color:#526683;padding-top:7px;padding-bottom:8px;overflow-wrap:anywhere}.reference-row span{font-weight:700;color:#1b3658;margin-right:5px}
footer{border-top:1px solid #d4deeb;display:flex;justify-content:space-between;gap:14px;margin-top:28px;padding-top:12px;font-size:8px;color:#526683}
@media(max-width:600px){.print-toolbar{margin:14px 12px}.print-toolbar span{max-width:170px}.document{margin:0;border-radius:0;padding:24px 18px}.test-banner span{display:none}h1{font-size:23px}.amount-panel{flex-direction:column;gap:12px}dl{width:100%}.brand-header div{font-size:8px}.brand-header strong{font-size:8px}.section-heading h2{font-size:13px}th,td{padding:8px 5px}footer{flex-direction:column;gap:4px}}
@media print{body{background:white}.continuation{display:block;margin-bottom:18px}.continuation .brand-header{margin-bottom:10px}.continuation p{font-size:10px;color:#526683}.print-toolbar{display:none}.document{max-width:none;padding:0;margin:0;border:0;border-radius:0;box-shadow:none}.allocations{break-before:page;margin-top:0}.brand-header{break-inside:avoid}.watermark{font-size:88px}footer{break-inside:avoid}}
`;
