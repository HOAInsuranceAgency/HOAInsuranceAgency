import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), send: vi.fn() }));
vi.mock("../lib/marketingReports", () => ({ loadMarketingReports: h.load, saveMarketingReports: h.save, sendMarketingReport: h.send }));
import MarketingReportSettings from "../components/MarketingReportSettings";
import type { MarketingReportSettingsSnapshot } from "../../../shared/marketingReportSettings";
import { enableLiveUpdates, invalidateLiveUpdates } from './liveUpdates';
import { liveUpdates } from '../lib/liveUpdates';

const snapshot = (): MarketingReportSettingsSnapshot => ({
  settings: { version: 2, enabled: true, recipient: "marketing@example.com" },
  environment: "main", schedule: { day: "Friday", time: "08:00", timeZone: "America/New_York" }, recentRuns: [],
});
const run = { id: "run-1", kind: "manual" as const, status: "queued" as const, recipient: "marketing@example.com", asOf: "2026-09-28T17:00:00Z", createdAt: "2026-09-28T17:00:00Z", updatedAt: "2026-09-28T17:00:00Z" };
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); h.load.mockResolvedValue(snapshot()); h.save.mockResolvedValue(snapshot()); h.send.mockResolvedValue({ run }); });
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("marketing report controls", () => {
  it("shows the Eastern schedule and does not send on load", async () => {
    render(<MarketingReportSettings />);
    expect(await screen.findByText(/Every Friday at 8:00 a.m. Eastern/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send now" })).toBeEnabled();
    expect(h.send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Refresh status' })).not.toBeInTheDocument();
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
    await invalidateLiveUpdates(['CRM']);
    expect(h.send).toHaveBeenCalledTimes(1);
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
    await invalidateLiveUpdates(['CRM']);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
    expect(screen.getByLabelText('Recipient email')).toHaveValue('new@example.com');
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
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
  await invalidateLiveUpdates(['CRM']);
  expect(h.load).toHaveBeenCalledTimes(2);
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
  await invalidateLiveUpdates(['CRM']);
  await screen.findByText(/Email a fresh Excel snapshot to other@example.com/);
  expect(screen.getByLabelText('Recipient email')).toHaveValue('mine@example.com');
  h.save.mockRejectedValue(new Error('Settings changed. Refresh before saving.'));
  fireEvent.submit(screen.getByRole('form', { name: 'Marketing report settings' }));
  await screen.findByText('Settings changed. Refresh before saving.');
  expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ version: 2, recipient: 'mine@example.com' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.getByLabelText('Recipient email')).toHaveValue('other@example.com');
});

it('checks queued delivery after four seconds without automatically sending another report', async () => {
  vi.useFakeTimers(); enableLiveUpdates();
  h.load.mockResolvedValueOnce({ ...snapshot(), recentRuns: [run] });
  h.load.mockResolvedValue({ ...snapshot(), recentRuns: [{ ...run, status: 'sent', sentAt: '2026-09-28T17:01:00Z' }] });
  render(<MarketingReportSettings />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Report in progress…' })).toBeDisabled();
  expect(h.load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
  expect(h.load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(h.load).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Sent')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  expect(h.send).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
});

it('checks an idle settings snapshot on the sixty-second fallback and adopts clean external changes', async () => {
  vi.useFakeTimers(); enableLiveUpdates();
  h.load.mockResolvedValueOnce(snapshot()).mockResolvedValue({ ...snapshot(), settings: { version: 3, enabled: false, recipient: 'updated@example.com' } });
  render(<MarketingReportSettings />);
  await act(async () => {});
  expect(screen.getByLabelText('Recipient email')).toHaveValue('marketing@example.com');
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(h.load).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(h.load).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Recipient email')).toHaveValue('updated@example.com');
  expect(screen.getByLabelText('Send automatically every Friday')).not.toBeChecked();
  expect(h.send).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
});

it('retains a stale snapshot after a transient live read failure and requires a successful retry before sending', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  h.load.mockRejectedValueOnce(new Error('Report status temporarily unavailable'));
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByLabelText('Recipient email')).toHaveValue('marketing@example.com');
  expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Report status temporarily unavailable');
  fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled());
  expect(h.send).not.toHaveBeenCalled();
});

it('clears private settings and history when a live read loses authorization', async () => {
  h.load.mockResolvedValueOnce({ ...snapshot(), recentRuns: [{ ...run, status: 'sent', sentAt: '2026-09-28T17:01:00Z' }] });
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  expect(screen.getByRole('region', { name: 'Marketing report delivery history' })).toHaveTextContent('marketing@example.com');
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'private-draft@example.com' } });
  h.load.mockRejectedValueOnce(Object.assign(new Error('Your access is inactive.'), { name: 'Unauthorized' }));
  await invalidateLiveUpdates(['CRM']);
  expect(screen.queryByLabelText('Recipient email')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Marketing report delivery history' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Your access is inactive.');
});

it('does not let a pending pre-denial status callback resurrect private data or replace a successful retry', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  const oldRead = deferred<MarketingReportSettingsSnapshot>();
  h.load.mockReturnValueOnce(oldRead.promise);
  await invalidateLiveUpdates(['CRM']);
  act(() => liveUpdates.deny(Object.assign(new Error('Access denied'), { name: 'Unauthorized' })));
  expect(screen.queryByLabelText('Recipient email')).not.toBeInTheDocument();
  h.load.mockResolvedValueOnce({ ...snapshot(), settings: { version: 8, enabled: true, recipient: 'restored@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
  await waitFor(() => expect(screen.getByLabelText('Recipient email')).toHaveValue('restored@example.com'));
  await act(async () => { oldRead.resolve({ ...snapshot(), recentRuns: [run] }); });
  expect(screen.getByLabelText('Recipient email')).toHaveValue('restored@example.com');
  expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  expect(screen.queryByText('Preparing')).not.toBeInTheDocument();
  expect(h.send).not.toHaveBeenCalled();
});

it('keeps a denied settings screen private when its earlier read succeeds before any retry', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  const oldRead = deferred<MarketingReportSettingsSnapshot>();
  h.load.mockReturnValueOnce(oldRead.promise);
  await invalidateLiveUpdates(['CRM']);
  act(() => liveUpdates.deny(Object.assign(new Error('Access denied'), { name: 'Unauthorized' })));
  await act(async () => { oldRead.resolve({ ...snapshot(), recentRuns: [run] }); });
  expect(screen.queryByLabelText('Recipient email')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Marketing report delivery history' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Access denied');
  expect(h.send).not.toHaveBeenCalled();
});

it('reuses an acknowledged queued request after a temporary history omission and starts a new request only after a terminal read', async () => {
  render(<MarketingReportSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Send now' }));
  await screen.findByText('Preparing');
  const firstRequest = h.send.mock.calls[0][0];
  expect(firstRequest).toEqual(expect.any(String));

  // The index can briefly omit the already acknowledged run. A deliberate
  // second click must still refer to that same server-owned operation.
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByText('No reports have been sent yet.')).toBeVisible();
  expect(h.send).toHaveBeenCalledTimes(1);
  h.load.mockResolvedValue({ ...snapshot(), recentRuns: [run] });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await screen.findByText('Preparing');
  expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.send.mock.calls[1][0]).toBe(firstRequest);

  h.load.mockResolvedValue({ ...snapshot(), recentRuns: [{ ...run, status: 'sent', updatedAt: '2026-09-28T17:01:00Z', sentAt: '2026-09-28T17:01:00Z' }] });
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByText('Sent')).toBeVisible();
  expect(h.send).toHaveBeenCalledTimes(2);
  h.send.mockResolvedValueOnce({ run: { ...run, id: 'run-2', createdAt: '2026-09-28T17:02:00Z', updatedAt: '2026-09-28T17:02:00Z' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await screen.findByText('Preparing');
  expect(h.send).toHaveBeenCalledTimes(3);
  expect(h.send.mock.calls[2][0]).not.toBe(firstRequest);
});

it('advances the confirmed save version while preserving a newer edit received during the save', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'submitted@example.com' } });
  const saving = deferred<MarketingReportSettingsSnapshot>();
  h.save.mockReturnValueOnce(saving.promise);
  fireEvent.submit(screen.getByRole('form', { name: 'Marketing report settings' }));
  expect(h.save).toHaveBeenCalledWith({ version: 2, enabled: true, recipient: 'submitted@example.com' });
  expect(screen.getByLabelText('Recipient email')).toBeDisabled();
  // Model an already queued input event; normal browser interaction is
  // disabled, but its late callback still cannot be silently discarded.
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'newer@example.com' } });
  await act(async () => { saving.resolve({ ...snapshot(), settings: { version: 3, enabled: true, recipient: 'submitted@example.com' } }); });
  expect(screen.getByLabelText('Recipient email')).toHaveValue('newer@example.com');
  expect(screen.getByText(/Email a fresh Excel snapshot to submitted@example.com/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
  h.save.mockResolvedValueOnce({ ...snapshot(), settings: { version: 4, enabled: true, recipient: 'newer@example.com' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Marketing report settings' }));
  await waitFor(() => expect(h.save).toHaveBeenNthCalledWith(2, { version: 3, enabled: true, recipient: 'newer@example.com' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled());
  expect(h.send).not.toHaveBeenCalled();
});

it('does not regress a terminal run to an index-lagged queued state with the same update timestamp', async () => {
  h.load.mockResolvedValueOnce({ ...snapshot(), recentRuns: [{ ...run, status: 'sent', sentAt: '2026-09-28T17:00:00Z' }] });
  render(<MarketingReportSettings />);
  await screen.findByText('Sent');
  h.load.mockResolvedValue({ ...snapshot(), recentRuns: [run] });
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByText('Sent')).toBeVisible();
  expect(screen.queryByText('Preparing')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  expect(h.send).not.toHaveBeenCalled();
});

it('invalidates a pending retry on a second transport denial so its later success cannot restore private data', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  enableLiveUpdates();
  act(() => liveUpdates.deny(Object.assign(new Error('First access denial'), { name: 'Unauthorized' })));
  expect(screen.queryByLabelText('Recipient email')).not.toBeInTheDocument();
  const retry = deferred<MarketingReportSettingsSnapshot>();
  h.load.mockReturnValueOnce(retry.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(h.load).toHaveBeenCalledTimes(2);
  act(() => liveUpdates.deny(Object.assign(new Error('Access remains inactive'), { name: 'Unauthorized' })));
  await act(async () => { retry.resolve({ ...snapshot(), settings: { version: 9, enabled: true, recipient: 'private-stale-retry@example.com' }, recentRuns: [run] }); });
  expect(screen.queryByLabelText('Recipient email')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Marketing report delivery history' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Access remains inactive');
  expect(h.send).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
});

it('treats a reverted recipient as pristine and adopts externally saved settings before the next manual send', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'temporary@example.com' } });
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: 'marketing@example.com' } });
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  const recipient = 'external@example.com';
  h.load.mockResolvedValue({ ...snapshot(), settings: { version: 3, enabled: true, recipient } });
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByLabelText('Recipient email')).toHaveValue(recipient);
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  expect(screen.getByText(/Email a fresh Excel snapshot to external@example.com/)).toBeVisible();
  expect(h.save).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  h.send.mockResolvedValueOnce({ run: { ...run, recipient } });
  h.load.mockResolvedValue({ ...snapshot(), settings: { version: 3, enabled: true, recipient }, recentRuns: [{ ...run, recipient }] });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await screen.findByText('Preparing');
  expect(screen.getByRole('region', { name: 'Marketing report delivery history' })).toHaveTextContent(recipient);
  expect(h.send).toHaveBeenCalledTimes(1);
});

