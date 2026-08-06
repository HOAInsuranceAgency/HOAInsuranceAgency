import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact — the
// same approach as MarketingTasks.test.tsx.
const models = vi.hoisted(() => ({
  Account: { get: vi.fn(), update: vi.fn() },
  Contact: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  Loss: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  Building: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models, mutations: {} }),
}));
// The actor proxy in client.ts stamps `lastWriteBy` on every create/update,
// which means every write here goes through getCurrentUser first.
vi.mock("aws-amplify/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ userId: "u1" })),
}));

import { buildingKey, contactKey, lossKey } from "../lib/extractionKeys";
import ExtractionPanel from "./ExtractionPanel";
import type { Account } from "../lib/client";

/**
 * Applying an extraction, twice.
 *
 * The bug: the panel created a Building for every selected candidate on every
 * apply, with no check against what existed — and the button reads "Re-run
 * extraction", which invites exactly that. Re-run, apply again, and the whole
 * property schedule was duplicated.
 *
 * The CRM is behind Cognito magic-link auth, so this screen cannot be driven
 * in a browser without a real sign-in. This is the substitute.
 */

const EXTRACTED_AT = "2026-08-01T10:00:00.000Z";

const extraction = (
  buildings: unknown[],
  rest: { contacts?: unknown[]; losses?: unknown[] } = {}
) =>
  JSON.stringify({
    address: { value: "12 Maple Ridge Way", confidence: "high", evidence: "", source: "" },
    contacts: [],
    losses: [],
    buildings,
    summary: "Two buildings.",
    extractedAt: EXTRACTED_AT,
    ...rest,
  });

const CANDIDATES = [
  { label: "Clubhouse", sqft: "4200", yearBuilt: "1985" },
  { label: "Pool House", sqft: "900" },
];

/** A stored Building as the account already has it. */
const stored = (label: string, sqft: number, extra: object = {}) => ({
  id: `b-${label}`,
  accountId: "a1",
  label,
  sqft,
  extractionSourceKey: buildingKey({ label }),
  ...extra,
});

const account = (over: Partial<Account> = {}): Account =>
  ({
    id: "a1",
    name: "Maple Ridge",
    stage: "LEAD",
    extractionStatus: "COMPLETE",
    aiExtraction: extraction(CANDIDATES),
    ...over,
  }) as Account;

const renderPanel = (acct: Account = account()) =>
  render(<ExtractionPanel account={acct} onChange={vi.fn()} />);

const apply = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByText(/^Apply selected to/));

beforeEach(() => {
  for (const model of Object.values(models)) {
    for (const fn of Object.values(model)) fn.mockClear();
  }
  models.Contact.list.mockImplementation(async () => ({ data: [], nextToken: null }));
  models.Loss.list.mockImplementation(async () => ({ data: [], nextToken: null }));
  models.Building.list.mockImplementation(async () => ({ data: [], nextToken: null }));
  models.Account.update.mockImplementation(async () => ({
    data: account(),
    errors: null,
  }));
  models.Building.create.mockImplementation(async () => ({ data: {}, errors: null }));
  models.Building.update.mockImplementation(async () => ({ data: {}, errors: null }));
});

describe("verdicts", () => {
  it("offers a building the account does not have as an add", async () => {
    renderPanel();
    const row = (await screen.findByText("Clubhouse · 4,200 sq ft")).closest("tr")!;
    expect(within(row).getByText("add")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox")).toBeEnabled();
  });

  it("greys out and locks a building that already matches the record", async () => {
    // The case that produced the duplicates. Selecting it would write nothing
    // and say something happened, so it cannot be selected at all.
    models.Building.list.mockImplementation(async () => ({
      data: [stored("Clubhouse", 4200, { yearBuilt: 1985 })],
      nextToken: null,
    }));
    renderPanel();
    const row = (await screen.findByText("Clubhouse · 4,200 sq ft")).closest("tr")!;
    await waitFor(() =>
      expect(within(row).getByText("no change")).toBeInTheDocument()
    );
    expect(within(row).getByRole("checkbox")).toBeDisabled();
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
  });

  it("shows field by field what an update would change", async () => {
    // A checkbox that says only "update" asks somebody to approve an edit
    // without telling them what the edit is.
    models.Building.list.mockImplementation(async () => ({
      data: [stored("Clubhouse", 3000, { yearBuilt: 1985 })],
      nextToken: null,
    }));
    renderPanel();
    const row = (await screen.findByText("Clubhouse · 4,200 sq ft")).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("update")).toBeInTheDocument());
    expect(within(row).getByText(/Sqft: 3000 → 4200/)).toBeInTheDocument();
  });
});

