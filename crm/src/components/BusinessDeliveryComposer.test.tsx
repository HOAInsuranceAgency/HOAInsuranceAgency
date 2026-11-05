import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invalidateLiveUpdates } from "../test/liveUpdates";
import type { BusinessDeliveryAttempt, BusinessDeliveryContext, BusinessDeliveryPreview, BusinessDeliverySelection } from "../../../shared/frontBusinessDelivery";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
import BusinessDeliveryComposer, { businessRecipients, recoveryFrontMessageId, safeFrontUrl } from "./BusinessDeliveryComposer";

const sender = { frontId: "tea_one", channelId: "cha_one", senderEmail: "producer@example.com", signatureId: "sig_one" };
const context: BusinessDeliveryContext = {
  accountId: "a1", accountName: "Harbor HOA", sender,
  choices: [{ kind: "PACKAGE", recordId: "option-one", label: "Complete coverage option" }, { kind: "CERTIFICATE", recordId: "cert-one", label: "Certificate for Bank" }, { kind: "DOCUMENT", recordId: "doc-one", label: "Generated ACORD.pdf" }],
  documents: [{ id: "doc-one", name: "Carrier terms.pdf", contentType: "application/pdf", size: 1200 }],
  conversations: [{ id: "cnv_client", label: "Client renewal · client@example.com" }],
  recipientSuggestions: [{ email: "client@example.com", label: "Client" }],
};
function preview(selection?: BusinessDeliverySelection): BusinessDeliveryPreview {
  return {
    id: "preview-one", previewId: "preview-one", previewHash: "frozen-hash", sender,
    selection: selection ?? { accountId: "a1", kind: "PACKAGE", recordId: "option-one", conversationId: "NEW", documentIds: [] },
    conversationId: selection?.conversationId ?? "NEW", conversationLabel: selection?.conversationId === "cnv_client" ? "Client renewal" : "New conversation — no quoted history",
    subject: "Harbor proposal", body: "<h2>Your proposal</h2><p>Review the attached terms.</p>", facts: ["Premium: $1,200"],
    quotes: [{ id: "q1", carrierName: "Example Carrier", lines: ["Property"], premium: 1200, effectiveDate: "2026-12-01", expirationDate: "2027-12-01", perOccurrenceDeductible: 5000 }],
    attachments: [{ id: "proposal", name: "Harbor proposal.pdf", contentType: "application/pdf", size: 5000, sha256: "abc" }],
    warnings: [], expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
}
function attempt(overrides: Partial<BusinessDeliveryAttempt> = {}): BusinessDeliveryAttempt {
  return { id: "attempt-one", requestId: "request-one", accountId: "a1", kind: "PACKAGE", recordId: "option-one", state: "DRAFT", from: sender.senderEmail, to: ["client@example.com"], cc: [], conversationId: "cnv_client", frontUrl: "https://app.frontapp.com/open/cnv_client", preparedAt: "2026-11-01T15:00:00Z", ...overrides };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.request.mockImplementation(async (op: string, input: Record<string, unknown>) => {
    if (op === "businessDeliveryContext") return { context: { ...context, accountId: input.accountId, accountName: input.accountId === "a2" ? "Other HOA" : context.accountName } };
    if (op === "historyBusinessDeliveries") return { items: [] };
    if (op === "previewBusinessDelivery") return { preview: preview(input as unknown as BusinessDeliverySelection) };
    if (op === "prepareBusinessDraft") return { attempt: attempt({ requestId: String(input.requestId), to: input.to as string[], cc: input.cc as string[] }) };
    if (op === "reconcileBusinessDraft") return { attempt: attempt({ state: "SENT", sentAt: "2026-11-01T15:01:00Z" }) };
    throw new Error(`Unexpected operation ${op}`);
  });
});
async function mount(props: Partial<Parameters<typeof BusinessDeliveryComposer>[0]> = {}) {
  const view = render(<BusinessDeliveryComposer accountId="a1" kind="PACKAGE" recordId="option-one" onClose={() => {}} {...props} />);
  await screen.findByText("Harbor HOA");
  return view;
}
async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review email preview" }));
  await screen.findByRole("region", { name: "Email preview" });
}
function recipients(to = "client@example.com", cc = "") {
  fireEvent.change(screen.getByLabelText("To"), { target: { value: to } });
  fireEvent.change(screen.getByLabelText("CC (optional)"), { target: { value: cc } });
}
function acknowledge() { fireEvent.click(screen.getByLabelText(/I checked the sender/)); }

