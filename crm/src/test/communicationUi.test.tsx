import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), list: vi.fn(), draft: vi.fn(), listener: undefined as undefined | ((context: unknown) => void) }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", async importOriginal => ({ ...await importOriginal<typeof import("../lib/client")>(), client: { models: { Account: { list: h.list } } } }));
vi.mock("@frontapp/plugin-sdk", () => ({ default: { contextUpdates: { subscribe: (fn: (context: unknown) => void) => { h.listener = fn; return { unsubscribe: vi.fn() }; } }, createDraft: h.draft, openUrl: vi.fn() } }));
import FrontSidebar from "../pages/FrontSidebar";
import { ResponsibilitySelect } from "../components/LeadWorkflowPanel";
import { CallOutcome } from "../components/CommunicationReview";
import CommunicationSettings from "../components/CommunicationSettings";
const context = { workflow: null, tasks: [], communications: [], team: [], issues: [] };
function linkedLead() {
  const linked = { ...context, workflow: { accountId: "a", name: "Willow HOA", salespersonId: "jake", championId: "jake", version: 4, disposition: "ACTIVE", updatedAt: "2026-09-10T12:00:00Z", conversationId: "cnv_a" },
    team: ["jake", "brian"].map(userId => ({ userId, name: userId === "jake" ? "Jake Greasley" : "Brian Cole", email: `${userId}@example.com`, enabled: true, salesperson: true, champion: true })),
    tasks: [{ id: "task", accountId: "a", kind: "FOLLOW_UP", role: "SALESPERSON", title: "Follow up with prospect", status: "OPEN", dueAt: "2026-09-14T13:00:00Z", escalationAt: "2026-09-15T13:00:00Z", version: 2 }],
  };
  h.request.mockImplementation(async (op: string) => op === "context" ? linked : op === "accountSummary" ? { summary: { name: "Willow HOA", source: "website-ho6:willow-condominium", contacts: [{ id: "c", name: "Willow HOA", email: "jake@example.com", phone: "6178959530" }], quotes: [], documents: [], more: true, url: "https://staging.example.com/accounts/a" } } : op === "work" ? { items: [] } : { ok: true });
  return linked;
}
beforeEach(() => { vi.clearAllMocks(); h.request.mockResolvedValue(context); });
describe("communication UI boundaries", () => {
  it("shows readable lead details and requires an explicit team edit that can be cancelled", async () => {
    linkedLead(); render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    await screen.findByRole("heading", { name: "Willow HOA" });
    expect(screen.getByText("HO-6 association form")).toBeTruthy(); expect(screen.getByText("(617) 895-9530")).toBeTruthy();
    expect(screen.queryByText(/website-ho6:/)).toBeNull(); expect(screen.queryByText(/Documents \(0\+/)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Salesperson" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Front" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit team" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Salesperson" }), { target: { value: "brian" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Lead team" })).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit team" }));
    expect(screen.getByRole("combobox", { name: "Salesperson" })).toHaveValue("jake");
    expect(h.request.mock.calls.some(([op]) => op === "setResponsibilities")).toBe(false);
  });
  it("saves both chosen roles with the existing workflow version", async () => {
    linkedLead(); render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit team" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Deal champion" }), { target: { value: "brian" } });
    fireEvent.click(screen.getByRole("button", { name: "Save responsibilities" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("setResponsibilities", { accountId: "a", salespersonId: "jake", championId: "brian", version: 4 }, true));
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Deal champion" })).toBeNull());
  });
  it("keeps task edits explicit and preserves the date when the editor is cancelled", async () => {
    linkedLead(); render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit action" }));
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "Unfinished change" } });
    fireEvent.click(within(screen.getByRole("region", { name: "Next actions" })).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Follow up with prospect")).toBeTruthy();
    expect(h.request.mock.calls.some(([op]) => op === "saveTask")).toBe(false);
  });
  it("clears a team edit when Front switches to another conversation", async () => {
    linkedLead(); render(<FrontSidebar />); act(() => h.listener?.({ conversation: { id: "cnv_a" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit team" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Salesperson" }), { target: { value: "brian" } });
    act(() => h.listener?.({ conversation: { id: "cnv_b" } }));
    await screen.findByRole("button", { name: "Edit team" });
    expect(screen.queryByRole("combobox", { name: "Salesperson" })).toBeNull();
  });
  it("explains that staging CRM acceptance follows controlled activation", async () => {
    const config = { environment: "staging", paused: true, allowedInboxIds: [], dialpadNumbers: [], holidays: [], testRecipients: ["tester@example.com"] };
    h.request.mockImplementation(async op => op === "settings" ? { config, credentialStatus: {} } : { team: [] });
    render(<CommunicationSettings />);
    fireEvent.click(await screen.findByText("Delivery and inbox cleanup"));
    expect(screen.getByText(/Start delivery to test the automated email/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start delivery" })).toBeDisabled();
  });
  it("preserves saved cleanup when revalidating and resuming the integration", async () => {
    const config = { environment: "main", version: 1, activatedAt: "2026-09-08T14:00:00Z", paused: true, cleanupEnabled: true, frontSender: "sales@protectmyhoa.com", allowedInboxIds: [], dialpadNumbers: [], holidays: [], testRecipients: [] };
    h.request.mockImplementation(async (op: string) => op === "settings" || op === "activate" ? { config, credentialStatus: {} } : { team: [] });
    render(<CommunicationSettings />);
    fireEvent.click(await screen.findByText("Delivery and inbox cleanup"));
    const cleanup = screen.getByLabelText(/Automatically tidy/); expect(cleanup).toBeChecked();
    fireEvent.click(screen.getByLabelText(/I verified email, calls/)); fireEvent.click(screen.getByRole("button", { name: "Resume delivery" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("activate", { nativeChecksConfirmed: true, cleanupEnabled: true }, true));
  });
  it("provides admin recovery controls with the current provider cursor version", async () => {
    const config = { environment: "staging", version: 1, activatedAt: "2026-09-08T14:00Z", frontSender: "test@example.com", allowedInboxIds: [], dialpadNumbers: [], holidays: [], testRecipients: [] };
    h.request.mockImplementation(async op => op === "settings" ? { config, credentialStatus: {}, recovery: { dialpad: { version: 7 } } } : op === "team" ? { team: [] } : { ok: true });
    render(<CommunicationSettings />); fireEvent.click(await screen.findByText("Advanced tools")); await screen.findByLabelText("Recovery reason");
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