describe("applying", () => {
  it("creates each building exactly once when none exist", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Clubhouse · 4,200 sq ft");
    await apply(user);

    await waitFor(() => expect(models.Building.create).toHaveBeenCalledTimes(2));
    expect(models.Building.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "a1",
        label: "Clubhouse",
        sqft: 4200,
        yearBuilt: 1985,
        extractionSourceKey: "building:clubhouse",
      })
    );
    expect(models.Building.update).not.toHaveBeenCalled();
  });

  it("writes nothing at all on a second apply of the same result", async () => {
    // The whole workstream in one assertion: same extraction, same account,
    // every candidate already on the record.
    const user = userEvent.setup();
    models.Building.list.mockImplementation(async () => ({
      data: [
        stored("Clubhouse", 4200, { yearBuilt: 1985 }),
        stored("Pool House", 900),
      ],
      nextToken: null,
    }));
    renderPanel();
    await screen.findByText("Clubhouse · 4,200 sq ft");
    await apply(user);

    await waitFor(() => expect(models.Account.update).toHaveBeenCalled());
    expect(models.Building.create).not.toHaveBeenCalled();
    expect(models.Building.update).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/2 selected rows were already on the record/)
    ).toBeInTheDocument();
  });

  it("updates a building whose sq ft changed instead of duplicating it", async () => {
    const user = userEvent.setup();
    models.Building.list.mockImplementation(async () => ({
      data: [stored("Clubhouse", 3000), stored("Pool House", 900)],
      nextToken: null,
    }));
    renderPanel();
    await screen.findByText("Clubhouse · 4,200 sq ft");
    await apply(user);

    await waitFor(() => expect(models.Building.update).toHaveBeenCalledTimes(1));
    expect(models.Building.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b-Clubhouse", sqft: 4200 })
    );
    expect(models.Building.create).not.toHaveBeenCalled();
  });

  it("creates exactly one row for the one genuinely new building", async () => {
    const user = userEvent.setup();
    models.Building.list.mockImplementation(async () => ({
      data: [stored("Clubhouse", 4200, { yearBuilt: 1985 })],
      nextToken: null,
    }));
    renderPanel();
    await screen.findByText("Pool House · 900 sq ft");
    await apply(user);

    await waitFor(() => expect(models.Building.create).toHaveBeenCalledTimes(1));
    expect(models.Building.create).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Pool House" })
    );
  });

  it("applies the same rule to contacts and losses, not just buildings", async () => {
    // The three loops are the same shape, and the one that had the bug is the
    // one everything else here exercises. Without this the other two could
    // lose their skip and nothing would notice.
    const user = userEvent.setup();
    models.Contact.list.mockImplementation(async () => ({
      data: [
        {
          id: "c1",
          extractionSourceKey: contactKey({ email: "pat@example.com" }),
          name: "Pat Alvarez",
          email: "pat@example.com",
          type: "MANAGER",
        },
      ],
      nextToken: null,
    }));
    models.Loss.list.mockImplementation(async () => ({
      data: [
        {
          id: "l1",
          extractionSourceKey: lossKey({
            dateOfLoss: "2024-03-14",
            lineOfBusiness: "Property",
            amountOfLoss: null,
          }),
          dateOfLoss: "2024-03-14",
          lineOfBusiness: "Property",
        },
      ],
      nextToken: null,
    }));
    models.Building.list.mockImplementation(async () => ({
      data: [stored("Clubhouse", 4200, { yearBuilt: 1985 }), stored("Pool House", 900)],
      nextToken: null,
    }));

    renderPanel(
      account({
        aiExtraction: extraction(CANDIDATES, {
          contacts: [
            { name: "Pat Alvarez", email: "pat@example.com", type: "MANAGER" },
          ],
          losses: [{ dateOfLoss: "2024-03-14", lineOfBusiness: "Property" }],
        }),
      })
    );
    await screen.findByText("Pat Alvarez");
    await apply(user);

    await waitFor(() => expect(models.Account.update).toHaveBeenCalled());
    for (const model of [models.Contact, models.Loss, models.Building]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
    }
    expect(
      await screen.findByText(/4 selected rows were already on the record/)
    ).toBeInTheDocument();
  });

  it("still reports partial success when a create fails", async () => {
    // Existing behaviour, kept: the account fields did land, so a child row
    // that failed is a partial success that names where to finish by hand —
    // not a green "Applied" and not a red failure.
    const user = userEvent.setup();
    models.Building.create.mockImplementation(async () => ({
      data: null,
      errors: [{ message: "nope" }],
    }));
    renderPanel();
    await screen.findByText("Clubhouse · 4,200 sq ft");
    await apply(user);

    const status = await screen.findByText(/Couldn't save 2 buildings under Property/);
    expect(status).toHaveAttribute("data-save-state", "warning");
  });
});

describe("the idempotency marker", () => {
  it("records which extraction was applied", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Clubhouse · 4,200 sq ft");
    await apply(user);

    await waitFor(() =>
      expect(models.Account.update).toHaveBeenCalledWith(
        expect.objectContaining({ aiExtractionAppliedAt: EXTRACTED_AT })
      )
    );
  });

  it("refuses to re-apply the same result, and says why", async () => {
    // Match-then-write already makes a second apply harmless row by row, but
    // harmless is not the same as "did nothing": it still patches the account
    // and still fills the activity log with edits nobody made. A disabled
    // button would say "no" without saying why, so the button stays live and
    // the refusal is a sentence.
    const user = userEvent.setup();
    renderPanel(account({ aiExtractionAppliedAt: EXTRACTED_AT }));
    await screen.findByText("Clubhouse · 4,200 sq ft");
    await apply(user);

    const status = await screen.findByText(/has already been applied/);
    expect(status).toHaveAttribute("data-save-state", "warning");
    expect(models.Account.update).not.toHaveBeenCalled();
    expect(models.Building.create).not.toHaveBeenCalled();
  });

  it("lets the reviewer override it, because the guard is a default", async () => {
    // Somebody who has since ticked a field they skipped the first time has a
    // legitimate reason to apply the same result again.
    const user = userEvent.setup();
    renderPanel(account({ aiExtractionAppliedAt: EXTRACTED_AT }));
    await screen.findByText("Clubhouse · 4,200 sq ft");

    await user.click(screen.getByText("Apply again anyway"));
    await waitFor(() => expect(models.Account.update).toHaveBeenCalled());
  });
});