it("offers a read-only Retry only when Front history fails to load", async () => {
  const base = h.request.getMockImplementation()!;
  let unavailable = true;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" && unavailable
    ? Promise.reject(new Error("Front history unavailable")) : base(op, input));
  await mount();
  const history = screen.getByRole("region", { name: "Front email history" });
  expect(await within(history).findByRole("alert")).toHaveTextContent("Front history unavailable");
  unavailable = false;
  fireEvent.click(within(history).getByRole("button", { name: "Retry" }));
  await within(history).findByText("No Front drafts recorded for this account.");
  expect(within(history).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(h.request.mock.calls.filter(([, , write]) => write)).toHaveLength(0);
});

it("requires explicit recipients and review, with one server API in standalone CRM", async () => {
  await mount();
  expect(within(screen.getByRole("region", { name: "Front email history" })).queryByRole("button", { name: /refresh|retry/i })).toBeNull();
  expect(screen.getByLabelText("To")).toHaveValue("");
  expect(screen.getByLabelText("Front conversation")).toHaveValue("NEW");
  await review();
  const prepare = screen.getByRole("button", { name: "Prepare Front draft" });
  expect(prepare).toBeDisabled();
  acknowledge(); fireEvent.click(prepare);
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least one To");
  recipients("holder@example.com", "client@example.com");
  expect(prepare).toBeDisabled();
  acknowledge(); fireEvent.click(prepare);
  await screen.findByRole("region", { name: "Prepared draft result" });
  expect(h.request).toHaveBeenCalledWith("prepareBusinessDraft", expect.objectContaining({ accountId: "a1", previewId: "preview-one", previewHash: "frozen-hash", to: ["holder@example.com"], cc: ["client@example.com"], conversationId: "NEW", requestId: expect.any(String) }), true);
  expect(screen.getByRole("link", { name: "Open in Front ↗" })).toHaveAttribute("href", "https://app.frontapp.com/open/cnv_client");
  expect(h.request.mock.calls.some(([op]) => ["authorizeBind", "saveCommercial"].includes(op))).toBe(false);
});

it("previews a reviewed package plus selected account PDFs, and invalidates changed selections", async () => {
  await mount({ conversationId: "cnv_client" });
  fireEvent.click(screen.getByLabelText(/Carrier terms.pdf/));
  await review();
  expect(h.request).toHaveBeenCalledWith("previewBusinessDelivery", { accountId: "a1", kind: "PACKAGE", recordId: "option-one", conversationId: "cnv_client", documentIds: ["doc-one"] }, true);
  expect(screen.getByRole("region", { name: "Email preview" })).toHaveTextContent("$5,000");
  fireEvent.change(screen.getByLabelText("Front conversation"), { target: { value: "NEW" } });
  expect(screen.queryByRole("region", { name: "Email preview" })).toBeNull();
});

