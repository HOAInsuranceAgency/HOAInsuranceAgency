import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ friendlyError: (error: Error) => error.message }));
import CommunicationSettings from "../components/CommunicationSettings";
import type { IntegrationConfig } from "../lib/communications";

const config: IntegrationConfig = {
  environment: "staging", version: 7, paused: true, cleanupEnabled: true, activatedAt: "2026-09-08T14:00:00Z",
  defaultUserId: "brian", frontSender: "staging@example.com", frontCompanyId: "cmp_test", frontInboxId: "inb_test", frontChannelId: "cha_test",
  frontSmsChannelId: "cha_sms", dialpadCompanyId: "123", dialpadOfficeId: "456", allowedInboxIds: ["inb_phone"],
  dialpadNumbers: ["+15082332261"], sharedSmsNumber: "+15082332261", holidays: ["2026-12-25"], testRecipients: ["test@example.com"],
};
const team = [{ userId: "brian", name: "Brian Cole", email: "brian@example.com", enabled: true, salesperson: true, champion: true }];
const settings = () => ({ config: { ...config }, credentialStatus: { frontToken: true }, recovery: { front: { version: 3 } }, webhookUrl: "https://example.com/", sidebarUrl: "https://example.com/sidebar" });
beforeEach(() => {
  vi.clearAllMocks();
  h.request.mockImplementation(async (op: string, input: { config?: IntegrationConfig }) => {
    if (op === "settings") return settings();
    if (op === "team") return { team };
    if (op === "saveSettings") return { config: { ...input.config, version: 8 } };
    return { ok: true };
  });
});
async function editSettings() { fireEvent.click(await screen.findByRole("button", { name: "Edit settings" })); }

describe("communication settings edit sessions", () => {
  it("keeps technical fields and repair controls out of the initial view", async () => {
    render(<CommunicationSettings />); await screen.findByRole("button", { name: "Edit settings" });
    for (const input of screen.queryAllByRole("textbox")) expect(input).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Restart Front history search" })).not.toBeVisible();
    expect(screen.getByText("Front webhook")).not.toBeVisible();
    expect(screen.getByText("Delivery paused")).toBeVisible();
    expect(screen.getByText("staging@example.com")).toBeVisible();
    expect(h.request.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["settings", "team"]));
    expect(h.request).not.toHaveBeenCalledWith("validateConnection", expect.anything(), true);
  });
  it("saves the current multiline input without blur and preserves hidden configuration", async () => {
    render(<CommunicationSettings />); await editSettings();
    fireEvent.change(screen.getByLabelText(/Test email recipients/), { target: { value: "first@example.com\nsecond@example.com, third@example.com\n" } });
    fireEvent.submit(screen.getByRole("form", { name: "Communication settings" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveSettings", {
      config: { ...config, testRecipients: ["first@example.com", "second@example.com", "third@example.com"] }, credentials: {},
    }, true));
    expect(await screen.findByText("Settings saved. Delivery remains paused.")).toBeVisible();
  });
  it("blocks activation, checks, and repairs during editing and discards cancelled input", async () => {
    render(<CommunicationSettings />); await editSettings();
    fireEvent.click(screen.getByText("Delivery and inbox cleanup"));
    fireEvent.click(screen.getByText("Advanced tools"));
    fireEvent.change(screen.getByLabelText(/Email sender/), { target: { value: "changed@example.com" } });
    expect(screen.getByRole("button", { name: "Check connections" })).toBeDisabled();
    expect(screen.getByLabelText(/I verified email/)).toBeDisabled();
    expect(screen.getByLabelText("Recovery reason")).toBeDisabled();
    fireEvent.click(screen.getByText("Secure credentials"));
    fireEvent.change(screen.getByLabelText("Front API token"), { target: { value: "discard-this-credential" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await editSettings();
    expect(screen.getByLabelText(/Email sender/)).toHaveValue(config.frontSender);
    expect(screen.getByLabelText("Front API token")).toHaveValue("");
    expect(h.request.mock.calls.some(call => call[0] === "saveSettings")).toBe(false);
  });
  it("retains edits on a failed save and uses the returned version on the next save", async () => {
    let saves = 0;
    h.request.mockImplementation(async (op: string, input: { config: IntegrationConfig }) => {
      if (op === "settings") return settings();
      if (op === "team") return { team };
      if (++saves === 1) throw new Error("Could not save. Try again.");
      return { config: { ...input.config, version: 8 } };
    });
    render(<CommunicationSettings />); await editSettings();
    fireEvent.change(screen.getByLabelText(/Test email recipients/), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(screen.getByLabelText(/Test email recipients/)).toHaveValue("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Settings saved. Delivery remains paused.");
    await editSettings();
    fireEvent.change(screen.getByLabelText(/Test email recipients/), { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.request).toHaveBeenLastCalledWith("saveSettings", expect.objectContaining({ config: expect.objectContaining({ version: 8 }) }), true));
  });
  it("prevents repeated saves while a request is pending", async () => {
    let finish!: (value: unknown) => void;
    h.request.mockImplementation((op: string) => op === "settings" ? Promise.resolve(settings()) : op === "team" ? Promise.resolve({ team }) : new Promise(resolve => { finish = resolve; }));
    render(<CommunicationSettings />); await editSettings();
    fireEvent.change(screen.getByLabelText(/Test email recipients/), { target: { value: "new@example.com" } });
    const form = screen.getByRole("form", { name: "Communication settings" });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(h.request.mock.calls.filter(call => call[0] === "saveSettings")).toHaveLength(1);
    expect(screen.getByLabelText(/Test email recipients/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => finish({ config: { ...config, version: 8 } }));
  });
});


describe("default teammate eligibility", () => {
  it("lets Jake select himself when both roles are enabled", async () => {
    const jake = { userId: "jake", name: "Jake Greasley", email: "jake@example.com", enabled: true, salesperson: true, champion: true };
    h.request.mockImplementation(async (op: string, input: { config: IntegrationConfig }) => {
      if (op === "settings") return { ...settings(), config: { ...config, defaultUserId: undefined } };
      if (op === "team") return { team: [jake] };
      return { config: { ...input.config, version: 8 } };
    });
    render(<CommunicationSettings />); await editSettings();
    const select = screen.getByRole("combobox", { name: /Default salesperson and champion/ });
    expect(screen.getByRole("option", { name: "Jake Greasley" })).toBeEnabled();
    fireEvent.change(select, { target: { value: "jake" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveSettings", { config: { ...config, defaultUserId: "jake" }, credentials: {} }, true));
    expect(await screen.findByText("Jake Greasley")).toBeVisible();
  });
  it("offers only active teammates eligible for both roles and preserves an unavailable saved choice", async () => {
    h.request.mockImplementation(async (op: string) => op === "settings" ? settings() : { team: [
      { ...team[0], champion: false },
      { ...team[0], userId: "jake", name: "Jake Greasley" },
      { ...team[0], userId: "sales", name: "Sales only", champion: false },
      { ...team[0], userId: "champ", name: "Champion only", salesperson: false },
      { ...team[0], userId: "disabled", name: "Disabled teammate", enabled: false },
    ] });
    render(<CommunicationSettings />); await editSettings();
    expect(screen.getByRole("option", { name: "Jake Greasley" })).toBeEnabled();
    expect(screen.queryByRole("option", { name: "Sales only" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Champion only" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Disabled teammate" })).toBeNull();
    expect(screen.getByRole("option", { name: "Brian Cole (unavailable)" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Default salesperson and champion/ })).toHaveValue("brian");
  });
});
