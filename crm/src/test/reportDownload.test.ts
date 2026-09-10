import { describe, expect, it } from "vitest";
import { csvCell, reportCsv, reportHtml, type DashboardReport } from "../lib/reportDownload";
const snapshot = { asOf: new Date("2026-09-10T15:00:00Z"), timezone: "America/New_York" };
const report: DashboardReport = { title: "Lead work list", filters: "Open leads · sorted by last contact", sections: [{ title: "Leads", columns: ["Lead", "Source", "Amount"], rows: [["Oak, Pine & Maple", "Google Ad Website", 1250.25], ['=HYPERLINK("https://bad.test")', "Phone", -10], ["José 王 <script>alert(1)</script>", "Email", null]] }] };
describe("dashboard exports", () => {
  it("protects text from spreadsheet formulas while keeping actual amounts numeric", () => {
    expect(csvCell("  =1+2")).toBe('"\'  =1+2"');
    expect(csvCell("\t@SUM(A1)")).toBe('"\'\t@SUM(A1)"');
    expect(csvCell(-10)).toBe('"-10"');
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
  it("includes every supplied row, readable source, scope, and snapshot date", () => {
    const csv = reportCsv(report, snapshot);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"Oak, Pine & Maple","Google Ad Website","1250.25"');
    expect(csv).toContain("2026-09-10T15:00:00.000Z");
    expect(csv).toContain("America/New_York");
    expect(csv).toContain("José 王");
    expect(csv).toContain("Open leads · sorted by last contact");
  });
  it("escapes untrusted report content and keeps Unicode in paginated printable tables", () => {
    const html = reportHtml(report, snapshot);
    expect(html).toContain("José 王 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("thead{display:table-header-group}");
    expect(html).toContain("3 rows");
  });
  it("exports an explicit empty report instead of a misleading blank file", () => {
    const empty = { ...report, sections: [{ ...report.sections[0], rows: [] }] };
    expect(reportCsv(empty, snapshot)).toContain("No matching records");
    expect(reportHtml(empty, snapshot)).toContain("0 rows");
  });
});