it("keeps general business files out of the package carrier PDF checklist", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "businessDeliveryContext" ? Promise.resolve({ context: { ...context, documents: [...context.documents, { id: "photo", name: "Property photo.jpg", contentType: "image/jpeg" }, { id: "sheet", name: "Schedule.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, { id: "private", name: "Finance agreement.pdf", contentType: "application/pdf", category: "PF_AGREEMENT" }] } }) : base(op, input));
  await mount();
  const checklist = screen.getByRole("group", { name: "Carrier PDFs to include" });
  expect(within(checklist).getAllByRole("checkbox")).toHaveLength(1);
  expect(checklist).not.toHaveTextContent("Property photo.jpg");
  expect(checklist).not.toHaveTextContent("Schedule.xlsx");
  expect(checklist).not.toHaveTextContent("Finance agreement.pdf");
});

it("prepares against the canonical conversation returned by the reviewed preview", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "previewBusinessDelivery" ? Promise.resolve({ preview: { ...preview(), conversationId: "cnv_canonical", conversationLabel: "Merged client conversation" } }) : base(op, input));
  await mount({ conversationId: "cnv_client" }); recipients(); await review(); acknowledge();
  expect(screen.getByRole("region", { name: "Email preview" })).toHaveTextContent("Merged client conversation");
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  await screen.findByRole("region", { name: "Prepared draft result" });
  expect(h.request).toHaveBeenCalledWith("prepareBusinessDraft", expect.objectContaining({ conversationId: "cnv_canonical" }), true);
});

it("explains explicit certificate holder/requester recipients and client CC", async () => {
  await mount({ kind: "CERTIFICATE", recordId: "cert-one" });
  expect(screen.getByText(/Choose the certificate holder or requester for To/)).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Carrier PDFs to include" })).toBeNull();
  expect(screen.getByLabelText("To")).toHaveValue("");
  expect(screen.getByLabelText("CC (optional)")).toHaveValue("");
});

it("does not switch a stale record or missing conversation to another target", async () => {
  await mount({ recordId: "gone", conversationId: "cnv_gone" });
  expect(screen.getByRole("button", { name: "Review email preview" })).toBeDisabled();
  expect(screen.getByLabelText("What to send")).toHaveValue("PACKAGE:gone");
  expect(screen.getByLabelText("Front conversation")).toHaveValue("cnv_gone");
  expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
});

it("blocks preparation when the preparing teammate's personal mailbox is unavailable", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "businessDeliveryContext" ? Promise.resolve({ context: { ...context, sender: undefined, senderError: "Connect your personal Front mailbox" } }) : base(op, input));
  await mount();
  expect(screen.getByRole("alert")).toHaveTextContent("Connect your personal Front mailbox");
  expect(screen.getByRole("button", { name: "Review email preview" })).toBeDisabled();
});

it("renders the public body as text and never injects provider HTML", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "previewBusinessDelivery" ? Promise.resolve({ preview: { ...preview(), body: '<img src="x" onerror="alert(1)"><p>Safe customer text</p>', commissionPct: 99, internalNotes: "Private commission memo" } }) : base(op, input));
  await mount(); await review();
  const region = screen.getByRole("region", { name: "Email preview" });
  expect(region).toHaveTextContent("Safe customer text");
  expect(region.querySelector("img")).toBeNull();
  expect(region).not.toHaveTextContent("Private commission memo");
});

it("holds expired previews until refreshed", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "previewBusinessDelivery" ? Promise.resolve({ preview: { ...preview(), expiresAt: "2020-01-01T00:00:00Z" } }) : base(op, input));
  await mount(); await review();
  expect(screen.getByRole("alert")).toHaveTextContent("preview has expired");
  expect(screen.getByLabelText(/I checked the sender/)).toBeDisabled();
  expect(screen.getByRole("button", { name: "Prepare Front draft" })).toBeDisabled();
});

it("does not create duplicate drafts for rapid repeated clicks", async () => {
  const base = h.request.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === "prepareBusinessDraft" ? new Promise(resolve => { finish = resolve; }) : base(op, input));
  await mount(); recipients(); await review(); acknowledge();
  const button = screen.getByRole("button", { name: "Prepare Front draft" });
  fireEvent.click(button); fireEvent.click(button);
  expect(h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft")).toHaveLength(1);
  await act(async () => finish({ attempt: attempt() }));
  expect(await screen.findByRole("region", { name: "Prepared draft result" })).toHaveTextContent("Prepared");
});

