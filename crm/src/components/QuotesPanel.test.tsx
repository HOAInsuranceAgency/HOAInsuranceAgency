import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../lib/pagination";
import type { Account } from "../lib/client";

const h = vi.hoisted(() => ({ quotes: vi.fn(), update: vi.fn(), carriers: vi.fn(), getQuote: vi.fn(), policies: vi.fn(), createPolicy: vi.fn(), accountUpdate: vi.fn(), request: vi.fn(), children: vi.fn() }));
vi.mock("./QuotePackages", () => ({ default: () => null }));
vi.mock("./CoverageForm", () => ({ default: () => null }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({
  client: { models: { Quote: { list: h.quotes, update: h.update, get: h.getQuote }, Carrier: { list: h.carriers }, Policy: { list: h.policies, create: h.createPolicy }, Account: { update: h.accountUpdate }, Invoice: { list: h.children }, Document: { list: h.children }, PfLoan: { list: h.children } } },
  listAllPages: (...args: Parameters<typeof listAllPages>) => listAllPages(...args),
  friendlyError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  fmtDate: (value: string) => value || "—",
  fmtMoney: (value: number) => value == null ? "—" : `$${value}`,
}));
import QuotesPanel from "./QuotesPanel";
import { emptyCommercialPlan } from "../../../shared/quotePackages";

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
  h.getQuote.mockResolvedValue({ data: quote });
  h.policies.mockResolvedValue({ data: [] });
  h.createPolicy.mockResolvedValue({ data: { id: "policy-a" } });
  h.accountUpdate.mockResolvedValue({ data: { ...account, stage: "CLIENT" } });
  h.children.mockResolvedValue({ data: [] });
  h.request.mockResolvedValue({ items: [{ plan: emptyCommercialPlan(account.id) }] });
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


async function openBind() {
  fireEvent.click(await screen.findByRole("button", { name: "Bind" }));
  fireEvent.change(screen.getByLabelText("Bill type (required)"), { target: { value: "DIRECT" } });
  fireEvent.change(screen.getByLabelText("Policy number (can be added later)"), { target: { value: "POL-123" } });
}
describe("binding recovery", () => {
  it("preserves the bill type and policy number after a failed preflight and allows retry", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.getQuote.mockRejectedValueOnce(new Error("Temporary quote read failure"));
    const changed = vi.fn();
    render(<QuotesPanel account={account} onAccountChange={changed} />);
    await openBind();
    fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await screen.findByText("Temporary quote read failure");
    expect(screen.getByLabelText("Policy number (can be added later)")).toHaveValue("POL-123");
    expect(screen.getByLabelText("Bill type (required)")).toHaveValue("DIRECT");
    expect(h.createPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ stage: "CLIENT" })));
    expect(h.createPolicy).toHaveBeenCalledWith(expect.objectContaining({ policyNumber: "POL-123", billType: "DIRECT" }));
  });

  it("checks later filtered policy pages before allowing another bind", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.policies.mockResolvedValueOnce({ data: [], nextToken: "later" }).mockResolvedValueOnce({ data: [{ id: "existing", policyNumber: "EXISTING-1" }] });
    render(<QuotesPanel account={account} onAccountChange={vi.fn()} />);
    await openBind(); fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await screen.findByText(/already bound to policy EXISTING-1/);
    expect(h.policies).toHaveBeenLastCalledWith({ filter: { quoteId: { eq: quote.id } }, nextToken: "later" });
    expect(h.createPolicy).not.toHaveBeenCalled();
  });

  it("reports a failed lead conversion after policy creation without presenting another bind", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    h.accountUpdate.mockResolvedValue({ data: null, errors: [{ message: "Conversion unavailable" }] });
    const changed = vi.fn();
    render(<QuotesPanel account={account} onAccountChange={changed} />);
    await openBind(); fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await screen.findByText(/Policy created, but binding did not finish: Conversion unavailable/);
    expect(h.createPolicy).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm bind" })).toBeNull();
  });

  it("keeps old bind completion from replacing the current account", async () => {
    h.quotes.mockResolvedValue({ data: [quote] });
    let finish!: (value: unknown) => void;
    h.accountUpdate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const view = render(<QuotesPanel account={account} onAccountChange={changed} />);
    await openBind(); fireEvent.click(screen.getByRole("button", { name: "Confirm bind" }));
    await waitFor(() => expect(h.accountUpdate).toHaveBeenCalledTimes(1));
    view.rerender(<QuotesPanel account={{ ...account, id: "account-b" }} onAccountChange={changed} />);
    await act(async () => finish({ data: { ...account, stage: "CLIENT" } }));
    expect(changed).not.toHaveBeenCalled();
  });
});
