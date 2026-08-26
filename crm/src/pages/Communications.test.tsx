import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Communication = vi.hoisted(() => ({
  listCommunicationByMatchConfidenceAndOccurredAt: vi.fn(),
}));
const Account = vi.hoisted(() => ({ list: vi.fn() }));
const fileCommunication = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: { Communication, Account },
    mutations: { fileCommunication },
  }),
}));

import Communications from "./Communications";

/**
 * The queue where the CRM admits it does not recognise a caller.
 *
 * The behaviour worth holding still is that nothing here files a call without
 * a person choosing where it goes — no default account, no pre-selected
 * action — because auto-creating leads from caller ID is exactly the
 * deduplication decision `lead-intake` declined to make.
 */

const call = (o: Record<string, unknown> = {}) => ({
  id: "m1",
  channel: "CALL",
  direction: "INBOUND",
  externalNumber: "+15085550199",
  contactName: "SPRINGFIELD MA",
  userName: null,
  state: "MISSED",
  durationSeconds: null,
  body: null,
  occurredAt: "2026-08-26T14:30:00.000Z",
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  Communication.listCommunicationByMatchConfidenceAndOccurredAt.mockResolvedValue({
    data: [call()],
    nextToken: null,
  });
  Account.list.mockResolvedValue({
    data: [
      { id: "a2", name: "Willow Creek Association", stage: "CLIENT" },
      { id: "a1", name: "Beacon Hill Condo Trust", stage: "LEAD" },
    ],
    nextToken: null,
  });
  fileCommunication.mockResolvedValue({ data: { ok: true }, errors: undefined });
});

const draw = () =>
  render(
    <MemoryRouter>
      <Communications />
    </MemoryRouter>
  );

describe("an unidentified call", () => {
  it("shows the number and marks the caller ID as only that", async () => {
    draw();
    expect(await screen.findByText(/\+15085550199/)).toBeTruthy();
    // Dialpad's caller ID is not a match — nothing in the CRM knows this
    // number — so it is shown as hearsay rather than as the contact's name.
    expect(screen.getByText(/caller ID says/)).toBeTruthy();
  });

  it("offers no account until somebody picks one", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: "File it" })).toHaveProperty("disabled", true);
  });

  it("sorts the account list by name", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    const options = within(screen.getByLabelText("Account")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose…",
      "Beacon Hill Condo Trust (lead)",
      "Willow Creek Association",
    ]);
  });
});

describe("filing it", () => {
  it("sends the account and the remember-this-number choice", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    await userEvent.selectOptions(screen.getByLabelText("Account"), "a1");
    await userEvent.click(screen.getByRole("button", { name: "File it" }));
    expect(fileCommunication).toHaveBeenCalledWith({
      communicationId: "m1",
      action: "FILE",
      accountId: "a1",
      rememberNumber: true,
    });
  });

  it("can file without remembering the number", async () => {
    // A shared management-office line is not necessarily that association's.
    draw();
    await screen.findByText(/\+15085550199/);
    await userEvent.selectOptions(screen.getByLabelText("Account"), "a1");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "File it" }));
    expect(fileCommunication).toHaveBeenCalledWith(
      expect.objectContaining({ rememberNumber: false })
    );
  });
});

describe("turning it into a lead", () => {
  it("will not create one without a name", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    await userEvent.selectOptions(screen.getByLabelText("What is this?"), "lead");
    expect(screen.getByRole("button", { name: "Create lead" })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("sends the name and carries the caller ID across as the person", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    await userEvent.selectOptions(screen.getByLabelText("What is this?"), "lead");
    await userEvent.type(screen.getByLabelText("Association name"), "Cedar Court Trust");
    await userEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(fileCommunication).toHaveBeenCalledWith({
      communicationId: "m1",
      action: "NEW_LEAD",
      leadName: "Cedar Court Trust",
      contactName: "SPRINGFIELD MA",
    });
  });
});

describe("making it go away", () => {
  it("remembers a non-customer so it never queues again", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    await userEvent.click(screen.getByRole("button", { name: "Not a customer" }));
    expect(fileCommunication).toHaveBeenCalledWith({
      communicationId: "m1",
      action: "NOT_CUSTOMER",
    });
  });

  it("ignores one call without remembering anything", async () => {
    draw();
    await screen.findByText(/\+15085550199/);
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(fileCommunication).toHaveBeenCalledWith({
      communicationId: "m1",
      action: "IGNORE",
    });
  });
});

describe("an empty queue", () => {
  it("says every call matched rather than showing nothing", async () => {
    Communication.listCommunicationByMatchConfidenceAndOccurredAt.mockResolvedValue({
      data: [],
      nextToken: null,
    });
    draw();
    expect(await screen.findByText(/Nothing waiting/)).toBeTruthy();
  });
});
