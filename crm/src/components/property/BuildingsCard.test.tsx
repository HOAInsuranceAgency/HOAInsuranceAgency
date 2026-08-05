import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope. Stubbing generateClient
// rather than the whole module keeps client.ts's real formatters and `unwrap`
// intact — those are exactly what this is testing.
const Building = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { Building } }),
}));

import BuildingsCard from "./BuildingsCard";

/**
 * `useChildRows` + `ChildRowsCard`, tested through the screen that is their
 * first caller.
 *
 * The CRM sits behind Cognito magic-link auth, so none of these screens can be
 * driven in a browser without a real sign-in; `MarketingTasks.test.tsx` is the
 * template PATTERNS names for that, and this follows it. Asserting through
 * `BuildingsCard` rather than through the hook in isolation covers the render
 * ladder and the edit placement too — and every other workstream in the
 * lead/client expansion will be a variation on this same file.
 *
 * The edit path in particular has no precedent anywhere in this codebase:
 * before this commit no child row could be edited at all.
 */

const rows = () => [
  { id: "b1", accountId: "a1", label: "Clubhouse", sqft: 12000, streetAddress: "2 John Hancock Dr", description: null },
  { id: "b2", accountId: "a1", label: "Pool House", sqft: 800, streetAddress: null, description: null },
];

/** A never-settling read, to hold the card in its in-flight state. */
const pending = () => new Promise<never>(() => {});

const renderCard = () => render(<BuildingsCard accountId="a1" />);

/** The add form and the edit form hold the same four fields, so every query
 *  has to say which one it means. */
const toolbar = () => within(document.querySelector(".toolbar") as HTMLElement);
const table = () => within(screen.getByRole("table"));

beforeEach(() => {
  Building.list.mockReset();
  Building.create.mockReset();
  Building.update.mockReset();
  Building.delete.mockReset();
});

