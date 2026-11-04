import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Link, Outlet, RouterProvider, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditProtectionProvider, useEditProtection } from "../lib/editProtection";
import { LeadDraftScope } from "../lib/newLeadDraft";
import type { Account } from "../lib/client";

const mocks = vi.hoisted(() => ({ request: vi.fn(), update: vi.fn(), accountGet: vi.fn(), contactCreate: vi.fn(), upload: vi.fn(), leaveSession: vi.fn() }));
vi.mock("../lib/relationships", () => ({ loadPartyIds: async () => [], searchParties: async () => ({ items: [] }) }));
vi.mock("../lib/communications", () => ({ communicationRequest: mocks.request }));
vi.mock("../components/LeadWorkflowPanel", () => ({ ResponsibilitySelect: () => null }));
vi.mock("../lib/googlePlaces", () => ({ AddressAutocomplete: () => null }));
vi.mock("../lib/scopedStorage", () => ({ uploadData: mocks.upload }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: async () => ({ userId: "actor" }) }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  Account: { update: mocks.update, get: mocks.accountGet }, Contact: { create: mocks.contactCreate },
  Document: { create: async () => ({ data: { id: "document" } }), update: async () => ({}) },
} }) }));
import NewLead from "./NewLead";
import { OverviewTab } from "./account/OverviewTab";

const account = { id: "one", name: "Harbor HOA", stage: "LEAD", type: "ASSOCIATION" } as Account;
function SessionAction() {
  const { requestLeave } = useEditProtection();
  return <button onClick={() => requestLeave(mocks.leaveSession)}>Leave session</button>;
}
function Layout({ userId = "one", role = "ADMIN" }: { userId?: string; role?: "ADMIN" | "PRODUCER" }) {
  const navigate = useNavigate();
  const location = useLocation();
  return <EditProtectionProvider><LeadDraftScope userId={userId} role={role}>
    <Link to="/elsewhere">Other page</Link><button onClick={() => navigate(-1)}>Browser Back</button><SessionAction />
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
  mocks.leaveSession.mockReset();
  mocks.contactCreate.mockReset().mockResolvedValue({ data: { id: "contact" } });
  mocks.accountGet.mockReset().mockImplementation(async () => {
    const fields = mocks.request.mock.calls.filter(([operation]) => operation === "createLead").at(-1)?.[1]?.fields ?? {};
    return { data: { id: "new-lead", ...fields, propertyType: fields.propertyType ?? (fields.type === "PERSONAL" ? "INDIVIDUAL_UNIT_OWNER" : null) } };
  });
});
afterEach(() => vi.restoreAllMocks());

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

it("still holds navigation when Overview fields are reverted while an earlier save is in flight", async () => {
  let finish!: (result: { data: Account }) => void;
  mocks.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = mount("/accounts/one");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Submitted name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: account.name } });
  fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  await screen.findByRole("dialog", { name: "Saving is still in progress" });
  expect(view.router.state.location.pathname).toBe("/accounts/one");
  expect(screen.queryByRole("button", { name: "Discard changes and continue" })).not.toBeInTheDocument();
  await act(async () => { finish({ data: { ...account, name: "Submitted name" } }); });
  // The server now has the submitted name; reverting locally is another edit.
  await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
  expect(view.router.state.location.pathname).toBe("/accounts/one");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes and continue" }));
  await screen.findByRole("heading", { name: "Other page" });
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

