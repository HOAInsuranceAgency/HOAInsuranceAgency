import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../../../shared/pagination";

const h = vi.hoisted(() => ({ quotes: vi.fn(), accounts: vi.fn(), carriers: vi.fn() }));
vi.mock("../lib/client", () => ({
  client: { models: { Quote: { list: h.quotes }, Account: { list: h.accounts }, Carrier: { list: h.carriers } } },
  listAllPages: (...args: Parameters<typeof listAllPages>) => listAllPages(...args),
  fmtDate: (value: string) => value || "—", fmtMoney: (value: number) => `$${value}`,
}));
import QuotesList from "./QuotesList";

const quotes = [
  { id: "today", status: "QUOTED", offerExpiresAt: "2026-11-03" },
  { id: "soon", status: "PRESENTED", offerExpiresAt: "2026-11-10" },
  { id: "later", status: "QUOTED", offerExpiresAt: "2026-11-11" },
  { id: "expired", status: "QUOTED", offerExpiresAt: "2026-11-02" },
  { id: "bound", status: "BOUND", offerExpiresAt: "2026-11-02" },
  { id: "lost", status: "LOST", offerExpiresAt: "2026-11-03" },
  { id: "declined", status: "DECLINED", offerExpiresAt: "2026-11-03" },
  { id: "draft", status: "DRAFT", offerExpiresAt: "2026-11-03" },
  { id: "submitted", status: "SUBMITTED", offerExpiresAt: "2026-11-02" },
  { id: "missing", status: "QUOTED", offerExpiresAt: null },
  { id: "invalid", status: "QUOTED", offerExpiresAt: "2026-02-30" },
].map(q => ({ ...q, accountId: q.id, effectiveDate: "2027-01-01", premium: 1000 }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  // UTC is already tomorrow; the agency is still on November3.
  vi.setSystemTime(new Date("2026-11-04T00:30:00Z"));
  h.quotes.mockResolvedValue({ data: quotes });
  h.accounts.mockResolvedValue({ data: quotes.map(q => ({ id: q.id, name: `Account ${q.id}` })) });
  h.carriers.mockResolvedValue({ data: [] });
});
afterEach(() => vi.useRealTimers());
async function openPage() {
  render(<MemoryRouter><QuotesList /></MemoryRouter>);
  return screen.findByRole("table", { name: "All carrier quotes" });
}
function names(table: HTMLElement) {
  return within(table).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0].textContent);
}

describe("quote offer expiry views", () => {
  it('shows the full client cost, including supplier charges, without disclosing agency earnings', async () => {
    h.quotes.mockResolvedValue({ data: [{ ...quotes[0], premium: 1000.01, brokerFee: 10.02, passThroughCharges: [{ id: 'tax', kind: 'TAX', description: 'Supplier tax', amountCents: 503 }], commissionPct: 72.125, notes: 'Private quote note' }] });
    const table = await openPage();
    expect(table).toHaveTextContent('Supplier tax: $5.03');
    expect(table).toHaveTextContent('HOA broker fee: $10.02');
    expect(table).toHaveTextContent('$1,015.06 client policy total');
    expect(table).not.toHaveTextContent('72.125');
    expect(table).not.toHaveTextContent('Private quote note');
  });

  it("combines expiry and status views, counting only issued open offers", async () => {
    const table = await openPage();
    expect(screen.getByRole("button", { name: "In flight" })).toHaveAttribute("aria-pressed", "true");
    expect(names(table)).toHaveLength(8);
    expect(screen.getByRole("option", { name: "Expiring within 7 days (2)" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Expired (1)" })).toBeVisible();
    const expiry = screen.getByRole("combobox", { name: "Offer expiry" });
    expect(expiry).toHaveAccessibleDescription(/valid through the recorded date, including today/);
    fireEvent.change(expiry, { target: { value: "expiring" } });
    expect(names(table)).toEqual(["Account soon", "Account today"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(names(table)).toEqual(["Account soon", "Account today"]);
    fireEvent.change(expiry, { target: { value: "expired" } });
    expect(names(table)).toEqual(["Account expired"]);
    fireEvent.click(screen.getByRole("button", { name: "In flight" }));
    expect(names(table)).toEqual(["Account expired"]);
    fireEvent.change(expiry, { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(names(table)).toHaveLength(11);
    const bound = screen.getByText("Account bound").closest("tr")!;
    expect(within(bound).queryByText("Expired")).toBeNull();
    expect(within(bound).getByText("2026-11-02")).toHaveAttribute("dateTime", "2026-11-02");
    expect(screen.getByText("Account missing").closest("tr")).toHaveTextContent("Not recorded");
    expect(screen.getByText("Account invalid").closest("tr")).toHaveTextContent("Invalid date");
  });

  it("sorts real offer dates, leaving missing/invalid dates last in both directions", async () => {
    const table = await openPage();
    const sort = screen.getByRole("button", { name: "Offer valid through" });
    fireEvent.click(sort);
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(names(table).slice(0, 2)).toEqual(["Account expired", "Account submitted"]);
    expect(names(table).slice(-2)).toEqual(["Account missing", "Account invalid"]);
    fireEvent.click(sort);
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(names(table)[0]).toBe("Account later");
    expect(names(table).slice(-2)).toEqual(["Account missing", "Account invalid"]);
  });

  it("updates badges and filtered results when the agency day changes", async () => {
    const table = await openPage();
    fireEvent.change(screen.getByRole("combobox", { name: "Offer expiry" }), { target: { value: "expiring" } });
    expect(names(table)).toContain("Account today");
    expect(within(screen.getByText("Account today").closest("tr")!).getByText("Expires today")).toBeVisible();
    await act(async () => {
      vi.setSystemTime(new Date("2026-11-04T05:30:00Z"));
      fireEvent.focus(window);
    });
    expect(names(table)).not.toContain("Account today");
    expect(screen.getByRole("option", { name: "Expired (2)" })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Offer expiry" }), { target: { value: "expired" } });
    expect(names(table)).toEqual(["Account expired", "Account today"]);
  });

  it("explains an empty expiry view without claiming that all quotes are absent", async () => {
    h.quotes.mockResolvedValue({ data: quotes.filter(q => ["missing", "invalid", "bound", "draft"].includes(q.id)) });
    await openPage();
    fireEvent.change(screen.getByRole("combobox", { name: "Offer expiry" }), { target: { value: "expired" } });
    expect(screen.getByText("No quotes match these filters.")).toBeVisible();
    expect(screen.queryByText("No quotes.")).toBeNull();
    expect(screen.getByRole("option", { name: "Expired (0)" })).toBeVisible();
  });
});
