import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ client: {}, friendlyError: (e: Error) => e.message, fmtDateTime: (v: string) => v || "—", fmtProviderPhone: (v: string) => v === "+16175550123" ? "(617) 555-0123" : v }));
vi.mock("../lib/lastContact", () => ({ useLastContacts: () => ({ contacts: { a1: { at: "2026-09-10T14:00:00Z" } }, loading: false, error: "" }) }));
import LeadWork from "../pages/LeadWork";
import CommunicationDiagnostics from "../components/CommunicationDiagnostics";
import type { UserProfile } from "../lib/client";
const future = { id: "future", accountId: "a1", name: "Willow HOA", title: "Follow up with prospect", kind: "FOLLOW_UP", dueAt: "2099-09-14T13:00:00Z", role: "SALESPERSON", status: "OPEN", version: 1 };
function page() { render(<MemoryRouter><LeadWork profile={{} as UserProfile} /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks();
  h.request.mockImplementation(async (_op: string, input: { kind: string }) => ({ items: input.kind === "TASK" ? [future] : [] }));
});
describe("staff follow-up", () => {
  it("has only three work views, separate responsibility and last contact, with reminders outside the selector", async () => {
    page(); await screen.findByText("Willow HOA");
    expect(within(screen.getByRole("combobox", { name: "View" })).getAllByRole("option").map(o => o.textContent)).toEqual(["Needs attention", "Upcoming", "All open"]);
    expect(within(screen.getByRole("combobox", { name: "Responsibility" })).getAllByRole("option").map(o => o.textContent)).toEqual(["All responsibilities", "Salesperson", "Deal champion"]);
    expect(screen.getByText("Waiting on prospect")).toBeVisible(); expect(screen.getByText("2026-09-10T14:00:00Z")).toBeVisible();
    expect(screen.queryByText("Delivery queue")).toBeNull(); expect(screen.queryByText("Event processing")).toBeNull();
    expect(h.request.mock.calls.some(([, input]) => input.kind === "NOTIFICATION")).toBe(false);
    fireEvent.click(screen.getByText("My reminders"));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("work", expect.objectContaining({ kind: "NOTIFICATION" })));
  });
  it("filters task requests while leaving unassigned and unlinked work shared", async () => {
    h.request.mockImplementation(async (_op: string, input: { kind: string }) => ({ items: input.kind === "WORKFLOW" ? [{ id: "wf", accountId: "missing", name: "Oak HOA", version: 1 }] : input.kind === "TRIAGE" ? [{ id: "triage", communicationId: "comm", phone: "+16175550123", version: 1 }] : [future] }));
    page(); await screen.findByText("Oak HOA");
    expect(screen.getByLabelText("My work")).toBeChecked();
    fireEvent.change(screen.getByRole("combobox", { name: "Responsibility" }), { target: { value: "CHAMPION" } });
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("work", { kind: "TASK", view: "Needs attention", responsibility: "CHAMPION", mine: true }));
    expect(screen.getByText("Oak HOA")).toBeVisible(); expect(screen.getByText("(617) 555-0123")).toBeVisible();
    expect(h.request.mock.calls.filter(([, input]) => ["WORKFLOW", "TRIAGE"].includes(input.kind)).every(([, input]) => !input.mine && !input.responsibility)).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "View" }), { target: { value: "Upcoming" } });
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("work", { kind: "TASK", view: "Upcoming", responsibility: "CHAMPION", mine: true }));
    expect(screen.queryByRole("region", { name: "Shared team items" })).toBeNull();
  });
  it("does not turn a failed read or an incomplete search into an empty-work claim", async () => {
    h.request.mockImplementation(async (_op: string, input: { kind: string; nextToken?: string }) => input.kind === "TASK" ? input.nextToken ? { items: [future] } : { items: [], nextToken: "next-page" } : { items: [] });
    page(); fireEvent.click(await screen.findByRole("button", { name: "Continue searching" }));
    await screen.findByText("Willow HOA");
    h.request.mockImplementation(async (_op: string, input: { kind: string }) => { if (input.kind === "TASK") throw new Error("Connection unavailable"); return { items: [] }; });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Connection unavailable");
    expect(screen.queryByText("No actions need attention in this view.")).toBeNull();
  });
  it("drops a late pagination response after the responsibility filter changes", async () => {
    let finish!: (v: unknown) => void;
    h.request.mockImplementation((_op: string, input: { kind: string; nextToken?: string; responsibility?: string }) => {
      if (input.kind !== "TASK") return Promise.resolve({ items: [] });
      if (input.nextToken) return new Promise(resolve => { finish = resolve; });
      return Promise.resolve(input.responsibility ? { items: [{ ...future, id: "champ", name: "Champion lead" }] } : { items: [future], nextToken: "more" });
    });
    page(); fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Responsibility" }), { target: { value: "CHAMPION" } });
    await screen.findByText("Champion lead");
    await act(async () => finish({ items: [{ ...future, id: "late", name: "Wrong older page" }] }));
    expect(screen.queryByText("Wrong older page")).toBeNull(); expect(screen.getByText("Champion lead")).toBeVisible();
  });
});
describe("admin troubleshooting", () => {
  it("keeps delivery and event repair available in the separate queue tool", async () => {
    h.request.mockImplementation(async (_op: string, input: { kind: string }) => ({ items: input.kind === "OPERATION" ? [{ id: "op", state: "UNKNOWN", version: 1, error: "Delivery needs review" }] : input.kind === "EVENT" ? [{ id: "event", error: "Event needs review", version: 1 }] : [] }));
    render(<MemoryRouter><CommunicationDiagnostics /></MemoryRouter>);
    fireEvent.change(screen.getByRole("combobox", { name: "Queue" }), { target: { value: "OPERATION" } });
    expect(await screen.findByText("Review delivery")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Queue" }), { target: { value: "EVENT" } });
    expect(await screen.findByText("Repair processing")).toBeVisible();
  });
});
