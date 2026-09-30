import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  opinionIndex: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ useIsAdmin: mocks.isAdmin }));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: { PfCounselOpinion: { listPfCounselOpinionByJurisdictionAndEffectiveAt: mocks.opinionIndex } },
  }),
}));
vi.mock("../components/FinancingAdmin", () => ({
  FinancingAdmin: ({ onChanged }: { onChanged: () => Promise<void> }) => (
    <section aria-label="Admin controls">
      <button type="button" onClick={() => void onChanged()}>Opinion saved</button>
    </section>
  ),
}));

import Financing from "./Financing";

type Opinion = { id: string; jurisdiction: string; effectiveAt: string; reviewBy: string };
type OpinionPage = { data: Opinion[] | null; nextToken?: string | null; errors?: { message: string }[] };
const opinion = (jurisdiction = "VA", changes: Partial<Opinion> = {}): Opinion => ({
  id: `opinion-${jurisdiction}`,
  jurisdiction,
  effectiveAt: "2020-01-01",
  reviewBy: "2090-12-31",
  ...changes,
});
const page = (data: Opinion[] = [], nextToken: string | null = null): OpinionPage => ({ data, nextToken });
const list = () => within(screen.getByRole("list", { name: "State availability" }));
const state = (name: string, status: string) => list().getByRole("listitem", { name: `${name}: ${status}` });
async function renderReady() {
  render(<Financing />);
  await waitFor(() => expect(state("Virginia", "Unavailable")).toBeInTheDocument());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAdmin.mockReturnValue(false);
  mocks.opinionIndex.mockResolvedValue(page());
});

describe("Financing state finder", () => {
  it("shows effective availability for every state without producer-facing regulatory detail", async () => {
    await renderReady();

    expect(list().getAllByRole("listitem")).toHaveLength(51);
    expect(state("Alaska", "Available")).toBeInTheDocument();
    expect(state("California", "Unavailable")).toBeInTheDocument();
    // Arkansas is marked open in the source file, but its unverified rate
    // ceiling must still prevent the producer from treating it as available.
    expect(state("Arkansas", "Unavailable")).toBeInTheDocument();
    expect(state("Rhode Island", "Available")).toHaveTextContent("Incorporated associations");
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/SHA-256|Max APR|Counsel opinions|License required|Amendment 89/)).not.toBeInTheDocument();
  });

  it("finds states by name and abbreviation regardless of case or surrounding spaces", async () => {
    await renderReady();
    const search = screen.getByRole("searchbox", { name: "Find a state" });
    await userEvent.type(search, "  VIRGINIA  ");
    expect(list().getAllByRole("listitem")).toHaveLength(2);
    expect(state("Virginia", "Unavailable")).toBeInTheDocument();
    expect(state("West Virginia", "Available")).toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, " aK ");
    expect(list().getAllByRole("listitem")).toHaveLength(1);
    expect(state("Alaska", "Available")).toBeInTheDocument();
  });

  it("filters availability and clears an empty search back to all states", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "Available" }));
    expect(list().getAllByRole("listitem").every(item => item.getAttribute("aria-label")?.endsWith(": Available"))).toBe(true);
    expect(list().queryByRole("listitem", { name: "Arkansas: Unavailable" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Unavailable" }));
    expect(list().getAllByRole("listitem").every(item => item.getAttribute("aria-label")?.endsWith(": Unavailable"))).toBe(true);
    const search = screen.getByRole("searchbox", { name: "Find a state" });
    await userEvent.type(search, "Atlantis");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /clear|reset/i }));
    expect(search).toHaveValue("");
    expect(list().getAllByRole("listitem")).toHaveLength(51);
    expect(screen.getByRole("button", { name: "All states" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps administrator controls unmounted until the disclosure is opened", async () => {
    mocks.isAdmin.mockReturnValue(true);
    await renderReady();
    const summary = screen.getByText("Administration");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("region", { name: "Admin controls" })).not.toBeInTheDocument();

    await userEvent.click(summary);
    expect(await screen.findByRole("region", { name: "Admin controls" })).toBeInTheDocument();
    await userEvent.click(summary);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Admin controls" })).not.toBeInTheDocument());
  });
});

