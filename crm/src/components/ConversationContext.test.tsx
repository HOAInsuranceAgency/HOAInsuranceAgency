import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/communications", () => ({ communicationRequest: request }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Policy: { list: async () => ({ data: [] }) } } }) }));
import ConversationContext from "./ConversationContext";
beforeEach(() => request.mockReset());

it("preserves an edited context when background refresh returns changed server values", () => {
  const props = { accountId: "a", conversationId: "cnv_a", bound: false, onSaved: vi.fn() };
  const view = render(<ConversationContext {...props} saved={{ context: "LEAD", purpose: "PROSPECT" }} />);
  fireEvent.change(screen.getByLabelText("This conversation concerns"), { target: { value: "SERVICE" } });
  view.rerender(<ConversationContext {...props} saved={{ context: "RENEWAL", purpose: "CARRIER" }} />);
  expect(screen.getByLabelText("This conversation concerns")).toHaveValue("SERVICE");
  expect(screen.getByLabelText("Correspondence with")).toHaveValue("PROSPECT");
});

it("locks pending context fields and ignores completion from a previous conversation", async () => {
  let finish!: (value: unknown) => void;
  request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const saved = vi.fn(), props = { accountId: "a", bound: false, onSaved: saved };
  const view = render(<ConversationContext {...props} conversationId="cnv_a" />);
  fireEvent.click(screen.getByRole("button", { name: "Save conversation context", hidden: true }));
  expect(screen.getByLabelText("This conversation concerns")).toBeDisabled();
  view.rerender(<ConversationContext {...props} conversationId="cnv_b" />);
  await act(async () => finish({}));
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByLabelText("This conversation concerns")).toBeEnabled();
});
