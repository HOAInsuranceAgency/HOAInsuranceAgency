import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ friendlyError: (error: Error) => error.message }));
import { LeadEligibilityCells, LeadEligibilityEditor, LeadEligibilityFeedback, useLeadEligibilitySettings } from "../components/LeadEligibilitySettings";
function LeadEligibilitySettings({ disabled = false }: { disabled?: boolean } = {}) {
  const settings = useLeadEligibilitySettings();
  return <><button onClick={settings.refresh}>Refresh roster</button><LeadEligibilityFeedback settings={settings} /><table><tbody>{settings.resource.data.team.map(member => <tr key={member.userId}><td>{member.name}</td><LeadEligibilityCells member={member} settings={settings} disabled={disabled} /></tr>)}</tbody></table><LeadEligibilityEditor settings={settings} /></>;
}
import type { TeamEligibility } from "../lib/communications";
const member: TeamEligibility = { userId: "jake", name: "Jake Greasley", email: "jake@example.com", enabled: true, salesperson: true, frontId: "tea_ci3mi", dialpadId: "5655281245659136", version: 3 };
type EligibilityPatch = Partial<TeamEligibility> & { userId: string };
function mockRoster(initial: TeamEligibility = member) {
  let persisted = { ...initial };
  h.request.mockImplementation(async (op: string, input: EligibilityPatch) => {
    if (op === "team") return { team: [{ ...persisted }] };
    persisted = { ...persisted, ...input, version: (input.version ?? 0) + 1 };
    return { member: { ...persisted } };
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mockRoster();
});
async function edit() { fireEvent.click(await screen.findByRole("button", { name: "Edit connections for Jake Greasley" })); }
const frontInput = () => screen.getByRole("textbox", { name: /^Front teammate ID/ });
const dialpadInput = () => screen.getByRole("textbox", { name: /^Dialpad user ID/ });
const channelInput = () => screen.getByRole("textbox", { name: /^Email channel ID/ });
const signatureInput = () => screen.getByRole("textbox", { name: /^Email signature ID/ });
const receiveLeadsInput = () => screen.getByRole("checkbox", { name: "Receive new leads for Jake Greasley" });

describe("producer lead delivery settings", () => {
  it("defaults existing producers to receive new leads and keeps assignment eligibility read-only", async () => {
    render(<LeadEligibilitySettings />);
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Jake Greasley" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Salesperson eligibility/i })).not.toBeInTheDocument();
    fireEvent.click(receiveLeadsInput());
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { userId: "jake", version: 3, receiveNewLeads: false }, true));
    await waitFor(() => expect(receiveLeadsInput()).not.toBeChecked());
    expect(screen.getByText("Off")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit connections for Jake Greasley" })).toBeEnabled();
    fireEvent.click(receiveLeadsInput());
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { userId: "jake", version: 4, receiveNewLeads: true }, true));
    await waitFor(() => expect(receiveLeadsInput()).toBeChecked());
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility").every(([, input]) => !Object.hasOwn(input, "salesperson"))).toBe(true);
  });

  it("honors a saved off setting and defaults missing member versions to zero", async () => {
    mockRoster({ ...member, receiveNewLeads: false, version: undefined });
    render(<LeadEligibilitySettings />);
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Jake Greasley" })).not.toBeChecked();
    fireEvent.click(receiveLeadsInput());
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { userId: "jake", version: 0, receiveNewLeads: true }, true));
    await waitFor(() => expect(receiveLeadsInput()).toBeChecked());
  });

  it("shows the receive-leads setting only for producers", async () => {
    mockRoster({ ...member, salesperson: false });
    render(<LeadEligibilitySettings />);
    expect(await screen.findByText("Producers only")).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit connections for Jake Greasley" })).toBeEnabled();
  });

  it("retains the committed setting after a failed toggle and allows retry", async () => {
    let saves = 0;
    h.request.mockImplementation(async (op: string, input: EligibilityPatch) => {
      if (op === "team") return { team: [{ ...member }] };
      if (++saves === 1) throw new Error("Could not save lead settings");
      return { member: { ...member, ...input, version: 4 } };
    });
    render(<LeadEligibilitySettings />);
    await screen.findByRole("checkbox", { name: "Receive new leads for Jake Greasley" });
    fireEvent.click(receiveLeadsInput());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save lead settings");
    expect(receiveLeadsInput()).toBeChecked();
    expect(receiveLeadsInput()).toBeEnabled();
    fireEvent.click(receiveLeadsInput());
    await waitFor(() => expect(receiveLeadsInput()).not.toBeChecked());
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility").map(([, input]) => input)).toEqual([
      { userId: "jake", version: 3, receiveNewLeads: false },
      { userId: "jake", version: 3, receiveNewLeads: false },
    ]);
  });

  it("disables lead delivery and connection edits for unavailable members", async () => {
    mockRoster({ ...member, available: false });
    render(<LeadEligibilitySettings />);
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Jake Greasley" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit connections for Jake Greasley" })).toBeDisabled();
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
  });

  it("honors an inactive team row independently of persisted assignment settings", async () => {
    render(<LeadEligibilitySettings disabled />);
    expect(await screen.findByRole("checkbox", { name: "Receive new leads for Jake Greasley" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit connections for Jake Greasley" })).toBeDisabled();
  });
});

describe("protected teammate connection IDs", () => {
  it("shows exact IDs as read-only text until the user explicitly opens the editor", async () => {
    render(<LeadEligibilitySettings />);
    expect(await screen.findByText(member.frontId!)).toBeVisible();
    expect(screen.getByText(member.dialpadId!)).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    await edit();
    expect(screen.getByRole("dialog", { name: "Connections for Jake Greasley" })).toBeVisible();
    expect(frontInput()).toHaveValue(member.frontId);
    expect(dialpadInput()).toHaveValue(member.dialpadId);
    expect(screen.getByRole("button", { name: "Save connections" })).toBeDisabled();
  });
  it("does not save on blur and discards cancelled edits", async () => {
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "tea_changed" } }); fireEvent.blur(frontInput());
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await edit(); expect(frontInput()).toHaveValue(member.frontId);
    fireEvent.change(dialpadInput(), { target: { value: "123456789" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
  });
  it("checks provider formats, keeps IDs as strings, and preserves role eligibility when saving", async () => {
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "not-a-front-id" } });
    fireEvent.change(dialpadInput(), { target: { value: "123-456" } });
    expect(frontInput()).toHaveAttribute("aria-invalid", "true"); expect(dialpadInput()).toHaveAttribute("aria-invalid", "true");
    fireEvent.submit(screen.getByRole("form", { name: "Connections for Jake Greasley" }));
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
    fireEvent.change(frontInput(), { target: { value: " tea_new123 " } });
    fireEvent.change(dialpadInput(), { target: { value: " 5655281245659136 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { userId: "jake", version: 3, frontId: "tea_new123", dialpadId: member.dialpadId, frontChannelId: "", frontSignatureId: "" }, true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("tea_new123")).toBeVisible();
    expect(receiveLeadsInput()).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /champion/i })).not.toBeInTheDocument();
    fireEvent.click(receiveLeadsInput());
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { userId: "jake", version: 4, receiveNewLeads: false }, true));
    await waitFor(() => expect(receiveLeadsInput()).not.toBeChecked());
    expect(screen.getByText("tea_new123")).toBeVisible();
  });
  it("validates optional Front email selections and preserves them when eligibility changes", async () => {
    render(<LeadEligibilitySettings />); await edit();
    expect(screen.getByText(/Leave blank to use the salesperson’s only mailbox/)).toBeVisible();
    fireEvent.change(channelInput(), { target: { value: "tea_wrong" } });
    fireEvent.change(signatureInput(), { target: { value: "wrong-signature" } });
    expect(channelInput()).toHaveAttribute("aria-invalid", "true");
    expect(signatureInput()).toHaveAttribute("aria-invalid", "true");
    fireEvent.submit(screen.getByRole("form", { name: "Connections for Jake Greasley" }));
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
    fireEvent.change(channelInput(), { target: { value: " cha_jake123 " } });
    fireEvent.change(signatureInput(), { target: { value: " sig_jake123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    const selections = { frontChannelId: "cha_jake123", frontSignatureId: "sig_jake123" };
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { userId: "jake", version: 3, frontId: member.frontId, dialpadId: member.dialpadId, ...selections }, true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Email: Custom Front selections")).toBeVisible();
    fireEvent.click(receiveLeadsInput());
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { userId: "jake", version: 4, receiveNewLeads: false }, true));
    await waitFor(() => expect(receiveLeadsInput()).not.toBeChecked());
    expect(screen.getByText("Email: Custom Front selections")).toBeVisible();
  });
  it("clears previous email selections when changing the Front teammate", async () => {
    mockRoster({ ...member, frontChannelId: "cha_old", frontSignatureId: "sig_old" });
    render(<LeadEligibilitySettings />); await edit();
    expect(channelInput()).toHaveValue("cha_old"); expect(signatureInput()).toHaveValue("sig_old");
    fireEvent.change(frontInput(), { target: { value: "tea_new" } });
    expect(channelInput()).toHaveValue(""); expect(signatureInput()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { userId: "jake", version: 3, frontId: "tea_new", dialpadId: member.dialpadId, frontChannelId: "", frontSignatureId: "" }, true));
  });
  it("sends explicit empty strings when clearing email overrides", async () => {
    mockRoster({ ...member, frontChannelId: "cha_old", frontSignatureId: "sig_old" });
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(channelInput(), { target: { value: "" } });
    fireEvent.change(signatureInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { userId: "jake", version: 3, frontId: member.frontId, dialpadId: member.dialpadId, frontChannelId: "", frontSignatureId: "" }, true));
  });
  it("keeps the draft visible after a failed save so it can be retried", async () => {
    let saves = 0;
    h.request.mockImplementation(async (op: string, input: EligibilityPatch) => {
      if (op === "team") return { team: [member] };
      if (++saves === 1) throw new Error("Could not save connections");
      return { member: { ...member, ...input, version: 4 } };
    });
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "tea_retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save connections");
    expect(frontInput()).toHaveValue("tea_retry");
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("tea_retry")).toBeVisible();
  });
  it("prevents repeated saves or dismissing a request while it is in progress", async () => {
    let finish!: (result: unknown) => void;
    h.request.mockImplementation((op: string) => op === "team" ? Promise.resolve({ team: [member] }) : new Promise(resolve => { finish = resolve; }));
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "tea_pending" } });
    const form = screen.getByRole("form", { name: "Connections for Jake Greasley" });
    fireEvent.submit(form); fireEvent.submit(form);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(frontInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(1);
    await act(async () => finish({ member: { ...member, frontId: "tea_pending", version: 4 } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});


it('does not start a background roster read over an open connection edit session', async () => {
  render(<LeadEligibilitySettings />); await edit();
  fireEvent.change(frontInput(), { target: { value: 'tea_draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roster' }));
  expect(h.request.mock.calls.filter(call => call[0] === 'team')).toHaveLength(1);
  expect(frontInput()).toHaveValue('tea_draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save connections' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByText('tea_draft')).toBeVisible();
});
