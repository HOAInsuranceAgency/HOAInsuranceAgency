import { invalidateLiveUpdates } from "./test/liveUpdates";
import { liveUpdates } from "./lib/liveUpdates";
import { createContext, StrictMode, useContext, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  authStatus: "authenticated",
  user: { userId: "user-one", username: "admin@example.com" },
  signOut: vi.fn(),
}));
const fetchUserGroups = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const scanProfiles = vi.hoisted(() => vi.fn());
const listLicenses = vi.hoisted(() => vi.fn());

vi.mock("@aws-amplify/ui-react", () => ({
  Authenticator: { Provider: ({ children }: { children: ReactNode }) => children },
  useAuthenticator: () => { useContext(AuthRerenderContext); return auth; },
}));
vi.mock("./lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/auth")>()),
  fetchUserGroups,
}));
vi.mock("./lib/client", async () => ({
  client: {
    models: {
      UserProfile: { listUserProfileByUserId: listProfiles, list: scanProfiles },
      License: { listLicenseByUserProfileId: listLicenses },
      AgencySettings: {
        observeQuery: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      },
    },
  },
  listAllPages: (await import("./lib/pagination")).listAllPages,
  friendlyError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

// Keep the real profile gate, router, sidebar and admin context. A small page
// with local state makes retained admin-page state visible when the active
// role changes while the route remains /leads.
vi.mock("./pages/AccountsList", () => ({
  default: function AccountsList({ stage, viewScope }: { stage: string; viewScope?: string }) {
    const isAdmin = useIsAdmin();
    const [note, setNote] = useState("");
    useUnsavedChanges(!!note, { onDiscard: () => setNote("") });
    return (
      <section data-view-scope={viewScope} data-stage={stage}>
        <h1>{isAdmin ? "All leads" : "My leads"}</h1>
        {isAdmin && <button>Admin control</button>}
        {useIsOwner() && <span>Owner access</span>}
        <input aria-label="Page note" value={note} onChange={(e) => setNote(e.target.value)} />
      </section>
    );
  },
}));
vi.mock("./pages/Dashboard", () => ({ default: () => <h1>Agency dashboard</h1> }));
vi.mock("./pages/OwnerProfitability", () => ({ default: () => <h1>{useIsOwner() ? "Private employee profitability" : "Owner context missing"}</h1> }));
vi.mock("./pages/FrontSidebar", () => ({ default: () => null }));
vi.mock("./pages/AccountDetail", () => ({ default: () => null }));
vi.mock("./pages/NewLead", () => ({ default: () => null }));
vi.mock("./pages/Carriers", () => ({ default: () => null }));
vi.mock("./pages/CarrierDetail", () => ({ default: () => null }));
vi.mock("./pages/Onboarding", () => ({
  default: ({ existing, existingLicenses, onComplete }: {
    existing: Record<string, unknown>;
    existingLicenses: unknown[];
    onComplete: (profile: unknown, licenses: unknown[]) => void;
  }) => <section>
    <h1>Producer setup</h1>
    <p>{existingLicenses.length} saved licenses</p>
    <button onClick={() => onComplete({ ...existing, npn: "12345678", onboardingComplete: true }, [savedLicense])}>Finish setup</button>
  </section>,
}));
vi.mock("./pages/Settings", () => ({ default: () => null }));
vi.mock("./pages/Financing", () => ({ default: () => null }));
vi.mock("./pages/SearchResults", () => ({ default: () => null }));
vi.mock("./pages/QuotesList", () => ({ default: () => null }));
vi.mock("./pages/PoliciesList", () => ({ default: () => null }));
vi.mock("./components/UniversalSearch", () => ({ default: () => null }));
vi.mock("./components/MagicLinkSignIn", () => ({ default: () => null }));

import App from "./App";
import { useIsAdmin, useIsOwner } from "./lib/auth";
import { activeRoleHeaders } from "./lib/activeRole";
import { EditProtectionProvider, useUnsavedChanges } from "./lib/editProtection";
const AuthRerenderContext = createContext(0);

const savedLicense = {
  id: "license-one", userProfileId: "profile-one", holderType: "PRODUCER",
  state: "FL", licenseNumber: "P123456",
};

const renderApp = (path = "/") =>
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

const renderProtectedApp = () => {
  const router = createMemoryRouter([
    { path: "*", element: <EditProtectionProvider><App /></EditProtectionProvider> },
  ], { initialEntries: ["/leads"] });
  let version = 0;
  const tree = () => <AuthRerenderContext.Provider value={version}><RouterProvider router={router} /></AuthRerenderContext.Provider>;
  const view = render(tree());
  return { ...view, refreshAuth: () => { version++; view.rerender(tree()); } };
};

it("scopes lead and client preferences to the current user's exact active role", async () => {
  renderApp("/leads");
  let page = (await screen.findByRole("heading", { name: "All leads" })).closest("section")!;
  expect(page).toHaveAttribute("data-view-scope", "user-one:ADMIN");
  expect(page).toHaveAttribute("data-stage", "LEAD");
  fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "PRODUCER" } });
  page = (await screen.findByRole("heading", { name: "My leads" })).closest("section")!;
  expect(page).toHaveAttribute("data-view-scope", "user-one:PRODUCER");
  fireEvent.click(screen.getByRole("link", { name: "Clients" }));
  page = (await screen.findByRole("heading", { name: "My leads" })).closest("section")!;
  expect(page).toHaveAttribute("data-view-scope", "user-one:PRODUCER");
  expect(page).toHaveAttribute("data-stage", "CLIENT");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  auth.authStatus = "authenticated";
  auth.user = { userId: "user-one", username: "admin@example.com" };
  fetchUserGroups.mockResolvedValue(["ADMIN", "PRODUCER"]);
  scanProfiles.mockRejectedValue(new Error("Profile table scans are not allowed"));
  listLicenses.mockResolvedValue({ data: [savedLicense] });
  listProfiles.mockResolvedValue({
    data: [{
      id: "profile-one",
      userId: "user-one",
      firstName: "Alex",
      lastName: "Agent",
      role: "ADMIN",
      npn: "12345678",
      onboardingComplete: true,
    }],
  });
});

