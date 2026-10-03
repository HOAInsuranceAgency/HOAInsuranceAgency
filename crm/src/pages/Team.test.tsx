import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact — the
// same approach as client.test.ts, storage.test.ts and MarketingTasks.test.tsx.
const listTeamUsers = vi.hoisted(() => vi.fn());
const UserProfile = vi.hoisted(() => ({ listUserProfileByUserId: vi.fn(), update: vi.fn() }));
const inviteUser = vi.hoisted(() => vi.fn());
const updateUserRoles = vi.hoisted(() => vi.fn());
const communicationRequest = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: { UserProfile },
    queries: { listTeamUsers },
    mutations: { inviteUser, updateUserRoles },
  }),
}));
vi.mock("../lib/communications", () => ({ communicationRequest }));

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
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty message when the read returns no users", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [] }, errors: undefined });
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
  listTeamUsers.mockResolvedValue({ data: { users: [teammate], profiles: [teammateProfile] } });
  communicationRequest.mockImplementation(async (operation: string, input: TeamEligibility) => operation === "team" ? { team: [{ ...eligibility }] } : { member: { ...input, version: (input.version ?? 0) + 1 } });
}

describe("paged team roster", () => {
  const later = { userId: "u-later", email: "later@example.com", createdAt: null, groups: ["PRODUCER"] };
  const laterProfile = { ...teammateProfile, id: "p-later", userId: later.userId, email: later.email, firstName: "Later", lastName: "Member" };

  it("loads the next roster page only on request, with profile decorations in the same response", async () => {
    listTeamUsers.mockResolvedValueOnce({ data: { users: [teammate], profiles: [teammateProfile], nextToken: "page-2" } })
      .mockResolvedValueOnce({ data: JSON.stringify({ ok: true, users: [later], profiles: [laterProfile], nextToken: null }) });
    renderPage();
    expect(await screen.findByText("Casey Staff")).toBeVisible();
    expect(listTeamUsers).toHaveBeenCalledTimes(1);
    expect(UserProfile.listUserProfileByUserId).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load more team members" }));
    expect(await screen.findByText("Later Member")).toBeVisible();
    expect(listTeamUsers).toHaveBeenLastCalledWith({ nextToken: "page-2" });
    expect(UserProfile.listUserProfileByUserId).not.toHaveBeenCalled();
    expect(screen.getByText("Casey Staff")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more team members" })).toBeNull();
  });

  it("retains loaded rows and local role edits across a failed later page and its retry", async () => {
    listTeamUsers.mockResolvedValueOnce({ data: { users: [teammate], profiles: [teammateProfile], nextToken: "page-2" } })
      .mockResolvedValueOnce({ errors: [{ message: "Cognito throttled" }] });
    updateUserRoles.mockResolvedValue({ data: { ok: true } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit roles for Casey Staff" }));
    const modal = screen.getByRole("dialog");
    expect(screen.getByRole("button", { name: "Refresh team" })).toBeDisabled();
    fireEvent.click(within(modal).getByRole("checkbox", { name: "Producer" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Load more team members" }));
    expect(await screen.findByText("Cognito throttled")).toBeVisible();
    const row = screen.getByText(teammate.email).closest("tr")!;
    expect(within(row).getByText("PRODUCER")).toBeVisible();

    let finish!: (result: unknown) => void;
    listTeamUsers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Retry loading more" }));
    expect(screen.getByRole("button", { name: "Loading more…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh team" })).toBeDisabled();
    expect(within(row).getByText("PRODUCER")).toBeVisible();
    await act(async () => finish({ data: { users: [teammate, later], nextToken: null } }));
    expect(await screen.findByText(later.email)).toBeVisible();
    expect(within(row).getByText("PRODUCER")).toBeVisible();
    expect(screen.getAllByText(teammate.email)).toHaveLength(1);
    expect(listTeamUsers.mock.calls.slice(1)).toEqual([[{ nextToken: "page-2" }], [{ nextToken: "page-2" }]]);
    expect(screen.queryByText("Cognito throttled")).toBeNull();
  });

  it("can retry an initial roster failure", async () => {
    listTeamUsers.mockRejectedValueOnce(new Error("Roster unavailable"))
      .mockResolvedValueOnce({ data: { users: [teammate] } });
    renderPage();
    expect(await screen.findByText("Roster unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry team" }));
    expect(await screen.findByText(teammate.email)).toBeVisible();
    expect(screen.queryByText("Roster unavailable")).toBeNull();
  });

  it("keeps role management available when the response omits a member's optional profile", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [teammate] } });
    renderPage();
    expect(await screen.findByRole("button", { name: `Edit roles for ${teammate.email}` })).toBeEnabled();
    expect(screen.getByText("STAFF")).toBeVisible();
    expect(UserProfile.listUserProfileByUserId).not.toHaveBeenCalled();
  });
});

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
    expect(communicationRequest).toHaveBeenLastCalledWith("saveEligibility", { ...eligibility, salesperson: true, frontId: "tea_new", frontChannelId: "", frontSignatureId: "", version: 4 }, true);
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

  it("refreshes incomplete members after invitation cleanup fails while retaining the invitation error", async () => {
    combinedSetup();
    const incomplete = { userId: "u-incomplete", email: "incomplete@example.com", groups: ["ADMIN"], createdAt: null };
    const error = "The invitation failed and the incomplete account could not be removed or disabled. Review this member's access immediately before trying again.";
    inviteUser.mockResolvedValue({ data: { ok: false, error } });
    renderPage();
    expect(await screen.findByText(teammate.email)).toBeVisible();
    let finishRefresh!: (result: unknown) => void;
    listTeamUsers.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const card = screen.getByRole("button", { name: "Send invite" }).closest(".card")! as HTMLElement;
    fireEvent.change(within(card).getByRole("textbox", { name: "Email" }), { target: { value: incomplete.email } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invite" }));
    expect(await within(card).findByText(error)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh team" })).toBeDisabled();
    await act(async () => finishRefresh({ data: { ok: true, users: [teammate, incomplete] } }));
    expect(await screen.findByText(incomplete.email)).toBeVisible();
    expect(within(card).getByText(error)).toBeVisible();
    expect(within(card).getByRole("textbox", { name: "Email" })).toHaveValue(incomplete.email);
    expect(screen.getByRole("button", { name: "Refresh team" })).toBeEnabled();

    listTeamUsers.mockResolvedValue({ data: { users: [teammate] } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
    await waitFor(() => expect(screen.queryByText(incomplete.email)).toBeNull());
    expect(listTeamUsers).toHaveBeenCalledTimes(3);
    expect(within(card).getByText(error)).toBeVisible();
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

  it("refreshes the invited roster without letting a late assignment read overwrite an in-flight save", async () => {
    combinedSetup();
    let finishSave!: (result: unknown) => void;
    let finishStaleRead: ((result: unknown) => void) | undefined;
    let reads = 0, saves = 0;
    communicationRequest.mockImplementation((operation: string, input: TeamEligibility) => {
      if (operation === "team") {
        if (++reads === 1) return Promise.resolve({ team: [{ ...eligibility }] });
        return new Promise(resolve => { finishStaleRead = resolve; });
      }
      if (++saves === 1) return new Promise(resolve => { finishSave = resolve; });
      return Promise.resolve({ member: { ...input, version: (input.version ?? 0) + 1 } });
    });
    inviteUser.mockResolvedValue({ data: { ok: true } });
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "Salesperson eligibility for Casey Staff" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();

    const inviteCard = screen.getByRole("button", { name: "Send invite" }).closest(".card")!;
    fireEvent.change(within(inviteCard as HTMLElement).getByRole("textbox"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(listTeamUsers).toHaveBeenCalledTimes(2));
    expect(UserProfile.listUserProfileByUserId).not.toHaveBeenCalled();

    await act(async () => finishSave({ member: { ...eligibility, salesperson: true, version: 4 } }));
    // Before the guard, the invite starts a stale read which can settle after
    // the successful save. Deliver it last to exercise that exact ordering.
    if (finishStaleRead) await act(async () => finishStaleRead!({ team: [{ ...eligibility }] }));
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(reads).toBe(1);
    fireEvent.click(checkbox);
    await waitFor(() => expect(communicationRequest).toHaveBeenLastCalledWith("saveEligibility", { ...eligibility, salesperson: false, version: 4 }, true));
  });
});


describe("assigning up to two roles", () => {
  it("invites with both selected roles and prevents selecting a third", async () => {
    combinedSetup(); inviteUser.mockResolvedValue({ data: { ok: true } }); renderPage();
    const card = screen.getByRole("button", { name: "Send invite" }).closest(".card")! as HTMLElement;
    const admin = within(card).getByRole("checkbox", { name: "Admin" });
    const staff = within(card).getByRole("checkbox", { name: "Staff" });
    const producer = within(card).getByRole("checkbox", { name: "Producer" });
    expect(staff).toBeChecked(); expect(staff).toBeDisabled();
    fireEvent.click(admin);
    expect(producer).toBeDisabled();
    fireEvent.click(staff); fireEvent.click(producer);
    fireEvent.change(within(card).getByRole("textbox", { name: "Email" }), { target: { value: "dual@example.com" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(inviteUser).toHaveBeenCalledWith({ email: "dual@example.com", roles: ["ADMIN", "PRODUCER"] }));
  });

  it("saves both memberships for an existing user and shows both badges", async () => {
    combinedSetup(); updateUserRoles.mockResolvedValue({ data: { ok: true } }); renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit roles for Casey Staff" }));
    const modal = screen.getByRole("dialog", { name: "Roles for Casey Staff" });
    fireEvent.click(within(modal).getByRole("checkbox", { name: "Producer" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateUserRoles).toHaveBeenCalledWith({ userId: "u-1", roles: ["STAFF", "PRODUCER"] });
    const row = screen.getByText(teammate.email).closest("tr")!;
    expect(within(row).getByText("STAFF")).toBeVisible();
    expect(within(row).getByText("PRODUCER")).toBeVisible();
    expect(UserProfile.update).not.toHaveBeenCalled();
  });

  it("keeps failed changes in the editor, leaving the saved roster unchanged", async () => {
    combinedSetup(); updateUserRoles.mockResolvedValue({ errors: [{ message: "Role change unavailable" }] }); renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit roles for Casey Staff" }));
    const modal = screen.getByRole("dialog");
    fireEvent.click(within(modal).getByRole("checkbox", { name: "Producer" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save roles" }));
    expect(await within(modal).findByText("Role change unavailable")).toBeVisible();
    expect(within(modal).getByRole("checkbox", { name: "Producer" })).toBeChecked();
    expect(screen.queryByText("PRODUCER")).toBeNull();
    expect(within(modal).getByRole("button", { name: "Save roles" })).toBeEnabled();
  });

  it("lets the current admin add Producer and asks the app to refresh roles immediately", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [{ userId: profile.userId, email: profile.email, groups: ["ADMIN"] }], profiles: [profile] } });
    updateUserRoles.mockResolvedValue({ data: { ok: true } });
    const refreshed = vi.fn(); window.addEventListener("team-roles-changed", refreshed);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit roles for Ada Admin" }));
    const modal = screen.getByRole("dialog");
    fireEvent.click(within(modal).getByRole("checkbox", { name: "Producer" }));
    expect(within(modal).getByRole("checkbox", { name: "Admin" })).toBeDisabled();
    fireEvent.click(within(modal).getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
    expect(updateUserRoles).toHaveBeenCalledWith({ userId: profile.userId, roles: ["ADMIN", "PRODUCER"] });
    window.removeEventListener("team-roles-changed", refreshed);
  });
});
