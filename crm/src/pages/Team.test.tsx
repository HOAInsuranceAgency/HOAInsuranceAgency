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
const setTeamUserEnabled = vi.hoisted(() => vi.fn());
const communicationRequest = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: { UserProfile },
    queries: { listTeamUsers },
    mutations: { inviteUser, updateUserRoles, setTeamUserEnabled },
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
import * as signatureStorage from "../lib/scopedStorage";
import { OwnerContext } from "../lib/auth";
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
function combinedSetup(producer = false) {
  listTeamUsers.mockResolvedValue({ data: { users: [{ ...teammate, groups: producer ? ["PRODUCER"] : teammate.groups }], profiles: [teammateProfile] } });
  let member = { ...eligibility, salesperson: producer, receiveNewLeads: false };
  communicationRequest.mockImplementation(async (operation: string, input: Partial<TeamEligibility>) => {
    if (operation === "teamSettings") return { team: [member] };
    member = { ...member, ...input, version: (input.version ?? 0) + 1 };
    return { member };
  });
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
    expect(within(row).queryByRole("checkbox", { name: /Salesperson eligibility/ })).toBeNull();
    expect(within(row).queryByRole("checkbox", { name: /Receive new leads/ })).toBeNull();
    expect(within(row).getByText("Producers only")).toBeVisible();
    expect(within(row).getByText(eligibility.frontId!)).toBeVisible();
    expect(within(row).getByText(eligibility.dialpadId!)).toBeVisible();
  });

  it("saves eligibility and connections from the same row using the committed version without changing access or lead alerts", async () => {
    combinedSetup(true); renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "Receive new leads for Casey Staff" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(communicationRequest).toHaveBeenCalledWith("saveEligibility", { userId: eligibility.userId, version: 3, receiveNewLeads: true }, true);
    expect(screen.getByText("PRODUCER")).toBeVisible();
    expect(UserProfile.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit connections for Casey Staff" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Front teammate ID/ }), { target: { value: "tea_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(communicationRequest).toHaveBeenLastCalledWith("saveEligibility", { userId: eligibility.userId, frontId: "tea_new", frontChannelId: "", frontSignatureId: "", dialpadId: eligibility.dialpadId, version: 4 }, true);
    expect(screen.getByText("tea_new")).toBeVisible();
    expect(communicationRequest.mock.calls.filter(call => call[0] === "teamSettings")).toHaveLength(1);
    UserProfile.update.mockResolvedValue({ data: { ...teammateProfile, leadTextAlerts: true } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead texts for Casey Staff" }));
    await waitFor(() => expect(UserProfile.update).toHaveBeenCalledWith(expect.objectContaining({ id: teammateProfile.id, leadTextAlerts: true })));
  });

  it("keeps the roster visible through an assignment load failure and recovers with refresh", async () => {
    combinedSetup(true); communicationRequest.mockRejectedValueOnce(new Error("Assignment service unavailable")); renderPage();
    expect(await screen.findByText("Assignment service unavailable")).toBeVisible();
    expect(await screen.findByText(teammate.email)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Receive new leads for Casey Staff" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh assignment settings" }));
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Casey Staff" })).toBeEnabled();
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
    listTeamUsers.mockResolvedValue({ data: { users: [{ ...teammate, groups: ["PRODUCER"] }], profiles: [teammateProfile] } });
    communicationRequest.mockResolvedValue({ team: [{ ...eligibility, salesperson: true }] });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Casey Staff" })).toBeEnabled();
    expect(communicationRequest.mock.calls.filter(call => call[0] === "teamSettings")).toHaveLength(2);
  });

  it("refreshes incomplete members after invitation cleanup fails while retaining the invitation error", async () => {
    combinedSetup(true);
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
    combinedSetup(true);
    let fail!: (error: Error) => void;
    communicationRequest.mockImplementation((op: string) => op === "teamSettings" ? Promise.resolve({ team: [{ ...eligibility, salesperson: true, receiveNewLeads: false }] }) : new Promise((_, reject) => { fail = reject; }));
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "Receive new leads for Casey Staff" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit connections for Casey Staff" })).toBeDisabled();
    await act(async () => fail(new Error("Could not save assignment")));
    expect(await screen.findByText("Could not save assignment")).toBeVisible();
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
  });

  it("refreshes the invited roster without letting a late assignment read overwrite an in-flight save", async () => {
    combinedSetup(true);
    let finishSave!: (result: unknown) => void;
    let finishStaleRead: ((result: unknown) => void) | undefined;
    let reads = 0, saves = 0;
    communicationRequest.mockImplementation((operation: string, input: Partial<TeamEligibility>) => {
      if (operation === "teamSettings") {
        if (++reads === 1) return Promise.resolve({ team: [{ ...eligibility, salesperson: true, receiveNewLeads: false }] });
        return new Promise(resolve => { finishStaleRead = resolve; });
      }
      if (++saves === 1) return new Promise(resolve => { finishSave = resolve; });
      return Promise.resolve({ member: { ...eligibility, salesperson: true, ...input, version: (input.version ?? 0) + 1 } });
    });
    inviteUser.mockResolvedValue({ data: { ok: true } });
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "Receive new leads for Casey Staff" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeDisabled();

    const inviteCard = screen.getByRole("button", { name: "Send invite" }).closest(".card")!;
    fireEvent.change(within(inviteCard as HTMLElement).getByRole("textbox"), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(listTeamUsers).toHaveBeenCalledTimes(2));
    expect(UserProfile.listUserProfileByUserId).not.toHaveBeenCalled();

    await act(async () => finishSave({ member: { ...eligibility, salesperson: true, receiveNewLeads: true, version: 4 } }));
    // Before the guard, the invite starts a stale read which can settle after
    // the successful save. Deliver it last to exercise that exact ordering.
    if (finishStaleRead) await act(async () => finishStaleRead!({ team: [{ ...eligibility }] }));
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(reads).toBe(1);
    fireEvent.click(checkbox);
    await waitFor(() => expect(communicationRequest).toHaveBeenLastCalledWith("saveEligibility", { userId: eligibility.userId, receiveNewLeads: false, version: 4 }, true));
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


describe("Owner role administration", () => {
  it("hides Owner invitation and disables changing an Owner when acting as Admin", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [{ ...teammate, groups: ["OWNER"] }], profiles: [teammateProfile] } });
    renderPage();
    expect(await screen.findByRole("button", { name: "Edit roles for Casey Staff" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: "Owner" })).not.toBeInTheDocument();
  });

  it("allows Owners to assign Owner and prevents removing their own Owner role", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [{ userId: profile.userId, email: profile.email, createdAt: null, groups: ["OWNER", "PRODUCER"] }], profiles: [profile] } });
    render(<OwnerContext.Provider value={true}><Team profile={profile} /></OwnerContext.Provider>);
    expect(screen.getByRole("checkbox", { name: "Owner" })).toBeEnabled();
    fireEvent.click(await screen.findByRole("button", { name: "Edit roles for Ada Admin" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: "Owner" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Owner" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "Producer" })).toBeEnabled();
  });
});