describe("session actions with unsaved changes", () => {
  it.each(["sign-out", "role change"])("cancels a queued %s when a different user becomes authenticated", async kind => {
    const view = renderProtectedApp();
    const note = await screen.findByRole("textbox", { name: "Page note" });
    fireEvent.change(note, { target: { value: "User one's draft" } });
    if (kind === "sign-out") fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    else fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "PRODUCER" } });
    await screen.findByRole("dialog");
    auth.user = { userId: "user-two", username: "second@example.com" };
    fetchUserGroups.mockResolvedValue(["STAFF"]);
    listProfiles.mockResolvedValue({ data: [{ id: "profile-two", userId: "user-two", firstName: "Second", lastName: "User", npn: "12345678", onboardingComplete: true }] });
    view.refreshAuth();
    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("hoa-crm:active-role:user-one")).toBe("ADMIN");
    expect(sessionStorage.getItem("hoa-crm:active-role:user-two")).toBe("STAFF");
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "STAFF" });
  });

  it("cancels a queued role change when fresh membership removes that role", async () => {
    renderProtectedApp();
    fireEvent.change(await screen.findByRole("textbox", { name: "Page note" }), { target: { value: "Draft" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "PRODUCER" } });
    await screen.findByRole("dialog");
    fetchUserGroups.mockResolvedValue(["ADMIN"]);
    act(() => window.dispatchEvent(new Event("team-roles-changed")));
    expect(await screen.findByRole("heading", { name: "All leads" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Active role" })).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "ADMIN" });
  });

  it("keeps the session and recovery draft on cancel, then clears drafts before explicit sign-out", async () => {
    renderProtectedApp();
    const note = await screen.findByRole("textbox", { name: "Page note" });
    sessionStorage.setItem("hoa-crm:new-lead-draft:v1:user-one:ADMIN", "saved draft");
    fireEvent.change(note, { target: { value: "Unfinished" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("dialog");
    expect(auth.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(note).toHaveValue("Unfinished");
    expect(sessionStorage.getItem("hoa-crm:new-lead-draft:v1:user-one:ADMIN")).toBe("saved draft");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes and continue" }));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("hoa-crm:new-lead-draft:v1:user-one:ADMIN")).toBeNull();
  });

  it("holds the active role until discard, and clears that user's drafts before changing role", async () => {
    renderProtectedApp();
    const note = await screen.findByRole("textbox", { name: "Page note" });
    sessionStorage.setItem("hoa-crm:new-lead-draft:v1:user-one:ADMIN", "saved draft");
    fireEvent.change(note, { target: { value: "Unfinished" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "PRODUCER" } });
    await screen.findByRole("dialog");
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "ADMIN" });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("combobox", { name: "Active role" })).toHaveValue("ADMIN");
    fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "PRODUCER" } });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes and continue" }));
    await screen.findByRole("heading", { name: "My leads" });
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "PRODUCER" });
    expect(sessionStorage.getItem("hoa-crm:new-lead-draft:v1:user-one:ADMIN")).toBeNull();
  });
});

