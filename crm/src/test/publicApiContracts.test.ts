import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicApi } from '../../../web/src/lib/publicApi';

const endpoint = 'https://api.example.test/graphql';
const fetchMock = vi.fn();
const response = (field: string, data: unknown) => ({ ok: true, json: async () => ({ data: { [field]: data } }) });
beforeEach(async () => {
  vi.resetModules(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PUBLIC_CRM_API_URL', endpoint); vi.stubEnv('PUBLIC_CRM_API_KEY', 'public-test-key');
  vi.stubEnv('PUBLIC_HOA_MIGRATION_PREVIEW', 'false');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('keeps disclosure requests credential-free and suppresses private GraphQL text', async () => {
  const disclosure = await import('../../../web/src/lib/brokerFeeDisclosure');
  fetchMock.mockResolvedValue(response('brokerFeeDisclosure', { ok: true, state: 'closed', reason: 'Link expired' }));
  await disclosure.loadBrokerFeeDisclosure('private-token');
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: 'Private account details' }] }) });
  await expect(disclosure.loadBrokerFeeDisclosure('private-token')).rejects.toThrow('This disclosure request could not be completed. Please retry.');
});
it('preserves enquiry identity, its 40s timeout, and one explicit write attempt', async () => {
  const lead = await import('../../../web/src/lib/crmLead');
  fetchMock.mockRejectedValue(new Error('Network response lost'));
  await expect(lead.submitCrmLead({ name: 'Example HOA' }, { submissionId: 'same-submission', retryProof: 'same-proof' })).rejects.toThrow('Network response lost');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toMatchObject({ submissionId: 'same-submission', retryProof: 'same-proof' });
});
it('does not call the network when migration-preview writes are disabled', async () => {
  vi.stubEnv('PUBLIC_HOA_MIGRATION_PREVIEW', 'true');
  await expect(publicApi('mutation Test { field }', {}, 'field', { url: endpoint, key: 'public-test-key', configurationError: 'Missing' })).rejects.toThrow('viewing-only');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('preserves upload content type and close-window keepalive without repeating either mutation', async () => {
  const lead = await import('../../../web/src/lib/crmLead');
  fetchMock.mockResolvedValueOnce(response('requestLeadUpload', JSON.stringify({ ok: true, uploadUrl: 'https://files.example.test/signed' })))
    .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(response('closeLeadUploadWindow', { ok: true }));
  const file = new File(['document'], 'loss-runs.pdf', { type: 'application/pdf' });
  await lead.uploadLeadFile('same-token', file);
  expect(fetchMock.mock.calls[1]).toEqual(['https://files.example.test/signed', expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file })]);
  await lead.closeLeadUploads('same-token', { keepalive: true });
  expect(fetchMock.mock.calls[2][1]).toMatchObject({ keepalive: true });
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).variables).toEqual({ uploadToken: 'same-token' });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
