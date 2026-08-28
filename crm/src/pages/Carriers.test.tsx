import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
  models.AppetiteGuide.list.mockResolvedValue({ data: GUIDES, nextToken: null });
});

const renderPage = async () => {
  render(
    <MemoryRouter>
      <Carriers />
    </MemoryRouter>
  );
  // The finder is gated on both reads landing — before that, "no appetite" is
  // a false negative rather than a placeholder.
  expect(await screen.findByText("Appetite finder")).toBeInTheDocument();
};

/**
 * The form's labels sit beside their control rather than wrapping it, so
 * `getByLabelText` has nothing to follow. `selector: "label"` keeps this off
 * the table headers of the same name.
 */
const field = (label: string) => {
  const el = screen
    .getByText(label, { selector: "label" })
    .parentElement!.querySelector("input, select");
  if (!el) throw new Error(`no control beside the "${label}" label`);
  return el as HTMLInputElement | HTMLSelectElement;
};

/** The finder's own results table — not the carrier list above it. */
const results = () => {
  const header = screen.getByText("Appetite finder").closest(".card")!;
  return within(header as HTMLElement);
};

describe("the carrier list", () => {
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

describe("the appetite finder", () => {
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