it("retains the exact request and recipients after an uncertain create response", async () => {
  const base = h.request.getMockImplementation()!;
  let tried = false;
  h.request.mockImplementation((op, input) => {
    if (op === "prepareBusinessDraft" && !tried) { tried = true; return Promise.reject(new Error("Network response lost")); }
    return base(op, input);
  });
  await mount(); recipients("holder@example.com", "client@example.com"); await review(); acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  await screen.findByRole("region", { name: "Unconfirmed draft" });
  expect(screen.getByLabelText("To")).toBeDisabled();
  const unconfirmed = screen.getByRole("region", { name: "Unconfirmed draft" });
  const reads = h.request.mock.calls.filter(([op]) => op === "historyBusinessDeliveries").length;
  fireEvent.click(within(unconfirmed).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(h.request.mock.calls.filter(([op]) => op === "historyBusinessDeliveries")).toHaveLength(reads + 1));
  await invalidateLiveUpdates(['CRM']);
  expect(h.request.mock.calls.filter(([op]) => op === "historyBusinessDeliveries")).toHaveLength(reads + 2);
  expect(screen.getByLabelText("To")).toHaveValue("holder@example.com");
  expect(screen.getByLabelText("CC (optional)")).toHaveValue("client@example.com");
  expect(screen.getByLabelText("To")).toBeDisabled();
  expect(h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry same draft request" }));
  await screen.findByRole("region", { name: "Prepared draft result" });
  const calls = h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft");
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual(calls[0][1]);
});

it("unlocks a fresh preview only for an explicit pre-dispatch rejection", async () => {
  const base = h.request.getMockImplementation()!;
  let tried = false;
  h.request.mockImplementation((op, input) => {
    if (op === "prepareBusinessDraft" && !tried) { tried = true; return Promise.reject(Object.assign(new Error("The quote changed. Review a new preview"), { code: "BUSINESS_DRAFT_NOT_DISPATCHED", origin: 'application' })); }
    return base(op, input);
  });
  await mount(); recipients(); await review(); acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("quote changed");
  expect(screen.queryByRole("region", { name: "Unconfirmed draft" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Email preview" })).toBeNull();
  expect(screen.getByLabelText("To")).toBeEnabled();
  expect(screen.getByLabelText("To")).toHaveValue("client@example.com");
  await review(); acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  await screen.findByRole("region", { name: "Prepared draft result" });
  const calls = h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft");
  expect(calls[1][1].requestId).not.toBe(calls[0][1].requestId);
});

it("does not unlock a rejected idempotency-key conflict as editable validation", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "prepareBusinessDraft" ? Promise.reject(Object.assign(new Error("This request ID already belongs to another payload"), { code: "BUSINESS_DRAFT_CONFLICT" })) : base(op, input));
  await mount(); recipients(); await review(); acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  await screen.findByRole("region", { name: "Unconfirmed draft" });
  expect(screen.getByLabelText("To")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry same draft request" })).toBeEnabled();
});

it("blocks a new attempt for an item with an unresolved existing draft", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve({ items: [attempt({ state: "UNKNOWN" })] }) : base(op, input));
  await mount(); recipients(); await review(); acknowledge();
  expect(screen.getByRole("button", { name: "Prepare Front draft" })).toBeDisabled();
  expect(screen.getByText(/An earlier draft for this item needs review/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check Front status" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Prepare Front draft" })).toBeEnabled());
  expect(screen.getByRole("region", { name: "Front email history" })).toHaveTextContent("Sent via Front. This does not confirm receipt or reading.");
});

it("recovers an UNKNOWN new-conversation attempt by verifying a normalized exact message ID", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => {
    if (op === "historyBusinessDeliveries") return Promise.resolve({ items: [attempt({ state: "UNKNOWN", conversationId: "NEW", frontUrl: undefined, reference: "HOA-123456ABCDEF" })] });
    if (op === "reconcileBusinessDraft") return Promise.resolve({ attempt: attempt({ state: "DRAFT", frontDraftId: "msg_recovered" }) });
    return base(op, input);
  });
  await mount(); recipients(); await review(); acknowledge();
  expect(screen.getByRole("button", { name: "Prepare Front draft" })).toBeDisabled();
  const recovery = screen.getByRole("form", { name: "Recover unconfirmed Front draft" });
  expect(recovery).toHaveTextContent("does not create or send another draft");
  expect(recovery).toHaveTextContent("Search Front for the email reference shown above");
  expect(screen.getByText("HOA-123456ABCDEF")).toBeVisible();
  fireEvent.change(within(recovery).getByLabelText("Front draft/message ID or message link"), { target: { value: " https://app.frontapp.com/open/msg_recovered " } });
  fireEvent.submit(recovery);
  const result = await screen.findByRole("region", { name: "Prepared draft result" });
  expect(result).toHaveTextContent("Prepared");
  expect(h.request).toHaveBeenCalledWith("reconcileBusinessDraft", { accountId: "a1", attemptId: "attempt-one", recoveryMessageId: "msg_recovered" }, true);
  expect(h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft")).toHaveLength(0);
  const dialog = within(screen.getByRole("dialog", { name: "Prepare email in Front" }));
  expect(dialog.queryAllByLabelText("To")).toHaveLength(0);
  expect(dialog.queryByRole("button", { name: "Prepare Front draft" })).toBeNull();
  expect(within(result).getByRole("link", { name: "Open in Front ↗" })).toBeInTheDocument();
});

