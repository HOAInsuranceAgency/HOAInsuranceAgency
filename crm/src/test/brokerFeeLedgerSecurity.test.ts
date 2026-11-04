import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commissionPolicy, line, statement } from './commissionFixtures';
import { appendEntry, type CommissionPolicy } from '../../../shared/commissions';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { BROKER_FEE_TERMS_VERSION, type BrokerFeeAgreement, type BrokerFeeRecord } from '../../../shared/brokerFees';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  rows: new Map<string, Row>(), models: new Map<string, Row>(), ledger: new Map<string, CommissionPolicy>(),
  transact: vi.fn(), commit: vi.fn(), session: vi.fn(), s3: vi.fn(), db: vi.fn(),
  deactivate: vi.fn(), sessions: vi.fn(), expire: vi.fn(),
}));
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  getRow: async (id: string) => structuredClone(h.rows.get(id)),
  getFee: async (id: string) => structuredClone(h.rows.get(`fee:${id}`)),
  getAgreement: async (id: string) => structuredClone(h.rows.get(id)),
  getModel: async (model: string, id: string) => structuredClone(h.models.get(`${model}:${id}`)),
  accountModels: async (model: string, accountId: string) => structuredClone([...h.models.entries()].filter(([key, value]) => key.startsWith(`${model}:`) && value.accountId === accountId).map(([, value]) => value)),
  transact: h.transact, db: { send: h.db },
}));
vi.mock('../../amplify/functions/commissions/store', () => ({
  get: async (_kind: string, id: string) => structuredClone(h.ledger.get(id)), commit: h.commit,
}));
vi.mock('../../amplify/functions/crm-access/user-status', async original => ({ ...await original<typeof import('../../amplify/functions/crm-access/user-status')>(), assertUserSession: h.session }));
vi.mock('@aws-sdk/client-s3', async original => ({
  ...await original<typeof import('@aws-sdk/client-s3')>(), S3Client: class { send = h.s3; },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://documents.invalid/signed.pdf' }));
vi.mock('../../amplify/functions/broker-fees/disclosurePdf', () => ({ createBrokerFeeDisclosurePdf: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]) }) }));
vi.mock('stripe', () => ({ default: class {
  paymentLinks = { update: h.deactivate };
  checkout = { sessions: { list: h.sessions, expire: h.expire } };
} }));

import { syncBrokerFeePayment, reconcileQuotePayments } from '../../amplify/functions/broker-fees/payments';
import { brokerFeeBindWrites } from '../../amplify/functions/broker-fees/bindValidation';
import { confirmInvoicePayment } from '../../amplify/functions/broker-fees/manualPayment';
import { saveJurisdiction } from '../../amplify/functions/broker-fees/settings';
import { handler } from '../../amplify/functions/broker-fees/handler';
import { AccountAccess } from '../../amplify/functions/crm-access/access';

const clone = <T,>(value: T): T => structuredClone(value);
const owner = { identity: { sub: 'owner', groups: ['OWNER'] }, request: { headers: { 'x-crm-role': 'OWNER' } } };
const quote: Row = { id: 'q', accountId: 'a', carrierId: 'c', carrierName: 'Carrier', premium: 10000, commissionPct: 10,
  brokerFee: 500, billType: 'AGENCY', lines: ['Property'], status: 'QUOTED', effectiveDate: '2026-10-01', expirationDate: '2027-10-01', updatedAt: '2026-10-01T12:00:00Z' };
const rule = { approved: true, version: 'v1', reviewedAt: '2026-09-01T12:00:00Z', reviewedBy: 'reviewer', evidenceUrl: 'https://regulator.invalid/fee-rules',
  allowedLines: ['Property'], allowedBillTypes: ['AGENCY', 'DIRECT'], allowsCarrierCommission: true, maxFeeCents: null,
  forms: [{ title: 'Approved state disclosure', paragraphs: ['The approved state-specific fee terms.'] }] };
const token = 't'.repeat(43);
const terms = () => authorizedQuoteTerms(quote);
const fee = () => h.rows.get('fee:q') as BrokerFeeRecord;
const payment = () => [...h.rows.values()].find(row => row.kind === 'PAYMENT')!;
const entries = () => h.ledger.get('p')!.entries;

