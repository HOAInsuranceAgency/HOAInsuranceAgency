import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact — the
// same approach as client.test.ts, storage.test.ts and MarketingTasks.test.tsx.
const listTeamUsers = vi.hoisted(() => vi.fn());
const UserProfile = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
const inviteUser = vi.hoisted(() => vi.fn());
const communicationRequest = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: { UserProfile },
    queries: { listTeamUsers },
    mutations: { inviteUser },
  }),
}));
vi.mock("../lib/communications", () => ({ communicationRequest }));
// Routing is a separate settings section; these exercise the combined member table.
vi.mock("../components/TeamWorkflowSettings", () => ({ default: () => null }));

// SignatureManager (rendered once per roster row) imports these at module
// scope. Only getUrl can fire, and only for a profile that has a signatureKey —
// no row here does — but the module still has to resolve.
vi.mock("../lib/scopedStorage", () => ({
  getUrl: vi.fn(),
  uploadData: vi.fn(),
  remove: vi.fn(),
}));

import Team from "./Team";
import type { UserProfile as UserProfileType } from "../lib/client";
import type { TeamEligibility } from "../lib/communications";

/**
 * The four render states of the team roster.
 *
 * `Team` was the one screen the useAsyncResource migration left with a
 * three-branch ladder: loading, empty, table. It had no error branch, so a
 * failed roster read fell through to `users.length === 0` and rendered
 * "No users found." — a read failure presented as an empty organisation, on
 * the one screen where "there are no users" is never a true statement about a
 * signed-in admin's own team.
 *
 * The message was not invisible; it was in the wrong card. `team.error` was
 * rendered in the *invite* form's action row beside SaveStatus, where a
 * roster-read failure reads as "your invite failed". These assert it now
 * appears where the roster does, and only there.
 *
 * The CRM is behind Cognito magic-link auth, so this screen cannot be driven
 * in a browser without a real sign-in. This is the substitute, per PATTERNS.
 */
const profile = {
  id: "p-self",
  userId: "u-self",
  email: "admin@getgim.com",
  firstName: "Ada",
  lastName: "Admin",
} as UserProfileType;

const renderPage = () => render(<Team profile={profile} />);

/** A never-settling read, to hold the component in its in-flight state. */
const pending = () => new Promise<never>(() => {});
beforeEach(() => {
  vi.clearAllMocks();
  communicationRequest.mockResolvedValue({ team: [] });
});