describe("read states", () => {
  it("shows a loader while the read is in flight", () => {
    Building.list.mockReturnValue(pending());
    renderCard();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    // The add form is behind the gate too: its default label is
    // `Building ${n + 1}`, which would number over an existing row.
    expect(screen.queryByText("+ Add building")).not.toBeInTheDocument();
  });

  it("shows the error — not the empty message, and not a stuck loader", async () => {
    Building.list.mockRejectedValue(new Error("network is down"));
    renderCard();

    expect(await screen.findByText(/network is down/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No buildings yet.")).not.toBeInTheDocument();
  });

  it("shows the empty message, with the add form still available", async () => {
    Building.list.mockResolvedValue({ data: [], nextToken: null });
    renderCard();

    expect(await screen.findByText("No buildings yet.")).toBeInTheDocument();
    expect(screen.getByText("+ Add building")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders rows, formatted, when the read succeeds", async () => {
    Building.list.mockResolvedValue({ data: rows(), nextToken: null });
    renderCard();

    expect(await screen.findByText("Clubhouse")).toBeInTheDocument();
    // 12000 renders 12,000 — the table already used fmtNum and still does.
    expect(screen.getByText("12,000")).toBeInTheDocument();
    expect(screen.getByText(/12,800 sq ft/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("reads every page, not just the first", async () => {
    Building.list
      .mockResolvedValueOnce({ data: [rows()[0]], nextToken: "page2" })
      .mockResolvedValueOnce({ data: [rows()[1]], nextToken: null });
    renderCard();

    expect(await screen.findByText("Pool House")).toBeInTheDocument();
    expect(Building.list).toHaveBeenCalledTimes(2);
    expect(Building.list.mock.calls[1][0]).toMatchObject({ nextToken: "page2" });
  });
});

describe("add", () => {
  beforeEach(() => {
    Building.list.mockResolvedValue({ data: rows(), nextToken: null });
  });

  it("creates the row, appends it, clears the form and confirms", async () => {
    const user = userEvent.setup();
    Building.create.mockResolvedValue({
      data: { id: "b3", accountId: "a1", label: "Gatehouse", sqft: 400, streetAddress: null, description: null },
    });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.type(toolbar().getByPlaceholderText("Building 3"), "Gatehouse");
    await user.type(toolbar().getAllByRole("textbox")[2], "400");
    await user.click(screen.getByText("+ Add building"));

    expect(Building.create).toHaveBeenCalledWith({
      accountId: "a1",
      label: "Gatehouse",
      sqft: 400,
      streetAddress: null,
      description: null,
    });
    expect(await screen.findByText("Gatehouse added.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Gatehouse");
    // No refetch — the row on screen is the one the write returned.
    expect(Building.list).toHaveBeenCalledTimes(1);
    expect(toolbar().getByPlaceholderText("Building 4")).toHaveValue("");
  });

  it("surfaces a rejected create instead of dropping its errors", async () => {
    const user = userEvent.setup();
    // Amplify resolves rather than rejects, which is why every write needs
    // `unwrap` — before it, ten sites let this land as a silent no-op.
    Building.create.mockResolvedValue({
      data: null,
      errors: [{ message: "sqft is invalid" }],
    });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getByText("+ Add building"));

    expect(await screen.findByText("sqft is invalid")).toBeInTheDocument();
    expect(screen.getByRole("table")).not.toHaveTextContent("Building 3");
  });

  it("refuses an invalid sq ft before it writes anything", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Clubhouse");

    await user.type(toolbar().getAllByRole("textbox")[2], "0");
    await user.click(screen.getByText("+ Add building"));

    expect(await screen.findByText(/Sq ft should be a whole number/)).toBeInTheDocument();
    expect(Building.create).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  beforeEach(() => {
    Building.list.mockResolvedValue({ data: rows(), nextToken: null });
  });

  it("seeds the form from the row, saves it, and patches the table", async () => {
    const user = userEvent.setup();
    Building.update.mockResolvedValue({
      data: { ...rows()[0], label: "Clubhouse Annex", sqft: 12000 },
    });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getAllByText("Edit")[0]);
    // Seeded from the row, and the numeric arrives formatted.
    expect(screen.getByDisplayValue("Clubhouse")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12,000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2 John Hancock Dr")).toBeInTheDocument();

    await user.clear(screen.getByDisplayValue("Clubhouse"));
    await user.type(table().getAllByRole("textbox")[0], "Clubhouse Annex");
    await user.click(screen.getByText("Save"));

    expect(Building.update).toHaveBeenCalledWith({
      id: "b1",
      label: "Clubhouse Annex",
      sqft: 12000,
      streetAddress: "2 John Hancock Dr",
      description: null,
    });
    expect(await screen.findByText("Clubhouse Annex saved.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Clubhouse Annex");
    expect(Building.list).toHaveBeenCalledTimes(1);
  });

  it("keeps the form open on a failed save, with the values still in it", async () => {
    const user = userEvent.setup();
    Building.update.mockResolvedValue({
      data: null,
      errors: [{ message: "Not Authorized" }],
    });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getAllByText("Edit")[0]);
    await user.click(screen.getByText("Save"));

    expect(
      await screen.findByText("You don't have permission to do that.")
    ).toBeInTheDocument();
    // Still editing — this is the only state the user can retry from.
    expect(screen.getByDisplayValue("Clubhouse")).toBeInTheDocument();
  });

  it("abandons the edit on cancel", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getAllByText("Edit")[0]);
    await user.clear(screen.getByDisplayValue("Clubhouse"));
    await user.click(screen.getByText("Cancel"));

    expect(Building.update).not.toHaveBeenCalled();
    expect(screen.getByRole("table")).toHaveTextContent("Clubhouse");
  });
});

describe("delete", () => {
  beforeEach(() => {
    Building.list.mockResolvedValue({ data: rows(), nextToken: null });
  });

  it("is behind a confirmation, then drops the row", async () => {
    const user = userEvent.setup();
    Building.delete.mockResolvedValue({ data: rows()[0] });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getAllByText("Remove")[0]);
    expect(Building.delete).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Clubhouse?")).toBeInTheDocument();

    await user.click(screen.getByText("Confirm"));
    expect(Building.delete).toHaveBeenCalledWith({ id: "b1" });
    expect(await screen.findByText("Clubhouse removed.")).toBeInTheDocument();
    expect(screen.getByRole("table")).not.toHaveTextContent("Clubhouse");
  });

  it("treats a row that was already gone as success, not failure", async () => {
    // A delete of a missing row resolves with a null payload and no errors —
    // two tabs open, or two people on the same account. `unwrap` would call
    // that a failure and keep calling it one on every retry.
    const user = userEvent.setup();
    Building.delete.mockResolvedValue({ data: null });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getAllByText("Remove")[0]);
    await user.click(screen.getByText("Confirm"));

    expect(await screen.findByText("Clubhouse removed.")).toBeInTheDocument();
    expect(screen.getByRole("table")).not.toHaveTextContent("Clubhouse");
  });

  it("keeps the row when the delete is refused", async () => {
    const user = userEvent.setup();
    Building.delete.mockResolvedValue({
      data: null,
      errors: [{ message: "Not Authorized" }],
    });
    renderCard();
    await screen.findByText("Clubhouse");

    await user.click(screen.getAllByText("Remove")[0]);
    await user.click(screen.getByText("Confirm"));

    expect(
      await screen.findByText("You don't have permission to do that.")
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Clubhouse");
  });
});