/** A generic staged transaction fake: errors apply no writes. Assertions below
 * inspect the real generated transaction items as well as resulting balances. */
function applyWrites(writes: readonly Row[]) {
  const rows = clone(h.rows), models = clone(h.models);
  for (const write of writes) {
    const action = write.Put || write.Update || write.ConditionCheck;
    const key = action?.Key?.id ?? action?.Key?.userId ?? action?.Item?.id;
    if (!action || !key) throw new Error('Unrecognized test transaction');
    const current = action.TableName === 'fee-table' ? rows.get(key) : models.get(`${action.TableName}:${key}`);
    const values = action.ExpressionAttributeValues ?? {};
    if ((action.ConditionExpression ?? '').includes('#v = :v')) {
      const field = action.ExpressionAttributeNames?.['#v'];
      if (current?.[field] !== values[':v']) throw Object.assign(new Error('Version changed'), { name: 'TransactionCanceledException' });
    }
    if (write.Put && action.ConditionExpression === 'attribute_not_exists(id)' && current) throw Object.assign(new Error('Duplicate'), { name: 'TransactionCanceledException' });
    if (write.Put) {
      if (action.TableName === 'fee-table') rows.set(key, clone(action.Item));
      else models.set(`${action.TableName}:${key}`, clone(action.Item));
    }
    if (write.Update && action.TableName === 'Policy') models.set(`Policy:${key}`, { ...current, brokerFeeCollected: values[':gross'], brokerFeeRefunded: values[':refund'], brokerFeeCollectedAt: values[':at'] });
    if (write.Update && action.TableName === 'Invoice') {
      if (current?.updatedAt !== values[':old'] || current?.status !== values[':status']) throw Object.assign(new Error('Invoice changed'), { name: 'TransactionCanceledException' });
      const invoice: Row = { ...current, status: values[':paid'], paidAt: values[':date'], updatedAt: values[':now'], lastWriteBy: values[':actor'] };
      delete invoice.paymentUrl; delete invoice.brokerFeeFinanceUrl;
      models.set(`Invoice:${key}`, invoice);
    }
    if (write.Update && action.TableName === 'AgencySettings') models.set(`AgencySettings:${key}`, { ...current, brokerFeeJurisdictions: values[':rules'], brokerFeeJurisdictionsVersion: values[':next'], updatedAt: values[':now'] });
  }
  h.rows.clear(); rows.forEach((value, key) => h.rows.set(key, value));
  h.models.clear(); models.forEach((value, key) => h.models.set(key, value));
}

