import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicApi } from '../../../web/src/lib/publicApi';
import { isFinanceElectionTerms } from '../../../shared/financeElection';

const endpoint = 'https://api.example.test/graphql';
const fetchMock = vi.fn();
let finance: typeof import('../../../web/src/lib/financeElection');
const offer = () => ({ ok: true, state: 'open', associationName: 'Example HOA', premium: 10000, months: 11, apr: 10, downPayment: 1000, amountFinanced: 9000, payment: 860, totalInterest: 460, originationFee: 100, brokerFee: 500, initialPaymentAmount: 1600, effectiveDate: '2026-12-01', agreementTerms: ['Reviewed agreement'], agreementSignedName: null, agreementSignedRole: null });
const response = (field: string, data: unknown) => ({ ok: true, json: async () => ({ data: { [field]: data } }) });
beforeEach(async () => {
  vi.resetModules(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PUBLIC_CRM_API_URL', endpoint); vi.stubEnv('PUBLIC_CRM_API_KEY', 'public-test-key');
  vi.stubEnv('PUBLIC_HOA_MIGRATION_PREVIEW', 'false');
  finance = await import('../../../web/src/lib/financeElection');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([(value: unknown) => value, JSON.stringify, (value: unknown) => JSON.stringify(JSON.stringify(value))])('decodes public finance terms and preserves separate upfront fees', async encode => {
  fetchMock.mockResolvedValue(response('financeElectionTerms', encode(offer())));
  expect(await finance.fetchElectionTerms('private-link-token')).toMatchObject({ state: 'open', initialPaymentAmount: 1600, brokerFee: 500, amountFinanced: 9000 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('retains compatibility with an offer before the explicit initial-payment field was added', async () => {
  const { initialPaymentAmount: _initial, ...legacy } = offer();
  fetchMock.mockResolvedValue(response('financeElectionTerms', legacy));
  expect((await finance.fetchElectionTerms('token')).initialPaymentAmount).toBe(1600);
});
it('preserves the financing-only flag and exact final payment in grouped terms', async () => {
  fetchMock.mockResolvedValue(response('financeElectionTerms', { ...offer(), financingOnly: true, brokerFee: 0, finalPayment: 859.99 }));
  expect(await finance.fetchElectionTerms('token')).toMatchObject({ state: 'open', financingOnly: true, finalPayment: 859.99 });
  expect(isFinanceElectionTerms({ ...offer(), financingOnly: true })).toBe(false);
});
it.each([
  { downPayment: 0.005, originationFee: 0.005, brokerFee: 0, expected: 0.01 },
  { downPayment: 1.005, originationFee: 10, brokerFee: 0, expected: 11.004999999999999 },
  { downPayment: 0.1, originationFee: 0.2, brokerFee: 0, expected: 0.30000000000000004 },
])('preserves the unrounded legacy offer fallback: %j', async ({ expected, ...amounts }) => {
  const { initialPaymentAmount: _initial, ...legacy } = offer();
  fetchMock.mockResolvedValue(response('financeElectionTerms', { ...legacy, ...amounts }));
  expect((await finance.fetchElectionTerms('token')).initialPaymentAmount).toBe(expected);
});
it.each([0, 1.2345])('uses the explicit server initial payment unchanged (%s)', async initialPaymentAmount => {
  fetchMock.mockResolvedValue(response('financeElectionTerms', {
    ...offer(), downPayment: 0.005, originationFee: 0.005, brokerFee: 0, initialPaymentAmount,
  }));
  expect((await finance.fetchElectionTerms('token')).initialPaymentAmount).toBe(initialPaymentAmount);
});
it.each([{ ...offer(), state: 'invented' }, { ...offer(), payment: '860' }, { ...offer(), premium: Number.NaN }, { ...offer(), months: -1 }])('refuses malformed financing data rather than displaying invented figures', async value => {
  expect(isFinanceElectionTerms(value)).toBe(false);
  fetchMock.mockResolvedValue(response('financeElectionTerms', value));
  await expect(finance.fetchElectionTerms('token')).rejects.toThrow('unreadable');
});
it('accepts closed terms without financial or identity details', async () => {
  fetchMock.mockResolvedValue(response('financeElectionTerms', { ok: true, state: 'closed', reason: 'Ask your agent for a new offer.' }));
  expect(await finance.fetchElectionTerms('token')).toMatchObject({ state: 'closed', reason: 'Ask your agent for a new offer.', premium: 0 });
});
it('keeps acceptance explicit and validates its redirect result without retrying a write', async () => {
  fetchMock.mockResolvedValue(response('acceptFinanceElection', { ok: true, state: 'checkout', url: 'https://checkout.stripe.com/c/pay/test' }));
  expect(await finance.acceptElection('token', { name: 'Board Treasurer', role: 'Treasurer' })).toEqual({ state: 'checkout', url: 'https://checkout.stripe.com/c/pay/test', reason: null });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.variables).toEqual({ token: 'token', accept: true, signerName: 'Board Treasurer', signerRole: 'Treasurer' });
  fetchMock.mockResolvedValue(response('acceptFinanceElection', { ok: true, state: 'checkout', url: 'javascript:alert(1)' }));
  await expect(finance.acceptElection('token')).rejects.toThrow('unreadable');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('redacts public GraphQL details while allowing reviewed handler refusals', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: 'Private account 123: token=secret', errorType: 'Unauthorized' }] }) });
  let failure: unknown;
  try { await finance.fetchElectionTerms('token'); } catch (error) { failure = error; }
  expect(failure).toEqual(new Error('The server refused that request. Please retry.'));
  expect(JSON.stringify(failure)).not.toContain('secret');
  fetchMock.mockResolvedValue(response('financeElectionTerms', { ok: false, error: 'This offer expired. Contact your agent.' }));
  await expect(finance.fetchElectionTerms('token')).rejects.toThrow('This offer expired. Contact your agent.');
});
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
