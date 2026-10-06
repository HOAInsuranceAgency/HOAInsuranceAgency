import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn(), search: vi.fn(), list: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ fmtProviderPhone: (value: string) => value, friendlyError: (error: unknown) => String(error), client: { models: { Account: { list: h.list } } } }));
import { ActivityReview, DeliveryReview, SidebarActivityLinker } from "./CommunicationReview";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  h.search.mockReset(); h.list.mockReset();
  h.request.mockReset().mockImplementation((operation, input) => operation === "searchAccounts" ? h.search(input) : Promise.resolve({ communication: { version: 1, from: "6175550100", status: "RECEIVED" } }));
});
function search(term: string) {
  fireEvent.change(screen.getByLabelText("Association name"), { target: { value: term } });
  fireEvent.submit(screen.getByLabelText("Association name").closest("form")!);
}

it("continues a bounded search explicitly instead of downloading every account", async () => {
  h.search.mockResolvedValueOnce({ items: [], nextToken: "page-2" }).mockResolvedValueOnce({ items: [{ id: "a", name: "Maple HOA" }] });
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("MAPLE");
  const more = await screen.findByRole("button", { name: "Continue searching" });
  expect(screen.queryByText("No matching leads or clients.")).not.toBeInTheDocument();
  expect(h.search).toHaveBeenCalledTimes(1);
  expect(h.search).toHaveBeenLastCalledWith({ query: "MAPLE" });
  expect(h.list).not.toHaveBeenCalled();
  fireEvent.click(more);
  expect(await screen.findByRole("button", { name: "Maple HOA" })).toBeInTheDocument();
  expect(h.search).toHaveBeenLastCalledWith({ query: "MAPLE", nextToken: "page-2" });
  expect(screen.queryByRole("button", { name: "Continue searching" })).not.toBeInTheDocument();
});

it("ignores search results for text the user has replaced", async () => {
  const page = deferred<unknown>(); h.search.mockReturnValue(page.promise);
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("maple");
  fireEvent.change(screen.getByLabelText("Association name"), { target: { value: "different lead" } });
  await act(async () => page.resolve({ items: [{ id: "a", name: "Maple HOA" }], nextToken: "old-cursor" }));
  expect(screen.queryByRole("button", { name: "Maple HOA" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next matches" })).not.toBeInTheDocument();
});

it("retains a failed continuation for retry and replaces the prior results page", async () => {
  h.search.mockResolvedValueOnce({ items: [{ id: "a", name: "Maple HOA" }], nextToken: "page-2" })
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValueOnce({ items: [{ id: "b", name: "Maple Court" }] });
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("Maple");
  fireEvent.click(await screen.findByRole("button", { name: "Next matches" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  expect(screen.getByRole("button", { name: "Maple HOA" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next matches" }));
  expect(await screen.findByRole("button", { name: "Maple Court" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Maple HOA" })).not.toBeInTheDocument();
  expect(h.search.mock.calls.slice(1).map(call => call[0])).toEqual([
    { query: "Maple", nextToken: "page-2" }, { query: "Maple", nextToken: "page-2" },
  ]);
});

it("blocks duplicate requests and starts a changed query without its old cursor", async () => {
  const pending = deferred<unknown>();
  h.search.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ items: [{ id: "b", name: "Pine HOA" }] });
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("Maple");
  fireEvent.submit(screen.getByLabelText("Association name").closest("form")!);
  expect(h.search).toHaveBeenCalledTimes(1);
  search("Pine");
  expect(await screen.findByRole("button", { name: "Pine HOA" })).toBeInTheDocument();
  await act(async () => pending.resolve({ items: [{ id: "a", name: "Maple HOA" }], nextToken: "old-cursor" }));
  expect(h.search).toHaveBeenLastCalledWith({ query: "Pine" });
  expect(screen.queryByRole("button", { name: "Maple HOA" })).not.toBeInTheDocument();
});

it("clears previous matches and the cursor if a continuation loses access", async () => {
  h.search.mockResolvedValueOnce({ items: [{ id: "a", name: "Private HOA" }], nextToken: "page-2" })
    .mockRejectedValueOnce(new Error("Access denied"));
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("Private");
  fireEvent.click(await screen.findByRole("button", { name: "Next matches" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access denied");
  expect(screen.queryByRole("button", { name: "Private HOA" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next matches" })).not.toBeInTheDocument();
});

it("distinguishes an exhausted continuation from an unfinished empty page", async () => {
  h.search.mockResolvedValueOnce({ items: [], nextToken: "page-2" }).mockResolvedValueOnce({ items: [] });
  render(<ActivityReview id="activity" onSaved={vi.fn()} />);
  search("Maple");
  fireEvent.click(await screen.findByRole("button", { name: "Continue searching" }));
  expect(await screen.findByText("No more matching leads or clients.")).toBeInTheDocument();
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
