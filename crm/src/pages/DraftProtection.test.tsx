import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Link, Outlet, RouterProvider, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { EditProtectionProvider } from "../lib/editProtection";
import { LeadDraftScope } from "../lib/newLeadDraft";
import type { Account } from "../lib/client";

const mocks = vi.hoisted(() => ({ request: vi.fn(), update: vi.fn(), upload: vi.fn() }));
vi.mock("../lib/relationships", () => ({ loadPartyIds: async () => [], searchParties: async () => ({ items: [] }) }));
vi.mock("../lib/communications", () => ({ communicationRequest: mocks.request }));
vi.mock("../components/LeadWorkflowPanel", () => ({ ResponsibilitySelect: () => null }));
vi.mock("../lib/googlePlaces", () => ({ AddressAutocomplete: () => null }));
vi.mock("../lib/scopedStorage", () => ({ uploadData: mocks.upload }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: async () => ({ userId: "actor" }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  Account: { update: mocks.update }, Contact: { create: async () => ({ data: { id: "contact" } }) },
  Document: { create: async () => ({ data: { id: "document" } }), update: async () => ({}) },
} }) }));
import NewLead from "./NewLead";
import { OverviewTab } from "./account/OverviewTab";

const account = { id: "one", name: "Harbor HOA", stage: "LEAD", type: "ASSOCIATION" } as Account;
function Layout({ userId = "one", role = "ADMIN" }: { userId?: string; role?: "ADMIN" | "PRODUCER" }) {
  const navigate = useNavigate();
  const location = useLocation();
  return <EditProtectionProvider><LeadDraftScope userId={userId} role={role}>
    <Link to="/elsewhere">Other page</Link><button onClick={() => navigate(-1)}>Browser Back</button>
    <output aria-label="Location">{location.pathname}{location.search}</output><Outlet />
  </LeadDraftScope></EditProtectionProvider>;
}
function AccountPage() {
  const [params, setParams] = useSearchParams();
  return <><button onClick={() => setParams({ tab: "activity" })}>Activity tab</button>
    {params.get("tab") === "activity" ? <h1>Activity</h1> : <OverviewTab account={account} onChange={() => {}} />}</>;
}
function mount(path = "/leads/new", userId = "one", role: "ADMIN" | "PRODUCER" = "ADMIN") {
  const router = createMemoryRouter([{ element: <Layout userId={userId} role={role} />, children: [
    { path: "/leads/new", element: <NewLead /> },
    { path: "/accounts/one", element: <AccountPage /> },
    { path: "/accounts/new-lead", element: <h1>Created account</h1> },
    { path: "/elsewhere", element: <h1>Other page</h1> },
  ] }], { initialEntries: ["/elsewhere", path], initialIndex: 1 });
  return { ...render(<RouterProvider router={router} />), router };
}
const name = () => screen.getByLabelText("Name (association / insured) *");
const typeName = (value: string) => fireEvent.change(name(), { target: { value } });
const drafts = () => Object.keys(sessionStorage).filter(key => key.startsWith("hoa-crm:new-lead-draft:"));

beforeEach(() => {
  sessionStorage.clear();
  mocks.request.mockReset().mockImplementation(async operation => operation === "team" ? { team: [] } : { id: "new-lead" });
  mocks.update.mockReset().mockImplementation(async fields => ({ data: { ...account, ...fields } }));
  mocks.upload.mockReset().mockReturnValue({ result: Promise.resolve() });
});

it("blocks route navigation and browser Back for an edited lead; Keep editing retains it and discard clears recovery", async () => {
  const view = mount();
  typeName("Harbor");
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
  expect(screen.getByLabelText("Location")).toHaveTextContent("/leads/new");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(name()).toHaveValue("Harbor");
  fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes and continue" }));
  await screen.findByRole("heading", { name: "Other page" });
  expect(view.router.state.location.pathname).toBe("/elsewhere");
  expect(drafts()).toEqual([]);
});

