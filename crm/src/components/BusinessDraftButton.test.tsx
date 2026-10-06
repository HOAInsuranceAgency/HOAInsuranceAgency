import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), createDraft: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("@frontapp/plugin-sdk", () => ({ default: { createDraft: h.createDraft } }));
import BusinessDraftButton from "./BusinessDraftButton";
const draft = { channelId: "channel", originalMessageId: "message", recipient: "client@example.com", subject: "Quote", body: "Terms", attachments: [] };
const props = { accountId: "a1", conversationId: "c1", kind: "QUOTE" as const, recordId: "q1", label: "Prepare quote draft" };
beforeEach(() => { vi.resetAllMocks(); h.createDraft.mockResolvedValue(undefined); });
it("prepares only one draft for repeated clicks while the request is pending", async () => {
  let finish!: (result: unknown) => void;
  h.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<BusinessDraftButton {...props} />);
  fireEvent.click(screen.getByRole("button")); fireEvent.click(screen.getByRole("button"));
  expect(h.request).toHaveBeenCalledTimes(1);
  await act(async () => finish({ draft }));
  await waitFor(() => expect(h.createDraft).toHaveBeenCalledTimes(1));
});
it("does not insert an old account's prepared draft after the conversation changes", async () => {
  let finish!: (result: unknown) => void;
  h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<BusinessDraftButton {...props} />);
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<BusinessDraftButton {...props} accountId="a2" conversationId="c2" recordId="q2" />);
  expect(screen.getByRole("button")).toBeEnabled();
  await act(async () => finish({ draft }));
  expect(h.createDraft).not.toHaveBeenCalled();
});
it("allows retry after a preparation failure", async () => {
  h.request.mockRejectedValueOnce(new Error("Could not prepare attachment")).mockResolvedValueOnce({ draft });
  render(<BusinessDraftButton {...props} />); fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(h.createDraft).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).toBeNull();
});
