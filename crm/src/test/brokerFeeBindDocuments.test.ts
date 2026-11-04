import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { BROKER_FEE_TERMS_VERSION, type BrokerFeeAgreement } from '../../../shared/brokerFees';
import { matchesLink } from '../lib/documentLinks';

const h = vi.hoisted(() => ({
  agreements: vi.fn(), fee: vi.fn(), getAgreement: vi.fn(), getModel: vi.fn(),
  rows: new Map<string, Record<string, any>>(),
}));
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  table: () => 'Fees', modelTable: (model: string) => model,
  accountAgreements: h.agreements, getFee: h.fee, getAgreement: h.getAgreement, getModel: h.getModel,
}));
import { brokerFeeBindWrites } from '../../amplify/functions/broker-fees/bindValidation';
import type { Write } from '../../amplify/functions/broker-fees/store';

const now = '2026-11-04T15:00:00.000Z';
const zero = { id: 'zero', accountId: 'a', premium: 12000, brokerFee: 0, billType: 'DIRECT', commissionPct: 10,
  carrierId: 'carrier', lines: ['Property'], effectiveDate: '2026-12-01', expirationDate: '2027-12-01' };
const positive = { ...zero, id: 'fee', brokerFee: 500, billType: 'AGENCY' };
const rule = { approved: true, version: 'v1', reviewedAt: now, reviewedBy: 'Owner', evidenceUrl: 'https://regulator.example.test/fees',
  allowedLines: ['Property'], allowedBillTypes: ['AGENCY'], allowsCarrierCommission: true, maxFeeCents: null, forms: [] };
