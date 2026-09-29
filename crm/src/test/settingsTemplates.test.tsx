import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ list: vi.fn(), uploadData: vi.fn(), inspect: vi.fn() }));
vi.mock("../lib/scopedStorage", () => ({ list: h.list, uploadData: h.uploadData }));
vi.mock("../lib/acord", () => ({
  ACORD_FORMS: [
    { key: "acord25", path: "templates/acord25.pdf", label: "ACORD 25 — Certificate of Liability Insurance", note: "Certificates." },
    { key: "acord125", path: "templates/acord125.pdf", label: "ACORD 125 — Application", note: "Applications." },
  ],
  listTemplateFields: h.inspect,
}));
vi.mock("../lib/client", () => ({ client: {}, friendlyError: (error: Error) => error.message }));
vi.mock("../pages/Team", () => ({ default: () => null }));
vi.mock("../components/CommunicationSettings", () => ({ default: () => null }));
vi.mock("../components/MarketingReportSettings", () => ({ default: () => null }));
vi.mock("../components/Licensing", () => ({ default: () => null }));
vi.mock("../components/SignatureManager", () => ({ default: () => null }));
import Settings from "../pages/Settings";
import { AdminContext } from "../lib/auth";
import type { UserProfile } from "../lib/client";

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({ items: [{ path: "templates/acord25.pdf" }] });
  h.inspect.mockResolvedValue(["NamedInsured", "PolicyNumber"]);
  h.uploadData.mockReturnValue({ result: Promise.resolve({ path: "templates/acord125.pdf" }) });
});
function renderSettings(admin: boolean) {
  // The profile mirror must not grant or remove Cognito administrator access.
  const profile = { id: "me", role: admin ? "STAFF" : "ADMIN" } as UserProfile;
  return render(<MemoryRouter><AdminContext.Provider value={admin}><Settings profile={profile} /></AdminContext.Provider></MemoryRouter>);
}

it("lets staff see template status and inspect forms without offering upload or replacement", async () => {
  const { container } = renderSettings(false);
  expect(await screen.findByText("Uploaded")).toBeVisible();
  expect(screen.getByText("Missing")).toBeVisible();
  expect(h.list).toHaveBeenCalledWith({ path: "templates/" });
  expect(screen.queryByText("Upload PDF…")).toBeNull();
  expect(screen.queryByText("Replace PDF…")).toBeNull();
  expect(container.querySelector('input[type="file"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inspect fields" }));
  expect(await screen.findByText(/NamedInsured/)).toBeVisible();
  expect(h.inspect).toHaveBeenCalledWith("templates/acord25.pdf");
  expect(h.uploadData).not.toHaveBeenCalled();
});

it("lets a Cognito administrator upload a missing form and replace an existing form", async () => {
  renderSettings(true);
  expect(await screen.findByText("Uploaded")).toBeVisible();
  const file = new File(["pdf"], "acord125.pdf", { type: "application/pdf" });
  expect(screen.getByLabelText("Replace PDF…")).toHaveAttribute("type", "file");
  fireEvent.change(screen.getByLabelText("Upload PDF…"), { target: { files: [file] } });
  await waitFor(() => expect(h.uploadData).toHaveBeenCalledWith({ path: "templates/acord125.pdf", data: file, options: { contentType: "application/pdf" } }));
  await waitFor(() => expect(screen.getAllByText("Uploaded")).toHaveLength(2));
  expect(screen.getAllByLabelText("Replace PDF…")).toHaveLength(2);
});
