import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { MARKETING_REPORT_HEADERS, type MarketingLeadReport } from "../../../shared/marketingLeadReport";
import { buildMarketingReportWorkbook } from "../../amplify/functions/marketing-report/workbook";

function sample(): MarketingLeadReport {
  const row: MarketingLeadReport["rows"][number] = Array(MARKETING_REPORT_HEADERS.length).fill(null);
  const set = (header: typeof MARKETING_REPORT_HEADERS[number], value: typeof row[number]) => { row[MARKETING_REPORT_HEADERS.indexOf(header)] = value; };
  set("Lead ID", "=HYPERLINK(\"https://example.test\")");
  set("Lead Name", "A & B <association>\u0001");
  set("Property Type", "HOA/COA");
  set("Property Units", 148);
  set("Inquiry Date", new Date("2026-09-28T00:00:00Z"));
  set("Quote Amount ($)", 1234.5);
  set("Premium on Record ($)", 0);
  set("Lead Age (Days)", 27);
  return { headers: MARKETING_REPORT_HEADERS, rows: [row], asOf: "2026-09-28T12:00:00Z", warnings: ["Unknown values remain blank or Not recorded."] };
}

describe("marketing report Excel package", () => {
  it("writes a valid XML package with the template sheet, typed numbers/dates, filter and frozen identity columns", () => {
    const files = unzipSync(buildMarketingReportWorkbook(sample()));
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    const doc = new DOMParser().parseFromString(sheet, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll('row[r="1"] c')).toHaveLength(53);
    expect([...doc.querySelectorAll('row[r="1"] c')].map(cell => cell.textContent)).toEqual(MARKETING_REPORT_HEADERS);
    expect(doc.querySelector('c[r="D1"]')?.textContent).toBe("Property Type");
    expect(doc.querySelector('c[r="E1"]')?.textContent).toBe("Property Units");
    expect(doc.querySelector('c[r="BA1"]')?.textContent).toBe("Notes");
    expect(doc.querySelector('c[r="D2"]')?.textContent).toBe("HOA/COA");
    expect(doc.querySelector('c[r="E2"] v')?.textContent).toBe("148");
    expect(doc.querySelector('c[r="S2"] v')?.textContent).toBe("46293");
    expect(doc.querySelector('c[r="AI2"] v')?.textContent).toBe("1234.5");
    expect(doc.querySelector('c[r="AJ2"] v')?.textContent).toBe("0");
    expect(doc.querySelector('c[r="AV2"] v')?.textContent).toBe("27");
    expect(doc.querySelector('c[r="T2"] v')).toBeNull();
    expect(doc.querySelector("dimension")?.getAttribute("ref")).toBe("A1:BA2");
    expect(doc.querySelector("autoFilter")?.getAttribute("ref")).toBe("A1:BA2");
    expect(doc.querySelector("pane")?.getAttribute("topLeftCell")).toBe("C2");
    expect(doc.querySelector("pane")?.getAttribute("xSplit")).toBe("2");
    expect(strFromU8(files["xl/workbook.xml"])).toContain('name="PMH Leads - Final"');
    expect(strFromU8(files["xl/worksheets/sheet2.xml"])).toContain("America/New_York");
    for (const [name, content] of Object.entries(files)) {
      const xml = new DOMParser().parseFromString(strFromU8(content), "application/xml");
      expect(xml.querySelector("parsererror"), name).toBeNull();
    }
  });

  it("formats units and ages as integers, premiums as currency and shifted dates as dates on both row bands", () => {
    const report = sample(); report.rows.push([...report.rows[0]]);
    const files = unzipSync(buildMarketingReportWorkbook(report));
    const doc = new DOMParser().parseFromString(strFromU8(files["xl/worksheets/sheet1.xml"]), "application/xml");
    const styles = new DOMParser().parseFromString(strFromU8(files["xl/styles.xml"]), "application/xml");
    const formats = styles.querySelectorAll("cellXfs > xf");
    const format = (ref: string) => {
      const cell = doc.querySelector(`c[r="${ref}"]`)!;
      expect(cell.getAttribute("t")).toBeNull();
      return formats[Number(cell.getAttribute("s"))].getAttribute("numFmtId");
    };
    for (const row of [2, 3]) {
      expect(format(`E${row}`)).toBe("1");
      expect(format(`AV${row}`)).toBe("1");
      expect(format(`AI${row}`)).toBe("165");
      expect(format(`AJ${row}`)).toBe("165");
      expect(format(`S${row}`)).toBe("164");
    }
    expect(doc.querySelector('col[min="4"]')?.getAttribute("width")).toBe("32");
    expect(doc.querySelector('col[min="5"]')?.getAttribute("width")).toBe("20");
    expect(doc.querySelector('col[min="34"]')?.getAttribute("width")).toBe("32");
    expect(doc.querySelector('col[min="53"]')?.getAttribute("width")).toBe("56");
    expect(doc.querySelector("autoFilter")?.getAttribute("ref")).toBe("A1:BA3");
  });

  it("stores untrusted text as literal inline strings without formulas, links or invalid XML controls", () => {
    const files = unzipSync(buildMarketingReportWorkbook(sample()));
    const doc = new DOMParser().parseFromString(strFromU8(files["xl/worksheets/sheet1.xml"]), "application/xml");
    expect(doc.querySelector('c[r="A2"]')?.getAttribute("t")).toBe("inlineStr");
    expect(doc.querySelector('c[r="A2"]')?.textContent).toBe('=HYPERLINK("https://example.test")');
    expect(doc.querySelector('c[r="B2"]')?.textContent).toBe("A & B <association>");
    expect(doc.querySelector("f")).toBeNull();
    expect(doc.querySelector("hyperlink")).toBeNull();
  });

  it("supports an empty cumulative snapshot with every header and the complete filter range", () => {
    const report = sample(); report.rows = [];
    const files = unzipSync(buildMarketingReportWorkbook(report));
    const doc = new DOMParser().parseFromString(strFromU8(files["xl/worksheets/sheet1.xml"]), "application/xml");
    expect(doc.querySelectorAll("row")).toHaveLength(1);
    expect(doc.querySelectorAll('row[r="1"] c')).toHaveLength(53);
    expect(doc.querySelector("dimension")?.getAttribute("ref")).toBe("A1:BA1");
    expect(doc.querySelector("autoFilter")?.getAttribute("ref")).toBe("A1:BA1");
  });

  it.each([
    ["empty", []],
    ["missing", MARKETING_REPORT_HEADERS.slice(0, -1)],
    ["extra", [...MARKETING_REPORT_HEADERS, "Unexpected"]],
    ["blank", ["", ...MARKETING_REPORT_HEADERS.slice(1)]],
    ["renamed", ["Renamed", ...MARKETING_REPORT_HEADERS.slice(1)]],
    ["duplicate", [MARKETING_REPORT_HEADERS[1], ...MARKETING_REPORT_HEADERS.slice(1)]],
    ["reordered", [MARKETING_REPORT_HEADERS[1], MARKETING_REPORT_HEADERS[0], ...MARKETING_REPORT_HEADERS.slice(2)]],
  ])("refuses %s headers instead of generating a mislabeled report", (_, headers) => {
    expect(() => buildMarketingReportWorkbook({ ...sample(), headers })).toThrow("headers must match the canonical column layout");
  });

  it.each([0, MARKETING_REPORT_HEADERS.length - 1, MARKETING_REPORT_HEADERS.length + 1])("refuses malformed rows with %i cells", length => {
    expect(() => buildMarketingReportWorkbook({ ...sample(), rows: [Array(length).fill(null)] })).toThrow("rows must contain all 53 columns");
  });

  it.each([
    ["date", new Date(NaN)],
    ["number", NaN],
    ["number", Infinity],
  ] as const)("refuses an invalid %s cell", (kind, value) => {
    const report = sample(); report.rows[0][4] = value;
    expect(() => buildMarketingReportWorkbook(report)).toThrow(`Report contains an invalid ${kind}`);
  });
});
