import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAllPages } from "../lib/pagination";

const h = vi.hoisted(() => ({ activity: vi.fn(), profiles: vi.fn() }));
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
});
