import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../lib/client";

const mocks = vi.hoisted(() => ({ getAccount: vi.fn() }));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { Account: { get: mocks.getAccount } } }),
}));
vi.mock("./account/OverviewTab", () => ({
  OverviewTab: () => <h2>Overview information</h2>,
}));
vi.mock("../components/ContactsCard", () => ({ default: () => <h2>Contacts</h2> }));
vi.mock("../components/LeadWorkflowPanel", () => ({ default: () => null }));
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
  return <><Link to={`/accounts/beta${location.search}`}>Another account</Link><output aria-label="Current location">{location.pathname}{location.search}</output></>;
}
function renderAccount(path = "/accounts/alpha?tab=overview") {
  render(<MemoryRouter initialEntries={[path]}>
    <Navigation />
    <Routes><Route path="/accounts/:id" element={<AccountDetail profile={{ id: "user" } as UserProfile} />} /></Routes>
  </MemoryRouter>);
}
const coverageHeadings = ["Buildings", "Blanket coverages", "General liability", "Directors & officers"];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAccount.mockImplementation(async ({ id }: { id: string }) => ({
    data: { id, name: id === "alpha" ? "Alpha association" : "Beta association", stage: "LEAD", type: "HOA" },
  }));
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
    ["property", "Buildings draft"],
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
