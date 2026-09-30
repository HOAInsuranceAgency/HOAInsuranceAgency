import { StrictMode, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  authStatus: "authenticated",
  user: { userId: "user-one", username: "admin@example.com" },
  signOut: vi.fn(),
}));
const fetchUserGroups = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const listLicenses = vi.hoisted(() => vi.fn());
const listLegacyLicenses = vi.hoisted(() => vi.fn());

vi.mock("@aws-amplify/ui-react", () => ({
  Authenticator: { Provider: ({ children }: { children: ReactNode }) => children },
  useAuthenticator: () => auth,
}));
vi.mock("./lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/auth")>()),
  fetchUserGroups,
}));
vi.mock("./lib/client", () => ({
  client: {
    models: {
      UserProfile: { list: listProfiles },
      License: { list: listLicenses },
      ProducerLicense: { list: listLegacyLicenses },
      AgencySettings: {
        observeQuery: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      },
    },
  },
  listAllPages: async (read: () => Promise<{ data: unknown[] }>) => (await read()).data,
  friendlyError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

// Keep the real profile gate, router, sidebar and admin context. A small page
// with local state makes retained admin-page state visible when the active
// role changes while the route remains /leads.
vi.mock("./pages/AccountsList", () => ({
  default: function AccountsList() {
    const isAdmin = useIsAdmin();
    const [note, setNote] = useState("");
    return (
      <section>
        <h1>{isAdmin ? "All leads" : "My leads"}</h1>
        {isAdmin && <button>Admin control</button>}
        <input aria-label="Page note" value={note} onChange={(e) => setNote(e.target.value)} />
      </section>
    );
  },
}));
vi.mock("./pages/Dashboard", () => ({ default: () => <h1>Agency dashboard</h1> }));
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
import { useIsAdmin } from "./lib/auth";
import { activeRoleHeaders } from "./lib/activeRole";

const savedLicense = {
  id: "license-one", userProfileId: "profile-one", holderType: "PRODUCER",
  state: "FL", licenseNumber: "P123456",
};

const renderApp = (path = "/") =>
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

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
  listLicenses.mockResolvedValue({ data: [savedLicense] });
  listLegacyLicenses.mockResolvedValue({ data: [] });
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

describe("assigned role switching", () => {
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

  it("accepts a previously saved legacy producer license", async () => {
    listLicenses.mockResolvedValue({ data: [] });
    listLegacyLicenses.mockResolvedValue({ data: [{ ...savedLicense, holderType: undefined }] });
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

  it.each(["current", "legacy"])("keeps failed %s license reads closed and recovers on retry", async (source) => {
    const read = source === "current" ? listLicenses : listLegacyLicenses;
    read.mockResolvedValueOnce({ data: [], errors: [{ message: "Cannot read producer licenses" }] });
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
    expect(listLegacyLicenses).not.toHaveBeenCalled();
  });
});
