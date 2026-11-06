import { describe, expect, it, vi } from "vitest";
import { csvCell, reportCsv, reportHtml, saveReport, type DashboardReport } from "../lib/reportDownload";
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
  it("fills the already-open PDF window without attempting a second popup", () => {
    const open = vi.spyOn(window, 'open');
    const win = { closed: false, document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn() };
    try {
      saveReport(report, snapshot, 'pdf', win as unknown as Window);
      expect(open).not.toHaveBeenCalled();
      expect(win.document.write).toHaveBeenCalledWith(reportHtml(report, snapshot));
      expect(win.focus).toHaveBeenCalledTimes(1);
      win.closed = true;
      expect(() => saveReport(report, snapshot, 'pdf', win as unknown as Window)).toThrow('window was closed');
    } finally { open.mockRestore(); }
  });
});

describe("branded commission ledger", () => {
  const ledger: DashboardReport = {
    title: "Producer commission ledger",
    commissionLedger: {
      scope: "All displayed employees", agencyReceivedCents: 250000, earnedCents: 50400, paidCents: 0,
      proposedPaidRecoveryCents: 0, unpaidAdjustmentCents: 8000, partialAdjustmentCents: 0,
    },
    sections: [
      { title: "Transactions", columns: [], rows: [
        ["Avery Brooks", "Cedar HOA", "POL-1", "2026-10-01", "RECEIPT", "Carrier commission", 2000, 16, 320, ""],
        ["Avery Brooks", "Cedar HOA", "POL-1", "2026-10-01", "REVERSAL", "Carrier commission", -500, 16, -80, ""],
        ["Avery Brooks", "Maple Court HOA", "SHARED-102", "2026-10-01", "RECEIPT · shared allocation", "Carrier commission", 1000, "", "", ""],
      ] },
      { title: "Employee earnings allocations", columns: [], rows: [
        ["Avery Brooks", "Maple Court HOA", "SHARED-102", "2026-10-01", "SHARED_RECEIPT", 60, 20, 120, "PAYABLE", "", 'receipt:["shared","avery"]', "shared-receipt"],
        ["Jordan Hayes", "Maple Court HOA", "SHARED-102", "2026-10-01", "SHARED_RECEIPT", 40, 16, 64, "PAYABLE", "batch-2", 'receipt:["shared","jordan"]', "shared-receipt"],
      ] },
    ],
  };
  it("retains ledger totals, allocation basis and traceability without counting agency cash twice", () => {
    const doc = new DOMParser().parseFromString(reportHtml(ledger, snapshot), "text/html");
    const totals = doc.querySelector(".amount-panel")!.textContent;
    expect(totals).toContain("$504.00");
    expect(totals).toContain("$2,500.00");
    expect(totals).not.toContain("$424.00");
    expect(doc.querySelector(".adjustments")!.textContent).toContain("$80.00");
    expect(doc.querySelectorAll(".transactions tbody tr")).toHaveLength(3);
    expect(doc.querySelector(".transactions tbody tr")!.textContent).toContain("$2,000.00");
    expect(doc.querySelector(".transactions tbody tr")!.textContent).toContain("$320.00");
    expect(doc.querySelector(".transactions tbody tr")!.textContent).toContain("16% frozen rate");
    expect(doc.querySelectorAll(".allocation-group")).toHaveLength(2);
    expect(doc.querySelector(".allocations")!.textContent).toContain("60% share × 20% plan rate");
    expect(doc.querySelector(".allocations")!.textContent).toContain("40% share × 16% plan rate");
    expect(doc.querySelector(".allocations")!.textContent).toContain("$120.00");
    expect(doc.querySelector(".allocations")!.textContent).toContain("$64.00");
    expect(doc.querySelector(".allocations")!.textContent).not.toContain("$1,000.00");
    expect(doc.querySelector(".allocations")!.textContent).toContain('receipt:["shared","jordan"]');
    expect(doc.querySelector(".allocations")!.textContent).toContain("shared-receipt");
    expect(doc.querySelector(".allocations")!.textContent).toContain("batch-2");
    expect(doc.querySelectorAll(".transactions tr")[3].textContent).toContain("See employee allocations");
    expect(doc.querySelector(".notice")!.textContent).toContain("Not a payroll approval");
  });
  it("escapes names and references, marks only test copies, and formats the stated time zone", () => {
    const unsafe = structuredClone(ledger);
    unsafe.commissionLedger!.scope = '<img src=x onerror="bad()">';
    unsafe.sections[1].rows[0][0] = "José 王 <script>alert(1)</script>";
    unsafe.sections[1].rows[0][10] = '<svg onload="bad()">';
    const live = reportHtml(unsafe, snapshot);
    const test = reportHtml(unsafe, { ...snapshot, isTest: true });
    expect(live).not.toContain("TEST DATA — DO NOT PAY");
    expect(test).toContain("TEST DATA — DO NOT PAY");
    expect(test).toContain("José 王 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(test).not.toContain('<svg onload="bad()">');
    const doc = new DOMParser().parseFromString(test, "text/html");
    expect(doc.querySelectorAll("script,svg")).toHaveLength(0);
    expect(doc.querySelectorAll("img")).toHaveLength(2);
    expect(doc.querySelector(".facts")!.textContent).toContain("11:00 AM EDT");
    expect(doc.querySelector(".facts")!.textContent).toContain("America/New_York");
  });
});
