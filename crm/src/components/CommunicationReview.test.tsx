import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), list: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ fmtProviderPhone: (value: string) => value, friendlyError: (error: unknown) => String(error), client: { models: { Account: { list: h.list } } } }));
import { ActivityReview, DeliveryReview, SidebarActivityLinker } from "./CommunicationReview";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { h.request.mockReset().mockResolvedValue({ communication: { version: 1, from: "6175550100", status: "RECEIVED" } }); h.list.mockReset(); });
function search(term: string) {
  fireEvent.change(screen.getByLabelText("Association name"), { target: { value: term } });
  fireEvent.submit(screen.getByLabelText("Association name").closest("form")!);
}

it("finds an association beyond the first page regardless of capitalization", async () => {
  h.list.mockResolvedValueOnce({ data: [], nextToken: "page-2" }).mockResolvedValueOnce({ data: [{ id: "a", name: "Maple HOA" }], nextToken: null });
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("MAPLE");
  expect(await screen.findByRole("button", { name: "Maple HOA" })).toBeInTheDocument();
  expect(h.list).toHaveBeenCalledWith(expect.objectContaining({ nextToken: "page-2" }));
});

it("ignores search results for text the user has replaced", async () => {
  const page = deferred<unknown>(); h.list.mockReturnValue(page.promise);
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("maple");
  fireEvent.change(screen.getByLabelText("Association name"), { target: { value: "different lead" } });
  await act(async () => page.resolve({ data: [{ id: "a", name: "Maple HOA" }] }));
  expect(screen.queryByRole("button", { name: "Maple HOA" })).not.toBeInTheDocument();
});

it("does not apply a completed link to another selected activity", async () => {
  const link = deferred<unknown>();
  h.request.mockImplementation(operation => operation === "activity" ? Promise.resolve({ communication: { version: 1 } }) : link.promise);
  const saved = vi.fn(), props = { accountId: "a", onSaved: saved };
  const view = render(<ActivityReview {...props} id="activity-a" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Link this activity to the selected lead and Front conversation" }));
  view.rerender(<ActivityReview {...props} id="activity-b" />);
  await act(async () => link.resolve({}));
  expect(saved).not.toHaveBeenCalled();
});

it("locks a pending delivery review and prevents duplicate submissions", async () => {
  const pending = deferred<unknown>(); h.request.mockReturnValue(pending.promise);
  render(<DeliveryReview item={{ id: "op", version: 1 }} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Front message UID"), { target: { value: "verified" } });
  fireEvent.change(screen.getByLabelText("Review notes"), { target: { value: "Checked provider" } });
  const form = screen.getByLabelText("Review notes").closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Review notes")).toBeDisabled();
  expect(screen.getByLabelText("Action")).toBeDisabled();
  await act(async () => pending.resolve({}));
});

it("requires fresh non-delivery verification when a refreshed operation changes", async () => {
  const props = { onSaved: vi.fn() };
  const view = render(<DeliveryReview {...props} item={{ id: "op", version: 1, state: "UNKNOWN" }} />);
  fireEvent.change(screen.getByLabelText("Action"), { target: { value: "retry" } });
  fireEvent.change(screen.getByLabelText("Review notes"), { target: { value: "Checked the source" } });
  const checkbox = screen.getByLabelText("I checked the source and confirmed this message was not sent.");
  fireEvent.click(checkbox);
  view.rerender(<DeliveryReview {...props} item={{ id: "op", version: 2, state: "ACCEPTED" }} />);
  fireEvent.submit(screen.getByLabelText("Review notes").closest("form")!);
  expect(h.request).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save review", hidden: true })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Review updated delivery", hidden: true }));
  expect(checkbox).not.toBeChecked();
  expect(screen.getByLabelText("Review notes")).toHaveValue("Checked the source");
  expect(screen.getByRole("button", { name: "Save review", hidden: true })).toBeDisabled();
  fireEvent.click(checkbox);
  fireEvent.submit(screen.getByLabelText("Review notes").closest("form")!);
  await act(async () => {});
  expect(h.request).toHaveBeenCalledWith("reviewOperation", expect.objectContaining({ version: 2, action: "retry", verifiedNotSent: true }), true);
});

it("locks pagination and deduplicates overlapping communication pages", async () => {
  const page = deferred<unknown>(), first = { id: "row-a", communicationId: "activity-a", phone: "111" };
  h.request.mockResolvedValueOnce({ items: [first], nextToken: "next" }).mockReturnValueOnce(page.promise);
  render(<SidebarActivityLinker accountId="a" conversationId="cnv_a" onSaved={vi.fn()} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "More activity", hidden: true }));
  expect(screen.getByRole("button", { name: "Loading activity…", hidden: true })).toBeDisabled();
  await act(async () => page.resolve({ items: [first, { id: "row-b", communicationId: "activity-b", phone: "222" }] }));
  expect(screen.getAllByRole("button", { name: /111/, hidden: true })).toHaveLength(1);
  expect(screen.getByRole("button", { name: /222/, hidden: true })).toBeInTheDocument();
});
