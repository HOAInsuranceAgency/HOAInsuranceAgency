import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emptyCommercialPlan } from "../../../../shared/quotePackages";

const h = vi.hoisted(() => ({ accounts: vi.fn(), quotes: vi.fn(), policies: vi.fn(), carriers: vi.fn(), assignments: vi.fn(), save: vi.fn() }));
vi.mock("../../lib/client", async original => ({
  ...await original<typeof import("../../lib/client")>(),
  client: { models: { Account: { list: h.accounts }, Quote: { list: h.quotes }, Policy: { list: h.policies }, Carrier: { list: h.carriers } } },
}));
vi.mock("../../lib/dashboardAssignments", () => ({ loadAssignments: h.assignments }));
vi.mock("../../lib/reportDownload", async original => ({ ...await original<typeof import("../../lib/reportDownload")>(), saveReport: h.save }));
import PerformanceTab from "./PerformanceTab";

beforeEach(() => {
  vi.resetAllMocks();
  h.accounts.mockRejectedValue(new Error("Dashboard must not list every account"));
  h.policies.mockResolvedValue({ data: [{ id: "policy", accountId: "a", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10, status: "ACTIVE" }] });
  h.carriers.mockResolvedValue({ data: [] });
  h.quotes.mockResolvedValue({ data: [
    { id: "q1", accountId: "a", status: "BOUND", effectiveDate: "2026-09-01" },
    { id: "q2", accountId: "a", status: "LOST", effectiveDate: "2026-09-01" },
    { id: "q3", accountId: "b", status: "PRESENTED", effectiveDate: "2026-09-01" },
  ] });
  h.assignments.mockImplementation(async (ids: string[]) => ({
    accounts: ids.map(id => ({ id, name: `${id} HOA`, leadSource: "GOOGLE_AD_WEBSITE" })),
    entries: Object.fromEntries(ids.map(id => [id, { accountId: id, salespersonId: id === "b" ? "bob" : "alice", plan: emptyCommercialPlan(id) }])),
    team: [{ userId: "alice", name: "Alice", salesperson: true }, { userId: "bob", name: "Bob", salesperson: true }],
  }));
});

it("shows decided quote denominators and retains zero-decision roster members without reading their accounts", async () => {
  render(<PerformanceTab />);
  const chart = await screen.findByRole("group", { name: "Quote win rate per person" });
  expect(within(chart).getByRole("img", { name: /Alice · 1 \/ 2 won: 50%/ })).toBeInTheDocument();
  expect(within(chart).queryByRole("img", { name: /Bob/ })).not.toBeInTheDocument();
  expect(screen.getByText("No decided quotes: Bob, Unassigned.")).toBeInTheDocument();
  expect(h.assignments).toHaveBeenCalledExactlyOnceWith(["a"]);
  expect(h.accounts).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Collected/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^PF interest income/)).not.toBeInTheDocument();
});

it("blocks charts and downloads for a reversed custom date range", async () => {
  render(<PerformanceTab />);
  fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
  fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("Effective to"), { target: { value: "2026-09-01" } });
  expect(screen.getByRole("alert")).toHaveTextContent("The start date must be on or before the end date.");
  expect(screen.queryByRole("combobox", { name: /^Download / })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Estimated commission per person" })).not.toBeInTheDocument();
});

it("does not present failed assignment loading as unassigned production", async () => {
  h.assignments.mockRejectedValue(new Error("Assignments unavailable"));
  render(<PerformanceTab />);
  expect(await screen.findByText("Assignments unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Estimated commission per person" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /^Download / })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Custom…" })).toBeEnabled();
});

