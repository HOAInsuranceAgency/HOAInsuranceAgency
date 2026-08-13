import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact — the
// same approach as client.test.ts and storage.test.ts.
const models = vi.hoisted(() => ({
  MarketingTask: { list: vi.fn(), update: vi.fn() },
  Quote: { list: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
const { MarketingTask } = models;

import AccountMarketingTasks, { AllMarketingTasks } from "./MarketingTasks";

/**
 * The four render states of a migrated read.
 *
 * `AllMarketingTasks` stands in for the thirteen call sites migrated onto
 * `useAsyncResource`: it is the one with no props, and it carried the sharpest
 * form of the bug the migration exists to remove — `setLoaded(true)` sat on the
 * success path with no `.catch()`, so a failed read left the screen on
 * "Loading…" permanently and a failure was indistinguishable from an empty
 * list. These assert the distinction now exists, rather than asserting it from
 * the diff.
 *
 * The CRM is behind Cognito magic-link auth, so the migrated screens cannot be
 * driven in a browser without a real sign-in. This is the substitute.
 */
const renderPage = () =>
  render(
    <MemoryRouter>
      <AllMarketingTasks completedByName="Dana Reyes" />
    </MemoryRouter>
  );

/** A never-settling read, to hold the component in its in-flight state. */
const pending = () => new Promise<never>(() => {});

describe("AllMarketingTasks read states", () => {
  it("shows a loader while the read is in flight", () => {
    MarketingTask.list.mockReturnValue(pending());
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty message when the read returns nothing", async () => {
    MarketingTask.list.mockResolvedValue({ data: [], nextToken: null });
    renderPage();
    expect(
      await screen.findByText(/No open marketing tasks\./)
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the error — not the empty message, and not a stuck loader", async () => {
    MarketingTask.list.mockRejectedValue(new Error("network is down"));
    renderPage();

    // The regression this migration removes: before it, a rejection left
    // `loaded` false forever and this screen sat on "Loading…" with the
    // failure visible only as an unhandled rejection in the console.
    expect(await screen.findByText(/network is down/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No open marketing tasks\./)).not.toBeInTheDocument();
  });

  it("renders rows when the read succeeds", async () => {
    MarketingTask.list.mockResolvedValue({
      data: [
        {
          id: "t1",
          accountId: "a1",
          accountName: "Elm Street Condominium",
          carrierName: "Acme Mutual",
          status: "OPEN",
          sourceType: "POLICY",
          lines: ["Property"],
          submitBy: "2026-09-01",
        },
      ],
      nextToken: null,
    });
    renderPage();

    expect(
      await screen.findByText("Elm Street Condominium")
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No open marketing tasks\./)).not.toBeInTheDocument();
  });
});

/**
 * Closing a task, and saying why.
 *
 * The reason is the reportable part: two carriers that keep coming back out
 * of appetite is an appointment problem and a run of not-submitted-on-time is
 * a staffing one, and neither shows up if every manual close records the same
 * value. So what these hold is that the menu offers exactly the reasons a
 * person may pick, and that the one they picked is the one that gets stored.
 */
const TASK = {
  id: "t1",
  accountId: "a1",
  carrierId: "c1",
  accountName: "Elm Street Condominium",
  carrierName: "Acme Mutual",
  status: "OPEN",
  sourceType: "POLICY",
  lines: ["Property"],
  expirationDate: "2026-10-01",
  submitBy: "2026-09-01",
  triggerDate: "2026-08-18",
};

function renderCard(tasks: Record<string, unknown>[] = [TASK]) {
  MarketingTask.list.mockResolvedValue({ data: tasks, nextToken: null });
  // No quotes, so the settle-on-load pass closes nothing and every update
  // recorded below came from the menu.
  models.Quote.list.mockResolvedValue({ data: [], nextToken: null });
  render(
    <MemoryRouter>
      <AccountMarketingTasks accountId="a1" completedByName="Dana Reyes" />
    </MemoryRouter>
  );
  return screen.findByRole("combobox", { name: "Close Acme Mutual" });
}

/** The `update` call that closed a task, if any. */
const closeCall = () =>
  MarketingTask.update.mock.calls.find(([arg]) => arg.status === "COMPLETE")?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  MarketingTask.update.mockImplementation(async (input: Record<string, unknown>) => ({
    data: { ...TASK, ...input },
    errors: undefined,
  }));
});

describe("closing a marketing task", () => {
  it("offers every reason a person may pick, and no others", async () => {
    const menu = await renderCard();
    const labels = within(menu)
      .getAllByRole("option")
      .map((o) => o.textContent);

    expect(labels).toEqual([
      "Close as…",
      "Out of carrier appetite",
      "Out of agency appetite",
      "Not submitted on time",
    ]);
    // QUOTED is detected from an existing quote, never asserted by hand —
    // offering it here would let someone record a quote that isn't there.
    expect(labels).not.toContain("Quoted");
  });

  it.each([
    ["OUT_OF_APPETITE", "out of carrier appetite"],
    ["OUT_OF_AGENCY_APPETITE", "out of agency appetite"],
    ["NOT_SUBMITTED_ON_TIME", "not submitted on time"],
  ])("stores %s and names it back", async (resolution, spoken) => {
    const user = userEvent.setup();
    const menu = await renderCard();

    await user.selectOptions(menu, resolution);

    await waitFor(() =>
      expect(closeCall()).toEqual({
        id: "t1",
        status: "COMPLETE",
        resolution,
        completedAt: expect.any(String),
        completedBy: "Dana Reyes",
      })
    );
    // The menu commits on selection, so the confirmation is where a mis-pick
    // gets caught — "closed" alone would not be enough to notice.
    expect(await screen.findByText(new RegExp(spoken))).toBeInTheDocument();
  });

  it("badges the closed row with the reason it was closed", async () => {
    const user = userEvent.setup();
    const menu = await renderCard();

    await user.selectOptions(menu, "NOT_SUBMITTED_ON_TIME");
    await user.click(await screen.findByRole("button", { name: /Show 1 completed/ }));

    expect(await screen.findByText("Not submitted on time")).toBeInTheDocument();
  });

  it("still reads a resolution-less row as out of carrier appetite", async () => {
    // Rows closed before the reason was recorded. Back then a manual close
    // could only mean one thing, so the fallback names what happened.
    const user = userEvent.setup();
    MarketingTask.list.mockResolvedValue({
      data: [{ ...TASK, status: "COMPLETE", resolution: null }],
      nextToken: null,
    });
    models.Quote.list.mockResolvedValue({ data: [], nextToken: null });
    render(
      <MemoryRouter>
        <AccountMarketingTasks accountId="a1" completedByName="Dana Reyes" />
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: /Show 1 completed/ }));
    expect(await screen.findByText("Out of carrier appetite")).toBeInTheDocument();
  });

  it("leaves the row open when the write fails", async () => {
    const user = userEvent.setup();
    MarketingTask.update.mockResolvedValue({
      data: null,
      errors: [{ message: "Not authorized" }],
    });
    const menu = await renderCard();

    await user.selectOptions(menu, "OUT_OF_APPETITE");

    // `errors` on an Amplify write does not throw; dropping it would move the
    // row to the completed table on a save that never landed.
    expect(await screen.findByText(/permission/i)).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Close Acme Mutual" })
    ).toBeInTheDocument();
  });
});

