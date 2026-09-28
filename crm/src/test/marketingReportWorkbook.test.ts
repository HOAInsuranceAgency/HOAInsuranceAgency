import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { MARKETING_REPORT_HEADERS, type MarketingLeadReport } from "../../../shared/marketingLeadReport";
import { buildMarketingReportWorkbook } from "../../amplify/functions/marketing-report/workbook";

function sample(): MarketingLeadReport {
  const row: MarketingLeadReport["rows"][number] = Array(52).fill(null);
  row[0] = "=HYPERLINK(\"https://example.test\")";
  row[1] = "A & B <association>\u0001";
  row[17] = new Date("2026-09-28T00:00:00Z");
  row[33] = 1234.5;
  row[34] = 0;
  row[46] = 27;
  return { headers: MARKETING_REPORT_HEADERS, rows: [row], asOf: "2026-09-28T12:00:00Z", warnings: ["Unknown values remain blank or Not recorded."] };
}

describe("marketing report Excel package", () => {
  it("writes a valid XML package with the template sheet, typed numbers/dates, filter and frozen identity columns", () => {
    const files = unzipSync(buildMarketingReportWorkbook(sample()));
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    const doc = new DOMParser().parseFromString(sheet, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll('row[r="1"] c')).toHaveLength(52);
    expect(doc.querySelector('c[r="AZ1"]')?.textContent).toBe("Notes");
    expect(doc.querySelector('c[r="R2"] v')?.textContent).toBe("46293");
    expect(doc.querySelector('c[r="AH2"] v')?.textContent).toBe("1234.5");
    expect(doc.querySelector('c[r="AI2"] v')?.textContent).toBe("0");
    expect(doc.querySelector('c[r="AU2"] v')?.textContent).toBe("27");
    expect(doc.querySelector('c[r="S2"] v')).toBeNull();
    expect(doc.querySelector("autoFilter")?.getAttribute("ref")).toBe("A1:AZ2");
    expect(doc.querySelector("pane")?.getAttribute("topLeftCell")).toBe("C2");
    expect(doc.querySelector("pane")?.getAttribute("xSplit")).toBe("2");
    expect(strFromU8(files["xl/workbook.xml"])).toContain('name="PMH Leads - Final"');
    expect(strFromU8(files["xl/worksheets/sheet2.xml"])).toContain("America/New_York");
    for (const [name, content] of Object.entries(files)) {
      const xml = new DOMParser().parseFromString(strFromU8(content), "application/xml");
      expect(xml.querySelector("parsererror"), name).toBeNull();
    }
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

  it("supports an empty cumulative snapshot and refuses malformed rows", () => {
    const report = sample(); report.rows = [];
    const files = unzipSync(buildMarketingReportWorkbook(report));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"])).toContain('ref="A1:AZ1"');
    expect(() => buildMarketingReportWorkbook({ ...report, rows: [["too short"]] })).toThrow("52");
  });
});