it.each(["PREPARING", "UNKNOWN"] as const)("recovers a sent reply after its draft response was lost (%s)", async state => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => {
    if (op === "historyBusinessDeliveries") return Promise.resolve({ items: [attempt({ state, conversationId: "cnv_client", frontDraftId: undefined, reference: "HOA-123456ABCDEF" })] });
    if (op === "reconcileBusinessDraft") return Promise.resolve({ attempt: attempt({ state: "SENT", frontDraftId: "msg_sentreply", messageUrl: "https://app.frontapp.com/open/msg_sentreply", sentAt: "2026-11-01T15:01:00Z" }) });
    return base(op, input);
  });
  await mount({ conversationId: "cnv_client" }); recipients(); await review(); acknowledge();
  expect(screen.getByRole("button", { name: "Prepare Front draft" })).toBeDisabled();
  const recovery = screen.getByRole("form", { name: "Recover unconfirmed Front draft" });
  expect(recovery).toHaveTextContent("exact draft or sent message");
  fireEvent.change(within(recovery).getByLabelText("Front draft/message ID or message link"), { target: { value: " https://app.frontapp.com/open/msg_sentreply " } });
  fireEvent.submit(recovery);
  const result = await screen.findByRole("region", { name: "Prepared draft result" });
  expect(result).toHaveTextContent("Sent via Front. This does not confirm receipt or reading.");
  expect(h.request).toHaveBeenCalledWith("reconcileBusinessDraft", { accountId: "a1", attemptId: "attempt-one", recoveryMessageId: "msg_sentreply" }, true);
  expect(within(result).getByRole("link", { name: "Open in Front ↗" })).toHaveAttribute("href", "https://app.frontapp.com/open/msg_sentreply");
  expect(h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft")).toHaveLength(0);
  expect(screen.queryByRole("form", { name: "Recover unconfirmed Front draft" })).toBeNull();
});

it.each(["PREPARING", "UNKNOWN"] as const)("does not offer replacement-ID recovery for a known %s draft", async state => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve({ items: [attempt({ state, conversationId: "NEW", frontDraftId: "msg_known" })] }) : base(op, input));
  await mount();
  expect(screen.queryByRole("form", { name: "Recover unconfirmed Front draft" })).toBeNull();
  expect(screen.getByRole("button", { name: "Check Front status" })).toBeEnabled();
  expect(h.request.mock.calls.filter(([op]) => ["prepareBusinessDraft", "reconcileBusinessDraft"].includes(op))).toHaveLength(0);
});

it.each(["DRAFT", "SENT", "FAILED"] as const)("does not expose missing-ID recovery for a resolved %s attempt", async state => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve({ items: [attempt({ state, frontDraftId: undefined })] }) : base(op, input));
  await mount(); expect(screen.queryByRole("form", { name: "Recover unconfirmed Front draft" })).toBeNull();
});

