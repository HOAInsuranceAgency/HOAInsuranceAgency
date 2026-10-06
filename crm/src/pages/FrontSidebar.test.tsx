import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn(), createDraft: vi.fn(), context: null as null | ((context: { conversation: { id: string } }) => void) }));
vi.mock("@frontapp/plugin-sdk", () => ({ default: {
  contextUpdates: { subscribe: (callback: typeof h.context) => { h.context = callback; return { unsubscribe: vi.fn() }; } },
  createDraft: h.createDraft, openUrl: vi.fn(),
} }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ friendlyError: (error: unknown) => String(error), client: { models: { Account: { list: async () => ({ data: [{ id: "account", name: "Example lead" }] }) } } } }));
vi.mock("../components/LeadWorkflowPanel", () => ({ default: () => <Draft /> }));
import FrontSidebar from "./FrontSidebar";

function Draft() {
  const [value, setValue] = useState("");
  return <input aria-label="Current account note" value={value} onChange={event => setValue(event.target.value)} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function select(id: string) { act(() => h.context!({ conversation: { id } })); }
function textDraft() {
  fireEvent.change(screen.getByLabelText("Prospect number"), { target: { value: "6175550123" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Please call me" } });
  fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
}
beforeEach(() => { h.request.mockReset(); h.createDraft.mockReset().mockResolvedValue({}); });

it("does not open a stale text draft after leaving and returning to a conversation", async () => {
  const setup = deferred<{ channelId: string; sender: string }>();
  h.request.mockReturnValue(setup.promise);
  render(<FrontSidebar />); select("cnv_a"); textDraft();
  select("cnv_b"); select("cnv_a");
  await act(async () => setup.resolve({ channelId: "cha_sms", sender: "6175550100" }));
  expect(h.createDraft).not.toHaveBeenCalled();
});

it("does not show an old draft error or unlock the new conversation's pending draft", async () => {
  const oldDraft = deferred<unknown>(), newSetup = deferred<unknown>();
  h.request.mockResolvedValueOnce({ channelId: "cha_sms", sender: "6175550100" }).mockReturnValueOnce(newSetup.promise);
  h.createDraft.mockReturnValueOnce(oldDraft.promise);
  render(<FrontSidebar />); select("cnv_a"); textDraft();
  await act(async () => {});
  select("cnv_b"); textDraft();
  await act(async () => oldDraft.reject(new Error("Old conversation unavailable")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open draft in Front", hidden: true })).toBeDisabled();
});

it("keeps the new conversation's note mounted when an earlier link finishes", async () => {
  const link = deferred<unknown>();
  h.request.mockReturnValue(link.promise);
  render(<FrontSidebar />); select("cnv_a");
  fireEvent.change(screen.getByLabelText("Association or client name"), { target: { value: "example" } });
  fireEvent.submit(screen.getByLabelText("Association or client name").closest("form")!);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Example lead", hidden: true }));
  fireEvent.click(screen.getByRole("button", { name: "Example lead", hidden: true }));
  expect(h.request).toHaveBeenCalledTimes(1);
  select("cnv_b");
  fireEvent.change(screen.getByLabelText("Current account note"), { target: { value: "New account draft" } });
  await act(async () => link.resolve({}));
  expect(screen.getByLabelText("Current account note")).toHaveValue("New account draft");
});
