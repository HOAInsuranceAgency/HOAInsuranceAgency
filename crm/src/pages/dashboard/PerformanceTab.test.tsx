import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { emptyCommercialPlan } from "../../../../shared/quotePackages";

const h = vi.hoisted(() => ({ accounts: vi.fn(), quotes: vi.fn(), policies: vi.fn(), carriers: vi.fn(), commercial: vi.fn() }));
vi.mock("../../lib/client", async original => ({
  ...await original<typeof import("../../lib/client")>(),
  client: { models: { Account: { list: h.accounts }, Quote: { list: h.quotes }, Policy: { list: h.policies }, Carrier: { list: h.carriers } } },
}));
vi.mock("../../lib/commercial", async original => ({ ...await original<typeof import("../../lib/commercial")>(), loadCommercial: h.commercial }));
import PerformanceTab from "./PerformanceTab";

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts.mockResolvedValue({ data: [{ id: "a", name: "Elm HOA" }, { id: "b", name: "Oak HOA" }] });
  h.policies.mockResolvedValue({ data: [{ id: "policy", accountId: "a", effectiveDate: "2026-09-01", premium: 1000, commissionPct: 10 }] });
  h.carriers.mockResolvedValue({ data: [] });
  h.quotes.mockResolvedValue({ data: [
    { id: "q1", accountId: "a", status: "BOUND", effectiveDate: "2026-09-01" },
    { id: "q2", accountId: "a", status: "LOST", effectiveDate: "2026-09-01" },
    { id: "q3", accountId: "b", status: "SENT", effectiveDate: "2026-09-01" },
  ] });
  h.commercial.mockResolvedValue({ entries: {
    a: { accountId: "a", salespersonId: "alice", plan: emptyCommercialPlan("a") },
    b: { accountId: "b", salespersonId: "bob", plan: emptyCommercialPlan("b") },
  }, team: [{ userId: "alice", name: "Alice", salesperson: true }, { userId: "bob", name: "Bob", salesperson: true }] });
});

it("shows decided quote denominators and distinguishes people with no decisions from a zero win rate", async () => {
  render(<PerformanceTab />);
  const chart = await screen.findByRole("group", { name: "Quote win rate per person" });
  expect(within(chart).getByRole("img", { name: /Alice · 1 \/ 2 won: 50%/ })).toBeInTheDocument();
  expect(within(chart).queryByRole("img", { name: /Bob/ })).not.toBeInTheDocument();
  expect(screen.getByText("No decided quotes: Bob, Unassigned.")).toBeInTheDocument();
  expect(screen.queryByText(/^Collected/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^PF interest income/)).not.toBeInTheDocument();
});

it("blocks charts and downloads for a reversed custom date range", async () => {
  render(<PerformanceTab />);
  fireEvent.click(await screen.findByRole("button", { name: "Custom…" }));
  fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("Effective to"), { target: { value: "2026-09-01" } });
  expect(screen.getByRole("alert")).toHaveTextContent("The start date must be on or before the end date.");
  expect(screen.queryByRole("combobox", { name: /^Download / })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Estimated commission per person" })).not.toBeInTheDocument();
});

it("does not present failed assignment loading as unassigned production", async () => {
  h.commercial.mockRejectedValue(new Error("Assignments unavailable"));
  render(<PerformanceTab />);
  expect(await screen.findByText("Assignments unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Estimated commission per person" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /^Download / })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