it.each(["NEW", "cnv_client"])("rejects conversation-only recovery links and keeps a mismatched %s attempt locked", async conversationId => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => {
    if (op === "historyBusinessDeliveries") return Promise.resolve({ items: [attempt({ state: "UNKNOWN", conversationId, frontUrl: undefined })] });
    if (op === "reconcileBusinessDraft") return Promise.reject(new Error("The Front message does not match this draft attempt"));
    return base(op, input);
  });
  await mount(); recipients(); await review(); acknowledge();
  const recovery = screen.getByRole("form", { name: "Recover unconfirmed Front draft" });
  const input = within(recovery).getByLabelText("Front draft/message ID or message link");
  fireEvent.change(input, { target: { value: "https://app.frontapp.com/open/cnv_client" } });
  fireEvent.submit(recovery);
  expect(within(recovery).getByRole("alert")).toHaveTextContent("conversation link alone");
  expect(h.request.mock.calls.filter(([op]) => op === "reconcileBusinessDraft")).toHaveLength(0);
  fireEvent.change(input, { target: { value: "msg_wrong" } }); fireEvent.submit(recovery);
  expect(await screen.findByRole("alert")).toHaveTextContent("does not match");
  expect(screen.getByRole("button", { name: "Prepare Front draft" })).toBeDisabled();
  expect(input).toHaveValue("msg_wrong");
  expect(h.request.mock.calls.filter(([op]) => op === "prepareBusinessDraft")).toHaveLength(0);
});

it("drops a late preview after account navigation", async () => {
  const base = h.request.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  h.request.mockImplementation((op, input) => op === "previewBusinessDelivery" ? new Promise(resolve => { finish = resolve; }) : base(op, input));
  const view = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Review email preview" }));
  view.rerender(<BusinessDeliveryComposer accountId="a2" kind="PACKAGE" recordId="option-one" onClose={() => {}} />);
  await screen.findByText("Other HOA");
  await act(async () => finish({ preview: preview() }));
  expect(screen.queryByRole("region", { name: "Email preview" })).toBeNull();
  expect(screen.getByLabelText("To")).toHaveValue("");
});

it("clears preview, recipients and history after authorization is lost", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "prepareBusinessDraft" ? Promise.reject(Object.assign(new Error("Access denied"), { name: "Unauthorized" })) : base(op, input));
  await mount(); recipients(); await review(); acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  await waitFor(() => expect(screen.queryByText("Harbor HOA")).toBeNull());
  expect(screen.queryByLabelText("To")).toBeNull();
  expect(screen.queryByRole("region", { name: "Email preview" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry same draft request" })).toBeNull();
});

it("shows failure alongside sent history and rejects unsafe Front links", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve({ items: [attempt({ state: "SENT", frontUrl: "https://evil.example/open/cnv_a", failure: "Recipient mailbox rejected the message" })] }) : base(op, input));
  await mount();
  const region = screen.getByRole("region", { name: "Front email history" });
  expect(region).toHaveTextContent("Recipient mailbox rejected the message");
  expect(within(region).queryByRole("link")).toBeNull();
  expect(region).not.toHaveTextContent("Delivered");
});

it("qualifies original recipients and quote status for a message sent with changes", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve({ items: [attempt({ state: "SENT", sentWithChanges: true, cc: ["treasurer@example.com"] })] }) : base(op, input));
  await mount();
  const history = screen.getByRole("region", { name: "Front email history" });
  expect(await within(history).findByText("Sent with changes", { exact: true })).toBeInTheDocument();
  expect(history).toHaveTextContent("Originally prepared for To: client@example.com");
  expect(history).toHaveTextContent("Originally prepared CC: treasurer@example.com");
  expect(history).toHaveTextContent("Open Front to verify the actual recipients, message and attachments");
  expect(history).toHaveTextContent("this send did not mark current quotes as presented");
  expect(within(history).queryByText(/^From .* · To /)).toBeNull();
  expect(within(history).getByRole("link", { name: "Open in Front ↗" })).toBeInTheDocument();
});

