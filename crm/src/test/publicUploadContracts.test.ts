import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readPortalStatus, readUploadDestination, type PortalStatus } from '../../../shared/publicUploads';

const status = (): PortalStatus => ({
  associationName: 'Fictional HOA', expiresAt: '2026-12-01T00:00:00Z', uploadCount: 2,
  maxFiles: 20, full: false, sections: [{ key: 'policies', label: 'Policies', help: 'Current policies', received: 1 }],
});
const fetchMock = vi.fn();
const response = (field: string, data: unknown) => ({ ok: true, json: async () => ({ data: { [field]: data } }) });
beforeEach(() => {
  vi.resetModules(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PUBLIC_CRM_API_URL', 'https://api.example.test/graphql');
  vi.stubEnv('PUBLIC_CRM_API_KEY', 'fictional-public-key');
  vi.stubEnv('PUBLIC_HOA_MIGRATION_PREVIEW', 'false');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('projects status and section fields without carrying private extensions into page state', () => {
  const input = { ...status(), accountId: 'private-account', contact: { email: 'private@example.test' }, address: 'Private address',
    sections: [{ ...status().sections[0], documentId: 'private-document', documentName: 'Private.pdf' }] };
  const result = readPortalStatus(input);
  expect(result).toEqual(status());
  expect(result).not.toBe(input);
  expect(result?.sections[0]).not.toBe(input.sections[0]);
});

it.each([
  { associationName: null }, { expiresAt: 123 }, { full: 'false' },
  { uploadCount: -1 }, { uploadCount: 1.5 }, { uploadCount: Number.MAX_SAFE_INTEGER + 1 },
  { maxFiles: -1 }, { maxFiles: Number.POSITIVE_INFINITY }, { sections: null },
  { sections: [{ key: 'policies', label: 'Policies', help: null, received: 1 }] },
  { sections: [{ key: 'policies', label: 'Policies', help: 'Help', received: -1 }] },
  { sections: [{ key: 'policies', label: 'Policies', help: 'Help', received: 0.5 }] },
])('rejects malformed checklist fields: %j', patch => {
  expect(readPortalStatus({ ...status(), ...patch })).toBeUndefined();
});

it('preserves the existing status contract for empty strings, empty sections and zero counts', () => {
  const legacy = { associationName: '', expiresAt: '', uploadCount: 0, maxFiles: 0, full: false, sections: [] };
  expect(readPortalStatus(legacy)).toEqual(legacy);
});

it('requires every displayed checklist field without inventing missing values', () => {
  for (const key of Object.keys(status())) {
    const input: Record<string, unknown> = { ...status() };
    delete input[key];
    expect(readPortalStatus(input), key).toBeUndefined();
  }
});

it.each([(value: unknown) => value, JSON.stringify, (value: unknown) => JSON.stringify(JSON.stringify(value))])('consumes the producer status through each supported AWSJSON encoding', async encode => {
  const portal = await import('../../../web/src/lib/uploadPortal');
  fetchMock.mockResolvedValue(response('uploadPortalStatus', encode({ ok: true, ...status(), accountId: 'private' })));
  expect(await portal.fetchPortalStatus('same-token')).toEqual(status());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({ token: 'same-token' });
});

it('retains the status error for malformed responses and handler refusals', async () => {
  const portal = await import('../../../web/src/lib/uploadPortal');
  fetchMock.mockResolvedValueOnce(response('uploadPortalStatus', { ok: true, ...status(), uploadCount: '2' }))
    .mockResolvedValueOnce(response('uploadPortalStatus', { ok: false, error: 'That upload link is no longer active.' }));
  await expect(portal.fetchPortalStatus('token')).rejects.toThrow('The server sent back something unreadable.');
  await expect(portal.fetchPortalStatus('token')).rejects.toThrow('That upload link is no longer active.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('validates only the receipt destination the browser uses, not unused or legacy metadata', () => {
  expect(readUploadDestination({ uploadUrl: 'https://files.example.test/signed' })).toEqual({ uploadUrl: 'https://files.example.test/signed' });
  expect(readUploadDestination({ uploadUrl: 'https://files.example.test/signed', documentId: null, uploadCount: 'legacy', category: {} }))
    .toEqual({ uploadUrl: 'https://files.example.test/signed' });
});
it.each([undefined, {}, { uploadUrl: null }, { uploadUrl: 'http://files.example.test/signed' },
  { uploadUrl: 'javascript:alert(1)' }, { uploadUrl: 'https://name:password@files.example.test/signed' }])('rejects an unusable destination: %j', value => {
  expect(readUploadDestination(value)).toBeUndefined();
});

it.each(['lead', 'portal'] as const)('keeps %s URL-only receipts compatible and PUT headers unchanged', async kind => {
  const lead = await import('../../../web/src/lib/crmLead');
  const portal = await import('../../../web/src/lib/uploadPortal');
  const file = new File(['document'], 'policy.pdf', { type: 'application/pdf' });
  fetchMock.mockResolvedValueOnce(response(kind === 'lead' ? 'requestLeadUpload' : 'requestPortalUpload', { ok: true, uploadUrl: 'https://files.example.test/signed' }))
    .mockResolvedValueOnce({ ok: true });
  await (kind === 'lead' ? lead.uploadLeadFile('same-token', file) : portal.uploadPortalFile('same-token', 'policies', file));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]).toEqual(['https://files.example.test/signed', { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file }]);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({
    ...(kind === 'lead' ? { uploadToken: 'same-token' } : { token: 'same-token', documentKey: 'policies' }),
    filename: 'policy.pdf', contentType: 'application/pdf', sizeBytes: file.size,
  });
});

it.each(['lead', 'portal'] as const)('does not PUT or repeat a %s reservation when its destination is malformed', async kind => {
  const lead = await import('../../../web/src/lib/crmLead');
  const portal = await import('../../../web/src/lib/uploadPortal');
  fetchMock.mockResolvedValue(response(kind === 'lead' ? 'requestLeadUpload' : 'requestPortalUpload', { ok: true, documentId: 'd1', uploadCount: 1, uploadUrl: 'http://unsafe.test' }));
  const file = new File(['document'], 'policy.pdf');
  await expect(kind === 'lead' ? lead.uploadLeadFile('token', file) : portal.uploadPortalFile('token', 'policies', file))
    .rejects.toThrow(kind === 'lead' ? "We couldn't accept that file." : "The server didn't give us anywhere to put it.");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps close-window fail-soft and preview mode network-free', async () => {
  const lead = await import('../../../web/src/lib/crmLead');
  const portal = await import('../../../web/src/lib/uploadPortal');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    fetchMock.mockRejectedValue(new Error('Lost response'));
    await expect(lead.closeLeadUploads('token', { keepalive: true })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    fetchMock.mockClear(); vi.stubEnv('PUBLIC_HOA_MIGRATION_PREVIEW', 'true');
    await expect(portal.fetchPortalStatus('token')).rejects.toThrow('viewing-only');
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});
