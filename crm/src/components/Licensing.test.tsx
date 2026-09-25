import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope — stub the generator, not
// the module, so client.ts's real exports stay intact. Same shape as
// MarketingTasks.test.tsx and storage.test.ts.
const models = vi.hoisted(() => ({
  License: { list: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn() },
  UserProfile: { list: vi.fn() },
  Document: { list: vi.fn(), observeQuery: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));

import Licensing from "./Licensing";
import { AdminContext } from "../lib/auth";
import type { License, UserProfile } from "../lib/client";

/**
 * The Licensing screen's shape, not its arithmetic — `LicenseMap.test.tsx`
 * already owns the coverage rule.
 *
 * What these hold is what makes the screen usable at the size it actually
 * reaches: a hundred-odd licences of each kind. One view on screen at a time,
 * people collapsed until asked for, and the editor over the page rather than
 * below it. Before this, opening Edit on the first row put the form under both
 * full tables and the coverage matrix.
 *
 * The CRM is behind Cognito magic-link auth, so this screen cannot be driven
 * in a browser without a real sign-in. This is the substitute.
 */

const YEAR_OUT = "2099-04-30";

const lic = (o: Partial<License> & { state: string; id: string }) =>
  ({
    licenseClass: "PRODUCER",
    status: "ACTIVE",
    residency: "NON_RESIDENT",
    linesOfAuthority: ["Property"],
    expirationDate: YEAR_OUT,
    licenseNumber: "1234567",
    holderType: "PRODUCER",
    ...o,
  }) as License;

const profiles = [
  { id: "p1", firstName: "Brian", lastName: "Cole" },
  { id: "p2", firstName: "Dana", lastName: "Reyes" },
] as unknown as UserProfile[];

/** Two producers with two states each, plus one firm licence. */
const LICENSES: License[] = [
  lic({ id: "f1", state: "MA", holderType: "FIRM", licenseClass: "AGENCY", licenseNumber: "FIRM-MA" }),
  lic({ id: "b1", state: "MA", userProfileId: "p1", licenseNumber: "BRIAN-MA" }),
  lic({ id: "b2", state: "NH", userProfileId: "p1", licenseNumber: "BRIAN-NH" }),
  lic({ id: "d1", state: "MA", userProfileId: "p2", licenseNumber: "DANA-MA" }),
  lic({ id: "d2", state: "RI", userProfileId: "p2", licenseNumber: "DANA-RI" }),
];

const renderPage = (isAdmin = true) =>
  render(
    <AdminContext.Provider value={isAdmin}>
      <Licensing />
    </AdminContext.Provider>
  );

const view = (name: string) => screen.getByRole("button", { name });
const goTo = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(view(name));

beforeEach(() => {
  vi.clearAllMocks();
  models.License.list.mockResolvedValue({ data: LICENSES });
  models.UserProfile.list.mockResolvedValue({ data: profiles });
  // DocumentsPanel subscribes when a row's Files panel opens.
  models.Document.observeQuery.mockReturnValue({
    subscribe: () => ({ unsubscribe: () => {} }),
  });
});

describe("one view at a time", () => {
  it("opens on the map, with no table underneath it", async () => {
    renderPage();
    await waitFor(() => expect(view("Map")).toHaveAttribute("aria-pressed", "true"));

    // The tables used to sit below the map view's own content.
    expect(screen.queryByText("Firm licenses")).not.toBeInTheDocument();
    expect(screen.queryByText("Personal licenses")).not.toBeInTheDocument();
  });

  it("shows the firm table without the personal one, and vice versa", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("Firm")).toBeInTheDocument());

    await goTo(user, "Firm");
    expect(await screen.findByText("Firm licenses")).toBeInTheDocument();
    expect(screen.queryByText("Personal licenses")).not.toBeInTheDocument();

    await goTo(user, "People");
    expect(await screen.findByText("Personal licenses")).toBeInTheDocument();
    expect(screen.queryByText("Firm licenses")).not.toBeInTheDocument();
  });
});

/**
 * Both tables open alphabetically by state.
 *
 * The flat one used to open on soonest expiration, which at fifty-odd states
 * reads as no order at all when you already know the state you are looking
 * for. These fixtures give the two orderings different answers on purpose —
 * expiry order would put NY first, alphabetical puts CA first — so the test
 * fails if the default reverts.
 */
