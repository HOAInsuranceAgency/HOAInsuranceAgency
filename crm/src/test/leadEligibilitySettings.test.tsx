import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ friendlyError: (error: Error) => error.message }));
import LeadEligibilitySettings from "../components/LeadEligibilitySettings";
import type { TeamEligibility } from "../lib/communications";
const member: TeamEligibility = { userId: "jake", name: "Jake Greasley", email: "jake@example.com", enabled: true, salesperson: true, champion: true, frontId: "tea_ci3mi", dialpadId: "5655281245659136", version: 3 };
beforeEach(() => {
  vi.clearAllMocks();
  h.request.mockImplementation(async (op: string, input: TeamEligibility) => op === "team" ? { team: [{ ...member }] } : { member: { ...input, version: (input.version ?? 0) + 1 } });
});
async function edit() { fireEvent.click(await screen.findByRole("button", { name: "Edit connections for Jake Greasley" })); }
const frontInput = () => screen.getByRole("textbox", { name: /^Front teammate ID/ });
const dialpadInput = () => screen.getByRole("textbox", { name: /^Dialpad user ID/ });

describe("protected teammate connection IDs", () => {
  it("shows exact IDs as read-only text until the user explicitly opens the editor", async () => {
    render(<LeadEligibilitySettings />);
    expect(await screen.findByText(member.frontId!)).toBeVisible();
    expect(screen.getByText(member.dialpadId!)).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    await edit();
    expect(screen.getByRole("dialog", { name: "Connections for Jake Greasley" })).toBeVisible();
    expect(frontInput()).toHaveValue(member.frontId);
    expect(dialpadInput()).toHaveValue(member.dialpadId);
    expect(screen.getByRole("button", { name: "Save connections" })).toBeDisabled();
  });
  it("does not save on blur and discards cancelled edits", async () => {
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "tea_changed" } }); fireEvent.blur(frontInput());
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await edit(); expect(frontInput()).toHaveValue(member.frontId);
    fireEvent.change(dialpadInput(), { target: { value: "123456789" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
  });
  it("checks provider formats, keeps IDs as strings, and preserves role eligibility when saving", async () => {
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "not-a-front-id" } });
    fireEvent.change(dialpadInput(), { target: { value: "123-456" } });
    expect(frontInput()).toHaveAttribute("aria-invalid", "true"); expect(dialpadInput()).toHaveAttribute("aria-invalid", "true");
    fireEvent.submit(screen.getByRole("form", { name: "Connections for Jake Greasley" }));
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(0);
    fireEvent.change(frontInput(), { target: { value: " tea_new123 " } });
    fireEvent.change(dialpadInput(), { target: { value: " 5655281245659136 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveEligibility", { ...member, frontId: "tea_new123" }, true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("tea_new123")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Salesperson eligibility for Jake Greasley" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deal champion eligibility for Jake Greasley" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Salesperson eligibility for Jake Greasley" }));
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveEligibility", { ...member, frontId: "tea_new123", salesperson: false, version: 4 }, true));
  });
  it("keeps the draft visible after a failed save so it can be retried", async () => {
    let saves = 0;
    h.request.mockImplementation(async (op: string, input: TeamEligibility) => {
      if (op === "team") return { team: [member] };
      if (++saves === 1) throw new Error("Could not save connections");
      return { member: { ...input, version: 4 } };
    });
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "tea_retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save connections");
    expect(frontInput()).toHaveValue("tea_retry");
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("tea_retry")).toBeVisible();
  });
  it("prevents repeated saves or dismissing a request while it is in progress", async () => {
    let finish!: (result: unknown) => void;
    h.request.mockImplementation((op: string) => op === "team" ? Promise.resolve({ team: [member] }) : new Promise(resolve => { finish = resolve; }));
    render(<LeadEligibilitySettings />); await edit();
    fireEvent.change(frontInput(), { target: { value: "tea_pending" } });
    const form = screen.getByRole("form", { name: "Connections for Jake Greasley" });
    fireEvent.submit(form); fireEvent.submit(form);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(frontInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(h.request.mock.calls.filter(call => call[0] === "saveEligibility")).toHaveLength(1);
    await act(async () => finish({ member: { ...member, frontId: "tea_pending", version: 4 } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