it("does not block an untouched lead or an edit restored to its initial value", async () => {
  const view = mount();
  typeName("Temporary"); typeName("");
  expect(drafts()).toEqual([]);
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  await screen.findByRole("heading", { name: "Other page" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(view.router.state.location.pathname).toBe("/elsewhere");
});

it("requests the browser reload warning only while there are unsaved changes", () => {
  mount();
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
  typeName("Harbor");
  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
  typeName("");
  const restored = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(restored); expect(restored.defaultPrevented).toBe(false);
});

it("offers same-scope recovery after remount without persisting notes, financial values or files; success clears it", async () => {
  const first = mount();
  typeName("Harbor");
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Private financial note" } });
  fireEvent.change(screen.getByLabelText("Total insured value ($)"), { target: { value: "4200000" } });
  fireEvent.change(screen.getByLabelText("Add documents…"), { target: { files: [new File(["contents"], "private-policy.pdf", { type: "application/pdf" })] } });
  const saved = sessionStorage.getItem(drafts()[0])!;
  const requestId = JSON.parse(saved).requestId;
  expect(saved).not.toMatch(/Private financial note|4200000|private-policy|contents/);
  first.unmount();
  mount();
  expect(name()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Recover lead details" }));
  expect(name()).toHaveValue("Harbor");
  expect(screen.getByLabelText("Notes")).toHaveValue("");
  expect(screen.getByLabelText("Total insured value ($)")).toHaveValue("");
  expect(screen.getByText(/Basic details recovered\. Review salesperson and relationship selections, re-enter notes and financial values, and reattach documents/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  await screen.findByRole("heading", { name: "Created account" });
  expect(mocks.request).toHaveBeenCalledWith("createLead", expect.objectContaining({ requestId }), true);
  expect(drafts()).toEqual([]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("isolates drafts by signed-in user and active role and lets a saved draft be discarded", () => {
  const first = mount(); typeName("Admin draft"); first.unmount();
  const otherRole = mount("/leads/new", "one", "PRODUCER");
  expect(screen.queryByRole("button", { name: "Recover lead details" })).not.toBeInTheDocument(); otherRole.unmount();
  const otherUser = mount("/leads/new", "two");
  expect(screen.queryByRole("button", { name: "Recover lead details" })).not.toBeInTheDocument(); otherUser.unmount();
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Discard saved draft" }));
  expect(name()).toHaveValue(""); expect(name()).toBeEnabled(); expect(drafts()).toEqual([]);
});

it("protects account Overview edits on tab changes, keeps failed saves dirty and unblocks after a successful save", async () => {
  mount("/accounts/one");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New name" } });
  fireEvent.click(screen.getByRole("button", { name: "Activity tab" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Name")).toHaveValue("New name");
  mocks.update.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Offline");
  fireEvent.click(screen.getByRole("button", { name: "Activity tab" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Saved.");
  fireEvent.click(screen.getByRole("button", { name: "Activity tab" }));
  await screen.findByRole("heading", { name: "Activity" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(drafts()).toEqual([]);
});

it("holds navigation during lead creation and continues after creation finishes without duplicate writes", async () => {
  let finish!: (result: { id: string }) => void;
  mocks.request.mockImplementation(operation => operation === "team" ? Promise.resolve({ team: [] }) : new Promise(resolve => { finish = resolve; }));
  mount(); typeName("Harbor");
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  await screen.findByRole("dialog", { name: "Saving is still in progress" });
  expect(screen.queryByRole("button", { name: "Discard changes and continue" })).not.toBeInTheDocument();
  await act(async () => { finish({ id: "new-lead" }); });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(mocks.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(1);
});

it("keeps Overview edits made during a save dirty rather than treating them as saved", async () => {
  let finish!: (result: { data: Account }) => void;
  mocks.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount("/accounts/one");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Submitted name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Newer unsaved name" } });
  await act(async () => { finish({ data: { ...account, name: "Submitted name" } }); });
  fireEvent.click(screen.getByRole("button", { name: "Activity tab" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Name")).toHaveValue("Newer unsaved name");
});

it("does not block unchanged Overview fields and discards its edited values only after confirmation", async () => {
  const first = mount("/accounts/one");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Temporary" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: account.name } });
  fireEvent.click(screen.getByRole("button", { name: "Activity tab" }));
  await screen.findByRole("heading", { name: "Activity" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); first.unmount();
  mount("/accounts/one");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discard this" } });
  fireEvent.click(screen.getByRole("button", { name: "Activity tab" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes and continue" }));
  await screen.findByRole("heading", { name: "Activity" });
  expect(mocks.update).not.toHaveBeenCalled();
});

it("rejects expired or malformed recovery snapshots", () => {
  const first = mount(); typeName("Expired");
  const key = drafts()[0], value = JSON.parse(sessionStorage.getItem(key)!);
  first.unmount();
  sessionStorage.setItem(key, JSON.stringify({ ...value, savedAt: Date.now() - 25 * 60 * 60 * 1000 }));
  const expired = mount();
  expect(screen.queryByRole("button", { name: "Recover lead details" })).not.toBeInTheDocument(); expired.unmount();
  sessionStorage.setItem(key, JSON.stringify({ ...value, fields: { ...value.fields, totalInsuredValue: "4200000" } }));
  mount();
  expect(screen.queryByRole("button", { name: "Recover lead details" })).not.toBeInTheDocument();
  expect(sessionStorage.getItem(key)).toBeNull();
});