describe("assigned role switching", () => {
  it("shows the Profitability navigation and private route only in the Owner view", async () => {
    fetchUserGroups.mockResolvedValue(["OWNER", "ADMIN", "PRODUCER"]);
    renderApp("/owner");
    expect(await screen.findByRole("heading", { name: "Private employee profitability" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Profitability" })).toHaveAttribute("href", "/owner");
    fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "ADMIN" } });
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Profitability" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Private employee profitability" })).not.toBeInTheDocument();
  });

  it.each(["ADMIN", "PRODUCER"])("denies a direct profitability URL in the %s view even for an assigned owner", async role => {
    fetchUserGroups.mockResolvedValue(["OWNER", "ADMIN", "PRODUCER"]);
    sessionStorage.setItem("hoa-crm:active-role:user-one", role);
    renderApp("/owner");
    expect(await screen.findByRole("heading", { name: role === "ADMIN" ? "Agency dashboard" : "My leads" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Profitability" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Private employee profitability" })).not.toBeInTheDocument();
  });

  it("denies the profitability route to an admin without the Owner group", async () => {
    fetchUserGroups.mockResolvedValue(["ADMIN"]);
    renderApp("/owner");
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Profitability" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Private employee profitability" })).not.toBeInTheDocument();
  });

  it("loads the signed-in profile through its paginated user index without scanning profiles", async () => {
    listProfiles.mockResolvedValueOnce({ data: [], nextToken: "profile-page-two" });
    renderApp();

    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(listProfiles).toHaveBeenNthCalledWith(1, { userId: "user-one" }, { nextToken: undefined });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { userId: "user-one" }, { nextToken: "profile-page-two" });
    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(scanProfiles).not.toHaveBeenCalled();
  });

  it("keeps a failed indexed profile read behind the error gate and recovers on retry", async () => {
    listProfiles.mockResolvedValueOnce({ data: [], errors: [{ message: "Cannot read profile" }] });
    renderApp();

    expect(await screen.findByText("Cannot read profile")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Producer setup" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
  });

  it("offers only assigned roles in the sidebar footer and refreshes group membership", async () => {
    fetchUserGroups.mockResolvedValue(["PRODUCER", "OTHER_GROUP", "ADMIN"]);
    renderApp();

    const selector = await screen.findByRole("combobox", { name: "Active role" });
    expect(selector).toHaveValue("ADMIN");
    expect(selector.closest(".sidebar .user")).not.toBeNull();
    expect(within(selector).getAllByRole("option").map((option) => option.getAttribute("value")))
      .toEqual(["ADMIN", "PRODUCER"]);
    expect(fetchUserGroups).toHaveBeenCalledWith(true);
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
  });

  it("switches access and request scope, clears old page state, and returns to the selected role's home", async () => {
    renderApp("/leads");

    const selector = await screen.findByRole("combobox", { name: "Active role" });
    expect(screen.getByRole("heading", { name: "All leads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Admin control" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Page note" }), {
      target: { value: "Details from another producer" },
    });

    fireEvent.change(selector, { target: { value: "PRODUCER" } });

    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admin control" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page note" })).toHaveValue("");
    expect(await activeRoleHeaders()).toMatchObject({ "x-crm-role": "PRODUCER" });
    expect(sessionStorage.getItem("hoa-crm:active-role:user-one")).toBe("PRODUCER");

    fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), {
      target: { value: "ADMIN" },
    });

    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(await activeRoleHeaders()).toMatchObject({ "x-crm-role": "ADMIN" });
    expect(sessionStorage.getItem("hoa-crm:active-role:user-one")).toBe("ADMIN");
  });

  it("gives Owner all admin controls and narrows both contexts when switching views", async () => {
    fetchUserGroups.mockResolvedValue(["OWNER", "PRODUCER"]);
    renderApp("/leads");
    const selector = await screen.findByRole("combobox", { name: "Active role" });
    expect(selector).toHaveValue("OWNER");
    expect(screen.getByRole("heading", { name: "All leads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Admin control" })).toBeInTheDocument();
    expect(screen.getByText("Owner access")).toBeInTheDocument();
    expect(within(selector).getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["OWNER", "PRODUCER"]);
    fireEvent.change(selector, { target: { value: "PRODUCER" } });
    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(screen.queryByText("Owner access")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admin control" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Active role" }), { target: { value: "OWNER" } });
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "OWNER" });
  });

  it("remembers the selected role when the same user reopens the app", async () => {
    const first = renderApp();
    fireEvent.change(await screen.findByRole("combobox", { name: "Active role" }), {
      target: { value: "PRODUCER" },
    });
    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    first.unmount();

    renderApp();

    expect(await screen.findByRole("combobox", { name: "Active role" })).toHaveValue("PRODUCER");
    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });

  it("does not apply another user's saved selection", async () => {
    sessionStorage.setItem("hoa-crm:active-role:another-user", "PRODUCER");
    renderApp();

    expect(await screen.findByRole("combobox", { name: "Active role" })).toHaveValue("ADMIN");
    expect(screen.getByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
  });

  it("ignores an unassigned saved role and stale profile role, showing a label for single-role users", async () => {
    sessionStorage.setItem("hoa-crm:active-role:user-one", "ADMIN");
    fetchUserGroups.mockResolvedValue(["PRODUCER"]);
    renderApp();

    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Active role" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).getByText("PRODUCER")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toMatchObject({ "x-crm-role": "PRODUCER" });
  });

  it("refreshes assigned roles after a team change without reloading the app", async () => {
    fetchUserGroups.mockResolvedValue(["ADMIN"]);
    renderApp();
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Active role" })).not.toBeInTheDocument();

    fetchUserGroups.mockResolvedValue(["ADMIN", "PRODUCER"]);
    act(() => window.dispatchEvent(new Event("team-roles-changed")));

    const selector = await screen.findByRole("combobox", { name: "Active role" });
    expect(selector).toHaveValue("ADMIN");
    expect(within(selector).getByRole("option", { name: "PRODUCER" })).toBeInTheDocument();
    expect(fetchUserGroups).toHaveBeenCalledTimes(2);
    expect(fetchUserGroups).toHaveBeenLastCalledWith(true);
  });

  it("drops a removed active role and its admin controls after a team change", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();

    fetchUserGroups.mockResolvedValue(["PRODUCER"]);
    act(() => window.dispatchEvent(new Event("team-roles-changed")));

    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Active role" })).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toMatchObject({ "x-crm-role": "PRODUCER" });
  });

  it("keeps the shell closed when fresh membership fails and opens only after a successful retry", async () => {
    sessionStorage.setItem("hoa-crm:active-role:user-one", "PRODUCER");
    fetchUserGroups.mockRejectedValueOnce(new Error("Cannot refresh assigned roles"));
    renderApp();

    expect(await screen.findByRole("heading", { name: "Couldn't load your profile" })).toBeInTheDocument();
    expect(screen.getByText("Cannot refresh assigned roles")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My leads" })).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({});

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "PRODUCER" });
  });

  it("removes the open shell when refreshing assigned roles fails", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    fetchUserGroups.mockRejectedValueOnce(new Error("Cannot refresh assigned roles"));

    act(() => window.dispatchEvent(new Event("team-roles-changed")));

    expect(await screen.findByRole("heading", { name: "Couldn't load your profile" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agency dashboard" })).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({});
  });

  it("ignores an earlier StrictMode load that resolves after the current load", async () => {
    const earlierGroups = deferred<string[]>();
    fetchUserGroups.mockReturnValueOnce(earlierGroups.promise).mockResolvedValue(["PRODUCER"]);
    render(<StrictMode><MemoryRouter><App /></MemoryRouter></StrictMode>);

    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(fetchUserGroups).toHaveBeenCalledTimes(2);
    await act(async () => { earlierGroups.resolve(["ADMIN"]); });

    expect(screen.getByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "PRODUCER" });
    expect(sessionStorage.getItem("hoa-crm:active-role:user-one")).toBe("PRODUCER");
  });

  it("does not restore request privileges when a pending load completes after sign-out", async () => {
    const earlierGroups = deferred<string[]>();
    fetchUserGroups.mockReturnValueOnce(earlierGroups.promise);
    const app = renderApp();
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    auth.authStatus = "unauthenticated";
    app.rerender(<MemoryRouter><App /></MemoryRouter>);
    await act(async () => { earlierGroups.resolve(["ADMIN"]); });

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({});
    expect(sessionStorage.getItem("hoa-crm:active-role:user-one")).toBeNull();
  });

  it("does not let a previous user's pending load overwrite the new user's request scope", async () => {
    const earlierGroups = deferred<string[]>();
    fetchUserGroups.mockReturnValueOnce(earlierGroups.promise).mockResolvedValue(["PRODUCER"]);
    const app = renderApp();
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    auth.user = { userId: "user-two", username: "producer@example.com" };
    app.rerender(<MemoryRouter><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "My leads" })).toBeInTheDocument();
    await act(async () => { earlierGroups.resolve(["ADMIN"]); });

    expect(screen.getByRole("heading", { name: "My leads" })).toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({ "x-crm-role": "PRODUCER" });
    expect(sessionStorage.getItem("hoa-crm:active-role:user-one")).toBeNull();
    expect(sessionStorage.getItem("hoa-crm:active-role:user-two")).toBe("PRODUCER");
  });
});


