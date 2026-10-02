import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../lib/pagination";

const h = vi.hoisted(() => ({ activity: vi.fn(), profiles: vi.fn(), communication: vi.fn() }));
vi.mock("../components/LeadWorkflowPanel", () => ({ default: () => null }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.communication }));
vi.mock("../lib/client", () => ({
  client: { models: {
    Activity: { listActivityByEntityIdAndOccurredAt: h.activity },
    UserProfile: { listUserProfileByUserId: h.profiles },
  } },
  listAllPages: (...args: Parameters<typeof listAllPages>) => listAllPages(...args),
  friendlyError: (_error: unknown, fallback: string) => fallback,
  fmtDateTime: (v: string) => v,
  fmtMoney: (v: number) => String(v),
}));
import { ActivityTab } from "../pages/account/ActivityTab";

const jake = "f42874a8-40a1-700a-55d1-0d02a36fbe7c";
const anotherJake = "b42874a8-40a1-700a-55d1-0d02a36fbe7c";
const row = (id: string, actor: string, actorName = actor) => ({
  id, actor, actorName, subjectType: "Lead communication", action: "UPDATE",
  summary: `Change ${id}`, occurredAt: "2026-09-10T02:00:00Z",
});
beforeEach(() => {
  vi.clearAllMocks();
  h.communication.mockReset();
  h.activity.mockResolvedValue({ data: [row("one", jake), row("two", anotherJake)] });
  h.profiles.mockResolvedValue({ data: [{ firstName: "Jake", lastName: "Greasley" }] });
});

