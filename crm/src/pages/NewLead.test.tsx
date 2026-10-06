import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn(), contactCreate: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../components/LeadWorkflowPanel", () => ({ ResponsibilitySelect: () => null }));
vi.mock("../lib/googlePlaces", () => ({ AddressAutocomplete: () => null }));
vi.mock("../lib/scopedStorage", () => ({ uploadData: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Contact: { create: h.contactCreate } } }) }));
import NewLead from "./NewLead";

beforeEach(() => {
  h.navigate.mockReset();
  h.contactCreate.mockReset().mockResolvedValue({ data: { id: "contact" } });
  h.request.mockReset().mockImplementation(async (operation: string) =>
    operation === "team" ? { team: [] } : { id: "new-lead" });
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

async function submit() {
  fireEvent.change(screen.getByRole("textbox", { name: "Name (association / insured) *" }), { target: { value: "Sample property" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Lead source *" }), { target: { value: "ORGANIC_WEBSITE" } });
  fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
  await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/accounts/new-lead?tab=documents"));
  return h.request.mock.calls.find(([operation]) => operation === "createLead")![1].fields;
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
