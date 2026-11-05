import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
const h = vi.hoisted(() => ({ data: {} as Record<string, unknown>, save: vi.fn() }));
vi.mock("../lib/useAsyncResource", () => ({ useAsyncResource: (_fetcher: unknown, deps: unknown[]) => ({ data: deps.length === 2 && typeof deps[0] === "string" ? { key: deps[0], snapshot: h.data, commercial: h.data.commercial, quotes: h.data.quotes } : h.data, loading: false, loaded: true, error: "", refetch: async () => {} }) }));

vi.mock("../lib/lastContact", () => ({ useLastContacts: () => ({ contacts: { a1: { at: "2026-09-10T14:00:00.000Z", channel: "EMAIL", direction: "INBOUND" } }, loading: false, error: "" }) }));
vi.mock("../lib/reportDownload", async original => ({ ...await original<typeof import("../lib/reportDownload")>(), saveReport: h.save }));
import LeadsTab from "../pages/dashboard/LeadsTab";
import FinanceTab from "../pages/dashboard/FinanceTab";
import PerformanceTab from "../pages/dashboard/PerformanceTab";
const lead = { id: "a1", name: "Elm HOA", stage: "LEAD", type: "ASSOCIATION", createdAt: "2026-09-01T14:00:00Z", city: "Worcester", state: "MA", source: "website-quote", leadSource: "GOOGLE_AD_WEBSITE" };
beforeEach(() => { h.save.mockClear(); h.data = { selections: {}, leads: [lead], clients: [], accounts: [lead], quotes: [], policies: [], carriers: [], invoices: [], pfLoans: [], payments: [], invoiceLines: [], asOf: new Date(), commercial: { entries: { a1: { accountId: "a1", salespersonId: "sales", disposition: "ACTIVE", plan: { accountId: "a1", version: 1, estimatedCents: 123456, requiredLines: [], options: [], selectedOptionId: null } } }, team: [{ userId: "sales", name: "Avery Brooks", salesperson: true }] } }; });
describe("dashboard report controls", () => {
  it.each([[LeadsTab, 6], [FinanceTab, 5], [PerformanceTab, 8]] as const)("provides a working export for every report in %s", (Tab, count) => {
    render(<MemoryRouter><Tab /></MemoryRouter>);
    if (Tab === LeadsTab) fireEvent.change(screen.getByRole("combobox", { name: "Salesperson" }), { target: { value: "sales" } });
    const controls = screen.getAllByRole("combobox", { name: /^Download / });
    expect(controls).toHaveLength(count);
    for (const control of controls) fireEvent.change(control, { target: { value: "csv" } });
    expect(h.save).toHaveBeenCalledTimes(count);
    for (const [report, snapshot, format] of h.save.mock.calls) {
      expect(report.sections.length).toBeGreaterThan(0); expect(snapshot.asOf).toBeInstanceOf(Date); expect(format).toBe("csv");
    }
  });
  it("exports booked fees, actual refunds and agency revenue by the existing salesperson basis", () => {
    h.data.policies = [
      { id: "active", accountId: "a1", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10, brokerFee: 500, brokerFeeRefunded: 100, status: "ACTIVE" },
      { id: "cancelled", accountId: "a1", effectiveDate: "2026-09-01", premium: 9000, commissionPct: 10, brokerFee: 200, status: "CANCELLED" },
    ];
    render(<MemoryRouter><PerformanceTab /></MemoryRouter>);
    fireEvent.change(screen.getByRole("combobox", { name: "Download Broker fees per person" }), { target: { value: "csv" } });
    const fees = h.save.mock.calls[0][0];
    expect(fees.sections[0].rows.find((row: unknown[]) => row[0] === "Avery Brooks")).toEqual(["Avery Brooks", 700, 100, 600, 2]);
    expect(fees.filters).toContain("current account salesperson");
    fireEvent.change(screen.getByRole("combobox", { name: "Download Total agency revenue per person" }), { target: { value: "csv" } });
    expect(h.save.mock.calls[1][0].sections[0].rows.find((row: unknown[]) => row[0] === "Avery Brooks")).toEqual(["Avery Brooks", 100, 600, 700]);
  });
  it("exports confirmed fee collections separately from booked revenue without recreating refunded debt", () => {
    h.data.brokerFeePolicies = [
      { id: "refunded", accountId: "a1", brokerFee: 500, brokerFeeCollected: 500, brokerFeeRefunded: 100, status: "CANCELLED" },
      { id: "partial", accountId: "a1", brokerFee: 200, brokerFeeCollected: 50, status: "ACTIVE" },
    ];
    render(<MemoryRouter><FinanceTab /></MemoryRouter>);
    fireEvent.change(screen.getByRole("combobox", { name: "Download Broker fee collections" }), { target: { value: "csv" } });
    const report = h.save.mock.calls[0][0];
    expect(report.sections[0].rows).toEqual([["Booked broker fees", 700], ["Gross fee receipts", 550], ["Actual fee refunds", 100], ["Net fees collected", 450], ["Net fee revenue", 600], ["Fee balance awaiting collection", 150]]);
    expect(report.sections[1].rows.find((row: unknown[]) => row[0] === "Avery Brooks")).toEqual(["Avery Brooks", 700, 550, 100, 450, 150]);
    expect(report.filters).toContain("not additional A/R");
  });
  it("shows and exports last contact and canonical acquisition without internal source slugs", () => {
    render(<MemoryRouter><LeadsTab /></MemoryRouter>);
    fireEvent.change(screen.getByRole("combobox", { name: "Salesperson" }), { target: { value: "sales" } });
    expect(screen.getByRole("columnheader", { name: /Last contact/ })).toBeTruthy();
    expect(screen.getByText("Google Ad Website")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Download Lead work list" }), { target: { value: "csv" } });
    const report = h.save.mock.calls[0][0];
    const section = report.sections[0];
    const value = (column: string) => section.rows[0][section.columns.indexOf(column)];
    expect(value("Lead source")).toBe("Google Ad Website");
    expect(value("Last contact (local)")).not.toBe("No contact recorded");
    expect(value("Salesperson")).toBe("Avery Brooks");
    expect(section.columns).not.toContain("Deal champion");
    expect(value("City")).toBe("Worcester");
    expect(value("State")).toBe("MA");
    expect(value("Website form")).toBe("Quote form");
    expect(value("Estimated opportunity (USD)")).toBe(1234.56);
    expect(value("Pending commission (USD)")).toBe(null);
    expect(JSON.stringify(report)).not.toContain("website-quote");
  });
  it("exports the selected reporting window and excludes cancelled policies", () => {
    h.data.policies = [
      { id: "p1", accountId: "a1", carrierId: "c1", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10, status: "ACTIVE" },
      { id: "p2", accountId: "a1", carrierId: "c1", effectiveDate: "2025-09-01", premium: 5000, commissionPct: 10, status: "ACTIVE" },
      { id: "p3", accountId: "a1", carrierId: "c1", effectiveDate: "2026-09-01", premium: 9000, commissionPct: 10, status: "CANCELLED" },
    ];
    h.data.carriers = [{ id: "c1", name: "Test carrier" }];
    render(<MemoryRouter><PerformanceTab /></MemoryRouter>);
    const dates = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: "2026-01-01" } }); fireEvent.change(dates[1], { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Download Commission by lead source" }), { target: { value: "csv" } });
    const report = h.save.mock.calls[0][0];
    expect(report.filters).toContain("2026-01-01 through 2026-12-31");
    expect(report.sections[0].rows).toEqual([["Google Ad Website", 100, 0, 100, 1]]);
  });
});
