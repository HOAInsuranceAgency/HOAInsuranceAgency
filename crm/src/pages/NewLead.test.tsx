import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  contactCreate: vi.fn(),
  documentCreate: vi.fn(),
  documentUpdate: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../components/LeadWorkflowPanel", () => ({ ResponsibilitySelect: () => null }));
vi.mock("../lib/googlePlaces", () => ({
  AddressAutocomplete: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input value={value} onChange={event => onChange(event.target.value)} />
  ),
}));
vi.mock("../lib/scopedStorage", () => ({ uploadData: h.upload }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: async () => ({ userId: "actor" }) }));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {
    Contact: { create: h.contactCreate },
    Document: { create: h.documentCreate, update: h.documentUpdate },
  } }),
}));
import NewLead from "./NewLead";

beforeEach(() => {
  h.navigate.mockReset();
  h.request.mockReset().mockImplementation(async (operation: string) =>
    operation === "team" ? { team: [] } : { id: "new-lead" });
  h.contactCreate.mockReset().mockResolvedValue({ data: { id: "contact-1" } });
  h.documentCreate.mockReset().mockResolvedValue({ data: { id: "document-1" } });
  h.documentUpdate.mockReset().mockResolvedValue({});
  h.upload.mockReset().mockReturnValue({ result: Promise.resolve() });
});