function agreement(id = 'bfa_combined', signedAt = now): BrokerFeeAgreement {
  return { id, kind: 'AGREEMENT', accountId: 'a', accountName: 'Cedar HOA', jurisdiction: 'MA', createdAt: now,
    expiresAt: '2026-11-18T15:00:00.000Z', totalCents: 50000, termsVersion: `${BROKER_FEE_TERMS_VERSION}:v1`,
    purpose: 'Placement', refundTerms: 'Earned at bind', stateForms: [], version: 1,
    quotes: [positive, zero].map(quote => ({ ...quote, terms: authorizedQuoteTerms(quote) })),
    signature: { name: 'Board Signer', email: 'board@example.test', role: 'Trustee', consent: true, signedAt },
    signedDocumentId: `doc-${id}`,
  };
}
function seedDocument(value: BrokerFeeAgreement) {
  h.rows.set(`Document:${value.signedDocumentId}`, { id: value.signedDocumentId, entityType: 'ACCOUNT', entityId: 'a',
    category: 'BROKER_FEE_DISCLOSURE', brokerFeeAgreementId: value.id, quoteIds: ['fee', 'zero'], policyIds: [], updatedAt: '2026-11-04T14:00:00.000Z' });
}
/** Apply the real generated writes only after every optimistic condition passes. */
function apply(writes: Write[]) {
  for (const write of writes) {
    if (write.Update) {
      const update = write.Update, current = h.rows.get(`${update.TableName}:${update.Key!.id}`), values = update.ExpressionAttributeValues!;
      if (!current || current.updatedAt !== values[':old'] || current.entityId !== values[':account']) throw new Error('Document changed');
    }
  }
  for (const write of writes) {
    if (write.Put) h.rows.set(`${write.Put.TableName}:${write.Put.Item!.id}`, structuredClone(write.Put.Item!));
    if (write.Update) {
      const update = write.Update, values = update.ExpressionAttributeValues!, key = `${update.TableName}:${update.Key!.id}`;
      h.rows.set(key, { ...h.rows.get(key), policyIds: values[':ids'], updatedAt: values[':now'] });
    }
  }
}
beforeEach(() => {
  vi.resetAllMocks(); h.rows.clear();
  vi.stubEnv('BROKER_FEE_TABLE', 'Fees');
  const combined = agreement();
  h.agreements.mockResolvedValue([combined]); h.getAgreement.mockResolvedValue(combined);
  h.rows.set('Account:a', { id: 'a', name: 'Cedar HOA', state: 'MA', updatedAt: now });
  h.rows.set('AgencySettings:AGENCY', { id: 'AGENCY', brokerFeeJurisdictions: { MA: rule }, updatedAt: now });
  h.rows.set('Fees:fee:fee', { id: 'fee:fee', kind: 'FEE', accountId: 'a', quoteId: 'fee', amountCents: 50000,
    terms: authorizedQuoteTerms(positive), agreementId: combined.id, signedAt: now, version: 1,
    submittedCents: 50000, collectedCents: 0, refundedCents: 0 });
  h.fee.mockImplementation(async id => structuredClone(h.rows.get(`Fees:fee:${id}`)));
  h.getModel.mockImplementation(async (model, id) => structuredClone(h.rows.get(`${model}:${id}`)));
  seedDocument(combined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('combined signed disclosure policy links', () => {
  it('binds mixed fee and fee-free terms to the same single signed document without a second fee or payment requirement', async () => {
    apply(await brokerFeeBindWrites(positive, 'policy-fee', 'AGENCY'));
    h.getModel.mockClear(); h.fee.mockClear();
    // Fee-free coverage can still bind when broker-fee settings have since been disabled.
    h.rows.delete('AgencySettings:AGENCY');
    const writes = await brokerFeeBindWrites(zero, 'policy-zero', 'DIRECT');
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ ConditionCheck: { TableName: 'Fees', Key: { id: 'bfa_combined' }, ExpressionAttributeValues: { ':v': 1 } } });
    expect(writes[1]).toMatchObject({ Update: { ExpressionAttributeValues: { ':account': 'a', ':agreement': 'bfa_combined', ':category': 'BROKER_FEE_DISCLOSURE' } } });
    apply(writes);
    const documents = [...h.rows.entries()].filter(([key]) => key.startsWith('Document:')).map(([, row]) => row);
    expect(documents).toHaveLength(1);
    expect(documents[0].policyIds).toEqual(['policy-fee', 'policy-zero']);
    expect(matchesLink(documents[0], 'policy:policy-fee')).toBe(true);
    expect(matchesLink(documents[0], 'policy:policy-zero')).toBe(true);
    expect([...h.rows.keys()].filter(key => key.startsWith('Fees:fee:'))).toEqual(['Fees:fee:fee']);
    expect(h.fee).not.toHaveBeenCalled();
    expect(h.getModel).not.toHaveBeenCalledWith('AgencySettings', expect.anything());
  });

  it.each(['absent', 'unsigned', 'changed terms', 'different account', 'changed insured', 'wrong document'])('leaves ordinary fee-free binding unchanged for %s disclosure evidence', async variant => {
    const value = agreement();
    if (variant === 'absent') h.agreements.mockResolvedValue([]);
    else {
      if (variant === 'unsigned') delete value.signature;
      if (variant === 'changed terms') value.quotes[1].terms = authorizedQuoteTerms({ ...zero, premium: 13000 });
      if (variant === 'different account') value.accountId = 'other';
      if (variant === 'changed insured') h.rows.get('Account:a')!.legalName = 'Different HOA';
      if (variant === 'wrong document') h.rows.get('Document:doc-bfa_combined')!.brokerFeeAgreementId = 'another';
      h.agreements.mockResolvedValue([value]);
    }
    expect(await brokerFeeBindWrites(zero, 'new-policy', 'DIRECT')).toEqual([]);
    expect(h.fee).not.toHaveBeenCalled();
  });

  it('links only the latest signed matching agreement and ignores newer stale or unsigned copies', async () => {
    const old = agreement('bfa_old', '2026-11-01T15:00:00Z'), latest = agreement('bfa_latest', '2026-11-02T15:00:00Z');
    const stale = agreement('bfa_stale', '2026-11-03T15:00:00Z'), unsigned = agreement('bfa_unsigned');
    stale.quotes[1].terms = 'changed'; delete unsigned.signature;
    for (const value of [old, latest, stale, unsigned]) seedDocument(value);
    h.agreements.mockResolvedValue([old, stale, latest, unsigned]);
    const writes = await brokerFeeBindWrites(zero, 'policy-zero', 'DIRECT');
    expect(writes[1]).toMatchObject({ Update: { Key: { id: 'doc-bfa_latest' } } });
  });

  it('retains an independently linked policy after an optimistic conflict and normal bind retry', async () => {
    const stale = await brokerFeeBindWrites(zero, 'policy-zero', 'DIRECT');
    h.rows.get('Document:doc-bfa_combined')!.policyIds = ['policy-other'];
    h.rows.get('Document:doc-bfa_combined')!.updatedAt = '2026-11-04T14:30:00.000Z';
    expect(() => apply(stale)).toThrow('Document changed');
    apply(await brokerFeeBindWrites(zero, 'policy-zero', 'DIRECT'));
    expect(h.rows.get('Document:doc-bfa_combined')!.policyIds).toEqual(['policy-other', 'policy-zero']);
  });
});