it.each(["review", "continue", "session"])("requires acknowledgement of a failed attachment before completing a queued leave (%s)", async choice => {
  let failUpload!: (error: Error) => void;
  mocks.upload.mockReturnValue({ result: new Promise((_resolve, reject) => { failUpload = reject; }) });
  const view = mount(); typeName("Harbor");
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.change(screen.getByLabelText("Add documents…"), { target: { files: [new File(["contents"], "policy.pdf", { type: "application/pdf" })] } });
  fireEvent.click(screen.getByRole("button", { name: /Create lead & upload/ }));
  await waitFor(() => expect(mocks.upload).toHaveBeenCalled());
  if (choice === "session") fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
  else fireEvent.click(screen.getByRole("link", { name: "Other page" }));
  await screen.findByRole("dialog", { name: "Saving is still in progress" });
  await act(async () => { failUpload(new Error("Upload failed")); });
  const notice = await screen.findByRole("dialog", { name: "Lead created — review missing details" });
  expect(notice).toHaveTextContent("The lead was created, but 1 document didn't upload: policy.pdf");
  expect(view.router.state.location.pathname).toBe("/leads/new");
  expect(mocks.leaveSession).not.toHaveBeenCalled();
  expect(drafts()).toEqual([]);
  expect(screen.queryByRole("button", { name: /Create lead/ })).not.toBeInTheDocument();
  if (choice === "review") {
    fireEvent.click(screen.getByRole("button", { name: "Review the lead" }));
    await screen.findByRole("heading", { name: "Created account" });
    expect(view.router.state.location.pathname).toBe("/accounts/new-lead");
  } else {
    fireEvent.click(screen.getByRole("button", { name: "Continue without fixing" }));
    if (choice === "session") expect(mocks.leaveSession).toHaveBeenCalledTimes(1);
    else await screen.findByRole("heading", { name: "Other page" });
  }
  expect(mocks.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(1);
});

it("preserves recovered edits when a lost creation response is replayed against the original existing lead", async () => {
  let savedFields: Record<string, unknown>;
  mocks.request.mockImplementation(async (operation, input) => {
    if (operation === "team") return { team: [] };
    if (!savedFields) { savedFields = { ...input.fields }; throw new Error("Response lost"); }
    return { id: "new-lead" };
  });
  mocks.accountGet.mockImplementation(async () => ({ data: { id: "new-lead", ...savedFields, propertyType: null } }));
  const first = mount(); typeName("Original saved name");
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  await screen.findByText("Response lost");
  const requestId = mocks.request.mock.calls.find(([op]) => op === "createLead")![1].requestId;
  expect(JSON.parse(sessionStorage.getItem(drafts()[0])!).attempted).toBe(true);
  first.unmount();
  const second = mount();
  fireEvent.click(screen.getByRole("button", { name: "Recover lead details" }));
  typeName("Later recovered edit");
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Later contact" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  await screen.findByText(/latest draft details have not been confirmed as saved/);
  expect(second.router.state.location.pathname).toBe("/leads/new");
  expect(mocks.request.mock.calls.filter(([op]) => op === "createLead").map(([, input]) => input.requestId)).toEqual([requestId, requestId]);
  expect(mocks.contactCreate).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  const preserved = JSON.parse(sessionStorage.getItem(drafts()[0])!);
  expect(preserved).toMatchObject({ existingId: "new-lead", requestId, fields: { name: "Later recovered edit", contactName: "Later contact" } });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Review saved lead in new tab" }));
  expect(open).toHaveBeenCalledWith("/accounts/new-lead?tab=overview", "_blank", "noopener,noreferrer");
  expect(name()).toHaveValue("Later recovered edit");
  expect(drafts()).toHaveLength(1);
  second.unmount();
  const third = mount();
  fireEvent.click(screen.getByRole("button", { name: "Recover lead details" }));
  expect(name()).toHaveValue("Later recovered edit");
  expect(screen.getByLabelText("Contact name")).toHaveValue("Later contact");
  expect(screen.queryByRole("button", { name: "Create lead" })).not.toBeInTheDocument();
  expect(drafts()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "I reviewed the lead — discard this draft" }));
  await screen.findByRole("heading", { name: "Created account" });
  expect(third.router.state.location.pathname).toBe("/accounts/new-lead");
  expect(drafts()).toEqual([]);
  expect(mocks.request.mock.calls.filter(([op]) => op === "createLead")).toHaveLength(2);
});

it("reports an oversized latest draft honestly and retains the last valid details for recovery", async () => {
  const first = mount(); typeName("Last recoverable name");
  typeName("x".repeat(2001));
  await screen.findByText(/Your latest details could not be backed up/);
  expect(JSON.parse(sessionStorage.getItem(drafts()[0])!).fields.name).toBe("Last recoverable name");
  first.unmount(); mount();
  fireEvent.click(screen.getByRole("button", { name: "Recover lead details" }));
  expect(name()).toHaveValue("Last recoverable name");
});

it("keeps the unavailable-backup warning visible while reconciling an oversized latest draft", async () => {
  mocks.accountGet.mockResolvedValue({ data: { ...account, id: "new-lead", name: "Earlier stored name" } });
  const first = mount(); typeName("Last recoverable name");
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Last recoverable contact" } });
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "x".repeat(2001) } });
  await screen.findByText(/Your latest details could not be backed up/);
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  await screen.findByText(/latest draft details have not been confirmed as saved/);
  expect(screen.getByRole("button", { name: "Review saved lead in new tab" })).toBeInTheDocument();
  expect(screen.getByText(/Your latest details could not be backed up/)).toBeVisible();
  expect(JSON.parse(sessionStorage.getItem(drafts()[0])!)).toMatchObject({ existingId: "new-lead", fields: { name: "Last recoverable name", contactName: "Last recoverable contact" } });
  expect(screen.getByLabelText("Contact name")).toHaveValue("x".repeat(2001));
  expect(mocks.contactCreate).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  first.unmount(); mount();
  fireEvent.click(screen.getByRole("button", { name: "Recover lead details" }));
  expect(screen.getByRole("button", { name: "Review saved lead in new tab" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create lead" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Contact name")).toHaveValue("Last recoverable contact");
  expect(mocks.request.mock.calls.filter(([op]) => op === "createLead")).toHaveLength(1);
});

it.each(["creation", "verification"])("does not restore an old user's draft or start secondary writes after unmount during %s", async phase => {
  let finish!: (result: unknown) => void;
  if (phase === "creation") mocks.request.mockImplementation(operation => operation === "team" ? Promise.resolve({ team: [] }) : new Promise(resolve => { finish = resolve; }));
  else mocks.accountGet.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = mount(); typeName("Old user's draft");
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Old user's contact" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  await waitFor(() => expect(phase === "creation" ? mocks.request.mock.calls.some(([op]) => op === "createLead") : mocks.accountGet.mock.calls.length > 0).toBe(true));
  const fields = mocks.request.mock.calls.find(([op]) => op === "createLead")![1].fields;
  view.unmount(); sessionStorage.clear();
  await act(async () => finish(phase === "creation" ? { id: "new-lead" } : { data: { id: "new-lead", ...fields, propertyType: null } }));
  expect(drafts()).toEqual([]);
  expect(mocks.contactCreate).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  if (phase === "creation") expect(mocks.accountGet).not.toHaveBeenCalled();
});
