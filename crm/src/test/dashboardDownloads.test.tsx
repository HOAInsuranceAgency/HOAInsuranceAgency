import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
const h = vi.hoisted(() => ({ data: {} as Record<string, unknown>, save: vi.fn() }));
vi.mock("../lib/useAsyncResource", () => ({ useAsyncResource: () => ({ data: h.data, loading: false, loaded: true, error: "", refetch: async () => {} }) }));
vi.mock("../lib/lastContact", () => ({ useLastContacts: () => ({ contacts: { a1: { at: "2026-09-10T14:00:00.000Z", channel: "EMAIL", direction: "INBOUND" } }, loading: false, error: "" }) }));
vi.mock("../lib/reportDownload", async original => ({ ...await original<typeof import("../lib/reportDownload")>(), saveReport: h.save }));
import LeadsTab from "../pages/dashboard/LeadsTab";
import OverviewTab from "../pages/dashboard/OverviewTab";
import FinanceTab from "../pages/dashboard/FinanceTab";
import RenewalsTab from "../pages/dashboard/RenewalsTab";
import ReportingTab from "../pages/dashboard/ReportingTab";
const lead = { id: "a1", name: "Elm HOA", stage: "LEAD", type: "ASSOCIATION", createdAt: "2026-09-01T14:00:00Z", source: "website-quote", leadSource: "GOOGLE_AD_WEBSITE" };
beforeEach(() => { h.save.mockClear(); h.data = { leads: [lead], clients: [], accounts: [lead], quotes: [], policies: [], carriers: [], tasks: [], openInvoices: [], invoices: [], pfLoans: [], notices: [], failedDocs: [], licenses: [], paidInvoices: [], pfPayments: [] }; });
describe("dashboard report controls", () => {
  it.each([[OverviewTab, 2], [LeadsTab, 3], [FinanceTab, 4], [RenewalsTab, 1], [ReportingTab, 5]] as const)("provides a working export for every report in %s", (Tab, count) => {
    render(<MemoryRouter><Tab /></MemoryRouter>);
    const controls = screen.getAllByRole("combobox", { name: /^Download / });
    expect(controls).toHaveLength(count);
    for (const control of controls) fireEvent.change(control, { target: { value: "csv" } });
    expect(h.save).toHaveBeenCalledTimes(count);
    for (const [report, snapshot, format] of h.save.mock.calls) {
      expect(report.sections.length).toBeGreaterThan(0); expect(snapshot.asOf).toBeInstanceOf(Date); expect(format).toBe("csv");
    }
  });
  it("shows and exports last contact and canonical acquisition without internal source slugs", () => {
    render(<MemoryRouter><LeadsTab /></MemoryRouter>);
    expect(screen.getByRole("columnheader", { name: /Last contact/ })).toBeTruthy();
    expect(screen.getByText("Google Ad Website")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Download Lead work list" }), { target: { value: "csv" } });
    const report = h.save.mock.calls[0][0];
    expect(report.sections[0].rows[0][1]).toBe("Google Ad Website");
    expect(report.sections[0].rows[0][2]).not.toBe("No contact recorded");
    expect(JSON.stringify(report)).not.toContain("website-quote");
  });
  it("exports the selected reporting window and excludes cancelled policies", () => {
    h.data.policies = [
      { id: "p1", accountId: "a1", carrierId: "c1", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10, status: "ACTIVE" },
      { id: "p2", accountId: "a1", carrierId: "c1", effectiveDate: "2025-09-01", premium: 5000, commissionPct: 10, status: "ACTIVE" },
      { id: "p3", accountId: "a1", carrierId: "c1", effectiveDate: "2026-09-01", premium: 9000, commissionPct: 10, status: "CANCELLED" },
    ];
    h.data.carriers = [{ id: "c1", name: "Test carrier" }];
    render(<MemoryRouter><ReportingTab /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
    const dates = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: "2026-01-01" } }); fireEvent.change(dates[1], { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Download Commission by lead source" }), { target: { value: "csv" } });
    const report = h.save.mock.calls[0][0];
    expect(report.filters).toContain("2026-01-01 through 2026-12-31");
    expect(report.sections[0].rows).toEqual([["Google Ad Website", 100, 1]]);
  });
});