it("upgrades an active Sent result to Sent with changes without losing verified evidence to stale rows", async () => {
  const base = h.request.getMockImplementation()!;
  let rows: BusinessDeliveryAttempt[] = [];
  h.request.mockImplementation((op, input) => {
    if (op === "historyBusinessDeliveries") return Promise.resolve({ items: rows });
    if (op === "reconcileBusinessDraft") return Promise.resolve({ attempt: attempt({ state: "SENT", sentWithChanges: false, frontUrl: undefined, messageUrl: undefined, sentAt: undefined }) });
    return base(op, input);
  });
  await mount(); recipients(); await review(); acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  const result = await screen.findByRole("region", { name: "Prepared draft result" });
  const refresh = () => invalidateLiveUpdates(['CRM']);
  rows = [attempt({ state: "SENT", sentAt: "2026-11-01T15:01:00Z" })]; await refresh();
  expect(await within(result).findByText("Sent", { exact: true })).toBeInTheDocument();
  rows = [attempt({ state: "SENT", sentWithChanges: true, sentAt: "2026-11-01T15:01:00Z", messageUrl: "https://app.frontapp.com/open/msg_actual" })]; await refresh();
  expect(await within(result).findByText("Sent with changes", { exact: true })).toBeInTheDocument();
  rows = [attempt({ state: "SENT", sentWithChanges: false, frontUrl: undefined, messageUrl: undefined, sentAt: undefined })]; await refresh();
  expect(within(result).getByText("Sent with changes", { exact: true })).toBeInTheDocument();
  expect(within(result).getByRole("link", { name: "Open in Front ↗" })).toHaveAttribute("href", "https://app.frontapp.com/open/msg_actual");
  expect(result).toHaveTextContent("Originally prepared for To: client@example.com");
  fireEvent.click(within(result).getByRole("button", { name: "Check Front status" })); await act(async () => {});
  expect(within(result).getByText("Sent with changes", { exact: true })).toBeInTheDocument();
  expect(within(result).getByRole("link", { name: "Open in Front ↗" })).toHaveAttribute("href", "https://app.frontapp.com/open/msg_actual");
  expect(screen.getByRole("button", { name: "Prepare another email" })).toBeEnabled();
  rows = [attempt({ state: "FAILED", sentWithChanges: true, failure: "Front reported a delivery failure" })]; await refresh();
  expect(await within(result).findByText("Failed", { exact: true })).toBeInTheDocument();
  expect(result).toHaveTextContent("Originally prepared for To: client@example.com");
  expect(result).toHaveTextContent("actual recipients, message and attachments");
  rows = [attempt({ state: "SENT", sentWithChanges: false })]; await refresh();
  expect(within(result).getByText("Failed", { exact: true })).toBeInTheDocument();
  expect(result).toHaveTextContent("Front reported a delivery failure");
}, 10_000);

it("keeps trusted sent-with-changes responses qualified through stale passive history refreshes", async () => {
  const base = h.request.getMockImplementation()!;
  let rows = [attempt({ state: "SENT", sentWithChanges: false })];
  h.request.mockImplementation((op, input) => {
    if (op === "historyBusinessDeliveries") return Promise.resolve({ items: rows });
    if (op === "reconcileBusinessDraft") return Promise.resolve({ attempt: attempt({ state: "SENT", sentWithChanges: true, messageUrl: "https://app.frontapp.com/open/msg_verified" }) });
    return base(op, input);
  });
  await mount();
  const history = screen.getByRole("region", { name: "Front email history" });
  fireEvent.click(await within(history).findByRole("button", { name: "Check Front status" }));
  expect(await within(history).findByText("Sent with changes", { exact: true })).toBeInTheDocument();
  rows = [attempt({ state: "DRAFT", sentWithChanges: false, frontUrl: undefined })];
  await invalidateLiveUpdates(['CRM']);
  expect(within(history).getByText("Sent with changes", { exact: true })).toBeInTheDocument();
  expect(history).toHaveTextContent("Originally prepared for To: client@example.com");
  expect(within(history).getByRole("link", { name: "Open in Front ↗" })).toHaveAttribute("href", "https://app.frontapp.com/open/msg_verified");
});