const noteId = `note:${jake}:request-12345678901234567890`;
const completeNote = `Discussed renewal options with the board.\n\n  Follow up with the property manager.\n${"Full meeting details, including limits and next steps. ".repeat(30)}\nFinal decision: keep the complete note.`;
const noteChanges = [{ field: "id", from: null, to: noteId }];
function noteAudit(changes: unknown = noteChanges, accountId = "a") {
  return { ...row(`audit-${accountId}`, jake, "Jake Greasley"), entityId: accountId, subjectId: accountId, summary: "Internal note added", changes };
}
function noteRecord(overrides: Record<string, unknown> = {}) {
  return { id: noteId, accountId: "a", channel: "NOTE", text: completeNote, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Internal notes in account changes", () => {
  it.each(["string", "parsed"] as const)("loads a complete historical note only while expanded (%s changes)", async format => {
    h.activity.mockResolvedValue({ data: [noteAudit(format === "string" ? JSON.stringify(noteChanges) : noteChanges)] });
    const firstRead = deferred<unknown>();
    h.communication.mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce({ communication: noteRecord({ text: "Newly read note text\nStill multiline." }) });
    render(<ActivityTab accountId="a" />);
    const summary = await screen.findByText("Internal note added");
    const disclosure = summary.closest("details")!;
    expect(within(disclosure).getByText("View note")).toBeVisible();
    expect(h.communication).not.toHaveBeenCalled();
    expect(disclosure.querySelector(".account-change-note-text")).toBeNull();

    fireEvent.click(within(disclosure).getByText("View note"));
    await waitFor(() => expect(h.communication).toHaveBeenCalledWith("activity", { id: noteId, accountId: "a" }));
    expect(within(disclosure).getByRole("status")).toHaveTextContent("Loading note…");
    await act(async () => firstRead.resolve({ communication: noteRecord() }));
    const displayed = within(disclosure).getByText(completeNote, { normalizer: value => value });
    expect(displayed).toBeVisible();
    expect(displayed).toHaveClass("account-change-note-text");
    expect(displayed.textContent).toBe(completeNote);
    expect(within(disclosure).queryByText("Before")).toBeNull();
    expect(within(disclosure).queryByText(noteId)).toBeNull();

    fireEvent.click(summary);
    await waitFor(() => expect(disclosure.querySelector(".account-change-note-text")).toBeNull());
    fireEvent.click(summary);
    expect(await within(disclosure).findByText("Newly read note text\nStill multiline.", { normalizer: value => value })).toBeVisible();
    expect(h.communication).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(completeNote, { normalizer: value => value })).toBeNull();
  });

  it.each(["network failure", "access denied"] as const)("keeps a reopened note hidden through %s and a pending retry", async failure => {
    const reopened = deferred<unknown>();
    const retry = deferred<unknown>();
    h.activity.mockResolvedValue({ data: [noteAudit()] });
    h.communication.mockResolvedValueOnce({ communication: noteRecord() })
      .mockImplementationOnce(() => reopened.promise)
      .mockImplementationOnce(() => retry.promise);
    render(<ActivityTab accountId="a" />);
    const summary = await screen.findByText("Internal note added");
    const disclosure = summary.closest("details")!;
    fireEvent.click(summary);
    await within(disclosure).findByText(completeNote, { normalizer: value => value });
    fireEvent.click(summary);
    await waitFor(() => expect(disclosure.querySelector(".account-change-note-text")).toBeNull());
    fireEvent.click(summary);
    await waitFor(() => expect(h.communication).toHaveBeenCalledTimes(2));
    expect(within(disclosure).getByRole("status")).toHaveTextContent("Loading note…");
    expect(screen.queryByText(completeNote, { normalizer: value => value })).toBeNull();
    await act(async () => reopened.reject(new Error(failure === "access denied"
      ? "This record is not available to your account. Contact an administrator if it needs to be assigned to you."
      : "Temporary network failure")));
    expect(within(disclosure).getByRole("alert")).toHaveTextContent("Could not load this note.");
    expect(disclosure.querySelector(".account-change-note-text")).toBeNull();
    fireEvent.click(within(disclosure).getByRole("button", { name: "Retry note" }));
    expect(within(disclosure).getByRole("status")).toHaveTextContent("Loading note…");
    expect(within(disclosure).queryByRole("alert")).toBeNull();
    expect(disclosure.querySelector(".account-change-note-text")).toBeNull();
    await act(async () => retry.resolve({ communication: noteRecord({ text: "Freshly authorized note" }) }));
    expect(within(disclosure).getByText("Freshly authorized note")).toBeVisible();
    expect(h.communication).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a different note", { id: "note:another-user:another-request" }],
    ["another account", { accountId: "other-account" }],
    ["an email", { channel: "EMAIL" }],
  ] as const)("rejects a response identifying %s", async (_description, override) => {
    h.activity.mockResolvedValue({ data: [noteAudit()] });
    h.communication.mockResolvedValue({ communication: noteRecord({ ...override, text: "Content that must not appear" }) });
    render(<ActivityTab accountId="a" />);
    fireEvent.click(await screen.findByText("View note"));
    expect(await screen.findByRole("button", { name: "Retry note" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this note.");
    expect(screen.queryByText("Content that must not appear")).toBeNull();
  });

  it.each([
    ["missing", undefined], ["empty", ""], ["whitespace", " \n\t "], ["non-string", { body: "Unexpected shape" }],
  ] as const)("reports %s note text as unavailable", async (_description, text) => {
    h.activity.mockResolvedValue({ data: [noteAudit()] });
    h.communication.mockResolvedValue({ communication: noteRecord({ text }) });
    render(<ActivityTab accountId="a" />);
    fireEvent.click(await screen.findByText("View note"));
    expect(await screen.findByText("Note text is unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry note" })).toBeVisible();
    expect(document.querySelector(".account-change-note-text")).toBeNull();
  });

  it.each([null, {}, { communication: null }] as const)("does not display a malformed note response (%j)", async response => {
    h.activity.mockResolvedValue({ data: [noteAudit()] });
    h.communication.mockResolvedValue(response);
    render(<ActivityTab accountId="a" />);
    fireEvent.click(await screen.findByText("View note"));
    expect(await screen.findByRole("button", { name: "Retry note" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this note.");
    expect(document.querySelector(".account-change-note-text")).toBeNull();
  });

  it("does not load note content for ordinary audits or malformed note references", async () => {
    h.activity.mockResolvedValue({ data: [
      { ...noteAudit(), id: "normal-subject", subjectType: "Account" },
      { ...noteAudit(), id: "normal-summary", summary: "Internal note changed" },
      { ...noteAudit("invalid JSON"), id: "bad-json" },
      { ...noteAudit([{ field: "id", from: null, to: "email:some-message" }]), id: "wrong-id" },
      { ...noteAudit([{ field: "id", from: null, to: "" }]), id: "empty-id" },
    ] });
    render(<ActivityTab accountId="a" />);
    await screen.findByText("Internal note changed");
    expect(screen.queryByText("View note")).toBeNull();
    for (const disclosure of screen.getByRole("table", { name: "Account change history" }).querySelectorAll("details")) {
      fireEvent.click(disclosure.querySelector("summary")!);
    }
    await act(async () => {});
    expect(h.communication).not.toHaveBeenCalled();
  });

  it("ignores a note response after its row is hidden and rechecks access when shown again", async () => {
    const pending = deferred<unknown>();
    h.activity.mockResolvedValue({ data: [noteAudit(), { ...row("account", "system", "System"), subjectType: "Account" }] });
    h.communication.mockImplementationOnce(() => pending.promise).mockResolvedValueOnce({ communication: noteRecord({ text: "Reloaded note" }) });
    render(<ActivityTab accountId="a" />);
    fireEvent.click(await screen.findByText("View note"));
    await waitFor(() => expect(h.communication).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Account" } });
    expect(screen.queryByText("Internal note added")).toBeNull();
    await act(async () => pending.resolve({ communication: noteRecord() }));
    expect(screen.queryByText(completeNote, { normalizer: value => value })).toBeNull();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "" } });
    expect(h.communication).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("View note"));
    expect(await screen.findByText("Reloaded note")).toBeVisible();
    expect(h.communication).toHaveBeenCalledTimes(2);
  });

  it("never shows a previous account's late note response under the new account", async () => {
    const secondNoteId = `note:${jake}:second-request-12345678901234567890`;
    const oldRead = deferred<unknown>();
    h.activity.mockImplementation(({ entityId }) => Promise.resolve({ data: [noteAudit([{ field: "id", from: null, to: entityId === "a" ? noteId : secondNoteId }], entityId)] }));
    h.communication.mockImplementation((_operation, { accountId }) => accountId === "a" ? oldRead.promise : Promise.resolve({ communication: noteRecord({ id: secondNoteId, accountId: "b", text: "Account B note" }) }));
    const view = render(<ActivityTab accountId="a" />);
    fireEvent.click(await screen.findByText("View note"));
    await waitFor(() => expect(h.communication).toHaveBeenCalledWith("activity", { id: noteId, accountId: "a" }));
    view.rerender(<ActivityTab accountId="b" />);
    const nextDisclosure = await screen.findByText("View note");
    await act(async () => oldRead.resolve({ communication: noteRecord() }));
    expect(screen.queryByText(completeNote, { normalizer: value => value })).toBeNull();
    expect(document.querySelector(".account-change-note-text")).toBeNull();
    fireEvent.click(nextDisclosure);
    expect(await screen.findByText("Account B note")).toBeVisible();
    expect(h.communication).toHaveBeenLastCalledWith("activity", { id: secondNoteId, accountId: "b" });
    expect(screen.queryByText(completeNote, { normalizer: value => value })).toBeNull();
  });
});

describe("Activity teammate attribution", () => {
  it("resolves legacy IDs and filters by identity even when names match", async () => {
    render(<ActivityTab accountId="a" />);
    await waitFor(() => expect(within(screen.getByLabelText("Who")).getAllByRole("option", { name: "Jake Greasley" })).toHaveLength(2));
    expect(screen.queryByText(jake)).toBeNull();
    fireEvent.change(screen.getByLabelText("Who"), { target: { value: jake } });
    expect(screen.getByText("Change one")).toBeTruthy();
    expect(screen.queryByText("Change two")).toBeNull();
    expect(h.profiles).toHaveBeenCalledTimes(2);
  });

  it("keeps historical names and System without unnecessary directory reads", async () => {
    h.activity.mockResolvedValue({ data: [row("person", jake, "Jake Greasley"), row("robot", "system", "System")] });
    render(<ActivityTab accountId="a" />);
    await screen.findByText("Change person");
    expect(screen.getAllByText("Jake Greasley").length).toBeGreaterThan(0);
    expect(screen.getAllByText("System").length).toBeGreaterThan(0);
    expect(h.profiles).not.toHaveBeenCalled();
  });

  it("keeps activity readable on lookup failure and supports retry with pagination", async () => {
    h.activity.mockResolvedValue({ data: [row("one", jake), row("two", jake)] });
    h.profiles.mockResolvedValueOnce({ data: null, errors: [{ message: "Temporary failure" }] });
    render(<ActivityTab accountId="a" />);
    await screen.findByRole("button", { name: "Retry names" });
    expect(screen.getByText("Change one")).toBeTruthy();
    expect(screen.queryByText(jake)).toBeNull();
    h.profiles.mockResolvedValueOnce({ data: [], nextToken: "next" })
      .mockResolvedValueOnce({ data: [{ firstName: "Jake", lastName: "Greasley" }] });
    fireEvent.click(screen.getByRole("button", { name: "Retry names" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry names" })).toBeNull());
    expect(screen.getAllByText("Jake Greasley").length).toBeGreaterThan(0);
    expect(h.profiles).toHaveBeenLastCalledWith({ userId: jake }, { nextToken: "next" });
  });

  it.each(["empty", "populated"])("keeps a retry loading until the %s history response arrives", async outcome => {
    let finishRetry!: (value: { data: ReturnType<typeof row>[] }) => void;
    h.activity.mockRejectedValueOnce(new Error("Temporary failure"))
      .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
    render(<ActivityTab accountId="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry account changes" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading account changes…");
    expect(screen.queryByText("No account changes yet")).toBeNull();
    expect(screen.getByRole("heading", { name: "Account changes" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => finishRetry({ data: outcome === "empty" ? [] : [row("retried", "system", "System")] }));
    expect(screen.queryByText("Loading account changes…")).toBeNull();
    if (outcome === "empty") {
      expect(screen.getByText("No account changes yet")).toBeVisible();
      expect(screen.getByRole("heading", { name: "Account changes 0" })).toBeVisible();
    } else {
      expect(screen.getByText("Change retried")).toBeVisible();
      expect(screen.queryByText("No account changes yet")).toBeNull();
      expect(screen.getByRole("heading", { name: "Account changes 1" })).toBeVisible();
    }
  });

  it("mounts field values only while a change is expanded", async () => {
    h.activity.mockResolvedValue({ data: [{
      ...row("premium", jake, "Jake Greasley"),
      changes: JSON.stringify([{ field: "premium", from: 100, to: 250 }]),
    }] });
    render(<ActivityTab accountId="a" />);
    const summary = await screen.findByText("Change premium");
    const disclosure = summary.closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(within(disclosure).queryByText("250")).toBeNull();
    fireEvent.click(within(disclosure).getByText("1 field change"));
    expect(disclosure).toHaveAttribute("open");
    expect(await within(disclosure).findByText("Premium")).toBeVisible();
    expect(within(disclosure).getByText("Before")).toBeVisible();
    expect(within(disclosure).getByText("100")).toBeVisible();
    expect(within(disclosure).getByText("After")).toBeVisible();
    expect(within(disclosure).getByText("250")).toBeVisible();
    fireEvent.click(summary);
    expect(disclosure).not.toHaveAttribute("open");
    await waitFor(() => expect(within(disclosure).queryByText("250")).toBeNull());
    expect(within(disclosure).queryByText("Before")).toBeNull();
    expect(within(disclosure).getByText("1 field change")).toBeVisible();
    fireEvent.click(summary);
    expect(await within(disclosure).findByText("250")).toBeVisible();
  });

  it("retains complete long and structured audit values inside expandable details", async () => {
    const reference = `provider-reference-${"abc123".repeat(80)}`;
    h.activity.mockResolvedValue({ data: [{
      ...row("technical", "system", "System"),
      changes: [
        { field: "externalReference", from: null, to: reference },
        { field: "providerMetadata", from: { status: "before" }, to: { status: "after", nested: { request: "test-request" } } },
        { field: "routing", from: [], to: [{ role: "salesperson", assigned: true }] },
      ],
    }] });
    render(<ActivityTab accountId="a" />);
    const summary = await screen.findByText("Change technical");
    const disclosure = summary.closest("details")!;
    expect(within(disclosure).queryByText(reference)).toBeNull();
    fireEvent.click(summary);
    expect(await within(disclosure).findByText(reference)).toBeVisible();
    expect(within(disclosure).getByText(reference).textContent).toBe(reference);
    expect(within(disclosure).getByText(/"request": "test-request"/)).toBeVisible();
    expect(within(disclosure).getByText(/"role": "salesperson"/)).toHaveTextContent('"assigned": true');
    expect(within(disclosure).queryByText("(changed)")).toBeNull();
  });

});
