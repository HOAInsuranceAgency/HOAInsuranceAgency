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
const signed = () => ({
  ...open(), state: 'signed', signedAt: '2026-11-05T17:00:00.000Z',
  agencySigner: { name: 'Fictional agency signer', title: 'Principal', licenseNumber: 'fictional-license' },
  downloadUrl: 'https://files.example.test/signed-disclosure.pdf',
  payments: [{ label: 'Pay the existing invoice', url: 'https://buy.stripe.com/fictional-invoice' }],
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

it.each([(value: unknown) => value, JSON.stringify, (value: unknown) => JSON.stringify(JSON.stringify(value))])(
  'accepts complete open disclosure terms through each supported AWSJSON encoding', async encode => {
    const terms = open();
    fetchMock.mockResolvedValue(response(encode(terms)));
    expect(await disclosure.loadBrokerFeeDisclosure('fictional-token')).toEqual(terms);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it.each([0, undefined, null])('accepts a combined agreement with a charged policy and a canonical zero-fee value %s', async brokerFee => {
  const terms = { ...open(), quotes: [quote(), { ...quote(), id: 'fictional-liability', lines: ['General liability'], brokerFee }] };
  const wire = JSON.stringify(terms);
  fetchMock.mockResolvedValue(response(wire));
  const result = await disclosure.loadBrokerFeeDisclosure('fictional-token');
  expect(result).toEqual(JSON.parse(wire));
  if (brokerFee === undefined) expect(result.quotes?.[1]).not.toHaveProperty('brokerFee');
});

it('accepts a nullable coverage list when it still contains a named coverage', async () => {
  const terms = { ...open(), quotes: [{ ...quote(), lines: ['Property', null] }] };
  fetchMock.mockResolvedValue(response(terms));
  expect(await disclosure.loadBrokerFeeDisclosure('fictional-token')).toEqual(terms);
});

it('preserves signed evidence and existing payment links after one explicit signing request', async () => {
  const terms = signed();
  const signer = { signerName: 'Fictional Board Member', signerEmail: 'board@example.test', signerRole: 'Treasurer', consent: true };
  fetchMock.mockResolvedValue(response(terms, 'signBrokerFeeDisclosure'));
  expect(await disclosure.signBrokerFeeDisclosure('fictional-token', signer)).toEqual(terms);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = fetchMock.mock.calls[0][1];
  expect(request).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  expect(JSON.parse(request.body).variables).toEqual({ token: 'fictional-token', ...signer });
});

it.each(['accountName', 'agreementId', 'purpose', 'refundTerms', 'stateForms', 'quotes', 'totalCents'])(
  'refuses an open signing form when its required %s is absent', async field => {
    fetchMock.mockResolvedValue(response({ ...open(), [field]: undefined }));
    await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
  },
);

it.each(['accountName', 'agreementId', 'purpose', 'refundTerms'])(
  'refuses blank %s instead of allowing consent to missing visible terms', async field => {
    fetchMock.mockResolvedValue(response({ ...open(), [field]: '  ' }));
    await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
  },
);

it.each([
  { id: undefined }, { carrierName: undefined }, { premium: undefined }, { brokerFee: undefined },
  { effectiveDate: undefined }, { expirationDate: undefined }, { lines: undefined }, { lines: [] },
  { premium: '10000' }, { brokerFee: '500' }, { brokerFee: -1 }, { lines: ['Property', {}] },
])('refuses malformed policy display fields: %j', async patch => {
  fetchMock.mockResolvedValue(response({ ...open(), quotes: [{ ...quote(), ...patch }] }));
  await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
});

it.each([
  { agencyCommissionPct: {} }, { agencyCommissionPct: '12.5', agencyCommissionCents: 125_000 },
  { agencyCommissionPct: -1, agencyCommissionCents: 125_000 }, { agencyCommissionPct: 101, agencyCommissionCents: 125_000 },
  { agencyCommissionPct: 12.5 }, { agencyCommissionCents: 125_000 },
  { agencyCommissionPct: 12.5, agencyCommissionCents: '125000' },
  { agencyCommissionPct: 12.5, agencyCommissionCents: -1 },
  { agencyCommissionPct: 12.5, agencyCommissionCents: 125_000.5 },
])('refuses incomplete or malformed disclosed agency compensation: %j', async patch => {
  fetchMock.mockResolvedValue(response({ ...open(), quotes: [{ ...quote(), ...patch }] }));
  await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
});

it('accepts complete finite disclosed agency compensation', async () => {
  const terms = { ...open(), quotes: [{ ...quote(), agencyCommissionPct: 12.5, agencyCommissionCents: 125_000 }] };
  fetchMock.mockResolvedValue(response(terms));
  expect(await disclosure.loadBrokerFeeDisclosure('fictional-token')).toEqual(terms);
});

it.each([
  { totalCents: 49_999 }, { totalCents: 0 }, { totalCents: -1 }, { totalCents: 50_000.5 },
  { quotes: [{ ...quote(), brokerFee: 0 }] }, { quotes: [{ ...quote(), brokerFee: 500.001 }] },
])('refuses an absent or inconsistent fee obligation: %j', async patch => {
  fetchMock.mockResolvedValue(response({ ...open(), ...patch }));
  await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
});

it.each([
  { stateForms: [{ title: 'Fictional form', paragraphs: [{}] }] },
  { agencySigner: { name: 'Fictional signer', title: '', licenseNumber: 'fictional-license' } },
])('refuses malformed required state disclosures or agency signature fields: %j', async patch => {
  fetchMock.mockResolvedValue(response({ ...open(), ...patch }));
  await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
});

it.each([
  { signedAt: undefined }, { signedAt: 'invalid-date' },
  { downloadUrl: 'javascript:alert(1)' },
  { payments: [{ label: 'Pay invoice', url: 'javascript:alert(1)' }] },
])('refuses invalid signed evidence or unsafe continuation links: %j', async patch => {
  fetchMock.mockResolvedValue(response({ ...signed(), ...patch }));
  await expect(disclosure.loadBrokerFeeDisclosure('fictional-token')).rejects.toThrow('unreadable');
});

it('accepts a closed response without requiring unavailable agreement or policy details', async () => {
  const terms = { ok: true, state: 'closed', reason: 'This fictional link expired.' };
  fetchMock.mockResolvedValue(response(terms));
  expect(await disclosure.loadBrokerFeeDisclosure('fictional-token')).toEqual(terms);
});
