import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Contact = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { Contact } }),
}));

import ContactsCard from "./ContactsCard";

/**
 * The contacts screen, and specifically the two things about it that are not
 * `useChildRows` doing its job:
 *
 *  - **`isPrimary` is single-valued across rows.** Exactly one contact per
 *    account carries the phone number that goes in the ACORD insured block,
 *    so promoting one has to demote the others — a write across rows that
 *    neither the add form nor the edit form can express.
 *  - **`extractionSourceKey` tracks the row.** It is what stops a re-run
 *    extraction creating a second copy of a person it already created, so it
 *    has to be recomputed when the fields it is derived from change.
 */

const rows = () => [
  {
    id: "c1",
    accountId: "a1",
    name: "Pat Alvarez",
    email: "pat@maplehoa.org",
    phone: "(555) 123-4567",
    type: "MANAGER",
    notes: null,
    isPrimary: true,
    extractionSourceKey: "email:pat@maplehoa.org",
  },
  {
    id: "c2",
    accountId: "a1",
    name: "Robin Chen",
    email: null,
    phone: "5559876543",
    type: "INSPECTION",
    notes: null,
    isPrimary: false,
    extractionSourceKey: "name:robin chen|INSPECTION",
  },
];

const pending = () => new Promise<never>(() => {});
const renderCard = () => render(<ContactsCard accountId="a1" />);
const toolbar = () => within(document.querySelector(".toolbar") as HTMLElement);

beforeEach(() => {
  Contact.list.mockReset();
  Contact.create.mockReset();
  Contact.update.mockReset();
  Contact.delete.mockReset();
});

describe("read states", () => {
  it("shows a loader while the read is in flight", () => {
    Contact.list.mockReturnValue(pending());
    renderCard();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the error — not the empty message, and not a stuck loader", async () => {
    Contact.list.mockRejectedValue(new Error("network is down"));
    renderCard();
    expect(await screen.findByText(/network is down/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No contacts yet.")).not.toBeInTheDocument();
  });

  it("shows the empty message with the add form still available", async () => {
    Contact.list.mockResolvedValue({ data: [], nextToken: null });
    renderCard();
    expect(await screen.findByText("No contacts yet.")).toBeInTheDocument();
    expect(screen.getByText("+ Add contact")).toBeInTheDocument();
  });

  it("renders rows with the role label and a formatted phone", async () => {
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    renderCard();

    expect(await screen.findByText("Pat Alvarez")).toBeInTheDocument();
    // Scoped to the table: the add form's role picker holds an <option> for
    // every label, so an unscoped query matches both.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Manager")).toBeInTheDocument();
    // Stored unformatted by an older write; rendered through fmtPhone anyway.
    expect(table.getByText("(555) 987-6543")).toBeInTheDocument();
  });
});

describe("add", () => {
  it("makes the first contact on an account primary, with no second write", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: [], nextToken: null });
    Contact.create.mockResolvedValue({
      data: { ...rows()[0], id: "c9", name: "Sam Ito", email: null, phone: null, type: null },
    });
    renderCard();
    await screen.findByText("No contacts yet.");

    await user.type(toolbar().getByPlaceholderText("Pat Alvarez"), "Sam Ito");
    await user.click(screen.getByText("+ Add contact"));

    expect(Contact.create).toHaveBeenCalledWith({
      accountId: "a1",
      name: "Sam Ito",
      type: null,
      email: null,
      phone: null,
      notes: null,
      extractionSourceKey: "name:sam ito|",
      isPrimary: true,
    });
    expect(Contact.update).not.toHaveBeenCalled();
    expect(await screen.findByText("Sam Ito added.")).toBeInTheDocument();
  });

  it("does not make a later contact primary", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    Contact.create.mockResolvedValue({ data: { ...rows()[1], id: "c9", name: "Sam Ito" } });
    renderCard();
    await screen.findByText("Pat Alvarez");

    await user.type(toolbar().getByPlaceholderText("Pat Alvarez"), "Sam Ito");
    await user.click(screen.getByText("+ Add contact"));

    expect(Contact.create).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: false })
    );
  });

  it("keys on the email when there is one", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: [], nextToken: null });
    Contact.create.mockResolvedValue({ data: rows()[0] });
    renderCard();
    await screen.findByText("No contacts yet.");

    await user.type(toolbar().getByPlaceholderText("Pat Alvarez"), "Pat Alvarez");
    await user.type(toolbar().getAllByRole("textbox")[1], "PAT@MapleHOA.org");
    await user.click(screen.getByText("+ Add contact"));

    // Lower-cased, and the email wins over the name: it is the only field on
    // a contact meant to be unique to one human.
    expect(Contact.create).toHaveBeenCalledWith(
      expect.objectContaining({ extractionSourceKey: "email:pat@maplehoa.org" })
    );
  });

  it("refuses a nameless contact and a malformed email before writing", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: [], nextToken: null });
    renderCard();
    await screen.findByText("No contacts yet.");

    await user.click(screen.getByText("+ Add contact"));
    expect(await screen.findByText(/Contact name is required\./)).toBeInTheDocument();

    await user.type(toolbar().getByPlaceholderText("Pat Alvarez"), "Sam Ito");
    await user.type(toolbar().getAllByRole("textbox")[1], "sam@ito");
    await user.click(screen.getByText("+ Add contact"));
    expect(
      await screen.findByText(/doesn't look like a valid address/)
    ).toBeInTheDocument();

    expect(Contact.create).not.toHaveBeenCalled();
  });
});

