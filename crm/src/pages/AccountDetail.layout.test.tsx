import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../lib/client";
import { AdminContext } from "../lib/auth";

const mocks = vi.hoisted(() => ({ getAccount: vi.fn(), listActivity: vi.fn(), scrollIntoView: vi.fn(), request: vi.fn(), accountChanges: new Map<string, (account: unknown) => void>() }));
vi.mock("../lib/communications", () => ({ communicationRequest: mocks.request }));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {
    Account: { get: mocks.getAccount },
    Activity: { listActivityByEntityIdAndOccurredAt: mocks.listActivity },
  } }),
}));
vi.mock("./account/OverviewTab", () => ({
  OverviewTab: ({ account, onChange }: { account: { id: string }; onChange: (account: unknown) => void }) => {
    mocks.accountChanges.set(account.id, onChange);
    return <h2>Overview information</h2>;
  },
}));
vi.mock("../components/ContactsCard", () => ({
  default: ({ accountId }: { accountId: string }) => <EditableCard heading="Contacts" accountId={accountId} />,
}));
vi.mock("../components/LeadWorkflowPanel", () => ({
  default: ({ accountId }: { accountId: string }) => <EditableCard heading="Account communications" accountId={accountId} />,
}));
vi.mock("./account/DeleteLeadZone", () => ({ DeleteLeadZone: () => null }));
vi.mock("../components/property/DetailsCard", () => ({
  default: ({ account }: { account: { id: string } }) => <EditableCard heading="Property basics" accountId={account.id} />,
}));
vi.mock("../components/property/PhotosCard", () => ({ default: () => <h2>Site photos &amp; plans</h2> }));
vi.mock("../components/property/BuildingsCard", () => ({
  default: ({ accountId }: { accountId: string }) => <EditableCard heading="Buildings" accountId={accountId} />,
}));
vi.mock("../components/property/BlanketsCard", () => ({ default: () => <h2>Blanket coverages</h2> }));
vi.mock("../components/property/GeneralLiabilityCard", () => ({ default: () => <h2>General liability</h2> }));
vi.mock("../components/property/DirectorsOfficersCard", () => ({ default: () => <h2>Directors &amp; officers</h2> }));

import AccountDetail from "./AccountDetail";

function EditableCard({ heading, accountId }: { heading: string; accountId: string }) {
  // These forms seed local state once, just like the actual underwriting cards.
  const [value, setValue] = useState(accountId);
  return <section><h2>{heading}</h2><input aria-label={`${heading} draft`} value={value} onChange={event => setValue(event.target.value)} /></section>;
}
function Navigation() {
  const location = useLocation();
  return <><Link to={`/accounts/beta${location.search}`}>Another account</Link><output aria-label="Current location">{location.pathname}{location.search}{location.hash}</output></>;
}
function renderAccount(path = "/accounts/alpha?tab=overview", admin = false) {
  return render(<AdminContext.Provider value={admin}><MemoryRouter initialEntries={[path]}>
    <Navigation />
    <Routes><Route path="/accounts/:id" element={<AccountDetail profile={{ id: "user" } as UserProfile} />} /></Routes>
  </MemoryRouter></AdminContext.Provider>);
}
const coverageHeadings = ["Buildings", "Blanket coverages", "General liability", "Directors & officers"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountChanges.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: mocks.scrollIntoView });
  mocks.listActivity.mockResolvedValue({ data: [], nextToken: null });
  mocks.getAccount.mockImplementation(async ({ id }: { id: string }) => ({
    data: { id, name: id === "alpha" ? "Alpha association" : "Beta association", stage: "LEAD", type: "HOA" },
  }));
  mocks.request.mockReset();
  mocks.request.mockImplementation(async (operation, input) => {
    if (operation === "context") return {
      workflow: { accountId: input.accountId, name: "Alpha association", salespersonId: "alice", version: 4, disposition: "ACTIVE" },
      team: ["alice", "bob"].map(userId => ({ userId, name: userId === "alice" ? "Alice" : "Bob", enabled: true, salesperson: true, available: true })),
      tasks: [], communications: [], issues: [],
    };
    if (operation === "setResponsibilities") return { workflow: { accountId: input.accountId, salespersonId: input.salespersonId, version: input.version + 1 } };
    throw new Error(`Unexpected operation: ${operation}`);
  });
});

it("does not let a pending save replace a different account after route navigation", async () => {
  renderAccount();
  await screen.findByRole("heading", { name: /Alpha association/ });
  const finishEarlierSave = mocks.accountChanges.get("alpha")!;
  fireEvent.click(screen.getByRole("link", { name: "Another account" }));
  await screen.findByRole("heading", { name: /Beta association/ });
  act(() => finishEarlierSave({ id: "alpha", name: "Old account saved late", stage: "LEAD", type: "HOA" }));
  expect(screen.getByRole("heading", { name: /Beta association/ })).toBeInTheDocument();
  expect(screen.queryByText("Old account saved late")).not.toBeInTheDocument();
});

