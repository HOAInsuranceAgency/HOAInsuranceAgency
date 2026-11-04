import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { BROKER_FEE_TERMS_VERSION } from '../../../shared/brokerFees';
type Row = Record<string, any>;
const h = vi.hoisted(() => ({ models: new Map<string, Row>(), rows: new Map<string, Row>(), sessions: [] as Row[], invoiceLineIds: ['fee-line'], intentStatus: 'requires_payment_method', events: [] as string[], transact: vi.fn(), deactivate: vi.fn(), expire: vi.fn(), retrieve: vi.fn(), session: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  modelTable: (model: string) => model,
  getModel: async (model: string, id: string) => structuredClone(h.models.get(`${model}:${id}`)),
  getRow: async (id: string) => structuredClone(h.rows.get(id)), getFee: async (id: string) => structuredClone(h.rows.get(`fee:${id}`)), getAgreement: async (id: string) => structuredClone(h.rows.get(id)),
  db: { send: async () => ({ Items: h.invoiceLineIds.map(id=>({id})) }) }, transact: h.transact,
}));
vi.mock('../../amplify/functions/crm-access/user-status', async original => ({ ...await original<typeof import('../../amplify/functions/crm-access/user-status')>(), assertUserSession: h.session }));
vi.mock('stripe', () => ({ default: class {
  paymentLinks = { update: h.deactivate }; paymentIntents = { retrieve: h.retrieve };
  checkout = { sessions: { list: async function* () { for (const session of h.sessions) yield session; }, expire: h.expire } };
} }));
import { AccountAccess } from '../../amplify/functions/crm-access/access';
import { confirmInvoicePayment } from '../../amplify/functions/broker-fees/manualPayment';
const actor = { identity: { sub: 'producer', groups: ['PRODUCER'] }, request: { headers: { 'x-crm-role': 'PRODUCER' } } };
const NOW = '2026-11-04T15:00:00Z';
const quote: Row = { id: 'q', accountId: 'a', carrierId: 'carrier', premium: 10000, commissionPct: 15, brokerFee: 500, billType: 'AGENCY', lines: ['Property'], status: 'QUOTED', effectiveDate: '2027-01-01', expirationDate: '2028-01-01', updatedAt: NOW };
const paymentRows = () => [...h.rows.values()].filter(row => row.kind === 'PAYMENT');
function issuedLoan(fields: Row = {}) {
  h.rows.get('fee:q')!.issuedLoanIds = ['loan'];
  const loan = { id: 'loan', accountId: 'a', quoteId: 'q', status: 'QUOTED', updatedAt: NOW, brokerFeeCents: 50000, brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }], ...fields };
  h.models.set('PfLoan:loan', loan);
  return loan;
}
function issuedInvoiceClaim(invoiceId = 'i', phase = 'PUBLISHED') {
  Object.assign(h.rows.get('fee:q')!, { issuedInvoiceIds: [invoiceId], invoiceSendClaim: { invoiceId, token: 'invoice-send-token', phase, totalCents: 50000, previousLinkId: null, ...(phase === 'PUBLISHED' ? { linkId: invoiceId === 'i' ? 'plink' : 'prior-plink' } : {}) } });
}