it("recovers from a rejected contact write after creation without offering another create", async () => {
  h.contactCreate.mockRejectedValueOnce(new Error("Contact temporarily unavailable"));
  render(<NewLead />);
  fireEvent.change(screen.getByRole("textbox", { name: "Name (association / insured) *" }), { target: { value: "Sample property" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Lead source *" }), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Pat" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  expect(await screen.findByText(/the contact wasn't saved/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create lead" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Go to the lead" }));
  expect(h.navigate).toHaveBeenCalledWith("/accounts/new-lead?tab=documents");
  expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(1);
});

it("does not navigate away from a new page when creation completes after unmount", async () => {
  let finish!: (value: { id: string }) => void;
  h.request.mockImplementation((operation: string) => operation === "team" ? Promise.resolve({ team: [] }) : new Promise(resolve => { finish = resolve; }));
  const view = render(<NewLead />);
  fireEvent.change(screen.getByRole("textbox", { name: "Name (association / insured) *" }), { target: { value: "Sample property" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Lead source *" }), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  expect(screen.getByRole("textbox", { name: "Name (association / insured) *" })).toBeDisabled();
  view.unmount();
  finish({ id: "new-lead" });
  await waitFor(() => expect(h.request).toHaveBeenCalledWith("createLead", expect.anything(), true));
  expect(h.navigate).not.toHaveBeenCalled();
});

function fillRequired() {
  fireEvent.change(screen.getByRole("textbox", { name: "Name (association / insured) *" }), { target: { value: "Sample property" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Lead source *" }), { target: { value: "ORGANIC_WEBSITE" } });
}

async function submit() {
  fillRequired();
  fireEvent.click(screen.getByRole("button", { name: /^Create lead/ }));
  await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/accounts/new-lead?tab=documents"));
  return h.request.mock.calls.find(([operation]) => operation === "createLead")![1].fields;
}

function disclosure(title: string) {
  const summary = screen.getByText(title).closest("summary");
  expect(summary).not.toBeNull();
  return summary!;
}

describe("new lead property classification", () => {
  it.each(["CONDO", "HOA_POA_POND_TOWNHOME", "INDIVIDUAL_UNIT_OWNER", "NOT_RECORDED"])("preserves the explicit %s selection when account type is toggled before saving", async propertyType => {
    render(<NewLead />);
    const classification = screen.getByRole("combobox", { name: "Property type" });
    const accountType = screen.getByRole("combobox", { name: "Account type" });
    fireEvent.change(classification, { target: { value: propertyType } });
    for (const type of ["PERSONAL", "COMMERCIAL_OTHER", "ASSOCIATION"]) {
      fireEvent.change(accountType, { target: { value: type } });
      expect(classification).toHaveValue(propertyType);
    }
    expect(await submit()).toMatchObject({ type: "ASSOCIATION", propertyType });
  });

  it("does not save a stale owner classification after toggling an unclassified lead back to Association", async () => {
    render(<NewLead />);
    const accountType = screen.getByRole("combobox", { name: "Account type" });
    fireEvent.change(accountType, { target: { value: "PERSONAL" } });
    expect(screen.getByText("Personal (HO-6) accounts use Individual unit owner unless you choose another property type.")).toBeVisible();
    fireEvent.change(accountType, { target: { value: "ASSOCIATION" } });
    expect(screen.getByRole("combobox", { name: "Property type" })).toHaveValue("");
    expect(await submit()).toMatchObject({ type: "ASSOCIATION", propertyType: undefined });
  });
});

describe("new lead form", () => {
  it("retains optional details and notes when their sections are closed before saving", async () => {
    render(<NewLead />);
    const property = disclosure("Property & current coverage");
    const notes = disclosure("Notes & documents");
    expect(property.parentElement).not.toHaveAttribute("open");
    expect(notes.parentElement).not.toHaveAttribute("open");

    fireEvent.click(property);
    fireEvent.change(screen.getByLabelText("Street address"), { target: { value: "100 Lake Street" } });
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Orlando" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "FL" } });
    fireEvent.change(screen.getByLabelText("ZIP"), { target: { value: "32801" } });
    fireEvent.change(screen.getByLabelText("Unit count"), { target: { value: "72" } });
    fireEvent.change(screen.getByLabelText("Total insured value ($)"), { target: { value: "4200000" } });
    fireEvent.change(screen.getByLabelText("Current agent / broker"), { target: { value: "Current Agency" } });
    fireEvent.change(screen.getByLabelText("Current policy expiration"), { target: { value: "2027-05-01" } });
    fireEvent.click(property);
    fireEvent.click(notes);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "  Budget received.  " } });
    fireEvent.click(notes);

    expect(await submit()).toMatchObject({
      address: "100 Lake Street", city: "Orlando", state: "FL", zip: "32801",
      unitCount: 72, totalInsuredValue: 4200000, currentAgent: "Current Agency",
      currentPolicyExpiration: "2027-05-01", notes: "Budget received.",
    });
  });

  it("submits with Enter and creates the primary contact using the entered contact fields", async () => {
    const user = userEvent.setup();
    render(<NewLead />);
    fillRequired();
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "  Pat Alvarez  " } });
    fireEvent.change(screen.getByLabelText("Contact role"), { target: { value: "MANAGER" } });
    fireEvent.change(screen.getByLabelText("Contact email"), { target: { value: "pat@example.com" } });
    fireEvent.change(screen.getByLabelText("Contact phone"), { target: { value: "4075550100" } });
    await user.click(screen.getByLabelText("Name (association / insured) *"));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/accounts/new-lead?tab=documents"));
    expect(h.contactCreate).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "new-lead", name: "Pat Alvarez", type: "MANAGER",
      email: "pat@example.com", phone: "4075550100", isPrimary: true,
      extractionSourceKey: "email:pat@example.com",
    }));
    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(1);
  });

  it("does not submit when Enter selects a street address", async () => {
    const user = userEvent.setup();
    render(<NewLead />);
    fillRequired();
    await user.click(disclosure("Property & current coverage"));
    await user.click(screen.getByLabelText("Street address"));
    await user.keyboard("100 Lake Street{Enter}");

    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(0);
    expect(await submit()).toMatchObject({ address: "100 Lake Street" });
  });

  it("shows validation errors and preserves entered fields for correction", async () => {
    render(<NewLead />);
    fireEvent.submit(screen.getByRole("form", { name: "New lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name is required.");
    fireEvent.change(screen.getByLabelText("Name (association / insured) *"), { target: { value: "Sample property" } });
    fireEvent.submit(screen.getByRole("form", { name: "New lead" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a lead source before creating the lead.");
    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(0);
    expect(screen.getByLabelText("Name (association / insured) *")).toHaveValue("Sample property");
    expect(await submit()).toMatchObject({ name: "Sample property", leadSource: "ORGANIC_WEBSITE" });
  });

  it("opens the optional property section and focuses an invalid ZIP for correction", async () => {
    render(<NewLead />);
    fillRequired();
    const property = disclosure("Property & current coverage");
    fireEvent.click(property);
    const zip = screen.getByLabelText("ZIP");
    fireEvent.change(zip, { target: { value: "ZIP123" } });
    fireEvent.click(property);
    expect(property.parentElement).not.toHaveAttribute("open");
    fireEvent.submit(screen.getByRole("form", { name: "New lead" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ZIP should be 5 digits (or ZIP+4).");
    expect(property.parentElement).toHaveAttribute("open");
    expect(zip).toHaveFocus();
    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(0);
    fireEvent.change(zip, { target: { value: "32801" } });
    expect(await submit()).toMatchObject({ zip: "32801" });
  });

  it("stages and removes documents without submitting, then uploads only retained files", async () => {
    render(<NewLead />);
    fireEvent.click(disclosure("Notes & documents"));
    const policy = new File(["policy"], "policy.pdf", { type: "application/pdf" });
    const budget = new File(["budget"], "budget.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Add documents…"), { target: { files: [policy, budget] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove policy.pdf" }));
    expect(screen.queryByText("policy.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("budget.pdf")).toBeInTheDocument();
    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(0);
    fireEvent.click(disclosure("Notes & documents"));

    await submit();
    expect(h.documentCreate).toHaveBeenCalledTimes(1);
    expect(h.documentCreate).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "ACCOUNT", entityId: "new-lead", name: "budget.pdf",
      contentType: "application/pdf", sizeBytes: budget.size, ocrStatus: "PENDING",
    }));
    expect(h.documentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: "document-1", s3Key: "documents/ACCOUNT/new-lead/document-1/budget.pdf",
    }));
    expect(h.upload).toHaveBeenCalledWith({
      path: "documents/ACCOUNT/new-lead/document-1/budget.pdf",
      data: budget, options: { contentType: "application/pdf" },
    });
  });

  it("prevents edits and duplicate submissions while saving, then allows a failed request to be retried", async () => {
    let failRequest!: (error: Error) => void;
    h.request.mockImplementation((operation: string) => operation === "team"
      ? Promise.resolve({ team: [] })
      : new Promise((_resolve, reject) => { failRequest = reject; }));
    render(<NewLead />);
    fillRequired();
    fireEvent.submit(screen.getByRole("form", { name: "New lead" }));
    expect(screen.getByLabelText("Name (association / insured) *")).toBeDisabled();
    expect(screen.getByLabelText("Contact email")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New lead" }));
    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(1);

    failRequest(new Error("Unable to create the lead right now."));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to create the lead right now.");
    expect(screen.getByLabelText("Name (association / insured) *")).toBeEnabled();
    h.request.mockImplementation(async (operation: string) => operation === "team" ? { team: [] } : { id: "new-lead" });
    await submit();
    expect(h.request.mock.calls.filter(([operation]) => operation === "createLead")).toHaveLength(2);
  });
});