describe("lead salesperson on Overview", () => {
  it("lets an admin reassign in place and uses the saved version for the next change", async () => {
    renderAccount(undefined, true);
    const picker = await screen.findByRole("combobox", { name: "Salesperson for Alpha association" });
    expect(picker).toHaveValue("alice");
    fireEvent.change(picker, { target: { value: "bob" } });
    await screen.findByText("Saved");
    expect(picker).toHaveValue("bob");
    expect(mocks.request).toHaveBeenCalledWith("setResponsibilities", { accountId: "alpha", salespersonId: "bob", version: 4 }, true);
    expect(screen.getByLabelText("Current location")).toHaveTextContent("/accounts/alpha?tab=overview");

    fireEvent.change(picker, { target: { value: "alice" } });
    await screen.findByText("Saved");
    expect(mocks.request).toHaveBeenCalledWith("setResponsibilities", { accountId: "alpha", salespersonId: "alice", version: 5 }, true);
  });

  it.each(["PRODUCER", "STAFF", "CLIENT"])("does not expose lead reassignment for %s", async view => {
    if (view === "CLIENT") mocks.getAccount.mockResolvedValue({ data: { id: "alpha", name: "Alpha association", stage: "CLIENT", type: "HOA" } });
    renderAccount(undefined, view === "CLIENT");
    await screen.findByRole("heading", { name: "Overview information" });
    expect(screen.queryByRole("region", { name: "Lead salesperson" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("assigns an uninitialized lead without first setting up communications", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (operation, input) => {
      const result = await normal(operation, input);
      return operation === "context" ? { ...result, workflow: null } : result;
    });
    renderAccount(undefined, true);
    const picker = await screen.findByRole("combobox", { name: "Salesperson for Alpha association" });
    expect(picker).toHaveValue("");
    fireEvent.change(picker, { target: { value: "bob" } });
    await screen.findByText("Saved");
    expect(mocks.request).toHaveBeenCalledWith("setResponsibilities", { accountId: "alpha", salespersonId: "bob", version: 0 }, true);
    expect(mocks.request.mock.calls.some(([operation]) => operation === "initializeLead")).toBe(false);
  });

  it("reloads ownership after visiting Activity and when opening another lead", async () => {
    renderAccount(undefined, true);
    fireEvent.change(await screen.findByRole("combobox", { name: "Salesperson for Alpha association" }), { target: { value: "bob" } });
    await screen.findByText("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.queryByRole("region", { name: "Lead salesperson" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(await screen.findByRole("combobox", { name: "Salesperson for Alpha association" })).toHaveValue("alice");
    expect(mocks.request.mock.calls.filter(([operation]) => operation === "context")).toHaveLength(2);

    fireEvent.click(screen.getByRole("link", { name: "Another account" }));
    const picker = await screen.findByRole("combobox", { name: "Salesperson for Beta association" });
    fireEvent.change(picker, { target: { value: "bob" } });
    await screen.findByText("Saved");
    expect(mocks.request).toHaveBeenCalledWith("setResponsibilities", { accountId: "beta", salespersonId: "bob", version: 4 }, true);
  });

  it("keeps a failed ownership read unavailable until an explicit successful retry", async () => {
    mocks.request.mockRejectedValueOnce(new Error("Assignment lookup unavailable"));
    renderAccount(undefined, true);
    expect(await screen.findByRole("alert")).toHaveTextContent("Assignment lookup unavailable");
    expect(screen.queryByRole("combobox", { name: /^Salesperson for/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry salesperson" }));
    expect(await screen.findByRole("combobox", { name: "Salesperson for Alpha association" })).toHaveValue("alice");
  });

  it.each(["refresh-last", "save-last"])("retains the newest ownership when a refresh overlaps a save (%s)", async order => {
    const normal = mocks.request.getMockImplementation()!;
    let reads = 0, saves = 0;
    let finishRefresh!: (result: unknown) => void;
    let finishSave!: (result: unknown) => void;
    mocks.request.mockImplementation((operation, input) => {
      if (operation === "context" && ++reads > 1) return new Promise(resolve => { finishRefresh = resolve; });
      if (operation === "setResponsibilities") {
        if (++saves === 1) return Promise.reject(new Error("Refresh before saving."));
        if (saves === 2) return new Promise(resolve => { finishSave = resolve; });
      }
      return normal(operation, input);
    });
    renderAccount(undefined, true);
    const picker = await screen.findByRole("combobox", { name: "Salesperson for Alpha association" });
    fireEvent.change(picker, { target: { value: "bob" } });
    fireEvent.click(await screen.findByRole("button", { name: "Refresh assignments" }));
    fireEvent.change(picker, { target: { value: "bob" } });
    const refreshed = await normal("context", { accountId: "alpha" });
    const saved = { workflow: { accountId: "alpha", salespersonId: "bob", version: 5 } };
    if (order === "refresh-last") {
      await act(async () => finishSave(saved));
      await act(async () => finishRefresh(refreshed));
      expect(picker).toHaveValue("bob");
    } else {
      refreshed.workflow.version = 6;
      await act(async () => finishRefresh(refreshed));
      await act(async () => finishSave(saved));
      expect(picker).toHaveValue("alice");
    }
    fireEvent.change(picker, { target: { value: order === "refresh-last" ? "alice" : "bob" } });
    await screen.findByText("Saved");
    expect(mocks.request).toHaveBeenLastCalledWith("setResponsibilities", { accountId: "alpha", salespersonId: order === "refresh-last" ? "alice" : "bob", version: order === "refresh-last" ? 5 : 6 }, true);
  });
});

describe("account underwriting layout", () => {
  it("keeps general property details and photos on Overview and moves the four coverage sections to their own tab", async () => {
    renderAccount();
    expect(await screen.findByRole("heading", { name: "Property basics" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Site photos & plans" })).toBeVisible();
    for (const name of coverageHeadings) expect(screen.queryByRole("heading", { name })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Property & coverage" }));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("/accounts/alpha?tab=property");
    for (const name of coverageHeadings) expect(screen.getByRole("heading", { name })).toBeVisible();
    expect(screen.getByLabelText("Buildings draft")).toHaveValue("alpha");
    expect(screen.queryByRole("heading", { name: "Property basics" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Site photos & plans" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("heading", { name: "Property basics" })).toBeVisible();
    for (const name of coverageHeadings) expect(screen.queryByRole("heading", { name })).toBeNull();
  });

  it("opens a saved property tab link after a lead becomes a client", async () => {
    mocks.getAccount.mockResolvedValue({ data: { id: "alpha", name: "Alpha association", stage: "CLIENT", type: "HOA" } });
    renderAccount("/accounts/alpha?tab=property");
    expect(await screen.findByRole("heading", { name: "Buildings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Property & coverage" })).toHaveClass("active");
    expect(screen.getByLabelText("Current location")).toHaveTextContent("?tab=property");
    expect(screen.queryByRole("heading", { name: "Overview information" })).toBeNull();
  });

  it.each([
    ["overview", "Property basics draft"],
    ["overview", "Contacts draft"],
    ["property", "Buildings draft"],
    ["activity", "Account communications draft"],
  ])("clears account-specific drafts when navigating from the %s tab to another account", async (tab, label) => {
    renderAccount(`/accounts/alpha?tab=${tab}`);
    const draft = await screen.findByLabelText(label);
    fireEvent.change(draft, { target: { value: "Unsaved alpha change" } });
    fireEvent.click(screen.getByRole("link", { name: "Another account" }));
    await screen.findByRole("heading", { name: /Beta association/ });
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue("beta"));
    expect(screen.getByLabelText("Current location")).toHaveTextContent(`/accounts/beta?tab=${tab}`);
  });
});

describe("account communications in Activity", () => {
  it.each(["LEAD", "CLIENT"])("keeps communications off Overview and alongside account changes in Activity for a %s", async stage => {
    mocks.getAccount.mockResolvedValue({ data: { id: "alpha", name: "Alpha association", stage, type: "HOA" } });
    renderAccount();
    await screen.findByRole("heading", { name: "Overview information" });
    expect(screen.queryByRole("heading", { name: "Account communications" })).not.toBeInTheDocument();
    expect(mocks.listActivity).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByRole("heading", { name: "Account communications" })).toBeVisible();
    expect(screen.getByRole("heading", { name: /^Account changes/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("active");
    expect(screen.queryByRole("heading", { name: "Overview information" })).not.toBeInTheDocument();
    expect(document.getElementById("lead-workspace")).toContainElement(screen.getByRole("heading", { name: "Account communications" }));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("/accounts/alpha?tab=activity");

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("heading", { name: "Overview information" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Account communications" })).not.toBeInTheDocument();
  });

  it.each(["LEAD", "CLIENT"])("opens a legacy communications link in Activity for a %s and still allows returning to Overview", async stage => {
    mocks.getAccount.mockResolvedValue({ data: { id: "alpha", name: "Alpha association", stage, type: "HOA" } });
    renderAccount("/accounts/alpha?tab=overview#lead-workspace");
    expect(await screen.findByRole("heading", { name: "Account communications" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("active");
    expect(screen.queryByRole("heading", { name: "Overview information" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("heading", { name: "Overview information" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("active");
    expect(screen.queryByRole("heading", { name: "Account communications" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Current location")).not.toHaveTextContent("#lead-workspace");
  });

  it("keeps an existing contact-details link on Overview", async () => {
    renderAccount("/accounts/alpha?tab=overview#contacts");
    expect(await screen.findByRole("heading", { name: "Contacts" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("active");
    expect(screen.queryByRole("heading", { name: "Account communications" })).not.toBeInTheDocument();
  });
});
