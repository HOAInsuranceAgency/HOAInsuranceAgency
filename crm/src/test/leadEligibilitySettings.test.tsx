import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ friendlyError: (error: Error) => error.message }));
import { LeadEligibilityCells, LeadEligibilityEditor, LeadEligibilityFeedback, useLeadEligibilitySettings } from "../components/LeadEligibilitySettings";
function LeadEligibilitySettings() {
  const settings = useLeadEligibilitySettings();
  return <><button onClick={settings.refresh}>Refresh roster</button><LeadEligibilityFeedback settings={settings} /><table><tbody>{settings.resource.data.team.map(member => <tr key={member.userId}><td>{member.name}</td><LeadEligibilityCells member={member} settings={settings} /></tr>)}</tbody></table><LeadEligibilityEditor settings={settings} /></>;
}
import type { TeamEligibility } from "../lib/communications";
const member: TeamEligibility = { userId: "jake", name: "Jake Greasley", email: "jake@example.com", enabled: true, salesperson: true, frontId: "tea_ci3mi", dialpadId: "5655281245659136", version: 3 };
beforeEach(() => {
  vi.clearAllMocks();
  h.request.mockImplementation(async (op: string, input: TeamEligibility) => op === "team" ? { team: [{ ...member }] } : { member: { ...input, version: (input.version ?? 0) + 1 } });
});
async function edit() { fireEvent.click(await screen.findByRole("button", { name: "Edit connections for Jake Greasley" })); }
const frontInput = () => screen.getByRole("textbox", { name: /^Front teammate ID/ });
const dialpadInput = () => screen.getByRole("textbox", { name: /^Dialpad user ID/ });
const channelInput = () => screen.getByRole("textbox", { name: /^Email channel ID/ });
const signatureInput = () => screen.getByRole("textbox", { name: /^Email signature ID/ });

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
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { ...member, frontId: "tea_new123", frontChannelId: "", frontSignatureId: "" }, true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("tea_new123")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Salesperson eligibility for Jake Greasley" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /champion/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Salesperson eligibility for Jake Greasley" }));
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { ...member, frontId: "tea_new123", frontChannelId: "", frontSignatureId: "", salesperson: false, version: 4 }, true));
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
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { ...member, ...selections }, true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Email: Custom Front selections")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Salesperson eligibility for Jake Greasley" }));
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { ...member, ...selections, salesperson: false, version: 4 }, true));
  });
  it("clears previous email selections when changing the Front teammate", async () => {
    h.request.mockImplementation(async (op: string, input: TeamEligibility) => op === "team" ? { team: [{ ...member, frontChannelId: "cha_old", frontSignatureId: "sig_old" }] } : { member: { ...input, version: 4 } });
    render(<LeadEligibilitySettings />); await edit();
    expect(channelInput()).toHaveValue("cha_old"); expect(signatureInput()).toHaveValue("sig_old");
    fireEvent.change(frontInput(), { target: { value: "tea_new" } });
    expect(channelInput()).toHaveValue(""); expect(signatureInput()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { ...member, frontId: "tea_new", frontChannelId: "", frontSignatureId: "" }, true));
  });
  it("sends explicit empty strings when clearing email overrides", async () => {
    h.request.mockImplementation(async (op: string, input: TeamEligibility) => op === "team" ? { team: [{ ...member, frontChannelId: "cha_old", frontSignatureId: "sig_old" }] } : { member: { ...input, version: 4 } });
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(channelInput(), { target: { value: "" } });
    fireEvent.change(signatureInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { ...member, frontChannelId: "", frontSignatureId: "" }, true));
  });
  it("keeps the draft visible after a failed save so it can be retried", async () => {
    let saves = 0;
    h.request.mockImplementation(async (op: string, input: TeamEligibility) => {
      if (op === "team") return { team: [member] };
      if (++saves === 1) throw new Error("Could not save connections");
      return { member: { ...input, version: 4 } };
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
