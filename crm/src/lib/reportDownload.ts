export type ReportValue = string | number | null | undefined;
export interface ReportSection { title: string; columns: string[]; rows: ReportValue[][] }
export interface DashboardReport { title: string; filters?: string; sections: ReportSection[] }
export interface ReportSnapshot { asOf: Date; timezone: string }
const text = (value: ReportValue) => value == null ? "" : String(value);
export function csvCell(value: ReportValue): string {
  let s = text(value);
  // Quoting alone does not prevent spreadsheet formula execution. Numeric
  // negative amounts remain numeric; untrusted text is explicitly literal.
  if (typeof value === "string" && (/^[\s\uFEFF]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s))) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function reportCsv(report: DashboardReport, snapshot: ReportSnapshot): string {
  const meta = [report.title, report.filters ?? "All displayed data", snapshot.asOf.toISOString(), snapshot.timezone];
  return "\uFEFF" + report.sections.map(section => [
    ["Report", "Filters", "Data as of (UTC)", "Display time zone", "Section", ...section.columns],
    ...(section.rows.length ? section.rows.map(row => [...meta, section.title, ...row]) : [[...meta, section.title, "No matching records"]]),
  ].map(row => row.map(csvCell).join(",")).join("\r\n")).join("\r\n\r\n") + "\r\n";
}
const escape = (value: ReportValue) => text(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Native print preserves Unicode names and paginates every row. */
export function reportHtml(report: DashboardReport, snapshot: ReportSnapshot): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(report.title)}</title><style>
  @page{size:landscape;margin:16mm}*{box-sizing:border-box}body{font:13px/1.5 Arial,sans-serif;color:#142d4e;margin:32px}header{border-bottom:3px solid #c3a566;padding-bottom:18px;margin-bottom:24px}h1{font-size:26px;margin:5px 0}h2{font-size:17px;margin-top:28px}p{margin:4px 0;color:#53657a}.brand{font-size:11px;text-transform:uppercase;letter-spacing:2px}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:12px 0 24px}th{text-align:left;background:#edf2f8;font-size:11px}th,td{padding:8px;border-bottom:1px solid #dce3ed;overflow-wrap:anywhere;vertical-align:top}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}.print-help{background:#edf2f8;padding:12px;margin-bottom:20px}button{padding:8px 14px;cursor:pointer}@media print{body{margin:0}.print-help{display:none}}
  </style></head><body><div class="print-help"><button onclick="window.print()">Print / save PDF</button> Choose “Save as PDF” in the print destination.</div><header><div class="brand">HOA Insurance Agency · Dashboard report</div><h1>${escape(report.title)}</h1><p>${escape(report.filters ?? "All displayed data")}</p><p>Data as of ${escape(snapshot.asOf.toLocaleString())} · ${escape(snapshot.timezone)} · Amounts in USD</p></header>${report.sections.map(section => `<section><h2>${escape(section.title)}</h2><p>${section.rows.length} ${section.rows.length === 1 ? "row" : "rows"}</p><table><thead><tr>${section.columns.map(c => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${section.rows.length ? section.rows.map(row => `<tr>${row.map(c => `<td>${escape(c)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${section.columns.length}">No matching records.</td></tr>`}</tbody></table></section>`).join("")}</body></html>`;
}
export function saveReport(report: DashboardReport, snapshot: ReportSnapshot, format: "csv" | "pdf") {
  if (format === "pdf") {
    const win = window.open("", "_blank");
    if (!win) throw new Error("Allow this site's pop-up to open the printable report.");
    win.opener = null;
    win.document.open(); win.document.write(reportHtml(report, snapshot)); win.document.close();
    win.focus();
    return;
  }
  const url = URL.createObjectURL(new Blob([reportCsv(report, snapshot)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url;
  a.download = `${report.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${snapshot.asOf.toISOString().slice(0, 10)}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