it("loads assignments only for selected policies and decided quotes, with projected date-filtered requests", async () => {
  h.policies.mockResolvedValue({ data: [
    { id: "included", accountId: "a", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10, status: "ACTIVE" },
    { id: "old", accountId: "old-account", effectiveDate: "2025-09-01", premium: 5000, commissionPct: 10, status: "ACTIVE" },
    { id: "cancelled", accountId: "cancelled-account", effectiveDate: "2026-09-01", premium: 8000, commissionPct: 10, status: "CANCELLED" },
    { id: "undated", accountId: "undated-account", premium: 2000, commissionPct: 10, status: "ACTIVE" },
  ] });
  h.quotes.mockResolvedValue({ data: [
    { id: "q1", accountId: "a", status: "BOUND", effectiveDate: "2026-09-01" },
    { id: "q2", accountId: "quote-only", status: "DECLINED", effectiveDate: "2026-09-30" },
    { id: "q3", accountId: "open-quote", status: "QUOTED", effectiveDate: "2026-09-01" },
    { id: "q4", accountId: "old-quote", status: "LOST", effectiveDate: "2025-09-01" },
    { id: "q5", accountId: "undated-quote", status: "BOUND" },
  ] });
  render(<PerformanceTab />);
  await screen.findByRole("group", { name: "Estimated commission per person" });
  fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
  fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("Effective to"), { target: { value: "2026-09-30" } });
  await screen.findByRole("group", { name: "Estimated commission per person" });
  expect(h.assignments).toHaveBeenLastCalledWith(["a", "quote-only"]);
  expect(h.accounts).not.toHaveBeenCalled();
  expect(h.policies).toHaveBeenLastCalledWith(expect.objectContaining({
    filter: { effectiveDate: { ge: "2026-09-01", le: "2026-09-30" }, status: { ne: "CANCELLED" } },
    selectionSet: ["id", "accountId", "carrierId", "effectiveDate", "premium", "commissionPct", "status"],
  }));
  expect(h.quotes).toHaveBeenLastCalledWith(expect.objectContaining({
    filter: { effectiveDate: { ge: "2026-09-01", le: "2026-09-30" }, or: [{ status: { eq: "BOUND" } }, { status: { eq: "LOST" } }, { status: { eq: "DECLINED" } }] },
    selectionSet: ["id", "accountId", "effectiveDate", "status"],
  }));
  fireEvent.change(screen.getByRole("combobox", { name: "Download Commission by lead source" }), { target: { value: "csv" } });
  expect(h.save.mock.calls[0][0].sections[0].rows).toEqual([["Google Ad Website", 100, 0, 0, 100, 1]]);
});

it("preserves undated all-time production and reloads attribution when cancelled policies are included", async () => {
  h.quotes.mockResolvedValue({ data: [] });
  h.policies.mockResolvedValue({ data: [
    { id: "undated", accountId: "undated", premium: 1000, commissionPct: 10, status: "ACTIVE" },
    { id: "cancelled", accountId: "cancelled", premium: 2000, commissionPct: 10, status: "CANCELLED" },
  ] });
  render(<PerformanceTab />);
  const monthly = await screen.findByRole("group", { name: "Written premium by month" });
  expect(within(monthly).getByRole("img", { name: /No effective date: \$1,000/ })).toBeInTheDocument();
  expect(h.assignments).toHaveBeenLastCalledWith(["undated"]);
  fireEvent.click(screen.getByRole("button", { name: "Exclude cancelled" }));
  await screen.findByRole("group", { name: "Written premium by month" });
  expect(h.assignments).toHaveBeenLastCalledWith(["undated", "cancelled"]);
  expect(h.policies.mock.lastCall?.[0]).not.toHaveProperty("filter");
});

it("keeps filters available while replacing a snapshot and never exports old totals under the new dates", async () => {
  render(<PerformanceTab />);
  await screen.findByRole("group", { name: "Estimated commission per person" });
  let resolvePolicies!: (value: { data: unknown[] }) => void;
  const pendingPolicies = new Promise<{ data: unknown[] }>(resolve => { resolvePolicies = resolve; });
  h.policies.mockImplementation(() => pendingPolicies);
  fireEvent.click(screen.getByRole("button", { name: "Custom…" }));
  fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2027-01-01" } });
  fireEvent.change(screen.getByLabelText("Effective to"), { target: { value: "2027-12-31" } });
  expect(screen.getByLabelText("Effective from")).toBeEnabled();
  expect(screen.getByRole("button", { name: "All time" })).toBeEnabled();
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Estimated commission per person" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /^Download / })).not.toBeInTheDocument();
  await act(async () => { resolvePolicies({ data: [{ id: "new-policy", accountId: "a", effectiveDate: "2027-09-01", premium: 2000, commissionPct: 10, status: "ACTIVE" }] }); });
  const chart = await screen.findByRole("group", { name: "Estimated commission per person" });
  expect(within(chart).getByRole("img", { name: /Alice: \$200/ })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Download Estimated commission per person" }), { target: { value: "csv" } });
  const report = h.save.mock.calls[0][0];
  expect(report.filters).toContain("2027-01-01 through 2027-12-31");
  expect(report.sections[0].rows[0]).toEqual(["Alice", 200, 1, 0]);
});

it("keeps salespeople with no production visible when the selected period needs no account lookups", async () => {
  h.policies.mockResolvedValue({ data: [] });
  h.quotes.mockResolvedValue({ data: [{ id: "open", accountId: "b", status: "PRESENTED" }] });
  render(<PerformanceTab />);
  await waitFor(() => expect(h.assignments).toHaveBeenCalledExactlyOnceWith([]));
  expect(await screen.findByText("No decided quotes: Alice, Bob, Unassigned.")).toBeInTheDocument();
  expect(h.accounts).not.toHaveBeenCalled();
});