/**
 * Closing from the agency-wide list, without opening the account.
 *
 * Same write as the card, but the surrounding affordances differ because the
 * screen does: it reads open tasks only, so a closed row leaves the list and
 * there is no completed table to reopen it from. The undo is what keeps
 * commit-on-selection defensible here.
 */
describe("closing from the agency-wide list", () => {
  const OTHER = {
    ...TASK,
    id: "t2",
    accountId: "a2",
    accountName: "Maple Ridge Trust",
    submitBy: "2026-09-05",
  };

  /** Both rows carry the same carrier — the case the row label has to survive. */
  const renderList = async (tasks: Record<string, unknown>[] = [TASK, OTHER]) => {
    MarketingTask.list.mockResolvedValue({ data: tasks, nextToken: null });
    renderPage();
    return screen.findByRole("combobox", {
      name: "Close Acme Mutual for Elm Street Condominium",
    });
  };

  it("names each row's menu by account, so one carrier on many rows stays distinct", async () => {
    await renderList();

    // Carrier alone would leave these two controls sharing an accessible name.
    expect(
      screen.getByRole("combobox", { name: "Close Acme Mutual for Maple Ridge Trust" })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("combobox", { name: /^Close Acme Mutual for / })
    ).toHaveLength(2);
  });

  it("records the reason and the person, without opening the account", async () => {
    const user = userEvent.setup();
    const menu = await renderList();

    await user.selectOptions(menu, "NOT_SUBMITTED_ON_TIME");

    await waitFor(() =>
      expect(closeCall()).toEqual({
        id: "t1",
        status: "COMPLETE",
        resolution: "NOT_SUBMITTED_ON_TIME",
        completedAt: expect.any(String),
        completedBy: "Dana Reyes",
      })
    );
    expect(
      await screen.findByText(/not submitted on time/)
    ).toBeInTheDocument();
  });

  it("drops the closed row and leaves the others alone", async () => {
    const user = userEvent.setup();
    const menu = await renderList();

    await user.selectOptions(menu, "OUT_OF_APPETITE");

    await waitFor(() =>
      expect(screen.queryByText("Elm Street Condominium")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Maple Ridge Trust")).toBeInTheDocument();
  });

  it("puts the row back when the close is undone", async () => {
    const user = userEvent.setup();
    const menu = await renderList();

    await user.selectOptions(menu, "OUT_OF_APPETITE");
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    // Reopening is the inverse write, not a local un-hide: a row restored
    // without it would come back here and stay closed in the database.
    await waitFor(() =>
      expect(
        MarketingTask.update.mock.calls.find(([a]) => a.status === "OPEN")?.[0]
      ).toEqual({
        id: "t1",
        status: "OPEN",
        resolution: null,
        completedAt: null,
        completedBy: null,
      })
    );
    expect(await screen.findByText("Elm Street Condominium")).toBeInTheDocument();
  });

  it("keeps the row when the write fails, and offers no undo", async () => {
    const user = userEvent.setup();
    MarketingTask.update.mockResolvedValue({
      data: null,
      errors: [{ message: "Not authorized" }],
    });
    const menu = await renderList();

    await user.selectOptions(menu, "OUT_OF_APPETITE");

    expect(await screen.findByText(/permission/i)).toBeInTheDocument();
    expect(screen.getByText("Elm Street Condominium")).toBeInTheDocument();
    // Undo is offered off the back of a success; a failed close has nothing
    // to undo and offering it would write COMPLETE's inverse over an open row.
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});