function seedSigned(bound = true) {
  const frozen = { ...quote, terms: terms() };
  const agreement: BrokerFeeAgreement = { id: 'agreement', kind: 'AGREEMENT', accountId: 'a', accountName: 'Cedar HOA', createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-11-14T12:00:00Z',
    quotes: [frozen as any], totalCents: 50000, termsVersion: `${BROKER_FEE_TERMS_VERSION}:v1`, purpose: 'Placement', refundTerms: 'Earned at bind; legally required refunds preserved.',
    jurisdiction: 'MA', stateForms: clone(rule.forms), version: 1,
    signature: { name: 'Board Signer', email: 'board@example.test', role: 'Trustee', consent: true, signedAt: '2026-10-01T12:00:00Z' }, signedDocumentId: 'doc', signedDocumentKey: 'documents/ACCOUNT/a/doc/signed.pdf' };
  h.rows.set('agreement', agreement);
  h.rows.set(`token:${createHash('sha256').update(token).digest('hex')}`, { id: `token:${createHash('sha256').update(token).digest('hex')}`, agreementId: 'agreement', expiresAt: agreement.expiresAt, version: 1 });
  h.rows.set('fee:q', { id: 'fee:q', kind: 'FEE', accountId: 'a', quoteId: 'q', amountCents: 50000, terms: terms(), version: 1,
    agreementId: 'agreement', signedAt: agreement.signature!.signedAt, ...(bound ? { policyId: 'p' } : {}), submittedCents: 0, collectedCents: 0, refundedCents: 0 });
  h.models.set('Quote:q', clone(quote));
  h.models.set('Account:a', { id: 'a', name: 'Cedar HOA', state: 'MA', updatedAt: quote.updatedAt });
  h.models.set('AgencySettings:AGENCY', { id: 'AGENCY', brokerFeeJurisdictions: { MA: clone(rule) }, brokerFeeJurisdictionsVersion: 1, updatedAt: quote.updatedAt });
  h.models.set('Document:doc', { id: 'doc', entityId: 'a', entityType: 'ACCOUNT', category: 'BROKER_FEE_DISCLOSURE', policyIds: [], updatedAt: quote.updatedAt, s3Key: agreement.signedDocumentKey });
  h.models.set('Policy:p', { id: 'p', accountId: 'a', quoteId: 'q', brokerFee: 500, premium: 10000, commissionPct: 10, effectiveDate: quote.effectiveDate, expirationDate: quote.expirationDate });
  h.ledger.set('p', { ...commissionPolicy(), brokerFeeCents: 50000, producerBps: 4000 });
}

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  h.rows.clear(); h.models.clear(); h.ledger.clear();
  process.env.BROKER_FEE_TABLE = 'fee-table'; process.env.SITE_URL = 'https://agency.example.test'; process.env.STRIPE_SECRET_KEY = 'fixture';
  process.env.ACCESS_TABLES = JSON.stringify(Object.fromEntries(['Account','Quote','Policy','Invoice','InvoiceLine','Document','AgencySettings','Communication'].map(name => [name, name])));
  process.env.COMMUNICATION_TABLE = 'Communication';
  process.env.USER_ACCESS_TABLE = 'TeamUser';
  process.env.ACCESS_INDEXES = JSON.stringify({ 'InvoiceLine.invoiceId': 'invoice-lines' });
  delete process.env.HOA_MIGRATION_PREVIEW; delete process.env.HOA_MIGRATION_BUSINESS_HELD;
  h.session.mockResolvedValue(undefined); h.s3.mockResolvedValue({}); h.db.mockResolvedValue({ Items: [] }); h.deactivate.mockResolvedValue({ active: false });
  h.sessions.mockImplementation(async function* () {});
  h.transact.mockImplementation(async writes => applyWrites(writes));
  h.commit.mockImplementation(async (changes, _actor, extras) => {
    for (const change of changes) if (h.ledger.get(change.value.id)?.version !== change.previous.version) throw Object.assign(new Error('Ledger changed'), { name: 'TransactionCanceledException' });
    applyWrites(extras ?? []);
    for (const change of changes) h.ledger.set(change.value.id, clone({ ...change.value, version: change.previous.version + 1 }));
  });
  seedSigned();
  h.models.set('InvoiceLine:fee-line', { id: 'fee-line', invoiceId: 'i', accountId: 'a', kind: 'BROKER_FEE', brokerFeeQuoteId: 'q', retailAmount: 500, costAmount: 0, updatedAt: quote.updatedAt });
  h.db.mockImplementation(async command => ({ Items: command.input?.TableName === 'InvoiceLine' ? [{ id: 'fee-line' }] : [] }));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const sync = (status: 'PROCESSING' | 'PAID' | 'FAILED' | 'REFUNDED', extra: Row = {}) => syncBrokerFeePayment({ sourceId: 'pi-one', accountId: 'a', allocations: [{ quoteId: 'q', amountCents: 50000 }], status, ...extra });

