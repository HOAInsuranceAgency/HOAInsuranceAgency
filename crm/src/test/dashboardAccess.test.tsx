import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  dashboard: vi.fn(),
  profile: {
    id: "profile-1",
    userId: "user-1",
    firstName: "Test",
    lastName: "User",
    role: "ADMIN",
    npn: "12345678",
    onboardingComplete: true,
  },
}));

vi.mock("@aws-amplify/ui-react", () => ({
  Authenticator: { Provider: ({ children }: { children: ReactNode }) => children },
  useAuthenticator: () => ({
    authStatus: "authenticated",
    user: { userId: "user-1", username: "test-user" },
    signOut: vi.fn(),
  }),
}));
vi.mock("aws-amplify/auth", () => ({ fetchAuthSession: h.session }));
vi.mock("../lib/client", () => ({
  client: {
    models: {
      UserProfile: { list: async () => ({ data: [h.profile] }) },
      License: { list: async () => ({ data: [{
        id: "license-1", userProfileId: "profile-1", holderType: "PRODUCER",
        state: "FL", licenseNumber: "FL123456",
      }] }) },
      ProducerLicense: { list: async () => ({ data: [] }) },
      AgencySettings: {
        observeQuery: () => ({ subscribe: () => ({ unsubscribe: vi.fn() }) }),
      },
    },
  },
  listAllPages: async (fetcher: () => Promise<{ data: unknown[] }>) => (await fetcher()).data,
  friendlyError: (error: Error) => error.message,
}));
vi.mock("../pages/Dashboard", () => ({
  default: () => {
    h.dashboard();
    return <h1>Dashboard content</h1>;
  },
}));
vi.mock("../pages/AccountsList", () => ({
  default: ({ stage }: { stage: string }) => <h1>{stage === "LEAD" ? "Leads content" : "Clients content"}</h1>,
}));
// Keep route authorization tests independent of each destination's data reads.
vi.mock("../pages/FrontSidebar", () => ({ default: () => null }));
vi.mock("../pages/AccountDetail", () => ({ default: () => null }));
vi.mock("../pages/NewLead", () => ({ default: () => null }));
vi.mock("../pages/Carriers", () => ({ default: () => null }));
vi.mock("../pages/CarrierDetail", () => ({ default: () => null }));
vi.mock("../pages/Onboarding", () => ({ default: () => null }));
vi.mock("../pages/Settings", () => ({ default: () => null }));
vi.mock("../pages/Financing", () => ({ default: () => null }));
vi.mock("../pages/SearchResults", () => ({ default: () => null }));
vi.mock("../pages/QuotesList", () => ({ default: () => null }));
vi.mock("../pages/PoliciesList", () => ({ default: () => null }));
vi.mock("../components/UniversalSearch", () => ({ default: () => null }));
vi.mock("../components/MagicLinkSignIn", () => ({ default: () => null }));

import App from "../App";

function session(groups: string[]) {
  return { tokens: { idToken: { payload: { "cognito:groups": groups } } } };
}

function Location() {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}{location.search}</output>;
}

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>);
}

beforeEach(() => {
  sessionStorage.clear();
  h.session.mockReset();
  h.dashboard.mockClear();
  h.profile.role = "ADMIN";
});

describe("Dashboard access", () => {
  it.each([
    { role: "STAFF", groups: ["STAFF"], path: "/" },
    { role: "PRODUCER", groups: ["PRODUCER"], path: "/?tab=finance" },
    { role: "ungrouped", groups: [], path: "/?tab=reporting" },
  ])("sends $role users directly to Leads even when the editable profile says ADMIN", async ({ groups, path }) => {
    h.session.mockResolvedValue(session(groups));
    renderApp(path);

    expect(await screen.findByRole("heading", { name: "Leads content" })).toBeInTheDocument();
    expect(screen.getByLabelText("Current location")).toHaveTextContent(/^\/leads$/);
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "HOA Insurance Agency" })).toHaveAttribute("href", "/leads");
    expect(h.dashboard).not.toHaveBeenCalled();
  });

  it("allows Cognito ADMIN access and navigation even when the profile says STAFF", async () => {
    h.profile.role = "STAFF";
    h.session.mockResolvedValue(session(["STAFF", "ADMIN"]));
    renderApp("/?tab=reporting");

    expect(await screen.findByRole("heading", { name: "Dashboard content" })).toBeInTheDocument();
    expect(screen.getByLabelText("Current location")).toHaveTextContent(/^\/\?tab=reporting$/);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "HOA Insurance Agency" })).toHaveAttribute("href", "/");
  });

  it("does not mount Dashboard while Cognito groups are still loading", async () => {
    let resolveSession!: (value: ReturnType<typeof session>) => void;
    h.session.mockReturnValue(new Promise<ReturnType<typeof session>>((resolve) => { resolveSession = resolve; }));
    renderApp("/");

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(h.dashboard).not.toHaveBeenCalled();
    await act(async () => resolveSession(session(["STAFF"])));
    expect(await screen.findByRole("heading", { name: "Leads content" })).toBeInTheDocument();
    expect(h.dashboard).not.toHaveBeenCalled();
  });

  it.each([
    { groups: ["STAFF"], label: "Back to leads", destination: "/leads", heading: "Leads content" },
    { groups: ["ADMIN"], label: "Back to dashboard", destination: "/", heading: "Dashboard content" },
  ])("returns $groups users from a missing page to their allowed home", async ({ groups, label, destination, heading }) => {
    h.session.mockResolvedValue(session(groups));
    renderApp("/missing-page");

    const returnLink = await screen.findByRole("link", { name: label });
    expect(returnLink).toHaveAttribute("href", destination);
    fireEvent.click(returnLink);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByLabelText("Current location")).toHaveTextContent(destination);
  });
  it.each([
    { groups: ['ADMIN'], path: '/tasks' }, { groups: ['STAFF'], path: '/tasks' },
    { groups: ['ADMIN'], path: '/lead-work?report=mine' }, { groups: ['PRODUCER'], path: '/lead-work?report=mine' },
  ])('redirects retired $path bookmarks without task navigation for $groups', async ({ groups, path }) => {
    h.session.mockResolvedValue(session(groups));
    renderApp(path);
    expect(await screen.findByRole('heading', { name: 'Leads content' })).toBeInTheDocument();
    expect(screen.getByLabelText('Current location')).toHaveTextContent(/^\/leads$/);
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Lead follow-up' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clients' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

});
