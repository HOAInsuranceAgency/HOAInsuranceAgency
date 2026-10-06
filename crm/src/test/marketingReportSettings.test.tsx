import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), send: vi.fn() }));
vi.mock("../lib/marketingReports", () => ({ loadMarketingReports: h.load, saveMarketingReports: h.save, sendMarketingReport: h.send }));
import MarketingReportSettings from "../components/MarketingReportSettings";
import type { MarketingReportSettingsSnapshot } from "../../../shared/marketingReportSettings";

const snapshot = (): MarketingReportSettingsSnapshot => ({
  settings: { version: 2, enabled: true, recipient: "marketing@example.com" },
  environment: "main", schedule: { day: "Friday", time: "08:00", timeZone: "America/New_York" }, recentRuns: [],
});
const run = { id: "run-1", kind: "manual" as const, status: "queued" as const, recipient: "marketing@example.com", asOf: "2026-09-28T17:00:00Z", createdAt: "2026-09-28T17:00:00Z", updatedAt: "2026-09-28T17:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); h.load.mockResolvedValue(snapshot()); h.save.mockResolvedValue(snapshot()); h.send.mockResolvedValue({ run }); });

describe("marketing report controls", () => {
  it("shows the Eastern schedule and does not send on load", async () => {
    render(<MarketingReportSettings />);
    expect(await screen.findByText(/Every Friday at 8:00 a.m. Eastern/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send now" })).toBeEnabled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("requires saved settings before sending to a changed recipient", async () => {
    render(<MarketingReportSettings />); await screen.findByRole("button", { name: "Send now" });
    fireEvent.change(screen.getByLabelText("Recipient email"), { target: { value: "new@example.com" } });
    expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
    h.save.mockResolvedValue({ ...snapshot(), settings: { version: 3, enabled: true, recipient: "new@example.com" } });
    fireEvent.submit(screen.getByRole("form", { name: "Marketing report settings" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledWith({ version: 2, enabled: true, recipient: "new@example.com" }));
    expect(await screen.findByText("Saved. Weekly delivery is on for Friday at 8:00 a.m. Eastern.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send now" })).toBeEnabled();
  });
  it("queues once despite repeated clicks and shows progress instead of claiming delivery", async () => {
    let finish!: (value: unknown) => void;
    h.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<MarketingReportSettings />); const button = await screen.findByRole("button", { name: "Send now" });
    fireEvent.click(button); fireEvent.click(button);
    expect(h.send).toHaveBeenCalledTimes(1);
    await act(async () => finish({ run }));
    expect(screen.getByText("Preparing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Report in progress…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Report queued");
  });
  it("reuses the request identifier after an uncertain request response", async () => {
    h.send.mockRejectedValueOnce(new Error("Connection interrupted"));
    render(<MarketingReportSettings />); fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await screen.findByText("Preparing");
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[0][0]).toEqual(h.send.mock.calls[1][0]);
  });
  it("allows manual sending while the weekly schedule is paused", async () => {
    h.load.mockResolvedValue({ ...snapshot(), settings: { ...snapshot().settings, enabled: false } });
    render(<MarketingReportSettings />);
    expect(await screen.findByRole("button", { name: "Send now" })).toBeEnabled();
    expect(screen.getByLabelText("Send automatically every Friday")).not.toBeChecked();
  });
  it("retains edits on save failure and blocks sends when status refresh fails", async () => {
    h.save.mockRejectedValue(new Error("Settings changed. Refresh before saving."));
    render(<MarketingReportSettings />); await screen.findByRole("button", { name: "Send now" });
    fireEvent.change(screen.getByLabelText("Recipient email"), { target: { value: "new@example.com" } });
    fireEvent.submit(screen.getByRole("form", { name: "Marketing report settings" }));
    await screen.findByText("Settings changed. Refresh before saving.");
    expect(screen.getByLabelText("Recipient email")).toHaveValue("new@example.com");
    h.load.mockRejectedValue(new Error("Could not refresh report status"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  });
  it("marks uncertain delivery for review without retrying automatically", async () => {
    h.load.mockResolvedValue({ ...snapshot(), recentRuns: [{ ...run, status: "unknown", error: "Check the original message before sending another copy." }] });
    render(<MarketingReportSettings />);
    expect(await screen.findByText("Delivery needs review")).toBeVisible();
    expect(h.send).not.toHaveBeenCalled();
  });
});

it('ignores a status read started before a committed recipient change', async () => {
  render(<MarketingReportSettings />); await screen.findByRole('button', { name: 'Send now' });
  let finish!: (value: unknown) => void;
  h.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'new@example.com' } });
  h.save.mockResolvedValue({ ...snapshot(), settings: { ...snapshot().settings, version: 3, recipient: 'new@example.com' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Marketing report settings' }));
  await screen.findByText('Saved. Weekly delivery is on for Friday at 8:00 a.m. Eastern.');
  await act(async () => finish(snapshot()));
  expect(screen.getByLabelText('Recipient email')).toHaveValue('new@example.com');
  expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  expect(screen.getByText(/Email a fresh Excel snapshot to new@example.com/)).toBeVisible();
});

it('preserves a dirty recipient and its original version across a status refresh', async () => {
  render(<MarketingReportSettings />); await screen.findByRole('button', { name: 'Send now' });
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'mine@example.com' } });
  h.load.mockResolvedValue({ ...snapshot(), settings: { ...snapshot().settings, version: 3, recipient: 'other@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText(/Email a fresh Excel snapshot to other@example.com/);
  expect(screen.getByLabelText('Recipient email')).toHaveValue('mine@example.com');
  h.save.mockRejectedValue(new Error('Settings changed. Refresh before saving.'));
  fireEvent.submit(screen.getByRole('form', { name: 'Marketing report settings' }));
  await screen.findByText('Settings changed. Refresh before saving.');
  expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ version: 2, recipient: 'mine@example.com' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.getByLabelText('Recipient email')).toHaveValue('other@example.com');
});
