import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packageTerms } from '../../../shared/quotePackages';

const h = vi.hoisted(() => ({
  records: new Map<string, any>(), rows: new Map<string, any>(),
  errors: new Map<string, string[]>(),
  quote: vi.fn(), carrier: vi.fn(), account: vi.fn(),
  active: { Quote: 0, Carrier: 0 }, peak: { Quote: 0, Carrier: 0 },
  reverse: false,
}));
vi.mock('../../amplify/functions/communications/data', () => ({
  dataClient: async () => ({ models: {
    Account: { get: h.account }, Quote: { get: h.quote }, Carrier: { get: h.carrier },
  } }),
}));
vi.mock('../../amplify/functions/communications/store', async original => ({
  ...await original<typeof import('../../amplify/functions/communications/store')>(),
  get: async (id: string) => {
    const value = h.rows.get(id);
    return value && structuredClone(value);
  },
}));
import { deliverySourceChecks, loadDeliverySource } from '../../amplify/functions/communications/businessDeliverySources';
import { row } from '../../amplify/functions/communications/store';

const NOW = '2026-11-04T16:00:00.000Z';
const selection = { accountId: 'a1', kind: 'PACKAGE' as const, recordId: 'option', documentIds: [] };
const quoteIds = Array.from({ length: 25 }, (_, i) => `q${String(i).padStart(2, '0')}`).reverse();
function review() {
  h.rows.set('commercial:a1', row('COMMERCIAL_PLAN', 'commercial:a1', {
    accountId: 'a1', version: 1, estimatedCents: null, requiredLines: ['Property'], selectedOptionId: null,
    options: [{ id: 'option', name: 'Reviewed package', quoteIds: [...quoteIds], reviewed: {
      at: NOW, by: 'actor', terms: Object.fromEntries(quoteIds.map(id => [id, packageTerms(h.records.get(`Quote:${id}`))])),
    } }],
  }, { accountId: 'a1' }));
}
async function modelRead(model: 'Quote' | 'Carrier', id: string, options?: { selectionSet?: readonly string[] }) {
  h.active[model]++; h.peak[model] = Math.max(h.peak[model], h.active[model]);
  const n = Number(id.replace(/\D/g, '')) || 0;
  await new Promise(resolve => setTimeout(resolve, 1 + (h.reverse ? 4 - n % 5 : n % 5)));
  h.active[model]--;
  const value = h.records.get(`${model}:${id}`);
  // Honor projection, so omitting a review/fence field cannot pass the test.
  const data = value ? structuredClone(options?.selectionSet
    ? Object.fromEntries(options.selectionSet.filter(key => key in value).map(key => [key, value[key]]))
    : value) : null;
  return { data, errors: h.errors.get(`${model}:${id}`) };
}
async function load() {
  // Observe rejections before advancing timers, including a failed in-flight batch.
  const settled = loadDeliverySource(selection).then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  h.records.clear(); h.rows.clear(); h.errors.clear(); h.reverse = false;
  h.active = { Quote: 0, Carrier: 0 }; h.peak = { Quote: 0, Carrier: 0 };
  h.quote.mockReset().mockImplementation(({ id }, options) => modelRead('Quote', id, options));
  h.carrier.mockReset().mockImplementation(({ id }, options) => modelRead('Carrier', id, options));
  h.account.mockReset().mockImplementation(async ({ id }) => ({ data: structuredClone(h.records.get(`Account:${id}`)) }));
  h.records.set('Account:a1', { id: 'a1', name: 'Synthetic HOA', updatedAt: NOW });
  h.records.set('Carrier:c1', { id: 'c1', name: 'Carrier 1', updatedAt: NOW });
  for (const [i, id] of quoteIds.entries()) h.records.set(`Quote:${id}`, {
    id, accountId: 'a1', carrierId: 'c1', status: 'QUOTED', premium: 1000 + i, commissionPct: 15,
    notes: `Private review note ${id}`, lines: ['Property'], effectiveDate: '2027-01-01', expirationDate: '2028-01-01',
    offerExpiresAt: '2026-12-20', perOccurrenceDeductible: i + 500, blanketLimit: 1_000_000, updatedAt: NOW,
  });
  for (const model of ['ACCOUNT', 'QUOTE', 'CARRIER']) vi.stubEnv(`${model}_TABLE`, model);
  vi.stubEnv('COMMUNICATION_TABLE', 'Communication');
  review();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('bounded package source reads', () => {
  it('loads 25 offers concurrently in bounded groups and reads a shared carrier once', async () => {
    const source = await load();
    expect(h.quote).toHaveBeenCalledTimes(25);
    expect(h.peak.Quote).toBe(5);
    expect(h.active.Quote).toBe(0);
    expect(h.carrier).toHaveBeenCalledExactlyOnceWith({ id: 'c1' }, { selectionSet: ['id', 'name', 'updatedAt'] });
    expect(source.quotes.map(q => q.id)).toEqual(quoteIds);
    expect(source.versions.filter(v => v.model === 'CARRIER')).toEqual([{ model: 'CARRIER', id: 'c1', updatedAt: NOW }]);
    expect(source.versions).toHaveLength(27); // Account, 25 quotes, one carrier.
    expect(deliverySourceChecks(source)).toHaveLength(28); // Plus commercial-plan version.
    const fields = h.quote.mock.calls[0][1].selectionSet;
    expect(fields).toEqual(expect.arrayContaining(['id', 'accountId', 'updatedAt', 'status', 'commissionPct', 'notes', 'offerExpiresAt', 'renewalPolicyId', 'perOccurrenceDeductible', 'minimumEarnedPremiumPct']));
    expect(fields).not.toContain('account'); expect(fields).not.toContain('invoices');
    expect(JSON.stringify({ facts: source.facts, quotes: source.quotes })).not.toContain('Private review note');
    expect(source.quotes[0]).not.toHaveProperty('commissionPct');
  });

  it('keeps public order, version order, reviewed terms and fingerprint stable under reversed completion', async () => {
    for (const [i, id] of quoteIds.entries()) {
      const carrierId = `c${i % 7}`;
      h.records.get(`Quote:${id}`).carrierId = carrierId;
      h.records.set(`Carrier:${carrierId}`, { id: carrierId, name: `Carrier ${i % 7}`, updatedAt: NOW });
    }
    review();
    const first = await load(); h.reverse = true;
    const second = await load();
    expect(h.peak.Carrier).toBe(5);
    expect(h.carrier).toHaveBeenCalledTimes(14); // Seven distinct carriers per independent source load.
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.facts).toEqual(first.facts);
    expect(second.versions).toEqual(first.versions);
    expect(second.quoteTerms).toEqual(first.quoteTerms);
    expect(second.quotes).toEqual(first.quotes);
    expect(second.quotes.map(q => [q.id, q.carrierName, q.premium])).toEqual(quoteIds.map((id, i) => [id, `Carrier ${i % 7}`, 1000 + i]));
    expect(second.facts.filter(f => f.startsWith('Premium:'))).toEqual(quoteIds.map((_, i) => `Premium: $${(1000 + i).toLocaleString('en-US')}.00`));
    expect(second.versions.slice(0, 5)).toEqual([
      { model: 'ACCOUNT', id: 'a1', updatedAt: NOW },
      { model: 'QUOTE', id: quoteIds[0], updatedAt: NOW }, { model: 'CARRIER', id: 'c0', updatedAt: NOW },
      { model: 'QUOTE', id: quoteIds[1], updatedAt: NOW }, { model: 'CARRIER', id: 'c1', updatedAt: NOW },
    ]);
  });

  it.each(['missing', 'wrong-account', 'wrong-id', 'partial-error'])('fails closed for a %s quote read', async variant => {
    const id = quoteIds[2], quote = h.records.get(`Quote:${id}`);
    if (variant === 'missing') h.records.delete(`Quote:${id}`);
    if (variant === 'wrong-account') quote.accountId = 'another-account';
    if (variant === 'wrong-id') quote.id = 'another-quote';
    if (variant === 'partial-error') h.errors.set(`Quote:${id}`, ['Read incomplete']);
    await expect(load()).rejects.toMatchObject({ code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
    expect(h.carrier).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong-id', 'partial-error', 'unversioned'])('fails closed for a %s carrier read', async variant => {
    if (variant === 'missing') h.records.delete('Carrier:c1');
    if (variant === 'wrong-id') h.records.get('Carrier:c1').id = 'other-carrier';
    if (variant === 'partial-error') h.errors.set('Carrier:c1', ['Read incomplete']);
    if (variant === 'unversioned') delete h.records.get('Carrier:c1').updatedAt;
    await expect(load()).rejects.toMatchObject({ code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
  });

  it.each(['notes', 'commissionPct', 'perOccurrenceDeductible', 'offerExpiresAt', 'renewalPolicyId'])('does not skip reviewed %s validation while projecting source fields', async field => {
    h.records.get(`Quote:${quoteIds[0]}`)[field] = field === 'notes' ? 'Changed private review note' : field === 'offerExpiresAt' ? '2026-12-21' : field === 'renewalPolicyId' ? 'renewal' : 99;
    await expect(load()).rejects.toMatchObject({ code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
    expect(h.carrier).not.toHaveBeenCalled();
  });

  it('retains exact fresh source conditions and changes the fingerprint when a carrier version changes', async () => {
    const preview = await load(), oldChecks = deliverySourceChecks(preview);
    const changed = '2026-11-04T16:01:00.000Z';
    h.records.get('Carrier:c1').updatedAt = changed;
    const fresh = await load();
    expect(fresh.fingerprint).not.toBe(preview.fingerprint);
    expect(oldChecks).toContainEqual({ ConditionCheck: { TableName: 'CARRIER', Key: { id: 'c1' }, ConditionExpression: 'updatedAt = :at', ExpressionAttributeValues: { ':at': NOW } } });
    expect(deliverySourceChecks(fresh)).toContainEqual({ ConditionCheck: { TableName: 'CARRIER', Key: { id: 'c1' }, ConditionExpression: 'updatedAt = :at', ExpressionAttributeValues: { ':at': changed } } });
    const firstQuote = oldChecks.find(w => w.ConditionCheck?.TableName === 'QUOTE');
    expect(firstQuote?.ConditionCheck?.Key).toEqual({ id: quoteIds[0] });
    expect(oldChecks.at(-1)?.ConditionCheck).toMatchObject({ TableName: 'Communication', Key: { id: 'commercial:a1' }, ConditionExpression: '#v = :v', ExpressionAttributeValues: { ':v': 1 } });
  });

  it('rejects an unversioned quote instead of producing an incomplete source fence', async () => {
    delete h.records.get(`Quote:${quoteIds[0]}`).updatedAt;
    await expect(load()).rejects.toMatchObject({ code: 'BUSINESS_DRAFT_NOT_DISPATCHED' });
  });

  it('retains duplicate-quote rejection and the 25-offer limit', async () => {
    h.rows.get('commercial:a1').data.options[0].quoteIds = [quoteIds[0], quoteIds[0]];
    await expect(load()).rejects.toThrow('only be counted once');
    h.quote.mockClear();
    h.rows.get('commercial:a1').data.options[0].quoteIds = [...quoteIds, 'q26'];
    await expect(load()).rejects.toThrow('reviewed package option');
    expect(h.quote).not.toHaveBeenCalled();
  });
});
