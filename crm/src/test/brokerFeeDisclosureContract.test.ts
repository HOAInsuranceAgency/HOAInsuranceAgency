import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
let disclosure: typeof import('../../../web/src/lib/brokerFeeDisclosure');
const quote = () => ({
  id: 'fictional-property', carrierName: 'Fictional carrier', lines: ['Property'],
  premium: 10_000, brokerFee: 500, billType: 'AGENCY',
  effectiveDate: '2026-12-01', expirationDate: '2027-12-01',
});
const open = () => ({
  ok: true, state: 'open', agreementId: 'fictional-agreement', accountName: 'Fictional HOA',
  purpose: 'Fictional placement and servicing terms.',
  refundTerms: 'Fictional reviewed refund terms.', totalCents: 50_000,
  quotes: [quote()], stateForms: [{ title: 'Fictional reviewed disclosure', paragraphs: ['Fictional reviewed state terms.'] }],
});
const response = (value: unknown, field = 'brokerFeeDisclosure') => ({
  ok: true, json: async () => ({ data: { [field]: value } }),
});

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PUBLIC_CRM_API_URL', 'https://api.example.test/graphql');
  vi.stubEnv('PUBLIC_CRM_API_KEY', 'fictional-public-key');
  vi.stubEnv('PUBLIC_HOA_MIGRATION_PREVIEW', 'false');
  disclosure = await import('../../../web/src/lib/brokerFeeDisclosure');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([0, -3, 100.001, '1000'])('rejects an invalid external financed amount %j before displaying a signing form', async amount => {
  fetchMock.mockResolvedValue(response({ ...open(), quotes: [{ ...quote(), ipfsAmountFinanced: amount }] }));
  await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
});

it('negotiates IPFS display support after a legacy read and uses a versioned mutation for external fee consent', async () => {
  const version = 'ipfs-v1', terms = { ...open(), quotes: [{ ...quote(), ipfsAmountFinanced: 1000 }] };
  fetchMock.mockResolvedValueOnce(response({ ok: true, state: 'closed', requiresIpfsDisclosureVersion: true })).mockResolvedValueOnce(response(terms));
  expect(await disclosure.loadBrokerFeeDisclosure('token')).toEqual(terms);
  const initial = JSON.parse(fetchMock.mock.calls[0][1].body), retry = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(initial.query).not.toContain('ipfsDisclosureVersion');
  expect(retry.query).toContain('ipfsDisclosureVersion: $ipfsDisclosureVersion'); expect(retry.variables.ipfsDisclosureVersion).toBe(version);
  fetchMock.mockResolvedValueOnce(response({ ...terms, state: 'signed', signedAt: '2026-11-22T10:00:00Z' }, 'signBrokerFeeDisclosure'));
  await disclosure.signBrokerFeeDisclosure('token', { signerName: 'Pat Manager', signerEmail: 'pat@example.test', signerRole: 'Treasurer', consent: true, ipfsDisclosureVersion: version });
  const mutation = JSON.parse(fetchMock.mock.calls[2][1].body);
  expect(mutation.query).toContain('ipfsDisclosureVersion: $ipfsDisclosureVersion'); expect(mutation.variables.ipfsDisclosureVersion).toBe(version);
});