describe("producer onboarding gate", () => {
  it.each(["ADMIN", "STAFF"])("reopens setup for an onboarded %s assigned PRODUCER without an NPN", async (role) => {
    fetchUserGroups.mockResolvedValue([role, "PRODUCER"]);
    listProfiles.mockResolvedValue({ data: [{
      id: "profile-one", userId: "user-one", firstName: "Alex", lastName: "Agent",
      role, npn: "  ", onboardingComplete: true,
    }] });
    renderApp();

    expect(await screen.findByRole("heading", { name: "Producer setup" })).toBeInTheDocument();
    expect(screen.getByText("1 saved licenses")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("complementary")).toBeInTheDocument();
  });

  it("requires a persisted license even when the NPN and completed flag already exist", async () => {
    listLicenses.mockResolvedValue({ data: [] });
    renderApp();

    expect(await screen.findByRole("heading", { name: "Producer setup" })).toBeInTheDocument();
    expect(screen.getByText("0 saved licenses")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("accepts an existing license in the unified producer licensing model", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Producer setup" })).not.toBeInTheDocument();
  });

  it("does not count firm licenses, another producer's license, or incomplete rows", async () => {
    listLicenses.mockResolvedValue({ data: [
      { ...savedLicense, holderType: "FIRM" },
      { ...savedLicense, userProfileId: "another-profile" },
      { ...savedLicense, state: " " },
      { ...savedLicense, licenseNumber: " " },
    ] });
    renderApp();

    expect(await screen.findByRole("heading", { name: "Producer setup" })).toBeInTheDocument();
    expect(screen.getByText("0 saved licenses")).toBeInTheDocument();
  });

  it("keeps the shell closed while producer licenses are loading", async () => {
    const pending = deferred<{ data: typeof savedLicense[] }>();
    listLicenses.mockReturnValueOnce(pending.promise);
    renderApp();
    await act(async () => {});

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Producer setup" })).not.toBeInTheDocument();
    await act(async () => { pending.resolve({ data: [savedLicense] }); });
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
  });

  it("keeps failed license reads closed and recovers on retry", async () => {
    listLicenses.mockResolvedValueOnce({ data: [], errors: [{ message: "Cannot read producer licenses" }] });
    renderApp();

    expect(await screen.findByText("Cannot read producer licenses")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Producer setup" })).not.toBeInTheDocument();
    expect(await activeRoleHeaders()).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
  });

  it("does not request producer licenses for a staff/admin without the producer role", async () => {
    fetchUserGroups.mockResolvedValue(["ADMIN", "STAFF"]);
    renderApp();

    expect(await screen.findByRole("heading", { name: "Agency dashboard" })).toBeInTheDocument();
    expect(listLicenses).not.toHaveBeenCalled();
  });
});


describe('live membership refresh', () => {
  it('preserves the exact mounted draft through PERSONAL and focus checks when group sets are unchanged', async () => {
    renderProtectedApp();
    const note = await screen.findByRole('textbox', { name: 'Page note' });
    fireEvent.change(note, { target: { value: 'Keep this admin draft' } });
    const reads = listProfiles.mock.calls.length;
    fetchUserGroups.mockResolvedValue(['PRODUCER', 'ADMIN', 'ADMIN']);
    await invalidateLiveUpdates(['PERSONAL']);
    expect(fetchUserGroups).toHaveBeenCalledTimes(2);
    expect(listProfiles).toHaveBeenCalledTimes(reads);
    expect(screen.getByRole('textbox', { name: 'Page note' })).toBe(note);
    expect(note).toHaveValue('Keep this admin draft');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolve => setTimeout(resolve, 1_100));
    });
    expect(fetchUserGroups).toHaveBeenCalledTimes(3);
    expect(listProfiles).toHaveBeenCalledTimes(reads);
    expect(screen.getByRole('textbox', { name: 'Page note' })).toBe(note);
    expect(note).toHaveValue('Keep this admin draft');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('applies actual remote role removal through a dirty lock and unmounts the old authorized shell', async () => {
    renderProtectedApp();
    const note = await screen.findByRole('textbox', { name: 'Page note' });
    fireEvent.change(note, { target: { value: 'Private admin draft' } });
    const unlock = liveUpdates.acquireBlock();
    try {
      fetchUserGroups.mockResolvedValue(['PRODUCER']);
      await invalidateLiveUpdates(['PERSONAL']);
      expect(await screen.findByRole('heading', { name: 'My leads' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Admin control' })).toBeNull();
      expect(note).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Page note' })).toHaveValue('');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await activeRoleHeaders()).toMatchObject({ 'x-crm-role': 'PRODUCER' });
      expect(listProfiles).toHaveBeenCalledTimes(2);
    } finally { unlock(); }
  });

  it('keeps drafts during a transient token outage but closes the profile on actual authorization denial', async () => {
    renderProtectedApp();
    const note = await screen.findByRole('textbox', { name: 'Page note' });
    fireEvent.change(note, { target: { value: 'Unsaved work' } });
    fetchUserGroups.mockRejectedValueOnce(new Error('Temporary token refresh outage'));
    await invalidateLiveUpdates(['PERSONAL']);
    expect(screen.getByRole('textbox', { name: 'Page note' })).toBe(note);
    expect(note).toHaveValue('Unsaved work');
    expect(listProfiles).toHaveBeenCalledTimes(1);
    fetchUserGroups.mockRejectedValueOnce(Object.assign(new Error('Your account is inactive'), { name: 'NotAuthorizedException' }));
    await invalidateLiveUpdates(['PERSONAL']);
    expect(await screen.findByText('Your account is inactive')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Page note' })).toBeNull();
    expect(await activeRoleHeaders()).toEqual({});
  });
});