describe("Owner access management", () => {
  const renderOwner = () => render(<OwnerContext.Provider value={true}><Team profile={profile} /></OwnerContext.Provider>);

  it("offers access changes only to Owners and prevents self-deactivation", async () => {
    combinedSetup();
    const { unmount } = renderPage();
    expect(await screen.findByText("Active")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Deactivate Casey Staff" })).toBeNull();
    unmount();
    listTeamUsers.mockResolvedValue({ data: { users: [teammate, { userId: profile.userId, email: profile.email, createdAt: null, groups: ["OWNER"] }], profiles: [teammateProfile, profile] } });
    renderOwner();
    expect(await screen.findByRole("button", { name: "Deactivate Casey Staff" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deactivate Ada Admin" })).toBeDisabled();
    expect(setTeamUserEnabled).not.toHaveBeenCalled();
  });

  it("confirms deactivation, blocks duplicate submissions and shows the saved inactive status", async () => {
    combinedSetup(true);
    let finish!: (result: unknown) => void;
    setTeamUserEnabled.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderOwner();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate Casey Staff" }));
    const dialog = screen.getByRole("dialog", { name: "Deactivate Casey Staff" });
    expect(within(dialog).getByText(/Block this team member’s CRM access/)).toBeVisible();
    expect(setTeamUserEnabled).not.toHaveBeenCalled();
    const confirm = within(dialog).getByRole("button", { name: "Deactivate user" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Updating access…" })).toBeDisabled();
    expect(setTeamUserEnabled).toHaveBeenCalledExactlyOnceWith({ userId: teammate.userId, enabled: false });
    await act(async () => finish({ data: { ok: true, userId: teammate.userId, enabled: false } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const row = screen.getByText(teammate.email).closest("tr")!;
    expect(within(row).getByText("Inactive")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Reactivate Casey Staff" })).toBeEnabled();
    expect(within(row).getByRole("checkbox", { name: "Receive new leads for Casey Staff" })).toBeDisabled();
    expect(within(row).getByRole("checkbox", { name: "Lead texts for Casey Staff" })).toBeDisabled();
    expect(screen.getByText(`Access deactivated for ${teammate.email}.`)).toBeVisible();
  });

  it("reactivates an inactive user with a new sign-in", async () => {
    combinedSetup();
    listTeamUsers.mockResolvedValue({ data: { users: [{ ...teammate, enabled: false }], profiles: [teammateProfile] } });
    setTeamUserEnabled.mockResolvedValue({ data: { ok: true, userId: teammate.userId, enabled: true } });
    renderOwner();
    fireEvent.click(await screen.findByRole("button", { name: "Reactivate Casey Staff" }));
    expect(screen.getByText(/They’ll need to sign in again/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reactivate user" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(setTeamUserEnabled).toHaveBeenCalledWith({ userId: teammate.userId, enabled: true });
    expect(screen.getByText("Active")).toBeVisible();
  });

  it("keeps failed requests reviewable and reflects access already blocked by a partial failure", async () => {
    combinedSetup();
    const error = "CRM access is blocked, but Cognito sign-out failed. Retry deactivation.";
    setTeamUserEnabled.mockResolvedValueOnce({ data: { ok: false, enabled: false, error } })
      .mockResolvedValueOnce({ data: { ok: true, enabled: false } });
    renderOwner();
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate Casey Staff" }));
    listTeamUsers.mockResolvedValue({ data: { users: [{ ...teammate, enabled: false }], profiles: [teammateProfile] } });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate user" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(error)).toBeVisible();
    expect(screen.getByText("Inactive")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Deactivate user" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate user" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(setTeamUserEnabled).toHaveBeenCalledTimes(2);
  });
});

it('does not claim a lead-alert change persisted when its save fails, and lets it retry', async () => {
  combinedSetup();
  UserProfile.update.mockResolvedValueOnce({ errors: [{ message: 'Profile save failed' }] }).mockResolvedValueOnce({ data: { ...teammateProfile, leadTextAlerts: true } });
  renderPage();
  const toggle = await screen.findByRole('checkbox', { name: 'Lead texts for Casey Staff' });
  fireEvent.click(toggle);
  expect(await screen.findByText('Profile save failed')).toBeVisible();
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(UserProfile.update).toHaveBeenCalledTimes(2);
});

it('retains an unsaved phone draft through roster refresh but adopts refreshes when pristine', async () => {
  combinedSetup(); renderPage();
  const phone = await screen.findByRole('textbox', { name: 'Mobile number for Casey Staff' });
  listTeamUsers.mockResolvedValue({ data: { users: [teammate], profiles: [{ ...teammateProfile, mobilePhone: '5085550200' }] } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh team' }));
  await waitFor(() => expect(phone).toHaveValue('5085550200'));
  fireEvent.change(phone, { target: { value: '5085550300' } });
  listTeamUsers.mockResolvedValue({ data: { users: [teammate], profiles: [{ ...teammateProfile, mobilePhone: '5085550400' }] } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh team' }));
  await waitFor(() => expect(listTeamUsers).toHaveBeenCalledTimes(3));
  expect(phone).toHaveValue('5085550300');
});


it.each(['alerts-first', 'signature-first'])('merges only committed fields when signature and alert saves overlap (%s)', async order => {
  combinedSetup();
  const signed = { ...teammateProfile, signatureKey: 'signatures/p-1.png' };
  listTeamUsers.mockResolvedValue({ data: { users: [teammate], profiles: [signed] } });
  vi.mocked(signatureStorage.getUrl).mockResolvedValue({ url: new URL('https://example.com/signature'), expiresAt: new Date() });
  vi.mocked(signatureStorage.remove).mockResolvedValue({ path: signed.signatureKey });
  let finishAlerts!: (value: unknown) => void, finishSignature!: (value: unknown) => void;
  UserProfile.update.mockImplementation((patch: Partial<UserProfileType>) => new Promise(resolve => {
    if ('signatureKey' in patch) finishSignature = resolve; else finishAlerts = resolve;
  }));
  renderPage();
  const toggle = await screen.findByRole('checkbox', { name: 'Lead texts for Casey Staff' });
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  if (order === 'alerts-first') {
    await act(async () => finishAlerts({ data: { ...signed, leadTextAlerts: true } }));
    await act(async () => finishSignature({ data: { ...signed, signatureKey: null } }));
  } else {
    await act(async () => finishSignature({ data: { ...signed, signatureKey: null } }));
    await act(async () => finishAlerts({ data: { ...signed, leadTextAlerts: true } }));
  }
  expect(toggle).toBeChecked();
  expect(screen.getByText('None on file')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
});


it('confirms a successful invite without treating the cleared email as an unsaved edit', async () => {
  listTeamUsers.mockResolvedValue({ data: { users: [] } });
  let finish!: (value: unknown) => void;
  inviteUser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  renderPage(); await screen.findByText('No users found.');
  const email = screen.getByRole('textbox', { name: 'Email' });
  fireEvent.change(email, { target: { value: 'producer@example.com' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Producer' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Staff' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
  expect(email).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Producer' })).toBeDisabled();
  await act(async () => finish({ data: { ok: true } }));
  expect(await screen.findByText(/Invited producer@example.com as PRODUCER/)).toBeVisible();
  expect(screen.queryByText(/Newer edits still need saving/)).toBeNull();
  expect(email).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: 'Producer' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Staff' })).not.toBeChecked();
});

describe("bounded visible teammate settings", () => {
  const page = (start: number, count: number, nextToken: string | null) => {
    const users = Array.from({ length: count }, (_, offset) => ({ userId: `page-user-${start + offset}`, email: `member${start + offset}@example.com`, groups: ["PRODUCER"], enabled: true, createdAt: null }));
    const profiles = users.map((user, offset) => ({ ...teammateProfile, id: `profile-${user.userId}`, userId: user.userId, email: user.email, firstName: "Member", lastName: String(start + offset) }));
    return { users, profiles, nextToken };
  };
  const settingsCalls = () => communicationRequest.mock.calls.filter(([operation]) => operation === "teamSettings");

  it("waits for the roster, loads its exact first twenty IDs, and reads only twenty new IDs on Load more", async () => {
    const first = page(0, 20, "second-page"), second = page(20, 20, null);
    let finishRoster!: (result: unknown) => void;
    listTeamUsers.mockImplementationOnce(() => new Promise(resolve => { finishRoster = resolve; }))
      .mockResolvedValueOnce({ data: second });
    renderPage();
    expect(communicationRequest).not.toHaveBeenCalled();
    await act(async () => finishRoster({ data: first }));
    await waitFor(() => expect(settingsCalls()).toHaveLength(1));
    expect(settingsCalls()[0]).toEqual(["teamSettings", { userIds: first.users.map(user => user.userId) }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more team members" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Load more team members" }));
    await waitFor(() => expect(settingsCalls()).toHaveLength(2));
    expect(settingsCalls()[1]).toEqual(["teamSettings", { userIds: second.users.map(user => user.userId) }]);
    expect(communicationRequest.mock.calls.some(([operation]) => operation === "team")).toBe(false);
    expect(UserProfile.listUserProfileByUserId).not.toHaveBeenCalled();
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Member 0" })).toBeChecked();
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Member 39" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Roles" }));
    expect(settingsCalls()).toHaveLength(2);
  });

  it("keeps role and access management usable during settings failure and retries visible settings in bounded chunks", async () => {
    const first = page(0, 20, "second-page"), second = page(20, 20, null);
    listTeamUsers.mockResolvedValueOnce({ data: first }).mockResolvedValueOnce({ data: second });
    let failRefresh = false;
    communicationRequest.mockImplementation(async (operation: string) => {
      if (operation !== "teamSettings") throw new Error("Unexpected operation");
      if (failRefresh) { failRefresh = false; throw new Error("Settings temporarily unavailable"); }
      return { team: [] };
    });
    render(<OwnerContext.Provider value={true}><Team profile={profile} /></OwnerContext.Provider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more team members" })).toBeEnabled());
    failRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Load more team members" }));
    expect(await screen.findByText("Settings temporarily unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit roles for Member 20" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deactivate Member 20" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh assignment settings" }));
    await waitFor(() => expect(settingsCalls()).toHaveLength(4));
    expect(settingsCalls().slice(2).map(([, input]) => input)).toEqual([
      { userIds: first.users.map(user => user.userId) }, { userIds: second.users.map(user => user.userId) },
    ]);
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Member 39" })).toBeEnabled();
    expect(screen.queryByText("Settings temporarily unavailable")).toBeNull();
  });

  it("prevents page loading during connection drafts, saves and access editing", async () => {
    combinedSetup(true);
    listTeamUsers.mockResolvedValue({ data: { users: [{ ...teammate, groups: ["PRODUCER"] }], profiles: [teammateProfile], nextToken: "second-page" } });
    let finishSave!: (result: unknown) => void;
    communicationRequest.mockImplementation((operation: string) => operation === "teamSettings" ? Promise.resolve({ team: [eligibility] }) : new Promise(resolve => { finishSave = resolve; }));
    render(<OwnerContext.Provider value={true}><Team profile={profile} /></OwnerContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit connections for Casey Staff" }));
    const more = screen.getByRole("button", { name: "Load more team members" });
    expect(more).toBeDisabled();
    fireEvent.click(more);
    fireEvent.change(screen.getByRole("textbox", { name: /^Front teammate ID/ }), { target: { value: "tea_draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    expect(more).toBeDisabled();
    expect(settingsCalls()).toHaveLength(1);
    expect(listTeamUsers).toHaveBeenCalledOnce();
    await act(async () => finishSave({ member: { ...eligibility, frontId: "tea_draft", version: 4 } }));
    expect(more).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Casey Staff" }));
    expect(more).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(more).toBeEnabled();
  });

  it("keeps an unaccepted invitation unavailable even when a saved row contains stale display and Producer metadata", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [teammate], profiles: [] } });
    communicationRequest.mockResolvedValue({ team: [{ ...eligibility, name: "Stale Name", email: "old@example.com", salesperson: true }] });
    renderPage();
    await waitFor(() => expect(settingsCalls()).toHaveLength(1));
    expect(screen.getByText("Available after first sign-in")).toBeVisible();
    expect(screen.getByText(teammate.email)).toBeVisible();
    expect(screen.queryByText("Stale Name")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Receive new leads/ })).toBeNull();
    expect(screen.getByRole("button", { name: `Edit roles for ${teammate.email}` })).toBeEnabled();
  });
});
