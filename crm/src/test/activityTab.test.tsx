import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../lib/pagination";

const h = vi.hoisted(() => ({ activity: vi.fn(), profiles: vi.fn() }));
vi.mock("../components/LeadWorkflowPanel", () => ({ default: () => null }));
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
  h.activity.mockResolvedValue({ data: [row("one", jake), row("two", anotherJake)] });
  h.profiles.mockResolvedValue({ data: [{ firstName: "Jake", lastName: "Greasley" }] });
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