describe("edit", () => {
  it("leaves the extraction key alone when the email changes", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    Contact.update.mockResolvedValue({
      data: { ...rows()[0], email: "p.alvarez@maplehoa.org" },
    });
    renderCard();
    await screen.findByText("Pat Alvarez");

    await user.click(screen.getAllByText("Edit")[0]);
    const email = screen.getByDisplayValue("pat@maplehoa.org");
    await user.clear(email);
    await user.type(email, "p.alvarez@maplehoa.org");
    await user.click(screen.getByText("Save"));

    // This used to assert the opposite, on the reasoning that a key pointing
    // at the old address would let the next extraction file a second row for
    // the same person. Matching now derives a row's current identity itself
    // (`contactAliases`), so the new address is covered without the rewrite —
    // and the rewrite costs the one thing only the stored key can say, which
    // is what this person was called when the row was written. A packet filed
    // before the correction still names the old address.
    expect(Contact.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1", email: "p.alvarez@maplehoa.org" })
    );
    expect(Contact.update.mock.calls[0][0]).not.toHaveProperty(
      "extractionSourceKey"
    );
  });

  it("cannot change isPrimary — the edit form has no such field", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    Contact.update.mockResolvedValue({ data: rows()[0] });
    renderCard();
    await screen.findByText("Pat Alvarez");

    await user.click(screen.getAllByText("Edit")[0]);
    await user.click(screen.getByText("Save"));

    expect(Contact.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ isPrimary: expect.anything() })
    );
  });
});

describe("the primary contact radio", () => {
  it("promotes one row and demotes the one that held it", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    Contact.update
      .mockResolvedValueOnce({ data: { ...rows()[1], isPrimary: true } })
      .mockResolvedValueOnce({ data: { ...rows()[0], isPrimary: false } });
    renderCard();
    await screen.findByText("Robin Chen");

    await user.click(
      screen.getByRole("radio", { name: "Make Robin Chen the primary contact" })
    );

    expect(Contact.update).toHaveBeenCalledTimes(2);
    // Promotion first: a half-applied batch that leaves two primaries is
    // recoverable, and one that leaves none blanks a carrier submission.
    expect(Contact.update.mock.calls[0][0]).toEqual({ id: "c2", isPrimary: true });
    expect(Contact.update.mock.calls[1][0]).toEqual({ id: "c1", isPrimary: false });
    expect(
      await screen.findByText("Robin Chen is now the primary contact.")
    ).toBeInTheDocument();

    expect(
      screen.getByRole("radio", { name: "Make Robin Chen the primary contact" })
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Make Pat Alvarez the primary contact" })
    ).not.toBeChecked();
  });

  it("writes nothing when the row is already primary", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    renderCard();
    await screen.findByText("Pat Alvarez");

    await user.click(
      screen.getByRole("radio", { name: "Make Pat Alvarez the primary contact" })
    );
    expect(Contact.update).not.toHaveBeenCalled();
  });

  it("surfaces a refused promotion and leaves the flag where it was", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    Contact.update.mockResolvedValue({
      data: null,
      errors: [{ message: "Not Authorized" }],
    });
    renderCard();
    await screen.findByText("Robin Chen");

    await user.click(
      screen.getByRole("radio", { name: "Make Robin Chen the primary contact" })
    );

    expect(
      await screen.findByText("You don't have permission to do that.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Make Pat Alvarez the primary contact" })
    ).toBeChecked();
  });
});

describe("delete", () => {
  it("is behind a confirmation, then drops the row", async () => {
    const user = userEvent.setup();
    Contact.list.mockResolvedValue({ data: rows(), nextToken: null });
    Contact.delete.mockResolvedValue({ data: rows()[1] });
    renderCard();
    await screen.findByText("Robin Chen");

    await user.click(screen.getAllByText("Remove")[1]);
    expect(screen.getByText("Remove Robin Chen?")).toBeInTheDocument();
    await user.click(screen.getByText("Confirm"));

    expect(Contact.delete).toHaveBeenCalledWith({ id: "c2" });
    expect(await screen.findByText("Robin Chen removed.")).toBeInTheDocument();
    expect(screen.getByRole("table")).not.toHaveTextContent("Robin Chen");
  });
});