describe("Team roster read states", () => {
  it("shows a loader while the read is in flight", () => {
    listTeamUsers.mockReturnValue(pending());
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty message when the read returns no users", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [] }, errors: undefined });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    expect(await screen.findByText("No users found.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the error — not the empty message, and not a stuck loader", async () => {
    // client.queries.* reports failure by *resolving* with an errors array, not
    // by rejecting, which is why Team unwraps inside the fetcher. That is the
    // failure mode this screen actually sees, so it is the one exercised here.
    listTeamUsers.mockResolvedValue({
      data: null,
      errors: [{ message: "listTeamUsers is unavailable" }],
    });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    expect(
      await screen.findByText(/listTeamUsers is unavailable/)
    ).toBeInTheDocument();
    // The regression: before the error branch existed, this fell through to the
    // empty case and reported an outage as an empty team.
    expect(screen.queryByText("No users found.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("reports a read failure once, and not beside the invite button", async () => {
    listTeamUsers.mockResolvedValue({
      data: null,
      errors: [{ message: "listTeamUsers is unavailable" }],
    });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    const shown = await screen.findAllByText(/listTeamUsers is unavailable/);
    expect(shown).toHaveLength(1);

    // It belongs to the roster card, not the invite form's action row — so the
    // send-invite button must not be its sibling.
    const actions = screen
      .getByRole("button", { name: /send invite/i })
      .closest(".form-actions");
    expect(actions).not.toBeNull();
    expect(actions).not.toHaveTextContent(/listTeamUsers is unavailable/);
  });

  it("renders rows when the read succeeds", async () => {
    listTeamUsers.mockResolvedValue({
      data: {
        users: [
          {
            userId: "u-1",
            email: "producer@getgim.com",
            createdAt: "2026-01-15T09:30:00.000Z",
            groups: ["PRODUCER"],
          },
        ],
      },
      errors: undefined,
    });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    expect(await screen.findByText("producer@getgim.com")).toBeInTheDocument();
    expect(screen.getByText("PRODUCER")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No users found.")).not.toBeInTheDocument();
  });
});

const teammate = { userId: "u-1", email: "casey@example.com", createdAt: "2026-01-15T09:30:00Z", groups: ["STAFF"] };
const teammateProfile = { id: "p-1", userId: "u-1", email: teammate.email, firstName: "Casey", lastName: "Staff", onboardingComplete: true, leadTextAlerts: false, mobilePhone: "5085550100" } as UserProfileType;
const eligibility: TeamEligibility = { userId: "u-1", name: "Casey Staff", email: teammate.email, enabled: true, salesperson: false, frontId: "tea_casey", dialpadId: "5655281245659136", version: 3 };
function combinedSetup() {
  listTeamUsers.mockResolvedValue({ data: { users: [teammate] } });
  UserProfile.list.mockResolvedValue({ data: [teammateProfile] });
  communicationRequest.mockImplementation(async (operation: string, input: TeamEligibility) => operation === "team" ? { team: [{ ...eligibility }] } : { member: { ...input, version: (input.version ?? 0) + 1 } });
}

describe("combined team and assignment settings", () => {
  it("shows one member row with role, alerts, eligibility and exact provider IDs", async () => {
    combinedSetup(); renderPage();
    const region = screen.getByRole("region", { name: "Team members" });
    expect(await within(region).findByText(teammate.email)).toBeVisible();
    expect(within(region).getAllByRole("table")).toHaveLength(1);
    expect(within(region).getAllByRole("row")).toHaveLength(2);
    expect(within(region).getAllByText(teammate.email)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Salesperson assignment eligibility" })).toBeNull();
    const row = within(region).getByText(teammate.email).closest("tr")!;
    expect(within(row).getByText("Casey Staff")).toBeVisible();
    expect(within(row).getByText("STAFF")).toBeVisible();
    expect(within(row).getByRole("checkbox", { name: "Lead texts for Casey Staff" })).not.toBeChecked();
    expect(within(row).getByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" })).not.toBeChecked();
    expect(within(row).getByText(eligibility.frontId!)).toBeVisible();
    expect(within(row).getByText(eligibility.dialpadId!)).toBeVisible();
  });

  it("saves eligibility and connections from the same row using the committed version without changing access or lead alerts", async () => {
    combinedSetup(); renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(communicationRequest).toHaveBeenCalledWith("saveEligibility", { ...eligibility, salesperson: true }, true);
    expect(screen.getByText("STAFF")).toBeVisible();
    expect(UserProfile.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit connections for Casey Staff" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Front teammate ID/ }), { target: { value: "tea_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(communicationRequest).toHaveBeenLastCalledWith("saveEligibility", { ...eligibility, salesperson: true, frontId: "tea_new", version: 4 }, true);
    expect(screen.getByText("tea_new")).toBeVisible();
    expect(communicationRequest.mock.calls.filter(call => call[0] === "team")).toHaveLength(1);
    UserProfile.update.mockResolvedValue({ data: { ...teammateProfile, leadTextAlerts: true } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead texts for Casey Staff" }));
    await waitFor(() => expect(UserProfile.update).toHaveBeenCalledWith(expect.objectContaining({ id: teammateProfile.id, leadTextAlerts: true })));
  });

  it("keeps the roster visible through an assignment load failure and recovers with refresh", async () => {
    combinedSetup(); communicationRequest.mockRejectedValueOnce(new Error("Assignment service unavailable")); renderPage();
    expect(await screen.findByText("Assignment service unavailable")).toBeVisible();
    expect(await screen.findByText(teammate.email)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh assignment settings" }));
    expect(await screen.findByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" })).toBeEnabled();
    expect(screen.queryByText("Assignment service unavailable")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Team members" })).getAllByRole("row")).toHaveLength(2);
  });

  it("keeps pending invites visible and refreshes assignment settings after an invite", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [teammate] } });
    UserProfile.list.mockResolvedValue({ data: [] });
    communicationRequest.mockResolvedValue({ team: [] });
    renderPage();
    expect(await screen.findByText("Available after first sign-in")).toBeVisible();
    expect(screen.getByText(teammate.email)).toBeVisible();
    inviteUser.mockResolvedValue({ data: { ok: true } });
    communicationRequest.mockResolvedValue({ team: [eligibility] });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" })).toBeEnabled();
    expect(communicationRequest.mock.calls.filter(call => call[0] === "team")).toHaveLength(2);
  });

  it("disables repeated assignment edits while saving and retains the original choice on failure", async () => {
    combinedSetup();
    let fail!: (error: Error) => void;
    communicationRequest.mockImplementation((op: string) => op === "team" ? Promise.resolve({ team: [eligibility] }) : new Promise((_, reject) => { fail = reject; }));
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit connections for Casey Staff" })).toBeDisabled();
    await act(async () => fail(new Error("Could not save assignment")));
    expect(await screen.findByText("Could not save assignment")).toBeVisible();
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
  });
});
