import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ list: vi.fn(), uploadData: vi.fn(), inspect: vi.fn(), loadAgency: vi.fn(), saveAgency: vi.fn() }));
vi.mock("../lib/scopedStorage", () => ({ list: h.list, uploadData: h.uploadData }));
vi.mock("../lib/acord", () => ({
  ACORD_FORMS: [
    { key: "acord25", path: "templates/acord25.pdf", label: "ACORD 25 — Certificate of Liability Insurance", note: "Certificates." },
    { key: "acord125", path: "templates/acord125.pdf", label: "ACORD 125 — Application", note: "Applications." },
  ],
  listTemplateFields: h.inspect,
}));
vi.mock("../lib/agencySettings", () => ({ EMPTY_IDENTIFIERS: { agencyNpn: "", drlpNpn: "", agencyEin: "" }, loadAgencyIdentifiers: h.loadAgency, saveAgencyIdentifiers: h.saveAgency }));
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


it('holds each template busy independently while other template requests finish', async () => {
  h.list.mockResolvedValue({ items: [{ path: 'templates/acord25.pdf' }, { path: 'templates/acord125.pdf' }] });
  let finishFirst!: (value: string[]) => void;
  let finishSecond!: (value: string[]) => void;
  h.inspect.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
  renderSettings(true); await screen.findAllByText('Uploaded');
  const buttons = screen.getAllByRole('button', { name: 'Inspect fields' });
  fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
  expect(buttons[0]).toBeDisabled(); expect(buttons[1]).toBeDisabled();
  await act(async () => finishSecond(['Second']));
  expect(buttons[0]).toBeDisabled(); expect(buttons[1]).toBeEnabled();
  await act(async () => finishFirst(['First']));
  expect(buttons[0]).toBeEnabled();
});

it('does not show a template as missing after its presence check fails, and retries', async () => {
  h.list.mockRejectedValueOnce(new Error('Storage unavailable'));
  renderSettings(true);
  expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
  expect(screen.queryByText('Missing')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry templates' }));
  expect(await screen.findByText('Uploaded')).toBeVisible();
});

it('keeps agency identifiers unavailable after a failed read instead of offering a blank save', async () => {
  h.loadAgency.mockResolvedValueOnce(null).mockResolvedValueOnce({ agencyNpn: '123', drlpNpn: '456', agencyEin: '123456789' });
  renderSettings(true); fireEvent.click(screen.getByRole('button', { name: 'Agency' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('load the agency identifiers');
  expect(screen.queryByLabelText('Agency NPN')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry agency identifiers' }));
  expect(await screen.findByLabelText('Agency NPN')).toHaveValue('123');
});

it('keeps agency edits unchanged after save failure and prevents typing into an in-flight save', async () => {
  h.loadAgency.mockResolvedValue({ agencyNpn: '123', drlpNpn: '456', agencyEin: '123456789' });
  let reject!: (reason: Error) => void;
  h.saveAgency.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  renderSettings(true); fireEvent.click(screen.getByRole('button', { name: 'Agency' }));
  const field = await screen.findByLabelText('Agency NPN');
  fireEvent.change(field, { target: { value: '999' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(field).toBeDisabled();
  await act(async () => reject(new Error('Save unavailable')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
  expect(field).toHaveValue('999'); expect(field).toBeEnabled();
});


it('follows settings links when only the query-string tab changes', async () => {
  h.loadAgency.mockResolvedValue({ agencyNpn: '123', drlpNpn: '456', agencyEin: '123456789' });
  function Jump() { const navigate = useNavigate(); return <button onClick={() => navigate('/settings?tab=agency')}>Open agency link</button>; }
  render(<MemoryRouter initialEntries={['/settings?tab=templates']}><AdminContext.Provider value={true}><Jump /><Settings profile={{ id: 'me' } as UserProfile} /></AdminContext.Provider></MemoryRouter>);
  await screen.findByText('Uploaded');
  fireEvent.click(screen.getByRole('button', { name: 'Open agency link' }));
  expect(await screen.findByLabelText('Agency NPN')).toHaveValue('123');
  expect(screen.queryByText('ACORD templates')).toBeNull();
});