describe('broker fee receipt and compensation ledger', () => {
  it('records submission without earnings, then uses actual settlement date and frozen producer rate once', async () => {
    await sync('PROCESSING', { receivedOn: '2026-10-01' });
    expect(fee()).toMatchObject({ submittedCents: 50000, collectedCents: 0 }); expect(entries()).toHaveLength(0);
    await sync('PAID', { receivedOn: '2026-10-04' });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ revenueKind: 'BROKER_FEE', receivedOn: '2026-10-04', agencyCents: 50000, producerCents: 20000 });
    await sync('PAID', { receivedOn: '2026-10-05' });
    await sync('PROCESSING', { receivedOn: '2026-10-01' });
    await sync('FAILED', { receivedOn: '2026-10-02' });
    expect(entries()).toHaveLength(1); expect(fee()).toMatchObject({ collectedCents: 50000, submittedCents: 50000 });
    expect(payment()).toMatchObject({ status: 'PAID', receivedOn: '2026-10-04' });
    expect(h.models.get('Policy:p')).toMatchObject({ brokerFeeCollected: 500, brokerFeeRefunded: 0 });
  });

  it('defers a settled prebind fee until a frozen producer policy exists, then recovers once', async () => {
    delete fee().policyId;
    await sync('PAID', { receivedOn: '2026-10-04' });
    expect(entries()).toHaveLength(0); expect(payment().pending).toBe('PENDING');
    h.rows.set('fee:q', { ...fee(), policyId: 'p', version: fee().version + 1 });
    await reconcileQuotePayments('q'); await reconcileQuotePayments('q');
    expect(entries()).toHaveLength(1); expect(entries()[0].producerCents).toBe(20000); expect(payment().pending).toBeUndefined();
  });

  it('rejects a second payment source without creating extra earnings or mutating the fee balance', async () => {
    await sync('PAID', { receivedOn: '2026-10-04' });
    await expect(syncBrokerFeePayment({ sourceId: 'pi-duplicate', accountId: 'a', allocations: [{ quoteId: 'q', amountCents: 50000 }], status: 'PAID', receivedOn: '2026-10-05' })).rejects.toThrow('Duplicate');
    expect(entries()).toHaveLength(1); expect(fee().collectedCents).toBe(50000); expect([...h.rows.values()].filter(row => row.kind === 'PAYMENT')).toHaveLength(1);
  });

  it('recovers a durable fee receipt once after payroll allocation storage fails', async () => {
    h.commit.mockRejectedValueOnce(new Error('Payroll storage unavailable'));
    await expect(sync('PAID', { receivedOn: '2026-10-04' })).rejects.toThrow('Payroll storage unavailable');
    expect(fee().collectedCents).toBe(50000); expect(entries()).toHaveLength(0); expect(payment().pending).toBe('PENDING');
    await sync('PAID', { receivedOn: '2026-10-04' });
    await reconcileQuotePayments('q');
    expect(entries()).toHaveLength(1); expect(payment().pending).toBeUndefined();
  });

  it('records the frozen amount actually collected during a concurrent quote edit and holds binding for current terms', async () => {
    delete fee().policyId;
    const edited = { ...quote, brokerFee: 600 };
    h.models.set('Quote:q', edited);
    await sync('PAID', { receivedOn: '2026-10-04' });
    expect(fee()).toMatchObject({ amountCents: 50000, collectedCents: 50000 });
    expect(entries()).toHaveLength(0);
    await expect(brokerFeeBindWrites(edited, 'p', 'AGENCY')).rejects.toThrow('current');
  });

  it('retains the actual refund date and original producer allocation despite delayed delivery or a later rate change', async () => {
    await sync('PAID', { receivedOn: '2026-10-01' });
    h.ledger.set('p', { ...h.ledger.get('p')!, producerBps: 9000 });
    await sync('REFUNDED', { receivedOn: '2026-10-10', refundedCents: 10000 });
    expect(entries()[1]).toMatchObject({ kind: 'REVERSAL', receivedOn: '2026-10-10', agencyCents: -10000, producerCents: -4000, originalId: entries()[0].id });
    await sync('REFUNDED', { receivedOn: '2026-10-09', refundedCents: 5000 });
    expect(entries()).toHaveLength(2); expect(fee().refundedCents).toBe(10000);
    expect(h.models.get('Policy:p')).toMatchObject({ brokerFeeCollected: 500, brokerFeeRefunded: 100 });
  });

  it('does not invent a settlement from a refund-first webhook and recovers the original receipt date later', async () => {
    await sync('REFUNDED', { receivedOn: '2026-10-10', refundedCents: 10000 });
    expect(entries()).toHaveLength(0);
    await sync('PAID', { receivedOn: '2026-10-01' });
    expect(entries()).toHaveLength(2);
    expect(entries()[0]).toMatchObject({ kind: 'RECEIPT', receivedOn: '2026-10-01', agencyCents: 50000 });
    expect(entries()[1]).toMatchObject({ kind: 'REVERSAL', receivedOn: '2026-10-10', agencyCents: -10000 });
  });

  it('rounds fee earnings independently from carrier commission and never multiplies the fee by the carrier rate', async () => {
    const policy = { ...commissionPolicy(), producerBps: 5000 };
    const carrier = appendEntry(policy, line({ agencyCents: 1 }), statement(), 'carrier-cent');
    const combined = appendEntry(carrier, line({ agencyCents: 1, revenueKind: 'BROKER_FEE' }), statement(), 'fee-cent');
    expect(combined.entries.map(entry => entry.producerCents)).toEqual([1, 1]);
    expect(combined.entries.map(entry => entry.agencyCents)).toEqual([1, 1]);
  });

  it('does not partially mark an outside-payment invoice paid when fee transaction storage fails', async () => {
    h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'SENT', updatedAt: '2026-10-01T12:00:00Z', brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }], paymentUrl: 'https://buy.stripe.com/fixture' });
    vi.spyOn(AccountAccess.prototype, 'requireRecord').mockImplementation(async (model, id) => clone(h.models.get(`${model}:${id}`)!));
    vi.spyOn(AccountAccess.prototype, 'get').mockImplementation(async (model, id) => clone(h.models.get(`${model}:${id}`)));
    h.transact.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(confirmInvoicePayment(owner, { invoiceId: 'i' })).rejects.toThrow('Storage unavailable');
    expect(h.models.get('Invoice:i')?.status).toBe('SENT'); expect(entries()).toHaveLength(0); expect(fee().collectedCents).toBe(0);
    await confirmInvoicePayment(owner, { invoiceId: 'i' });
    expect(h.transact.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ kind: 'PAYMENT' }) }) })]));
    expect(h.models.get('Invoice:i')).toMatchObject({ status: 'PAID', lastWriteBy: 'broker-fee-manual-payment' });
    await confirmInvoicePayment(owner, { invoiceId: 'i' }); expect(entries()).toHaveLength(1);
  });

  it('does not mint a manual receipt for an invoice already paid online and refuses a submitted online checkout', async () => {
    h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'PAID', updatedAt: quote.updatedAt, lastWriteBy: 'stripe', brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }] });
    vi.spyOn(AccountAccess.prototype, 'requireRecord').mockImplementation(async (model, id) => clone(h.models.get(`${model}:${id}`)!));
    vi.spyOn(AccountAccess.prototype, 'get').mockImplementation(async (model, id) => clone(h.models.get(`${model}:${id}`)));
    await confirmInvoicePayment(owner, { invoiceId: 'i' }); expect(h.transact).not.toHaveBeenCalled();
    h.models.set('Invoice:i', { ...h.models.get('Invoice:i'), status: 'SENT', stripePaymentLinkId: 'plink' });
    h.sessions.mockImplementation(async function* () { yield { id: 'cs-paid', status: 'complete', payment_status: 'unpaid' }; });
    await expect(confirmInvoicePayment(owner, { invoiceId: 'i' })).rejects.toThrow('already been submitted');
    expect(h.transact).not.toHaveBeenCalled(); expect(entries()).toHaveLength(0);
  });

  it('dates an outside payment by the agency day rather than the following UTC day', async () => {
    vi.setSystemTime(new Date('2026-11-05T01:00:00Z'));
    h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'SENT', updatedAt: quote.updatedAt, brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }] });
    vi.spyOn(AccountAccess.prototype, 'requireRecord').mockImplementation(async (model, id) => clone(h.models.get(`${model}:${id}`)!));
    vi.spyOn(AccountAccess.prototype, 'get').mockImplementation(async (model, id) => clone(h.models.get(`${model}:${id}`)));
    await confirmInvoicePayment(owner, { invoiceId: 'i' });
    expect(h.models.get('Invoice:i')?.paidAt).toBe('2026-11-04');
    expect(entries()[0].receivedOn).toBe('2026-11-04');
  });
});

