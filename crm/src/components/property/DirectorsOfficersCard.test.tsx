import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DoApplication = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
const DoCoveragePart = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { DoApplication, DoCoveragePart } }),
}));

import DirectorsOfficersCard from "./DirectorsOfficersCard";

/**
 * The two things about this screen that are not `useChildRows` doing its job:
 * a 1:1 record created on its first save rather than on render, and three
 * fixed coverage parts upserted together.
 *
 * Both matter for the same reason. An empty row and no row look identical on
 * screen and mean different things in the data — "every answer is blank"
 * versus "nobody has been asked" — and on an application that difference is
 * the difference between an answer and a silence.
 */

const renderCard = () => render(<DirectorsOfficersCard accountId="a1" />);
const empty = { data: [], nextToken: null };

const partsTable = () => within(screen.getByRole("table"));
/** The application form's only money field. Labels in this app are siblings
 *  of their inputs rather than `for`-associated, so a role query is what
 *  there is; scoping to the form-grid keeps it off the parts table. */
const defenceLimit = () =>
  document.querySelector<HTMLInputElement>(
    ".form-grid input[type=text]"
  ) as HTMLInputElement;
const rowFor = (label: string) =>
  within(partsTable().getByRole("row", { name: new RegExp(label) }));

beforeEach(() => {
  for (const m of [DoApplication, DoCoveragePart]) {
    m.list.mockReset();
    m.create.mockReset();
    m.update.mockReset();
    m.delete.mockReset();
  }
  DoApplication.list.mockResolvedValue(empty);
  DoCoveragePart.list.mockResolvedValue(empty);
});

describe("the D&O application record", () => {
  it("is not created just by opening the section", async () => {
    renderCard();
    await screen.findByText("Coverage parts");
    // Rendering a form is not an answer to anything.
    expect(DoApplication.create).not.toHaveBeenCalled();
  });

  it("is created by the first save and updated by the second", async () => {
    const user = userEvent.setup();
    DoApplication.create.mockResolvedValue({
      data: { id: "d1", accountId: "a1", defenseLimit: 500000 },
    });
    DoApplication.update.mockResolvedValue({
      data: { id: "d1", accountId: "a1", defenseLimit: 750000 },
    });
    renderCard();
    await screen.findByText("Coverage parts");

    const limit = defenceLimit();
    await user.type(limit, "500000");
    await user.click(screen.getByText("Save D&O terms"));

    expect(DoApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "a1", defenseLimit: 500000 })
    );

    await user.clear(limit);
    await user.type(limit, "750000");
    await user.click(screen.getByText("Save D&O terms"));

    // The second save updates the row the first one created — it does not
    // create a second application for the same account.
    expect(DoApplication.create).toHaveBeenCalledTimes(1);
    expect(DoApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1", defenseLimit: 750000 })
    );
  });

  it("records an unanswered question as null, not as false", async () => {
    const user = userEvent.setup();
    DoApplication.create.mockResolvedValue({ data: { id: "d1", accountId: "a1" } });
    renderCard();
    await screen.findByText("Coverage parts");

    await user.click(screen.getByText("Save D&O terms"));
    expect(DoApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({ separateDefenseLimit: null })
    );

    await user.click(screen.getByRole("radio", { name: "No" }));
    await user.click(screen.getByText("Save D&O terms"));
    expect(DoApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ separateDefenseLimit: false })
    );
  });
});

describe("the three coverage parts", () => {
  it("always renders exactly three, whether or not any are stored", async () => {
    renderCard();
    await screen.findByText("Coverage parts");
    // Fixed by the form — there is no fourth to add and no button to add one.
    expect(partsTable().getByText("Part A")).toBeInTheDocument();
    expect(partsTable().getByText("Part B")).toBeInTheDocument();
    expect(partsTable().getByText("Part C")).toBeInTheDocument();
    expect(screen.queryByText(/\+ Add/)).not.toBeInTheDocument();
  });

  it("writes only the parts that were filled in", async () => {
    const user = userEvent.setup();
    DoCoveragePart.create.mockResolvedValue({
      data: { id: "p1", accountId: "a1", part: "A", perClaimLimit: 1000000 },
    });
    renderCard();
    await screen.findByText("Coverage parts");

    await user.type(rowFor("Part A").getAllByRole("textbox")[0], "1000000");
    await user.click(screen.getByText("Save coverage parts"));

    // An account carrying only Part A should not end up with two empty rows
    // implying it was asked about B and C.
    expect(DoCoveragePart.create).toHaveBeenCalledTimes(1);
    expect(DoCoveragePart.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "a1", part: "A", perClaimLimit: 1000000 })
    );
  });

  it("updates a stored part rather than adding a second one", async () => {
    const user = userEvent.setup();
    DoCoveragePart.list.mockResolvedValue({
      data: [{ id: "p1", accountId: "a1", part: "B", perClaimLimit: 500000 }],
      nextToken: null,
    });
    DoCoveragePart.update.mockResolvedValue({
      data: { id: "p1", accountId: "a1", part: "B", perClaimLimit: 750000 },
    });
    renderCard();
    await screen.findByText("Coverage parts");

    // Seeded from the stored row, formatted.
    const limit = rowFor("Part B").getByDisplayValue("500,000");
    await user.clear(limit);
    await user.type(limit, "750000");
    await user.click(screen.getByText("Save coverage parts"));

    expect(DoCoveragePart.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", perClaimLimit: 750000 })
    );
    expect(DoCoveragePart.create).not.toHaveBeenCalled();
  });

  it("deletes a part that has been blanked out", async () => {
    const user = userEvent.setup();
    DoCoveragePart.list.mockResolvedValue({
      data: [{ id: "p1", accountId: "a1", part: "B", perClaimLimit: 500000 }],
      nextToken: null,
    });
    DoCoveragePart.delete.mockResolvedValue({ data: { id: "p1" } });
    renderCard();
    await screen.findByText("Coverage parts");

    await user.clear(rowFor("Part B").getByDisplayValue("500,000"));
    await user.click(screen.getByText("Save coverage parts"));

    // Storing an empty row instead would make "asked, no cover" and "not
    // asked" indistinguishable again.
    expect(DoCoveragePart.delete).toHaveBeenCalledWith({ id: "p1" });
    expect(DoCoveragePart.update).not.toHaveBeenCalled();
  });

  it("surfaces a refused save instead of reporting success", async () => {
    const user = userEvent.setup();
    DoCoveragePart.create.mockResolvedValue({
      data: null,
      errors: [{ message: "Not Authorized" }],
    });
    renderCard();
    await screen.findByText("Coverage parts");

    await user.type(rowFor("Part A").getAllByRole("textbox")[0], "1000000");
    await user.click(screen.getByText("Save coverage parts"));

    expect(
      await screen.findByText("You don't have permission to do that.")
    ).toBeInTheDocument();
  });
});
