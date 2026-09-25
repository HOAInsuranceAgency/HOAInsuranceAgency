import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), contact: vi.fn(), document: vi.fn(), updateDocument: vi.fn(), upload: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Contact: { create: h.contact }, Document: { create: h.document, update: h.updateDocument } } }) }));
vi.mock("aws-amplify/storage", () => ({ uploadData: h.upload }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/googlePlaces", () => ({ AddressAutocomplete: () => null }));
import NewLead from "./NewLead";
import { DirtyFormsProvider } from "../components/ui/unsaved";

beforeEach(() => {
  vi.clearAllMocks();
  h.request.mockImplementation(async op => op === "team" ? { team: [] } : { id: "new-lead" });
  h.contact.mockResolvedValue({ data: { id: "contact" } });
  h.document.mockResolvedValue({ data: { id: "document" } });
  h.updateDocument.mockResolvedValue({ data: { id: "document" } });
  h.upload.mockImplementation(() => ({ result: Promise.resolve({}) }));
});
afterEach(() => vi.restoreAllMocks());

function startDraft() {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const router = createMemoryRouter([{ element: <DirtyFormsProvider><Outlet /></DirtyFormsProvider>, children: [
    { path: "/leads/new", element: <NewLead /> },
    { path: "/leads", element: <p>Lead directory</p> },
    { path: "/accounts/:id", element: <p>Saved lead</p> },
  ] }], { initialEntries: ["/leads/new"] });
  render(<RouterProvider router={router} />);
  fireEvent.change(screen.getByLabelText("Name (association / insured) *"), { target: { value: "Willow HOA" } });
  fireEvent.change(screen.getByLabelText("Lead source *"), { target: { value: "PHONE" } });
  return { router, confirm };
}

describe("lead creation recovery", () => {
  it.each(["contact response", "contact exception", "upload"])("keeps the %s failure visible but allows opening the saved lead without an unsaved warning", async failure => {
    if (failure === "contact response") h.contact.mockResolvedValue({ data: null, errors: [{ message: "Unavailable" }] });
    if (failure === "contact exception") h.contact.mockRejectedValue(new Error("Unavailable"));
    if (failure === "upload") h.upload.mockImplementation(() => ({ result: Promise.reject(new Error("Upload unavailable")) }));
    const { router, confirm } = startDraft();
    if (failure.startsWith("contact")) fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Alex Agent" } });
    else fireEvent.change(screen.getByLabelText("Add documents…"), { target: { files: [new File(["fixture"], "renewal.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: /^Create lead/ }));
    const open = await screen.findByRole("button", { name: "Go to the lead" });
    expect(screen.getByRole("alert")).toHaveTextContent(failure === "upload" ? /didn't upload: renewal.pdf/ : /contact wasn't saved/);
    expect(screen.queryByRole("button", { name: /^Create lead/ })).toBeNull();
    fireEvent.click(open);
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts/new-lead"));
    expect(confirm).not.toHaveBeenCalled();
    expect(h.request.mock.calls.filter(([op]) => op === "createLead")).toHaveLength(1);
  });

  it("retains the draft and departure protection when the lead itself was not created", async () => {
    h.request.mockImplementation(async op => { if (op === "team") return { team: [] }; throw new Error("Creation unavailable"); });
    const { router, confirm } = startDraft();
    fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Creation unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(router.state.location.pathname).toBe("/leads/new");
    expect(screen.getByLabelText("Name (association / insured) *")).toHaveValue("Willow HOA");
    expect(h.contact).not.toHaveBeenCalled();
  });
});