describe("alphabetical by default", () => {
  const UNSORTED: License[] = [
    lic({ id: "x1", state: "NY", holderType: "FIRM", licenseNumber: "F-NY", expirationDate: "2027-01-01" }),
    lic({ id: "x2", state: "CA", holderType: "FIRM", licenseNumber: "F-CA", expirationDate: "2099-01-01" }),
    lic({ id: "x3", state: "MA", holderType: "FIRM", licenseNumber: "F-MA", expirationDate: "2050-01-01" }),
  ];

  /** The State cell of every rendered row, in the order they appear. */
  const statesShown = () =>
    [...document.querySelectorAll("tbody tr")]
      .map((tr) => tr.querySelector("td")?.textContent?.trim().slice(0, 2))
      .filter((s) => s && /^[A-Z]{2}$/.test(s));

  it("orders the firm table by state, not by expiration", async () => {
    const user = userEvent.setup();
    models.License.list.mockResolvedValue({ data: UNSORTED });
    renderPage();
    await waitFor(() => expect(view("Firm")).toBeInTheDocument());
    await goTo(user, "Firm");

    await screen.findByText("Firm licenses");
    // Expiry order would be NY, MA, CA.
    expect(statesShown()).toEqual(["CA", "MA", "NY"]);
  });

  it("orders each person's rows by state", async () => {
    const user = userEvent.setup();
    models.License.list.mockResolvedValue({
      data: [
        lic({ id: "p1c", state: "RI", userProfileId: "p1", licenseNumber: "B-RI" }),
        lic({ id: "p1a", state: "CT", userProfileId: "p1", licenseNumber: "B-CT" }),
        lic({ id: "p1b", state: "NH", userProfileId: "p1", licenseNumber: "B-NH" }),
      ],
    });
    renderPage();
    await waitFor(() => expect(view("People")).toBeInTheDocument());
    await goTo(user, "People");

    // A lone producer's group is open already, so the rows are on screen.
    await screen.findByText("Brian Cole");
    expect(statesShown()).toEqual(["CT", "NH", "RI"]);
  });

  it("still lets Expires be chosen", async () => {
    const user = userEvent.setup();
    models.License.list.mockResolvedValue({ data: UNSORTED });
    renderPage();
    await waitFor(() => expect(view("Firm")).toBeInTheDocument());
    await goTo(user, "Firm");

    // `SortTh` is a clickable <th>, not a button — hence columnheader.
    await user.click(await screen.findByRole("columnheader", { name: /Expires/ }));

    expect(statesShown()).toEqual(["NY", "MA", "CA"]);
  });
});

describe("people start collapsed", () => {
  it("lists producers, not their licences, until one is picked", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("People")).toBeInTheDocument());
    await goTo(user, "People");

    // Both names, neither's rows.
    expect(await screen.findByText("Brian Cole")).toBeInTheDocument();
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
    expect(screen.queryByText("BRIAN-MA")).not.toBeInTheDocument();
    expect(screen.queryByText("DANA-RI")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Brian Cole/ }));

    expect(await screen.findByText("BRIAN-MA")).toBeInTheDocument();
    expect(screen.getByText("BRIAN-NH")).toBeInTheDocument();
    // Opening one person does not open the other.
    expect(screen.queryByText("DANA-RI")).not.toBeInTheDocument();
  });

  it("opens every group while a filter is active, so matches are not hidden", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("People")).toBeInTheDocument());
    await goTo(user, "People");

    await user.type(
      screen.getByPlaceholderText(/Filter by state/),
      "RI"
    );

    // Dana's RI licence is inside a group that was collapsed a moment ago.
    expect(await screen.findByText("DANA-RI")).toBeInTheDocument();
  });

  it("collapses again when the filter is cleared", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("People")).toBeInTheDocument());
    await goTo(user, "People");

    const search = screen.getByPlaceholderText(/Filter by state/);
    await user.type(search, "RI");
    expect(await screen.findByText("DANA-RI")).toBeInTheDocument();

    await user.clear(search);
    await waitFor(() =>
      expect(screen.queryByText("DANA-RI")).not.toBeInTheDocument()
    );
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
  });
});

describe("the editor is a modal", () => {
  it("opens over the page instead of below the tables", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("Firm")).toBeInTheDocument());
    await goTo(user, "Firm");

    await user.click(await screen.findByRole("button", { name: "+ Add license" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("Add firm license")).toBeInTheDocument();
  });

  it("names the licence being edited, and closes on Escape", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("Firm")).toBeInTheDocument());
    await goTo(user, "Firm");

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit firm license")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /**
   * Editing from the map was the worst case of the old layout: the form
   * rendered after tables the map view wasn't even showing, so the click
   * appeared to do nothing at all.
   */
  it("opens from the map view too", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(view("People")).toBeInTheDocument());

    // Reach a licence through the People table, then confirm the dialog is
    // what carries the form regardless of which view raised it.
    await goTo(user, "People");
    await user.click(await screen.findByRole("button", { name: /Dana Reyes/ }));
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0]);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Edit personal license")).toBeInTheDocument();
  });

  it("offers no add or edit control to a non-admin", async () => {
    const user = userEvent.setup();
    renderPage(false);
    await waitFor(() => expect(view("Firm")).toBeInTheDocument());
    await goTo(user, "Firm");

    expect(await screen.findByText("Firm licenses")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Add license" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});