describe('bind, state configuration, and browser guards', () => {
  it('requires a current signed disclosure and submitted payment while preserving zero-fee legacy binds', async () => {
    expect(await brokerFeeBindWrites({ ...quote, brokerFee: 0 }, 'new-policy', 'DIRECT')).toEqual([]);
    await expect(brokerFeeBindWrites(quote, 'p', 'AGENCY')).rejects.toThrow('submitted');
    await sync('PROCESSING', { receivedOn: '2026-10-01' });
    const writes = await brokerFeeBindWrites(quote, 'p', 'AGENCY');
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ id: 'fee:q', policyId: 'p' }), ConditionExpression: '#v = :v' }) }),
      expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'fee-table', Key: { id: 'agreement' } }) }),
      expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'AgencySettings', Key: { id: 'AGENCY' } }) }),
    ]));
    await expect(brokerFeeBindWrites(quote, 'p', 'DIRECT')).rejects.toThrow('billing method');
    await expect(brokerFeeBindWrites({ ...quote, brokerFee: 501 }, 'p', 'AGENCY')).rejects.toThrow('current');
    h.rows.set('fee:q', { ...fee(), refundedCents: 100 });
    await expect(brokerFeeBindWrites(quote, 'p', 'AGENCY')).rejects.toThrow('submitted');
  });

  it('rejects an old signature after current state forms or the insured identity change', async () => {
    await sync('PROCESSING');
    const settings = h.models.get('AgencySettings:AGENCY')!;
    settings.brokerFeeJurisdictions.MA.forms = [{ title: 'Replacement form', paragraphs: ['Changed legal terms'] }];
    await expect(brokerFeeBindWrites(quote, 'p', 'AGENCY')).rejects.toThrow('requirements changed');
    settings.brokerFeeJurisdictions.MA = clone(rule);
    h.models.get('Account:a')!.legalName = 'Different legal entity';
    await expect(brokerFeeBindWrites(quote, 'p', 'AGENCY')).rejects.toThrow('insured or jurisdiction');
  });

  it('takes public signing amounts and state only from stored current agreement sources', async () => {
    delete h.rows.get('agreement')!.signature; delete h.rows.get('agreement')!.signedDocumentId;
    delete fee().policyId; delete fee().signedAt;
    const result = await handler({ fieldName: 'signBrokerFeeDisclosure', arguments: { token, signerName: 'Board Signer', signerEmail: 'board@example.test', signerRole: 'Trustee', consent: true,
      state: 'FL', accountId: 'attacker-account', totalCents: 1, brokerFee: 0, quotes: [{ id: 'attack', brokerFee: 0 }] } });
    expect(result).toMatchObject({ ok: true, state: 'signed', totalCents: 50000, quotes: [{ id: 'q', brokerFee: 500 }] });
    expect(h.rows.get('agreement')).toMatchObject({ jurisdiction: 'MA', accountId: 'a', totalCents: 50000 });
    expect(JSON.stringify(result)).not.toContain('commissionPct'); expect(JSON.stringify(result)).not.toContain('producerBps');
  });

  it('requires an active verified administrator and optimistic version when configuring jurisdictions', async () => {
    const staff = { identity: { sub: 'owner', groups: ['OWNER', 'STAFF'] }, request: { headers: { 'x-crm-role': 'STAFF' } } };
    await expect(saveJurisdiction(staff, { state: 'MA', version: 1, rule })).rejects.toThrow('administrator');
    await expect(saveJurisdiction(owner, { state: 'MA', version: 0, rule })).rejects.toThrow('changed');
    await expect(saveJurisdiction(owner, { state: 'ZZ', version: 1, rule })).rejects.toThrow('US state');
    const result = await saveJurisdiction(owner, { state: 'MA', version: 1, rule: { ...rule, version: 'v2', requiresBrokerSignature: true,
      agencySigner: { name: 'Agency Signer', title: 'Owner', licenseNumber: 'license', authorized: true, authorizedBy: 'spoofed-actor', authorizedAt: '2020-01-01' } } });
    expect(result).toMatchObject({ version: 2, rules: { MA: { agencySigner: { authorizedBy: 'owner', authorizedAt: '2026-11-04T15:00:00.000Z' } } } });
  });

  it('retains paid quote sources for receipt recovery and later refunds', async () => {
    await sync('PAID', { receivedOn: '2026-10-04' });
    const access = new AccountAccess(owner.identity, async (model, id) => clone(h.models.get(`${model}:${id}`)), owner.request);
    await expect(access.write('Quote', 'delete', { id: 'q' })).rejects.toThrow();
  });

  it('allows an internal agency-commission correction without changing the accepted client fee terms', async () => {
    await sync('PAID', { receivedOn: '2026-10-04' });
    const access = new AccountAccess(owner.identity, async (model, id) => clone(h.models.get(`${model}:${id}`)), owner.request);
    await expect(access.write('Quote', 'update', { id: 'q', commissionPct: 20 })).resolves.toBeUndefined();
    expect(await brokerFeeBindWrites({ ...quote, commissionPct: 20 }, 'p', 'AGENCY')).not.toHaveLength(0);
  });

  it('requires current client agreement when the state disclosure expressly includes insurer-paid agency commission', async () => {
    await sync('PROCESSING');
    h.models.get('AgencySettings:AGENCY')!.brokerFeeJurisdictions.MA.discloseCarrierCommission = true;
    const frozen = h.rows.get('agreement')!.quotes[0];
    frozen.agencyCommissionPct = 10; frozen.agencyCommissionCents = 100000;
    await expect(brokerFeeBindWrites({ ...quote, commissionPct: 20 }, 'p', 'AGENCY')).rejects.toThrow('disclosed insurer commission changed');
    const result = await handler({ fieldName: 'brokerFeeDisclosure', arguments: { token } });
    expect(result).toMatchObject({ ok: true, quotes: [{ agencyCommissionPct: 10, agencyCommissionCents: 100000 }] });
    expect((result as any).quotes[0]).not.toHaveProperty('producerBps');
  });

  it.each(['PAID', 'PROCESSING'])('does not let a browser reopen a %s invoice to alter fee allocations', async status => {
    h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status, brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }] });
    const access = new AccountAccess(owner.identity, async (model, id) => clone(h.models.get(`${model}:${id}`)), owner.request);
    await expect(access.write('Invoice', 'update', { id: 'i', status: 'DRAFT' })).rejects.toThrow();
  });

  it.each(['OWNER', 'PRODUCER'])('denies %s browser writes to signed evidence, processor state and frozen policy money', async role => {
    h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'SENT' });
    const access = new AccountAccess({ sub: 'producer', groups: [role] }, async (model, id) => {
      if (model === 'Communication' && id === 'workflow:a') return { data: { salespersonId: 'producer' } };
      return clone(h.models.get(`${model}:${id}`));
    });
    for (const patch of [{ brokerFee: 1 }, { brokerFeeCollected: 500 }, { brokerFeeRefunded: 100 }, { premium: 9999 }]) await expect(access.write('Policy', 'update', { id: 'p', ...patch })).rejects.toThrow();
    for (const op of ['create', 'update', 'delete']) await expect(access.write('Document', op, { id: 'doc', ...(op === 'create' ? { category: 'BROKER_FEE_DISCLOSURE' } : {}) })).rejects.toThrow('preserved');
    await expect(access.path('documents/ACCOUNT/a/doc/signed.pdf', 'delete')).rejects.toThrow('cannot be replaced');
    await expect(access.write('Invoice', 'update', { id: 'i', status: 'PAID' })).rejects.toThrow('payment action');
    await expect(access.write('AgencySettings', 'update', { id: 'AGENCY', brokerFeeJurisdictions: {} })).rejects.toThrow('Agency settings');
  });

  it.each([
    ['Quote', 'q', { brokerFee: -1 }],
    ['Invoice', 'i', { status: 'PAID' }],
    ['Policy', 'p', { brokerFeeCollected: 500 }],
    ['Document', 'doc', { category: 'BROKER_FEE_DISCLOSURE' }],
  ] as const)('checks foreign %s access before revealing fee metadata or financial validation', async (model, id, patch) => {
    h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'SENT' });
    const access = new AccountAccess({ sub: 'unassigned-producer', groups: ['PRODUCER'] }, async (kind, key) => clone(h.models.get(`${kind}:${key}`)));
    await expect(access.write(model, 'update', { id, ...patch })).rejects.toThrow('This record is not available to your account');
  });
});
