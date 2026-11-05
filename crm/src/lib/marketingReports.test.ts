import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn(), action: vi.fn() }));
vi.mock('./client', () => ({ client: { queries: { marketingReportSettings: h.read }, mutations: { marketingReportAction: h.action } } }));
import { loadMarketingReports, saveMarketingReports, sendMarketingReport } from './marketingReports';
import { isAuthorizationError } from '../../../shared/authorizationError';

beforeEach(() => { vi.resetAllMocks(); });
it('loads settings and status only through the read operation', async () => {
  const snapshot = { ok: true, settings: { enabled: true, recipient: 'marketing@example.com', version: 4 }, recentRuns: [] };
  h.read.mockResolvedValue({ data: JSON.stringify(snapshot) });
  expect(await loadMarketingReports()).toEqual(snapshot);
  expect(h.read).toHaveBeenCalledExactlyOnceWith();
  expect(h.action).not.toHaveBeenCalled();
});
it('preserves a typed authorization denial even after another GraphQL error', async () => {
  h.read.mockResolvedValue({ errors: [{ message: 'Temporary lookup failure' }, { errorType: 'Unauthorized', message: 'Request rejected' }] });
  const error = await loadMarketingReports().catch(error => error);
  expect(error).toMatchObject({ name: 'Unauthorized', message: 'Request rejected' });
  expect(isAuthorizationError(error)).toBe(true);
  expect(h.action).not.toHaveBeenCalled();
});
it.each([
  { ok: false, error: 'Administrator access is required.' },
  { ok: false, error: 'Access denied' },
  { ok: false, error: 'Request rejected', code: 'Forbidden' },
])('keeps a returned access denial recognizable (%j)', async payload => {
  h.read.mockResolvedValue({ data: JSON.stringify(payload) });
  const error = await loadMarketingReports().catch(error => error);
  expect(isAuthorizationError(error)).toBe(true);
});
it('passes rejected signed-session envelopes through without hiding their type', async () => {
  const denied = { errors: [{ errorType: 'NoValidAuthTokens', message: 'Authentication expired' }] };
  h.read.mockRejectedValue(denied);
  const error = await loadMarketingReports().catch(error => error);
  expect(error).toBe(denied);
  expect(isAuthorizationError(error)).toBe(true);
});
it('keeps ordinary save validation separate from access denial', async () => {
  const settings = { enabled: true, recipient: 'marketing@example.com', version: 4 };
  h.action.mockResolvedValue({ data: { ok: false, error: 'Settings changed. Refresh and try again.' } });
  const error = await saveMarketingReports(settings).catch(error => error);
  expect(error.message).toBe('Settings changed. Refresh and try again.');
  expect(isAuthorizationError(error)).toBe(false);
  expect(h.action).toHaveBeenCalledExactlyOnceWith({ operation: 'save', input: JSON.stringify(settings) });
  expect(h.read).not.toHaveBeenCalled();
});
it('preserves the explicit send request identity without issuing a second request', async () => {
  const requestId = '4a9cf50b-5400-4550-9e1a-e54687552c4c';
  const run = { id: 'existing-reservation', status: 'queued' };
  h.action.mockResolvedValue({ data: { ok: true, run } });
  expect(await sendMarketingReport(requestId)).toEqual({ ok: true, run });
  expect(h.action).toHaveBeenCalledExactlyOnceWith({ operation: 'sendNow', input: JSON.stringify({ requestId }) });
  expect(h.read).not.toHaveBeenCalled();
});
