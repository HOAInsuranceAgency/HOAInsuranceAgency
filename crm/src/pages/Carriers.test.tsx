import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope — stub generateClient
// rather than the module, so client.ts's real exports (BEST_FIT_BUSINESS,
// fmtMoney) stay intact. Same approach as MarketingTasks.test.tsx.
const models = vi.hoisted(() => ({
  Carrier: { list: vi.fn(), create: vi.fn() },
  AppetiteGuide: { list: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));

import Carriers from "./Carriers";

/**
 * The Appetite Finder, driven the way a producer drives it.
 *
 * The CRM sits behind Cognito magic-link auth, so this screen cannot be
 * opened in a browser without a real sign-in — the same reason
 * `MarketingTasks.test.tsx` gives for testing its render states here. The
 * rules themselves are covered in `lib/appetite.test.ts`; what this file
 * asserts is that the page hands them the right risk and shows the right
 * answer, which is where a typed-but-unwired filter would hide.
 */
const CARRIERS = [
  {
    id: "c-atlantic",
    name: "Atlantic Mutual",
    appointed: true,
    marketType: "MGA",
    states: ["MA"],
    primaryUnderwriterName: "Robin Vega",
    standardCommissionPct: 12,
  },
  {
    id: "c-beacon",
    name: "Beacon Specialty",
    appointed: true,
    marketType: "WHOLESALER",
    states: ["MA"],
    primaryUnderwriterName: null,
    standardCommissionPct: null,
  },
  {
    // Never a finder result, whatever its appetite says.
    id: "c-casco",
    name: "Casco Prospective",
    appointed: false,
    marketType: "DIRECT_CARRIER",
    states: ["MA"],
    primaryUnderwriterName: null,
    standardCommissionPct: null,
  },
];

const GUIDES = [
  {
    id: "g-atlantic",
    carrierId: "c-atlantic",
    linesWritten: ["Commercial Property"],
    bestFitBusiness: ["Clean condo"],
    paperType: "ADMITTED",
    states: [],
    quoteSubmissionLeadTimeDays: 30,
    minValue: null,
    maxValue: null,
    minConstructionYear: null,
    maxConstructionYear: null,
    writesCoastal: false,
    minMilesToCoast: null,
    maxRentalPct: 25,
    maxLosses: 2,
    maxLossIncurred: null,
    notes: null,
  },
  {
    id: "g-beacon",
    carrierId: "c-beacon",
    linesWritten: ["Commercial Property"],
    bestFitBusiness: ["Difficult condo", "High-loss"],
    paperType: "SURPLUS_LINES",
    states: [],
    quoteSubmissionLeadTimeDays: 21,
    minValue: null,
    maxValue: null,
    minConstructionYear: null,
    maxConstructionYear: null,
    writesCoastal: true,
    minMilesToCoast: null,
    maxRentalPct: null,
    maxLosses: null,
    maxLossIncurred: null,
    notes: null,
  },
  {
    id: "g-casco",
    carrierId: "c-casco",
    linesWritten: ["Commercial Property"],
    bestFitBusiness: [],
    paperType: "ADMITTED",
    states: [],
    quoteSubmissionLeadTimeDays: null,
    minValue: null,
    maxValue: null,
    minConstructionYear: null,
    maxConstructionYear: null,
    writesCoastal: null,
    minMilesToCoast: null,
    maxRentalPct: null,
    maxLosses: null,
    maxLossIncurred: null,
    notes: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  models.Carrier.list.mockResolvedValue({ data: CARRIERS, nextToken: null });
  models.Carrier.create.mockResolvedValue({ data: { id: "c-new" } });
  models.AppetiteGuide.list.mockResolvedValue({ data: GUIDES, nextToken: null });
});

function CurrentRoute() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

const renderPage = async ({ openFinder = true } = {}) => {
  render(
    <MemoryRouter initialEntries={["/carriers"]}>
      <Carriers />
      <CurrentRoute />
    </MemoryRouter>
  );
  // The finder is gated on both reads landing — before that, "no appetite" is
  // a false negative rather than a placeholder.
  expect(await screen.findByText("Appetite finder")).toBeInTheDocument();
  if (openFinder) {
    await userEvent.click(screen.getByText("Appetite finder").closest("summary")!);
  }
};

/** Open optional risk fields the same way a producer does before editing. */
const field = (label: string) => {
  const el = screen.getByLabelText(label);
  const section = el.closest("details");
  if (section && !section.open) fireEvent.click(section.querySelector("summary")!);
  return el as HTMLInputElement | HTMLSelectElement;
};

/** The finder's own results table — not the carrier list above it. */
const results = () => {
  const header = screen.getByText("Appetite finder").closest("details")!;
  return within(header as HTMLElement);
};

const directory = () => within(screen.getByRole("table", { name: "Carrier directory" }));

describe("the carrier list", () => {
  it("starts with the directory visible and the appetite finder collapsed", async () => {
    await renderPage({ openFinder: false });
    expect(directory().getAllByRole("link")).toHaveLength(3);
    expect(screen.getByText("Appetite finder").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("searchbox", { name: "Search carriers" })).toBeVisible();
  });

  it("searches carrier names and underwriters without changing appetite results", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.selectOptions(field("State"), "MA");
    expect(results().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search carriers" });
    await user.type(search, "Robin");
    expect(directory().getByRole("link", { name: "Atlantic Mutual" })).toBeInTheDocument();
    expect(directory().queryByRole("link", { name: "Beacon Specialty" })).not.toBeInTheDocument();
    expect(results().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "Casco");
    expect(directory().getByRole("link", { name: "Casco Prospective" })).toBeInTheDocument();
    expect(directory().queryByRole("link", { name: "Atlantic Mutual" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(directory().getAllByRole("link")).toHaveLength(3);
    expect(field("State")).toHaveValue("MA");
    expect(results().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument();
  });

  it("combines appointment, coverage state and market filters and clears them together", async () => {
    const user = userEvent.setup();
    models.Carrier.list.mockResolvedValue({
      data: CARRIERS.map(carrier => carrier.id === "c-beacon" ? { ...carrier, states: ["NH"] } : carrier),
      nextToken: null,
    });
    await renderPage({ openFinder: false });
    const all = screen.getByRole("button", { name: /^All \(3\)$/ });
    const appointed = screen.getByRole("button", { name: /^Appointed \(2\)$/ });
    const prospective = screen.getByRole("button", { name: /^Prospective \(1\)$/ });
    expect(all).toHaveAttribute("aria-pressed", "true");
    await user.click(prospective);
    expect(prospective).toHaveAttribute("aria-pressed", "true");
    expect(directory().getAllByRole("link")).toHaveLength(1);
    expect(directory().getByRole("link", { name: "Casco Prospective" })).toBeInTheDocument();
    await user.click(appointed);
    await user.selectOptions(screen.getByLabelText("Coverage state"), "NH");
    await user.selectOptions(screen.getByLabelText("Market type"), "WHOLESALER");
    expect(directory().getAllByRole("link")).toHaveLength(1);
    expect(directory().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Market type"), "MGA");
    expect(screen.getByText("No carriers match these filters.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Carrier directory" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Coverage state")).toHaveValue("");
    expect(screen.getByLabelText("Market type")).toHaveValue("");
    expect(directory().getAllByRole("link")).toHaveLength(3);
  });

  it("expands coverage and lines without following the clickable carrier row", async () => {
    const user = userEvent.setup();
    models.Carrier.list.mockResolvedValue({
      data: CARRIERS.map(carrier => carrier.id === "c-atlantic" ? { ...carrier, states: ["MA", "FL", "NH"] } : carrier),
      nextToken: null,
    });
    models.AppetiteGuide.list.mockResolvedValue({
      data: GUIDES.map(guide => guide.id === "g-atlantic" ? {
        ...guide,
        linesWritten: ["Commercial Property", "General Liability", "Directors & Officers", "Workers Compensation"],
      } : guide),
      nextToken: null,
    });
    await renderPage({ openFinder: false });
    const row = directory().getByRole("link", { name: "Atlantic Mutual" }).closest("tr")!;
    const coverage = within(row).getByLabelText("Coverage for Atlantic Mutual").closest("details")!;
    const lines = within(row).getByLabelText("Lines written for Atlantic Mutual").closest("details")!;
    expect(coverage).not.toHaveAttribute("open");
    expect(lines).not.toHaveAttribute("open");
    await user.click(within(coverage).getByText("3 states"));
    await user.click(lines.querySelector("summary")!);
    expect(coverage).toHaveAttribute("open");
    expect(coverage).toHaveTextContent("MA");
    expect(coverage).toHaveTextContent("FL");
    expect(coverage).toHaveTextContent("NH");
    expect(lines).toHaveAttribute("open");
    expect(lines).toHaveTextContent("Directors & Officers");
    expect(lines).toHaveTextContent("Workers Compensation");
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/carriers");
  });

  it("opens the carrier detail through keyboard activation of its named link", async () => {
    const user = userEvent.setup();
    await renderPage({ openFinder: false });
    const link = directory().getByRole("link", { name: "Atlantic Mutual" });
    expect(link).toHaveAttribute("href", "/carriers/c-atlantic");
    link.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/carriers/c-atlantic");
  });

  it("sorts carriers through keyboard activation and announces the sort direction", async () => {
    const user = userEvent.setup();
    await renderPage({ openFinder: false });
    const sort = directory().getByRole("button", { name: "Carrier" });
    const header = sort.closest("th")!;
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(directory().getAllByRole("link").map(link => link.textContent)).toEqual([
      "Atlantic Mutual", "Beacon Specialty", "Casco Prospective",
    ]);
    sort.focus();
    await user.keyboard("{Enter}");
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(directory().getAllByRole("link").map(link => link.textContent)).toEqual([
      "Casco Prospective", "Beacon Specialty", "Atlantic Mutual",
    ]);
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/carriers");
  });

  it("includes carriers and appetite guides from later pages, including after an empty page", async () => {
    models.Carrier.list
      .mockResolvedValueOnce({ data: [CARRIERS[0]], nextToken: "carrier-page-2" })
      .mockResolvedValueOnce({ data: [], nextToken: "carrier-page-3" })
      .mockResolvedValueOnce({ data: CARRIERS.slice(1), nextToken: null });
    models.AppetiteGuide.list
      .mockResolvedValueOnce({ data: [GUIDES[0]], nextToken: "guide-page-2" })
      .mockResolvedValueOnce({ data: GUIDES.slice(1), nextToken: null });

    await renderPage();
    expect(models.Carrier.list).toHaveBeenNthCalledWith(2, { nextToken: "carrier-page-2" });
    expect(models.Carrier.list).toHaveBeenNthCalledWith(3, { nextToken: "carrier-page-3" });
    expect(models.AppetiteGuide.list).toHaveBeenNthCalledWith(2, { nextToken: "guide-page-2" });
    const beacon = screen.getByText("Beacon Specialty").closest("tr")!;
    expect(within(beacon).getByText("E&S")).toBeInTheDocument();
    await userEvent.selectOptions(field("Coastal?"), "yes");
    expect(results().getByText("Beacon Specialty")).toBeInTheDocument();
    expect(results().queryByText("Atlantic Mutual")).not.toBeInTheDocument();
  });

  it("waits for the last guide page before offering an appetite verdict", async () => {
    let finish!: (page: { data: typeof GUIDES; nextToken: null }) => void;
    const lastPage = new Promise<{ data: typeof GUIDES; nextToken: null }>((resolve) => { finish = resolve; });
    models.AppetiteGuide.list
      .mockResolvedValueOnce({ data: [GUIDES[0]], nextToken: "guide-page-2" })
      .mockReturnValueOnce(lastPage);
    render(<MemoryRouter><Carriers /></MemoryRouter>);
    await waitFor(() => expect(models.AppetiteGuide.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Appetite finder")).not.toBeInTheDocument();
    await act(async () => { finish({ data: GUIDES.slice(1), nextToken: null }); });
    expect(await screen.findByText("Appetite finder")).toBeInTheDocument();
  });

  it.each(["Carrier", "AppetiteGuide"] as const)("withholds appetite results when a later %s page fails", async (model) => {
    models[model].list
      .mockResolvedValueOnce({ data: model === "Carrier" ? [CARRIERS[0]] : [GUIDES[0]], nextToken: "next-page" })
      .mockResolvedValueOnce({ data: [], nextToken: null, errors: [{ message: "Later page unavailable" }] });
    render(<MemoryRouter><Carriers /></MemoryRouter>);
    expect(await screen.findByText("Later page unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Appetite finder")).not.toBeInTheDocument();
    expect(screen.queryByText(/No appointed carrier has appetite/)).not.toBeInTheDocument();
  });

  it("shows the market type, and derives paper from the guides", async () => {
    await renderPage();
    const row = screen.getByText("Atlantic Mutual").closest("tr")!;
    expect(within(row).getByText("MGA")).toBeInTheDocument();
    expect(within(row).getByText("Admitted")).toBeInTheDocument();

    const beacon = screen.getByText("Beacon Specialty").closest("tr")!;
    expect(within(beacon).getByText("Wholesaler")).toBeInTheDocument();
    expect(within(beacon).getByText("E&S")).toBeInTheDocument();
  });
});

describe("adding a carrier", () => {
  it("submits on Enter, locks pending fields, and retains the form after a failure for retry", async () => {
    const user = userEvent.setup();
    let fail!: (reason: Error) => void;
    models.Carrier.create.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await renderPage({ openFinder: false });
    await user.click(screen.getByRole("button", { name: /Add carrier/ }));
    const form = screen.getByRole("form", { name: "Add carrier" });
    const name = within(form).getByLabelText("Carrier name *");
    const status = within(form).getByLabelText("Status");
    await user.type(name, "  New Specialty  ");
    await user.selectOptions(status, "0");
    await user.click(name);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(models.Carrier.create).toHaveBeenCalledTimes(1));
    expect(models.Carrier.create).toHaveBeenCalledWith({ name: "New Specialty", appointed: false });
    expect(name).toBeDisabled();
    expect(status).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(form);
    expect(models.Carrier.create).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error("Carrier temporarily unavailable")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Carrier temporarily unavailable");
    expect(name).toBeEnabled();
    expect(name).toHaveValue("  New Specialty  ");
    expect(status).toHaveValue("0");
    await user.click(within(form).getByRole("button", { name: "Create carrier" }));
    await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/carriers/c-new"));
    expect(models.Carrier.create).toHaveBeenCalledTimes(2);
  });
});

describe("the appetite finder", () => {
  it("retains the risk while refresh and retry withhold stale appetite results", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.selectOptions(field("State"), "MA");
    await user.type(field("Rented units (%)"), "40");
    expect(results().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument();
    let finish!: (page: { data: typeof GUIDES; nextToken: null; errors: { message: string }[] }) => void;
    models.AppetiteGuide.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(results().queryByRole("table", { name: "Appetite matches" })).not.toBeInTheDocument();
    expect(results().getByRole("status")).toHaveTextContent("Appetite results are unavailable");
    expect(field("State")).toHaveValue("MA");
    expect(field("Rented units (%)")).toHaveValue(40);
    await act(async () => { finish({ data: [], nextToken: null, errors: [{ message: "Guide refresh unavailable" }] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Guide refresh unavailable");
    expect(results().queryByRole("table", { name: "Appetite matches" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry appetite guides" }));
    await waitFor(() => expect(results().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument());
    expect(results().queryByRole("link", { name: "Atlantic Mutual" })).not.toBeInTheDocument();
    expect(field("State")).toHaveValue("MA");
    expect(field("Rented units (%)")).toHaveValue(40);
  });

  it("stays quiet until something is asked of it", async () => {
    await renderPage();
    expect(
      screen.queryByText(/No appointed carrier has appetite/)
    ).not.toBeInTheDocument();
  });

  it("drops a carrier that declines coastal, and keeps the one that writes it", async () => {
    await renderPage();
    await userEvent.selectOptions(field("Coastal?"), "yes");

    await waitFor(() =>
      expect(results().getByText("Beacon Specialty")).toBeInTheDocument()
    );
    expect(results().queryByText("Atlantic Mutual")).not.toBeInTheDocument();
  });

  it("drops a carrier whose rental cap the risk exceeds", async () => {
    await renderPage();
    await userEvent.type(field("Rented units (%)"), "40");

    await waitFor(() =>
      expect(results().getByText("Beacon Specialty")).toBeInTheDocument()
    );
    expect(results().queryByText("Atlantic Mutual")).not.toBeInTheDocument();
  });

  it("keeps optional risk criteria active when their details are collapsed", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.type(field("Rented units (%)"), "40");
    const more = screen.getByText("More risk details").closest("summary")!;
    await user.click(more);
    expect(more.closest("details")).not.toHaveAttribute("open");
    expect(results().getByRole("link", { name: "Beacon Specialty" })).toBeInTheDocument();
    expect(results().queryByRole("link", { name: "Atlantic Mutual" })).not.toBeInTheDocument();
    await user.click(more);
    expect(field("Rented units (%)")).toHaveValue(40);
  });

  it("keeps a carrier at the edge of its cap rather than just under it", async () => {
    await renderPage();
    await userEvent.type(field("Rented units (%)"), "25");

    await waitFor(() =>
      expect(results().getByText("Atlantic Mutual")).toBeInTheDocument()
    );
  });

  it("drops a carrier over its loss count", async () => {
    await renderPage();
    await userEvent.type(field("Losses (last 5 yrs)"), "3");

    await waitFor(() =>
      expect(results().getByText("Beacon Specialty")).toBeInTheDocument()
    );
    expect(results().queryByText("Atlantic Mutual")).not.toBeInTheDocument();
  });

  it("narrows to one paper when asked, and to the other when asked", async () => {
    await renderPage();
    await userEvent.selectOptions(field("Paper"), "ADMITTED");
    await waitFor(() =>
      expect(results().getByText("Atlantic Mutual")).toBeInTheDocument()
    );
    expect(results().queryByText("Beacon Specialty")).not.toBeInTheDocument();

    await userEvent.selectOptions(field("Paper"), "SURPLUS_LINES");
    await waitFor(() =>
      expect(results().getByText("Beacon Specialty")).toBeInTheDocument()
    );
    expect(results().queryByText("Atlantic Mutual")).not.toBeInTheDocument();
  });

  it("never surfaces a prospective appointment, however well it fits", async () => {
    await renderPage();
    await userEvent.selectOptions(field("State"), "MA");

    await waitFor(() =>
      expect(results().getByText("Atlantic Mutual")).toBeInTheDocument()
    );
    expect(results().queryByText("Casco Prospective")).not.toBeInTheDocument();
  });

  it("shows best-fit business beside the result without filtering on it", async () => {
    await renderPage();
    await userEvent.selectOptions(field("State"), "MA");

    await waitFor(() =>
      expect(results().getByText("Difficult condo, High-loss")).toBeInTheDocument()
    );
    // Atlantic's tags say nothing about this search and it is still here —
    // best fit ranks by eye, it does not exclude.
    expect(results().getByText("Clean condo")).toBeInTheDocument();
  });

  it("spells out the restrictions that decided the match", async () => {
    await renderPage();
    await userEvent.selectOptions(field("State"), "MA");

    await waitFor(() =>
      expect(
        results().getByText("no coastal · rentals ≤25% · ≤2 losses/5yr")
      ).toBeInTheDocument()
    );
  });

  it("says so when nothing fits", async () => {
    await renderPage();
    // Beacon declines nothing, so exclude it on paper and Atlantic on rentals.
    await userEvent.selectOptions(field("Paper"), "ADMITTED");
    await userEvent.type(field("Rented units (%)"), "80");

    expect(
      await screen.findByText("No appointed carrier has appetite for this risk.")
    ).toBeInTheDocument();
  });
});
