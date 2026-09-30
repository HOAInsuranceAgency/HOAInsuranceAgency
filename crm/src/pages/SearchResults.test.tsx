import { fireEvent, render, screen, within } from "@testing-library/react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real search index, ranking and pagination. The generated client
// returns only the caller's authorized records, just as it does in the app.
const models = vi.hoisted(() => ({
  Account: { list: vi.fn() },
  Contact: { list: vi.fn() },
  Policy: { list: vi.fn() },
  Invoice: { list: vi.fn() },
  Certificate: { list: vi.fn() },
  Carrier: { list: vi.fn() },
  Document: { list: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models, mutations: {} }),
}));
vi.mock("aws-amplify/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ userId: "u1" })),
}));

import SearchResults from "./SearchResults";

const page = (data: unknown[], nextToken: string | null = null) => ({ data, nextToken });
const accounts = Array.from({ length: 121 }, (_, i) => ({
  id: `a${i + 1}`,
  name: `Harbor ${String(i + 1).padStart(3, "0")} HOA`,
  city: "Springfield",
  state: "FL",
  stage: i % 2 === 0 ? "LEAD" : "CLIENT",
}));

function LocationSpy() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderResults(query = "harbor") {
  render(
    <MemoryRouter initialEntries={[`/search?q=${query}`]}>
      <SearchResults />
      <Link to="/search?q=springfield">Change query</Link>
      <LocationSpy />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const model of Object.values(models)) model.list.mockResolvedValue(page([]));
});

describe("SearchResults", () => {
  it("makes every matching lead and client reachable across backend and display pages", async () => {
    // The backend is not alphabetically ordered; one filtered page is empty
    // but still has a cursor. All pages must enter the ranked result set.
    models.Account.list.mockImplementation(async ({ nextToken }) => {
      if (!nextToken) return page(accounts.slice(60).reverse(), "empty");
      if (nextToken === "empty") return page([], "last");
      return page(accounts.slice(0, 60).reverse());
    });
    renderResults();

    const table = await screen.findByRole("table", { name: "Accounts" });
    expect(within(table).getAllByRole("row")).toHaveLength(50);
    expect(screen.getByText("Showing 50 of 121")).toBeInTheDocument();
    expect(screen.queryByText("Harbor 121 HOA")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more accounts" }));
    expect(within(table).getAllByRole("row")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Show more accounts" }));

    const names = within(table).getAllByRole("row").map(row => row.firstElementChild?.textContent);
    expect(names).toEqual(accounts.map(account => account.name));
    expect(new Set(names).size).toBe(121);
    expect(screen.getByText("Showing 121 of 121")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more accounts/ })).not.toBeInTheDocument();
    expect(models.Account.list.mock.calls.map(([options]) => options.nextToken)).toEqual([
      undefined, "empty", "last",
    ]);
    // Revealing more uses the same authorized snapshot instead of fetching
    // another loosely paginated list that could skip or duplicate records.
    expect(models.Account.list).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByText("Harbor 121 HOA"));
    expect(screen.getByTestId("location")).toHaveTextContent("/accounts/a121");
  });

  it("expands contacts independently and keeps email matches linked to their account", async () => {
    models.Account.list.mockResolvedValue(page(accounts));
    models.Contact.list.mockResolvedValue(page(Array.from({ length: 51 }, (_, i) => ({
      id: `c${i + 1}`,
      accountId: `a${i + 1}`,
      name: `Person ${String(i + 1).padStart(3, "0")}`,
      email: `person${i + 1}@harbor.org`,
    }))));
    renderResults();

    const contactTable = await screen.findByRole("table", { name: "Contacts" });
    const accountTable = screen.getByRole("table", { name: "Accounts" });
    expect(within(contactTable).getAllByRole("row")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show more contacts" }));
    expect(within(contactTable).getAllByRole("row")).toHaveLength(51);
    expect(within(accountTable).getAllByRole("row")).toHaveLength(50);
    expect(screen.getByText("person51@harbor.org · Harbor 051 HOA")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Person 051"));
    expect(screen.getByTestId("location")).toHaveTextContent("/accounts/a51");
  });

  it("starts each new query at the first display page", async () => {
    models.Account.list.mockResolvedValue(page(accounts));
    renderResults();
    await screen.findByRole("table", { name: "Accounts" });
    fireEvent.click(screen.getByRole("button", { name: "Show more accounts" }));
    expect(screen.getByText("Showing 100 of 121")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Change query" }));
    expect(screen.getByText("Everything matching “springfield”")).toBeInTheDocument();
    expect(screen.getByText("Showing 50 of 121")).toBeInTheDocument();
    expect(screen.queryByText("Harbor 051 HOA")).not.toBeInTheDocument();
    expect(models.Account.list).toHaveBeenCalledTimes(1);
  });

  it("does not offer another page when every match already fits", async () => {
    models.Account.list.mockResolvedValue(page(accounts.slice(0, 2)));
    renderResults();
    const table = await screen.findByRole("table", { name: "Accounts" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Showing 2 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more accounts/ })).not.toBeInTheDocument();
  });
});