it("refreshes the active prepared result to Sent/Failed without stale history downgrades", async () => {
  const base = h.request.getMockImplementation()!;
  let rows: BusinessDeliveryAttempt[] = [];
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve({ items: rows }) : base(op, input));
  await mount(); recipients(); await review(); acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
  const result = await screen.findByRole("region", { name: "Prepared draft result" });
  expect(within(result).getByText("Prepared", { exact: true })).toBeInTheDocument();
  const refresh = () => invalidateLiveUpdates(['CRM']);
  rows = [attempt({ state: "SENT", sentAt: "2026-11-01T15:01:00Z" })];
  await refresh();
  expect(await within(result).findByText("Sent", { exact: true })).toBeInTheDocument();
  rows = [attempt({ state: "DRAFT" })]; await refresh();
  expect(within(result).getByText("Sent", { exact: true })).toBeInTheDocument();
  expect(within(result).queryByText("Prepared", { exact: true })).toBeNull();
  rows = [attempt({ state: "FAILED", failure: "Front reported a delivery failure" })]; await refresh();
  expect(await within(result).findByText("Failed", { exact: true })).toBeInTheDocument();
  expect(result).toHaveTextContent("Front reported a delivery failure");
  rows = [attempt({ state: "SENT" })]; await refresh();
  expect(within(result).getByText("Failed", { exact: true })).toBeInTheDocument();
}, 10_000);

it.each(["preview", "prepared"])("clears all cached account details on history authorization denial while showing %s", async phase => {
  const base = h.request.getMockImplementation()!;
  let denied = false;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" && denied ? Promise.reject(Object.assign(new Error("The requested operation failed"), { name: "Unauthorized" })) : base(op, input));
  await mount(); recipients(); await review();
  if (phase === "prepared") {
    acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Prepare Front draft" }));
    await screen.findByRole("region", { name: "Prepared draft result" });
  }
  denied = true;
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByText("Harbor HOA")).toBeNull());
  expect(screen.queryByRole("region", { name: "Email preview" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Prepared draft result" })).toBeNull();
  expect(screen.queryByLabelText("To")).toBeNull();
  expect(screen.queryByText("client@example.com")).toBeNull();
});

it("loads older history without hiding the already loaded attempts", async () => {
  const base = h.request.getMockImplementation()!;
  h.request.mockImplementation((op, input) => op === "historyBusinessDeliveries" ? Promise.resolve(input.nextToken ? { items: [attempt({ id: "older", recordId: "older-doc", kind: "DOCUMENT", state: "FAILED", failure: "Older preparation failed" })] } : { items: [attempt()], nextToken: "page-two" }) : base(op, input));
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Load older drafts" }));
  await screen.findByText("Older preparation failed");
  expect(screen.getByRole("region", { name: "Front email history" })).toHaveTextContent("Prepared");
  expect(h.request).toHaveBeenCalledWith("historyBusinessDeliveries", { accountId: "a1", nextToken: "page-two" });
});

it("validates recipient limits, duplicates and Front URLs", () => {
  expect(businessRecipients("a@example.com; b@example.com", " c@example.com ")).toEqual({ to: ["a@example.com", "b@example.com"], cc: ["c@example.com"] });
  expect(() => businessRecipients("a@example.com", "A@example.com")).toThrow(/only once/);
  expect(() => businessRecipients("Alice <a@example.com>", "")).toThrow(/display names/);
  expect(() => businessRecipients(Array.from({ length: 21 }, (_, n) => `a${n}@example.com`).join(","), "")).toThrow(/20/);
  expect(safeFrontUrl("https://app.frontapp.com/open/cnv_good")).toBe("https://app.frontapp.com/open/cnv_good");
  for (const url of ["javascript:alert(1)", "https://app.frontapp.com@evil.example/open/cnv_a", "https://app.frontapp.com/open/cnv_a?redirect=evil", "https://app.frontapp.com/other", "http://app.frontapp.com/open/cnv_a"]) expect(safeFrontUrl(url)).toBeUndefined();
  expect(recoveryFrontMessageId(" msg_exact ")).toBe("msg_exact");
  expect(recoveryFrontMessageId("https://app.frontapp.com/open/msg_exact")).toBe("msg_exact");
  for (const value of ["cnv_client", "https://app.frontapp.com/open/cnv_client", "https://evil.example/open/msg_exact", "https://app.frontapp.com/open/msg_exact?redirect=evil"]) expect(() => recoveryFrontMessageId(value)).toThrow(/exact/);
});