describe("conditional financing availability", () => {
  it("waits for all opinion pages, including empty pages, before making a state available", async () => {
    const lastPage = deferred<OpinionPage>();
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }, options: { nextToken?: string }) => {
      if (jurisdiction !== "VA") return Promise.resolve(page());
      if (!options.nextToken) return Promise.resolve(page([], "va-second"));
      if (options.nextToken === "va-second") return Promise.resolve(page([], "va-third"));
      return lastPage.promise;
    });
    render(<Financing />);
    await waitFor(() => expect(mocks.opinionIndex).toHaveBeenCalledWith(
      { jurisdiction: "VA" }, expect.objectContaining({ nextToken: "va-third" }),
    ));
    expect(state("Virginia", "Checking…")).toBeInTheDocument();
    expect(list().queryByRole("listitem", { name: "Virginia: Available" })).not.toBeInTheDocument();
    await act(async () => { lastPage.resolve(page([opinion()])); });
    expect(await screen.findByRole("listitem", { name: "Virginia: Available" })).toBeInTheDocument();
  });

  it("does not approve an expired or future opinion", async () => {
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }) => Promise.resolve(page(
      jurisdiction === "VA" ? [opinion("VA", { reviewBy: "2020-12-31" }), opinion("VA", {
        id: "future-va", effectiveAt: "2090-01-01", reviewBy: "2091-01-01",
      })] : [],
    )));
    await renderReady();
    expect(state("Virginia", "Unavailable")).toBeInTheDocument();
  });

  it("does not advertise a partial successful read when a later page fails, and can retry", async () => {
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }, options: { nextToken?: string }) => Promise.resolve(
      jurisdiction !== "VA" ? page() : options.nextToken
        ? { data: null, errors: [{ message: "Page unavailable" }] }
        : page([opinion()], "va-second"),
    ));
    render(<Financing />);
    expect(await screen.findByRole("listitem", { name: "Virginia: Retry check" })).toBeInTheDocument();
    expect(list().queryByRole("listitem", { name: "Virginia: Available" })).not.toBeInTheDocument();
    // Fixed, non-conditional decisions still work if the live check fails.
    expect(state("Alaska", "Available")).toBeInTheDocument();
    expect(state("California", "Unavailable")).toBeInTheDocument();

    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }) => Promise.resolve(page(jurisdiction === "VA" ? [opinion()] : [])));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("listitem", { name: "Virginia: Available" })).toBeInTheDocument();
  });

  it("stops repeated pagination tokens and leaves live availability unknown", async () => {
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }) => Promise.resolve(
      jurisdiction === "VA" ? page([opinion()], "repeated") : page(),
    ));
    render(<Financing />);
    expect(await screen.findByRole("listitem", { name: "Virginia: Retry check" })).toBeInTheDocument();
    expect(mocks.opinionIndex.mock.calls.filter(([input]) => input.jurisdiction === "VA")).toHaveLength(2);
  });

  it("withholds an old available decision while refreshing, including after a failed refresh", async () => {
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }) => Promise.resolve(page(jurisdiction === "VA" ? [opinion()] : [])));
    render(<Financing />);
    expect(await screen.findByRole("listitem", { name: "Virginia: Available" })).toBeInTheDocument();
    const refreshed = deferred<OpinionPage>();
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }) => jurisdiction === "VA" ? refreshed.promise : Promise.resolve(page()));
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(state("Virginia", "Checking…")).toBeInTheDocument();
    expect(list().queryByRole("listitem", { name: "Virginia: Available" })).not.toBeInTheDocument();
    await act(async () => { refreshed.resolve({ data: null, errors: [{ message: "Refresh unavailable" }] }); });
    expect(await screen.findByRole("listitem", { name: "Virginia: Retry check" })).toBeInTheDocument();
    expect(list().queryByRole("listitem", { name: "Virginia: Available" })).not.toBeInTheDocument();
  });

  it("refreshes producer-facing availability after an administrator changes an opinion", async () => {
    mocks.isAdmin.mockReturnValue(true);
    await renderReady();
    await userEvent.click(screen.getByText("Administration"));
    mocks.opinionIndex.mockImplementation(({ jurisdiction }: { jurisdiction: string }) => Promise.resolve(page(jurisdiction === "OH" ? [opinion("OH")] : [])));
    await userEvent.click(await screen.findByRole("button", { name: "Opinion saved" }));
    const ohio = await screen.findByRole("listitem", { name: "Ohio: Available" });
    expect(ohio).toHaveTextContent(/100,000/);
    expect(ohio).not.toHaveTextContent(/counsel|APR|opinion/i);
  });
});
