import { zipSync, strToU8 } from "fflate";
import { MARKETING_REPORT_HEADERS, MARKETING_REPORT_TIMEZONE, type MarketingLeadReport, type ReportCell } from "../../../../shared/marketingLeadReport";

const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const mainNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const escape = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
function column(index: number): string { let result = ""; for (index++; index; index = Math.floor((index - 1) / 26)) result = String.fromCharCode(65 + (index - 1) % 26) + result; return result; }
const currencyColumns = new Set(["Quote Amount ($)", "Premium on Record ($)"]);
const wideTextColumns = new Set(["Status Definition", "Last Client Response Note", "Docs Detail", "Docs Outstanding", "Premium Note", "Other Premium on Record", "Hold Reason", "Exclusion Reason", "Notes"]);
const textColumns = new Set(["Lead Name", "Property Type", "Status", "Source", "Coverage Segment", "Coverage Requested", "Stated Carrier", "Quote Carrier", "Premium Category", "Premium Basis", "Expiration Confidence"]);
function cell(value: ReportCell, row: number, col: number, header = false, fieldName = ""): string {
  const ref = `${column(col)}${row}`, band = row % 2 === 0 ? 0 : 4;
  if (value === null) return `<c r="${ref}" s="${1 + band}"/>`;
  if (header) return `<c r="${ref}" s="0" t="inlineStr"><is><t xml:space="preserve">${escape(String(value))}</t></is></c>`;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Report contains an invalid date");
    return `<c r="${ref}" s="${2 + band}"><v>${value.getTime() / 86400000 + 25569}</v></c>`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Report contains an invalid number");
    return `<c r="${ref}" s="${(currencyColumns.has(fieldName) ? 3 : 4) + band}"><v>${value}</v></c>`;
  }
  // Explicit inline strings cannot be interpreted as formulas, even when beginning with =, +, - or @.
  return `<c r="${ref}" s="${1 + band}" t="inlineStr"><is><t xml:space="preserve">${escape(value.slice(0, 32767))}</t></is></c>`;
}
function width(header: string): number {
  if (header === "Lead ID") return 38;
  if (wideTextColumns.has(header)) return 56;
  if (textColumns.has(header)) return 32;
  return 20;
}
function rowHeight(values: ReportCell[], headers: readonly string[]): number {
  const lines = Math.max(2, ...values.map((v, i) => typeof v === "string" ? v.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (width(headers[i]) - 3))), 0) : 1));
  return Math.min(409, lines * 15 + 8);
}
const styles = `${xmlHeader}<styleSheet xmlns="${mainNs}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><color rgb="FF172B4D"/></font><font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173C5B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F5F8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9"><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1" applyFill="1" applyFont="1"><alignment vertical="center" wrapText="1"/></xf>
${[0, 3].flatMap(fill => [0, 164, 165, 1].map(numFmt => `<xf numFmtId="${numFmt}" fontId="0" fillId="${fill}" borderId="0" xfId="0" applyAlignment="1" applyFill="1" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf>`)).join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Small, deterministic OOXML writer: no spreadsheet runtime or formulas in Lambda. */
export function buildMarketingReportWorkbook(report: MarketingLeadReport): Uint8Array {
  if (report.headers.length !== MARKETING_REPORT_HEADERS.length || MARKETING_REPORT_HEADERS.some((header, i) => report.headers[i] !== header)) throw new Error("Marketing report headers must match the canonical column layout");
  if (report.rows.some(row => row.length !== report.headers.length)) throw new Error(`Marketing report rows must contain all ${report.headers.length} columns`);
  if (report.rows.length > 1_048_575) throw new Error("Report exceeds the Excel row limit");
  const range = `A1:${column(report.headers.length - 1)}${report.rows.length + 1}`;
  const dataSheet = `${xmlHeader}<worksheet xmlns="${mainNs}"><dimension ref="${range}"/>
<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="C2" sqref="C2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="30"/>
<cols>${report.headers.map((header, i) => `<col min="${i + 1}" max="${i + 1}" width="${width(header)}" customWidth="1"/>`).join("")}</cols>
<sheetData><row r="1" ht="48" customHeight="1">${report.headers.map((h, i) => cell(h, 1, i, true)).join("")}</row>
${report.rows.map((values, i) => `<row r="${i + 2}" ht="${rowHeight(values, report.headers)}" customHeight="1">${values.map((v, c) => cell(v, i + 2, c, false, report.headers[c])).join("")}</row>`).join("")}</sheetData><autoFilter ref="${range}"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`;
  const notes: [string, string][] = [["Report notes", ""], ["Generated at", report.asOf], ["Timezone", MARKETING_REPORT_TIMEZONE], ["Population", `${report.rows.length} lead and client accounts`], ...report.warnings.map((warning, i): [string, string] => [`Definition ${i + 1}`, warning])];
  const noteSheet = `${xmlHeader}<worksheet xmlns="${mainNs}"><dimension ref="A1:B${notes.length}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="110" customWidth="1"/></cols><sheetData>${notes.map((values, i) => `<row r="${i + 1}" ht="${i === 0 ? 30 : Math.max(30, Math.ceil(values[1].length / 110) * 16 + 10)}" customHeight="1">${values.map((v, c) => cell(v, i + 1, c, i === 0)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const files: Record<string, string> = {
    "[Content_Types].xml": `${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${xmlHeader}<workbook xmlns="${mainNs}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="PMH Leads - Final" sheetId="1" r:id="rId1"/><sheet name="Report notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${xmlHeader}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": styles, "xl/worksheets/sheet1.xml": dataSheet, "xl/worksheets/sheet2.xml": noteSheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])), { level: 6 });
}
