import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), list: vi.fn(), draft: vi.fn(), listener: undefined as undefined | ((context: unknown) => void) }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ client: { models: { Account: { list: h.list } } }, fmtDateTime: (v: string) => v }));
vi.mock("@frontapp/plugin-sdk", () => ({ default: { contextUpdates: { subscribe: (fn: (context: unknown) => void) => { h.listener = fn; return { unsubscribe: vi.fn() }; } }, createDraft: h.draft, openUrl: vi.fn() } }));
import FrontSidebar from "../pages/FrontSidebar";
import { ResponsibilitySelect } from "../components/LeadWorkflowPanel";
import { CallOutcome } from "../components/CommunicationReview";
import CommunicationSettings from "../components/CommunicationSettings";
const context = { workflow: null, tasks: [], communications: [], team: [], issues: [] };
beforeEach(() => { vi.clearAllMocks(); h.request.mockResolvedValue(context); });
describe("communication UI boundaries", () => {
  it("preserves saved cleanup when revalidating and resuming the integration", async () => {
    const config = { environment: "main", version: 1, activatedAt: "2026-09-08T14:00:00Z", cleanupEnabled: true, frontSender: "sales@protectmyhoa.com", allowedInboxIds: [], dialpadNumbers: [], holidays: [], testRecipients: [] };
    h.request.mockImplementation(async (op: string) => op === "settings" || op === "activate" ? { config, credentialStatus: {} } : { team: [] });
    render(<CommunicationSettings />);
    const cleanup = await screen.findByLabelText(/Enable automatic cleanup/); expect(cleanup).toBeChecked();
    fireEvent.click(screen.getByLabelText(/I verified the individual lines/)); fireEvent.click(screen.getByRole("button", { name: "Revalidate and resume" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("activate", { nativeChecksConfirmed: true, cleanupEnabled: true }, true));
  });
  it("provides admin recovery controls with the current provider cursor version", async () => {
    const config = { environment: "staging", version: 1, activatedAt: "2026-09-08T14:00Z", frontSender: "test@example.com", allowedInboxIds: [], dialpadNumbers: [], holidays: [], testRecipients: [] };
    h.request.mockImplementation(async op => op === "settings" ? { config, credentialStatus: {}, recovery: { dialpad: { version: 7 } } } : op === "team" ? { team: [] } : { ok: true });
    render(<CommunicationSettings />); await screen.findByLabelText("Recovery reason");
    fireEvent.change(screen.getByLabelText("Recovery reason"), { target: { value: "Expired pagination" } });
    fireEvent.click(screen.getByRole("button", { name: "Restart Dialpad history search" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("restartReconciliation", { provider: "dialpad", version: 7, reason: "Expired pagination" }, true));
    await waitFor(() => expect(screen.getByLabelText("Front conversation ID")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Front conversation ID"), { target: { value: "cnv_test" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry conversation history" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Retry conversation history" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("restartConversationHistory", { conversationId: "cnv_test", reason: "Expired pagination" }, true));
  });
  it("filters assignment choices without treating eligibility as an access permission", () => {
    render(<ResponsibilitySelect label="Salesperson" value="" kind="salesperson" team={[
      { userId: "b", name: "Brian Cole", email: "b@e.com", enabled: true, salesperson: true, champion: true },
      { userId: "c", name: "Carrier specialist", email: "c@e.com", enabled: true, salesperson: false, champion: true },
    ]} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Brian Cole" })).toBeTruthy(); expect(screen.queryByRole("option", { name: "Carrier specialist" })).toBeNull();
  });
  it("discards a lead search result after the selected Front conversation changes", async () => {
    let resolve!: (value: unknown) => void; h.list.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    fireEvent.change(screen.getByLabelText("Association or client name"), { target: { value: "Willow" } }); fireEvent.click(screen.getByRole("button", { name: "Search CRM" }));
    act(() => h.listener?.({ conversation: { id: "cnv_b" } }));
    await act(async () => resolve({ data: [{ id: "a", name: "Wrong old search result" }] }));
    expect(screen.queryByRole("button", { name: "Wrong old search result" })).toBeNull();
  });
  it("does not create a text draft if Front context changes while setup is loading", async () => {
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation((op: string) => op === "smsComposer" ? new Promise(r => { resolve = r; }) : Promise.resolve(context));
    render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    fireEvent.change(screen.getByLabelText("Prospect number"), { target: { value: "+16175550123" } }); fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello" } }); fireEvent.click(screen.getByRole("button", { name: "Open draft in Front" }));
    act(() => h.listener?.({ conversation: { id: "cnv_b" } }));
    await act(async () => resolve({ channelId: "cha_sms", sender: "+15082332261" })); expect(h.draft).not.toHaveBeenCalled();
  });
  it("resets the conversation purpose only when the selected conversation changes", async () => {
    render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    fireEvent.change(screen.getByLabelText("Conversation purpose"), { target: { value: "CARRIER" } });
    act(() => h.listener?.({ conversation: { id: "cnv_a" } })); expect(screen.getByLabelText("Conversation purpose")).toHaveValue("CARRIER");
    act(() => h.listener?.({ conversation: { id: "cnv_b" } })); expect(screen.getByLabelText("Conversation purpose")).toHaveValue("PROSPECT");
  });
  it("shows a loading explanation while settings are pending", () => {
    h.request.mockReturnValue(new Promise(() => {})); render(<CommunicationSettings />);
    expect(screen.getByText("Loading settings…")).toBeTruthy();
  });
  it("records an unanswered attempt without completing an inbound request", async () => {
    h.request.mockResolvedValue({ ok: true });
    render(<CallOutcome communication={{ id: "c", accountId: "a", channel: "CALL", provider: "dialpad", providerId: "1", direction: "OUTBOUND", status: "MISSED", at: "2026-09-08T14:00Z", version: 3 }} tasks={[]} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "NO_ANSWER" } }); fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Left a voicemail" } }); fireEvent.click(screen.getByRole("button", { name: "Save call outcome" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("recordCallOutcome", expect.objectContaining({ outcome: "NO_ANSWER", taskId: undefined, nextAction: undefined }), true));
  });
});