/** Stage the entire real receipt transaction before publishing any test writes. */
function applyTransaction(writes: Row[]) {
  const rows = structuredClone(h.rows), models = structuredClone(h.models);
  for (const write of writes) {
    const action = write.Put || write.Update || write.ConditionCheck, values = action.ExpressionAttributeValues || {};
    const id = action.Key?.id || action.Key?.userId || action.Item?.id;
    const old = action.TableName === 'fee-table' ? rows.get(id) : models.get(`${action.TableName}:${id}`);
    const fail = () => { throw new Error('Atomic payment transaction condition failed'); };
    if (action.ConditionExpression === 'attribute_not_exists(id)' && old) fail();
    if (action.ConditionExpression?.includes('#v = :v') && old?.[action.ExpressionAttributeNames['#v']] !== values[':v']) fail();
    if (action.ConditionExpression === '#data = :data' && JSON.stringify(old?.data) !== JSON.stringify(values[':data'])) fail();
    if (action.TableName === 'TeamUser' && old?.disabled) fail();
    if (write.Update && action.TableName === 'Invoice' && (old?.updatedAt !== values[':old'] || old?.status !== values[':status'])) fail();
  }
  for (const write of writes) {
    if (write.Put) rows.set(write.Put.Item.id, structuredClone(write.Put.Item));
    if (write.Update && write.Update.TableName === 'Invoice') {
      const action = write.Update, values = action.ExpressionAttributeValues, key = `Invoice:${action.Key.id}`;
      const next: Row = { ...models.get(key), status: values[':paid'], paidAt: values[':date'], updatedAt: values[':now'], lastWriteBy: values[':actor'] };
      delete next.paymentUrl; delete next.brokerFeeFinanceUrl; models.set(key, next);
    }
  }
  h.rows.clear(); rows.forEach((value, key) => h.rows.set(key, value)); h.models.clear(); models.forEach((value, key) => h.models.set(key, value));
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); h.models.clear(); h.rows.clear(); h.sessions = []; h.invoiceLineIds=['fee-line']; h.events = []; h.intentStatus = 'requires_payment_method';
  process.env.BROKER_FEE_TABLE = 'fee-table'; process.env.USER_ACCESS_TABLE = 'TeamUser'; process.env.COMMUNICATION_TABLE = 'Communication'; process.env.STRIPE_SECRET_KEY = 'fixture'; process.env.ACCESS_INDEXES = JSON.stringify({ 'InvoiceLine.invoiceId': 'invoice-lines' });
  vi.spyOn(AccountAccess.prototype, 'get').mockImplementation(async (model, id) => structuredClone(h.models.get(`${model}:${id}`)));
  h.session.mockResolvedValue(undefined);
  h.deactivate.mockImplementation(async () => { h.events.push('deactivate'); return { active: false }; });
  h.expire.mockImplementation(async id => { h.events.push(`expire:${id}`); return { id, status: 'expired' }; });
  h.retrieve.mockImplementation(async id => { h.events.push(`intent:${id}`); return { id, status: h.intentStatus }; });
  h.transact.mockImplementation(async writes => { h.events.push('commit'); applyTransaction(writes); });
  h.models.set('Communication:workflow:a', { id: 'workflow:a', data: { accountId: 'a', salespersonId: 'producer' }, updatedAt: NOW });
  h.models.set('Account:a', { id: 'a', name: 'Maple HOA', state: 'MA', updatedAt: NOW }); h.models.set('Quote:q', structuredClone(quote));
  h.models.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'SENT', updatedAt: NOW, stripePaymentLinkId: 'plink', paymentUrl: 'https://buy.stripe.com/issued', brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }] });
  h.models.set('InvoiceLine:fee-line', { id: 'fee-line', invoiceId: 'i', accountId: 'a', kind: 'BROKER_FEE', brokerFeeQuoteId: 'q', retailAmount: 500, costAmount: 0, updatedAt: NOW });
  const forms = [{ title: 'Reviewed state form', paragraphs: ['Reviewed state fee terms.'] }];
  h.models.set('AgencySettings:AGENCY', { id: 'AGENCY', updatedAt: NOW, brokerFeeJurisdictions: { MA: { approved: true, version: 'v1', reviewedBy: 'Reviewer', reviewedAt: '2026-10-01T12:00:00Z', evidenceUrl: 'https://regulator.example.test/fees', allowedLines: ['Property'], allowedBillTypes: ['AGENCY', 'DIRECT'], allowsCarrierCommission: true, maxFeeCents: null, forms } } });
  h.rows.set('agreement', { id: 'agreement', kind: 'AGREEMENT', accountId: 'a', accountName: 'Maple HOA', jurisdiction: 'MA', quotes: [{ ...quote, terms: authorizedQuoteTerms(quote) }], termsVersion: `${BROKER_FEE_TERMS_VERSION}:v1`, stateForms: forms, signature: { name: 'Board Signer', email: 'board@example.test', role: 'Trustee', consent: true, signedAt: NOW }, signedDocumentId: 'doc', version: 1 });
  h.rows.set('fee:q', { id: 'fee:q', kind: 'FEE', accountId: 'a', quoteId: 'q', amountCents: 50000, terms: authorizedQuoteTerms(quote), agreementId: 'agreement', signedAt: NOW, submittedCents: 0, collectedCents: 0, refundedCents: 0, version: 1, paymentSources: { 'old-failed-payment': { status: 'FAILED', amountCents: 50000, refundedCents: 0 } } });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('outside invoice payment after an unsuccessful online checkout', () => {
  it.each(['requires_payment_method', 'canceled'])('allows Mark paid after a completed unpaid checkout whose intent is definitively %s', async status => {
    h.intentStatus = status; h.sessions = [{ id: 'cs-failed', status: 'complete', payment_status: 'unpaid', payment_intent: status === 'canceled' ? { id: 'pi-failed' } : 'pi-failed' }];
    const result = await confirmInvoicePayment(actor, { invoiceId: 'i' });
    expect(result).toMatchObject({ ok: true, invoice: { status: 'PAID', paidAt: '2026-11-04' } });
    expect(h.models.get('Invoice:i')).toMatchObject({ status: 'PAID', lastWriteBy: 'broker-fee-manual-payment' });
    expect(h.rows.get('fee:q')).toMatchObject({ collectedCents: 50000, submittedCents: 50000 });
    expect(paymentRows()).toHaveLength(1); expect(paymentRows()[0]).toMatchObject({ sourceId: 'manual-invoice:i', status: 'PAID', confirmedBy: 'producer' });
    expect(h.transact).toHaveBeenCalledTimes(1);
    expect(h.transact.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ kind: 'PAYMENT' }) }) }), expect.objectContaining({ Update: expect.objectContaining({ TableName: 'Invoice' }) })]));
    expect(h.events).toEqual(['deactivate', 'intent:pi-failed', 'commit']);
  });
  it.each(['requires_action', 'processing', 'succeeded'])('refuses Mark paid while the completed checkout intent is %s', async status => {
    h.intentStatus = status; h.sessions = [{ id: 'cs-submitted', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi-submitted' }];
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('already been submitted');
    expect(h.models.get('Invoice:i')?.status).toBe('SENT'); expect(paymentRows()).toHaveLength(0); expect(h.rows.get('fee:q')?.collectedCents).toBe(0); expect(h.transact).not.toHaveBeenCalled();
  });
  it('refuses a paid checkout without creating a second receipt', async () => {
    h.sessions = [{ id: 'cs-paid', status: 'complete', payment_status: 'paid', payment_intent: 'pi-paid' }];
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('already been submitted');
    expect(h.retrieve).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it('expires open sessions before atomically recording the outside payment', async () => {
    h.sessions = [{ id: 'cs-failed', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi-failed' }, { id: 'cs-open-one', status: 'open', payment_status: 'unpaid' }, { id: 'cs-open-two', status: 'open', payment_status: 'unpaid' }];
    await confirmInvoicePayment(actor, { invoiceId: 'i' });
    expect(h.events).toEqual(['deactivate', 'intent:pi-failed', 'expire:cs-open-one', 'expire:cs-open-two', 'commit']); expect(paymentRows()).toHaveLength(1);
  });
  it('refuses a completed unpaid session whose payment intent cannot be identified', async () => {
    h.sessions = [{ id: 'cs-missing-intent', status: 'complete', payment_status: 'unpaid' }];
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('already been submitted');
    expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0); expect(h.models.get('Invoice:i')?.status).toBe('SENT');
  });
  it('requires the current client fee signature before accepting an outside payment', async () => {
    delete h.rows.get('fee:q')!.signedAt;
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('electronically sign');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it('does not grant a producer access to another account through Mark paid', async () => {
    h.models.set('Invoice:i', { ...h.models.get('Invoice:i'), accountId: 'other-account' });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('not available');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
});

describe('outside invoice payment beside an issued financing offer', () => {
  it.each(['https://checkout.stripe.com/c/pay/live', 'claim-pending-session'])('refuses a live financing checkout %s before closing invoice links', async electionCheckoutUrl => {
    issuedLoan({ electionCheckoutUrl, electionCheckoutExpiresAt: '2026-11-04T16:00:00Z' });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow(/financ|checkout/i);
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled();
    expect(paymentRows()).toHaveLength(0); expect(h.models.get('Invoice:i')?.status).toBe('SENT');
  });
  it('refuses an already submitted financing down payment even after its checkout expires', async () => {
    issuedLoan({ downPaymentIntentId: 'pi-financing', electionCheckoutUrl: 'https://checkout.stripe.com/c/pay/expired', electionCheckoutExpiresAt: '2026-11-04T14:00:00Z' });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow(/financ|checkout/i);
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it('refuses committed financing even when its checkout URL is absent', async () => {
    issuedLoan({ status: 'ACTIVE' });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow(/financ|checkout/i);
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it('records an outside payment when a quoted financing checkout has expired and fences the loan version', async () => {
    issuedLoan({ electionCheckoutUrl: 'https://checkout.stripe.com/c/pay/expired', electionCheckoutExpiresAt: '2026-11-04T14:00:00Z' });
    await confirmInvoicePayment(actor, { invoiceId: 'i' });
    expect(paymentRows()).toHaveLength(1); expect(h.rows.get('fee:q')?.collectedCents).toBe(50000);
    expect(h.transact.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'PfLoan', Key: { id: 'loan' }, ExpressionAttributeValues: { ':v': NOW } }) })]));
  });
  it('does not record a manual receipt if a financing checkout wins after the initial check', async () => {
    issuedLoan();
    h.deactivate.mockImplementation(async () => {
      h.events.push('deactivate');
      Object.assign(h.models.get('PfLoan:loan')!, { electionCheckoutUrl: 'claim-concurrent', electionCheckoutExpiresAt: '2026-11-04T16:00:00Z', updatedAt: '2026-11-04T15:00:01Z' });
      return { active: false };
    });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('transaction condition failed');
    expect(paymentRows()).toHaveLength(0); expect(h.rows.get('fee:q')?.collectedCents).toBe(0); expect(h.models.get('Invoice:i')?.status).toBe('SENT');
  });
  it('does not record a manual receipt if another financing offer is reserved after the initial check', async () => {
    h.deactivate.mockImplementation(async () => {
      h.events.push('deactivate');
      Object.assign(h.rows.get('fee:q')!, { issuedLoanIds: ['new-loan'], version: 2 });
      return { active: false };
    });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow(/changed|version|refresh|payment/i);
    expect(paymentRows()).toHaveLength(0); expect(h.rows.get('fee:q')?.collectedCents).toBe(0); expect(h.models.get('Invoice:i')?.status).toBe('SENT');
  });
});

describe('outside payment while an invoice send owns the fee', () => {
  it('uses the persisted linked legacy policy to accept an at-cost supplier charge with an outside payment', async () => {
    h.models.set('Policy:legacy',{id:'legacy',accountId:'a',quoteId:'q',premium:10000,brokerFee:500,billType:'AGENCY',updatedAt:NOW});
    Object.assign(h.models.get('Invoice:i')!,{policyId:'legacy',sourcePricingVersion:1});
    h.invoiceLineIds.push('premium','supplier');
    h.models.set('InvoiceLine:premium',{id:'premium',invoiceId:'i',accountId:'a',kind:'PREMIUM',retailAmount:10000,costAmount:9000,updatedAt:NOW});
    h.models.set('InvoiceLine:supplier',{id:'supplier',invoiceId:'i',accountId:'a',kind:'WHOLESALER_FEE',description:'RT brokerage fee',retailAmount:250,costAmount:250,updatedAt:NOW});
    expect(await confirmInvoicePayment(actor,{invoiceId:'i'})).toMatchObject({invoice:{status:'PAID'}});
    expect(paymentRows()).toHaveLength(1);expect(h.rows.get('fee:q')?.collectedCents).toBe(50000);
  });
  it('refuses an unpublished preparing send before any processor link has been stored', async () => {
    issuedInvoiceClaim('i', 'PREPARING');
    const invoice = h.models.get('Invoice:i')!; invoice.status = 'DRAFT'; delete invoice.stripePaymentLinkId; delete invoice.paymentUrl; delete invoice.brokerFeeAllocations;
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('still being prepared');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0); expect(invoice.status).toBe('DRAFT');
  });
  it('refuses a preparing claim owned by another invoice even if that prior row appears void', async () => {
    issuedInvoiceClaim('prior', 'PREPARING');
    h.models.set('Invoice:prior', { id: 'prior', accountId: 'a', status: 'VOID', updatedAt: NOW });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('still being prepared');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it.each(['SENT', 'DRAFT', 'PROCESSING', 'PAID'])('refuses a second invoice while the published owner is %s', async status => {
    issuedInvoiceClaim('prior');
    h.models.set('Invoice:prior', { id: 'prior', accountId: 'a', status, stripePaymentLinkId: 'prior-plink', updatedAt: NOW });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('Void the other issued broker fee invoice');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it.each(['missing', 'foreign'])('fails closed when the previous invoice is %s', async state => {
    issuedInvoiceClaim('prior');
    if (state === 'foreign') h.models.set('Invoice:prior', { id: 'prior', accountId: 'another-account', status: 'VOID', updatedAt: NOW });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('Void the other issued broker fee invoice');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it('allows collection after strongly verifying a prior published invoice is void and fences that version', async () => {
    issuedInvoiceClaim('prior');
    h.models.set('Invoice:prior', { id: 'prior', accountId: 'a', status: 'VOID', stripePaymentLinkId: 'prior-plink', updatedAt: NOW });
    await confirmInvoicePayment(actor, { invoiceId: 'i' });
    expect(paymentRows()).toHaveLength(1); expect(h.models.get('Invoice:i')?.status).toBe('PAID');
    expect(h.transact.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'Invoice', Key: { id: 'prior' }, ExpressionAttributeValues: { ':v': NOW } }) })]));
  });
  it('closes the published owner invoice link and its open sessions before recording the receipt', async () => {
    issuedInvoiceClaim(); h.sessions = [{ id: 'open', status: 'open', payment_status: 'unpaid' }];
    await confirmInvoicePayment(actor, { invoiceId: 'i' });
    expect(h.events).toEqual(['deactivate', 'expire:open', 'commit']); expect(paymentRows()).toHaveLength(1);
  });
  it('refuses an owner invoice whose stored link differs from the published claim', async () => {
    issuedInvoiceClaim(); h.rows.get('fee:q')!.invoiceSendClaim.linkId = 'another-link';
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('could not be verified');
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.transact).not.toHaveBeenCalled(); expect(paymentRows()).toHaveLength(0);
  });
  it('cannot commit if a new invoice send is reserved while the current link closes', async () => {
    h.deactivate.mockImplementation(async () => {
      issuedInvoiceClaim('other', 'PREPARING'); h.rows.get('fee:q')!.version = 2; return { active: false };
    });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('payment source changed');
    expect(paymentRows()).toHaveLength(0); expect(h.models.get('Invoice:i')?.status).toBe('SENT'); expect(h.rows.get('fee:q')?.collectedCents).toBe(0);
  });
  it('cannot commit if the closed previous invoice changes after validation', async () => {
    issuedInvoiceClaim('prior'); h.models.set('Invoice:prior', { id: 'prior', accountId: 'a', status: 'VOID', updatedAt: NOW });
    h.deactivate.mockImplementation(async () => { h.models.get('Invoice:prior')!.updatedAt = '2026-11-04T15:00:01Z'; return { active: false }; });
    await expect(confirmInvoicePayment(actor, { invoiceId: 'i' })).rejects.toThrow('transaction condition failed');
    expect(paymentRows()).toHaveLength(0); expect(h.models.get('Invoice:i')?.status).toBe('SENT'); expect(h.rows.get('fee:q')?.collectedCents).toBe(0);
  });
});
