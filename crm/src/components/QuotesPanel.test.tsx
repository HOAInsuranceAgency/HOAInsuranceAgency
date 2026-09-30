import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../lib/pagination";
import type { Account } from "../lib/client";

const h = vi.hoisted(() => ({ quotes: vi.fn(), update: vi.fn(), carriers: vi.fn() }));
vi.mock("./QuotePackages", () => ({ default: () => null }));
vi.mock("./CoverageForm", () => ({ default: () => null }));
vi.mock("../lib/communications", () => ({ communicationRequest: vi.fn() }));
vi.mock("../lib/client", () => ({
  client: { models: { Quote: { list: h.quotes, update: h.update }, Carrier: { list: h.carriers } } },
  listAllPages: (...args: Parameters<typeof listAllPages>) => listAllPages(...args),
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  fmtDate: (value: string) => value || "—",
  fmtMoney: (value: number) => value == null ? "—" : `$${value}`,
}));
import QuotesPanel from "./QuotesPanel";

const account = { id: "account-a", stage: "LEAD" } as Account;
const quote = {
  id: "quote-a", accountId: account.id, carrierId: "carrier-a", status: "QUOTED",
  lines: ["Commercial Property"], premium: 12000, commissionPct: 10,
  effectiveDate: "2026-10-01", createdAt: "2026-09-01T12:00:00Z",
};
function pendingQuotes() {
  let resolve!: (result: { data: typeof quote[] }) => void;
  const promise = new Promise<{ data: typeof quote[] }>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.carriers.mockResolvedValue({ data: [{ id: "carrier-a", name: "Harbor Mutual" }] });
  h.update.mockResolvedValue({ data: quote });
});

describe("quote loading and retries", () => {
  it.each([false, true])("keeps a failed load in the loading state until its retry settles (has quotes: %s)", async hasQuotes => {
    const retry = pendingQuotes();
    h.quotes.mockRejectedValueOnce(new Error("Quote read failed"))
      .mockReturnValueOnce(retry.promise);
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry quotes" }));
    expect(screen.getByText("Loading quotes…")).toBeVisible();
    expect(screen.queryByText("No quotes yet")).toBeNull();
    expect(screen.queryByText("Quote read failed")).toBeNull();

    await act(async () => retry.resolve({ data: hasQuotes ? [quote] : [] }));
    expect(screen.queryByText("Loading quotes…")).toBeNull();
    if (hasQuotes) {
      expect(screen.getByRole("table", { name: "Carrier quotes" })).toBeVisible();
      expect(screen.getByText("Harbor Mutual")).toBeVisible();
      expect(screen.queryByText("No quotes yet")).toBeNull();
    } else {
      expect(screen.getByText("No quotes yet")).toBeVisible();
    }
  });

  it("keeps known quotes visible while refreshing after a status change", async () => {
    const refresh = pendingQuotes();
    h.quotes.mockResolvedValueOnce({ data: [quote] }).mockReturnValueOnce(refresh.promise);
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    await screen.findByRole("table", { name: "Carrier quotes" });
    fireEvent.change(screen.getByRole("combobox", { name: "Quote status" }), { target: { value: "PRESENTED" } });
    await waitFor(() => expect(h.quotes).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Harbor Mutual")).toBeVisible();
    expect(screen.getByRole("table", { name: "Carrier quotes" }).parentElement).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading quotes…")).toBeNull();
    expect(screen.queryByText("No quotes yet")).toBeNull();
    await act(async () => refresh.resolve({ data: [{ ...quote, status: "PRESENTED" }] }));
    expect(screen.getByRole("combobox", { name: "Quote status" })).toHaveValue("PRESENTED");
  });
});