it('immediately releases an edited draft when discarding values that already match the newest server settings', async () => {
  render(<MarketingReportSettings />);
  await screen.findByRole('button', { name: 'Send now' });
  const originalEdits = liveUpdates.getSnapshot().edits;
  const recipient = 'same-new-recipient@example.com';
  fireEvent.change(screen.getByLabelText('Recipient email'), { target: { value: recipient } });
  expect(liveUpdates.getSnapshot().edits).toBeGreaterThan(originalEdits);
  h.load.mockResolvedValue({ ...snapshot(), settings: { version: 3, enabled: true, recipient } });
  await invalidateLiveUpdates(['CRM']);
  expect(screen.getByText(/Email a fresh Excel snapshot to same-new-recipient@example.com/)).toBeVisible();
  expect(screen.getByLabelText('Recipient email')).toHaveValue(recipient);
  expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled();
  const reads = h.load.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  // The field values need no DOM change, but adopting the confirmed baseline
  // must still update the rendered dirty state and release its global fence.
  expect(screen.getByLabelText('Recipient email')).toHaveValue(recipient);
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send now' })).toBeEnabled();
  expect(liveUpdates.getSnapshot().edits).toBe(originalEdits);
  expect(h.load).toHaveBeenCalledTimes(reads);
  expect(h.save).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
});
