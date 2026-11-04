import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
const h = vi.hoisted(() => ({
  invoice: {} as Record<string, any>, quote: {} as Record<string, any>, models: {} as Record<string, any>, order: [] as string[],
  db: vi.fn(), mail: vi.fn(), begin: vi.fn(), finish: vi.fn(), reserve: vi.fn(), publish: vi.fn(), complete: vi.fn(),
  price: vi.fn(), link: vi.fn(), retrieve: vi.fn(), deactivate: vi.fn(), close: vi.fn(), getFee: vi.fn(), pdf: vi.fn(),
  sessions: vi.fn(), expire: vi.fn(), intent: vi.fn(), prepare: vi.fn(), realClose: undefined as undefined | ((...args: any[]) => Promise<void>),
  records: new Map<string, Record<string, any>>(), model: vi.fn(), storeDb: vi.fn(), accountModels: vi.fn(),
}));
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: h.models }) }));
vi.mock('@aws-amplify/backend/function/runtime', () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({ ...await original<object>(), DynamoDBDocumentClient: { from: () => ({ send: h.db }) } }));
vi.mock('../../amplify/functions/transactional-mail/client', () => ({ TransactionalMailClient: class { send = h.mail; } }));
vi.mock('../../amplify/functions/send-invoice/sendOperation', () => ({ beginInvoiceSend: h.begin, completeInvoiceSend: h.finish, InvoiceSendBlocked: class extends Error {} }));
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  getFee: h.getFee, getModel: h.model, accountModels: h.accountModels, db: { send: h.storeDb },
}));
vi.mock('../../amplify/functions/broker-fees/payments', () => ({ reserveFeeInvoice: h.reserve, publishFeeInvoiceLink: h.publish, completeFeeInvoiceSend: h.complete, reserveFeeLoan: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/bindValidation', () => ({ assertBrokerFeeSigned: async () => ({}) }));
vi.mock('../../amplify/functions/broker-fees/agreements', () => ({ prepareBrokerFeeAgreement: h.prepare }));
vi.mock('../../amplify/functions/send-invoice/pdf', () => ({ pdfFilename: () => 'invoice.pdf', renderInvoicePdf: h.pdf }));
vi.mock('../../amplify/functions/invoiceCheckout', async original => {
  h.realClose = (await original<typeof import('../../amplify/functions/invoiceCheckout')>()).closeInvoiceCheckoutSessions;
  return { closeInvoiceCheckoutSessions: h.close };
});
vi.mock('stripe', () => ({ default: class {
  prices = { create: h.price }; paymentLinks = { create: h.link, retrieve: h.retrieve, update: h.deactivate };
  checkout = { sessions: { list: h.sessions, expire: h.expire } }; paymentIntents = { retrieve: h.intent };
} }));
import { handler } from '../../amplify/functions/send-invoice/handler';

const claim = { invoiceId: 'i', token: 'stable', createdAt: '2026-11-04T15:00:00Z', phase: 'PREPARING' as const, totalCents: 50000, previousLinkId: null };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('HOA_TRANSACTIONAL_MAIL_PROVIDER', 'resend'); vi.stubEnv('STRIPE_SECRET_KEY', 'fixture'); vi.stubEnv('INVOICE_TABLE', 'Invoice');
  vi.stubEnv('PF_LOAN_TABLE', ''); vi.stubEnv('SITE_URL', '');
  vi.stubEnv('ACCESS_TABLES', JSON.stringify({ Policy: 'Policy', Quote: 'Quote', Invoice: 'Invoice', InvoiceLine: 'InvoiceLine' }));
  vi.stubEnv('ACCESS_INDEXES', JSON.stringify({ 'Invoice.accountId': 'by-account', 'InvoiceLine.invoiceId': 'by-invoice' }));
  h.order.length = 0;
  h.records.clear();
  h.quote = { id: 'q', accountId: 'a', carrierId: 'c', premium: 10000, brokerFee: 500, billType: 'AGENCY', lines: ['Property'], status: 'QUOTED', updatedAt: '2026-11-04T14:00:00.000Z' };
  h.invoice = { id: 'i', accountId: 'a', quoteId: 'q', number: 'INV1', status: 'DRAFT', updatedAt: 'i1' };
  const lines = [{ id: 'fee', invoiceId: 'i', accountId: 'a', brokerFeeQuoteId: 'q', kind: 'BROKER_FEE', description: 'Broker fee', retailAmount: 500, costAmount: 0 }];
  for (const key of Object.keys(h.models)) delete h.models[key];
  Object.assign(h.models, {
    Invoice: { get: async () => ({ data: structuredClone(h.invoice) }), list: async () => ({ data: [structuredClone(h.invoice)] }) },
    Account: { get: async () => ({ data: { id: 'a', name: 'Cedar HOA', state: 'MA' } }) },
    Quote: { get: async () => ({ data: structuredClone(h.quote) }) }, Carrier: { get: async () => ({ data: { name: 'Carrier' } }) },
    InvoiceLine: { list: async () => ({ data: structuredClone(lines) }) },
    Contact: { list: async () => ({ data: [{ id: 'contact', email: 'board@example.test', isPrimary: true }] }) },
  });
  h.getFee.mockImplementation(async () => ({ signedAt: 'signed', amountCents: 50000, terms: authorizedQuoteTerms(h.quote), submittedCents: 0, collectedCents: 0, refundedCents: 0, invoiceSendClaim: structuredClone(claim) }));
  h.model.mockImplementation(async (model, id) => structuredClone(model === 'Invoice' && id === h.invoice.id ? h.invoice
    : model === 'Quote' && id === h.quote.id ? h.quote : h.records.get(`${model}:${id}`)));
  h.accountModels.mockImplementation(async (model, accountId) => [...h.records.entries()].filter(([key, row]) => key.startsWith(`${model}:`) && row.accountId === accountId).map(([, row]) => structuredClone(row)));
  h.storeDb.mockImplementation(async command => {
    const input = command.input;
    if (command.constructor.name === 'GetCommand') return { Item: await h.model(input.TableName, input.Key.id) };
    if (command.constructor.name !== 'QueryCommand') throw new Error('Unexpected private-store write in Send fixture');
    const value = Object.values(input.ExpressionAttributeValues ?? {})[0];
    return { Items: [...h.records.entries()].filter(([key, row]) => key.startsWith(`${input.TableName}:`) && (input.TableName === 'Invoice' ? row.accountId === value : row.invoiceId === value)).map(([, row]) => structuredClone(row)) };
  });
  h.begin.mockImplementation(async () => { h.order.push('begin'); return { operation: { key: 'mail-operation' } }; });
  h.reserve.mockImplementation(async () => { h.order.push('reserve'); return structuredClone(claim); });
  h.prepare.mockResolvedValue({ url: 'https://agency.test/sign' });
  h.price.mockResolvedValue({ id: 'price1' }); h.link.mockResolvedValue({ id: 'pl1', url: 'https://buy.stripe.com/known' });
  h.retrieve.mockResolvedValue({ active: true, url: 'https://buy.stripe.com/known' }); h.deactivate.mockResolvedValue({});
  h.close.mockImplementation(h.realClose!); h.sessions.mockImplementation(async function* () {}); h.expire.mockResolvedValue({});
  h.intent.mockResolvedValue({ status: 'requires_action' });
  h.publish.mockImplementation(async (_id, _parts, _token, linkId, write) => {
    h.order.push('publish'); const values = write.Update.ExpressionAttributeValues;
    Object.assign(h.invoice, { stripePaymentLinkId: linkId, paymentUrl: values[':url'], stripeLinkAmountCents: values[':cents'] }); return true;
  });
  h.mail.mockImplementation(async () => { h.order.push('mail'); return { MessageId: 'mail1' }; });
  h.pdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  h.db.mockImplementation(async command => {
    if (command.constructor.name === 'TransactWriteCommand') {
      for (const item of command.input.TransactItems) if (item.ConditionCheck) {
        const action = item.ConditionCheck, row = await h.model(action.TableName, action.Key.id);
        if (row?.[action.ExpressionAttributeNames['#v']] !== action.ExpressionAttributeValues[':v']) throw Object.assign(new Error('Proof changed'), { name: 'TransactionCanceledException' });
      }
      const quoteUpdate=command.input.TransactItems.find((item:any)=>item.Update?.TableName==='Quote')?.Update;
      if(quoteUpdate){
        const values=quoteUpdate.ExpressionAttributeValues, pointer=quoteUpdate.ExpressionAttributeNames['#pointer'];
        if(h.quote.updatedAt!==values[':old'] || ['sourcePricingInvoiceId','sourcePricingLoanId'].some((field,index)=>Object.hasOwn(values,`:source${index}`)?h.quote[field]!==values[`:source${index}`]:Object.hasOwn(h.quote,field)))throw Object.assign(new Error('Source changed'),{name:'TransactionCanceledException'});
        Object.assign(h.quote,{[pointer]:values[':id'],updatedAt:values[':now']});
      }
      const update = command.input.TransactItems.find((item: any) => item.Update)?.Update;
      if (!update) throw new Error('Expected atomic link publication');
      h.order.push('store-link'); const values = update.ExpressionAttributeValues;
      Object.assign(h.invoice, { stripePaymentLinkId: values[':link'], paymentUrl: values[':url'], stripeLinkAmountCents: values[':cents'] });
      return {};
    }
    const values = command.input.ExpressionAttributeValues;
    if (command.input.UpdateExpression.startsWith('SET paymentUrl')) {
      h.order.push('store-link'); Object.assign(h.invoice, { stripePaymentLinkId: values[':link'], paymentUrl: values[':url'], stripeLinkAmountCents: values[':cents'] });
    } else { h.order.push('record'); if (values[':sent']) h.invoice.status = 'SENT'; }
    return {};
  });
  h.complete.mockImplementation(async () => { h.order.push('complete'); }); h.finish.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const send = () => handler({ arguments: { invoiceId: 'i', toEmail: 'board@example.test' } });
function adjustmentFixture(amount = 250, cost: number | null = 200) {
  h.quote.brokerFee = 0;
  Object.assign(h.invoice, { policyId: 'p', sourcePricingVersion: 2, adjustsInvoiceId: 'original', adjustsPremiumLineId: 'original-premium' });
  delete h.invoice.quoteId;
  h.records.set('Policy:p', { ...h.quote, id: 'p', quoteId: 'q', updatedAt: 'policy-v1', datePolicyBound: '2026-11-04' });
  h.records.set('Invoice:original', { id: 'original', accountId: 'a', policyId: 'p', quoteId: 'q', status: 'PAID', sourcePricingVersion: 1, updatedAt: 'original-v1' });
  h.records.set('InvoiceLine:original-premium', { id: 'original-premium', accountId: 'a', invoiceId: 'original', policyId: 'p', kind: 'PREMIUM', retailAmount: 10000, costAmount: 8000, updatedAt: 'premium-v1' });
  h.models.Policy = { get: async () => ({ data: structuredClone(h.records.get('Policy:p')) }) };
  h.models.InvoiceLine.list = async () => ({ data: [{ id: 'delta', accountId: 'a', invoiceId: 'i', policyId: 'p', kind: 'ENDORSEMENT', description: 'Added building endorsement', retailAmount: amount, costAmount: cost, updatedAt: 'delta-v1' }] });
  h.models.AgencySettings = { get: vi.fn().mockResolvedValue({ data: { premiumFinanceEnabled: true } }) };
}

describe('real broker fee invoice send claim sequencing', () => {
  it('does not treat a quoted effective date as evidence of bound coverage in the attachment', async () => {
    Object.assign(h.quote, { effectiveDate: '2026-12-01', expirationDate: '2027-12-01' });
    expect(await send()).toMatchObject({ ok: true });
    expect(h.pdf.mock.calls[0][0]).toMatchObject({ effectiveDate: '2026-12-01', coverageBound: false });
  });

  it('passes bound evidence only from the linked policy binding record', async () => {
    h.invoice.policyId = 'p';
    h.models.Policy = { get: async () => ({ data: { ...h.quote, id: 'p', quoteId: 'q', datePolicyBound: '2026-11-04', effectiveDate: '2026-12-01' } }) };
    const result = await send();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(h.pdf.mock.calls[0][0]).toMatchObject({ effectiveDate: '2026-12-01', coverageBound: true });
  });

  it('returns a completed mail retry before touching its published fee claim', async () => {
    const result = { ok: true, sentTo: 'board@example.test', subject: 'Invoice', sentAt: '2026-11-04T14:00:00Z' };
    h.begin.mockResolvedValue({ operation: {}, completed: result });
    expect(await send()).toEqual(result);
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('keeps fee ownership through processor publication, email, and the DRAFT to SENT write', async () => {
    expect(await send()).toMatchObject({ ok: true });
    expect(h.order).toEqual(['begin', 'reserve', 'publish', 'mail', 'record', 'complete']);
    expect(h.complete).toHaveBeenCalledWith('i', [{ quoteId: 'q', amountCents: 50000 }], 'stable');
    expect(h.price.mock.calls[0][1]).toEqual({ idempotencyKey: 'broker-fee:stable:price' });
    expect(h.link.mock.calls[0][1]).toEqual({ idempotencyKey: 'broker-fee:stable:link' });
  });

  it('stops before email when processor creation is uncertain, retaining the recoverable claim', async () => {
    h.link.mockRejectedValue(new Error('Response lost'));
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('same invoice') });
    expect(h.reserve).toHaveBeenCalledOnce(); expect(h.mail).not.toHaveBeenCalled(); expect(h.db).not.toHaveBeenCalled(); expect(h.complete).not.toHaveBeenCalled();
  });

  it('fails a fee send with missing processor configuration before recording or emailing', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('not configured') });
    expect(h.mail).not.toHaveBeenCalled(); expect(h.complete).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
    expect(h.db).not.toHaveBeenCalled();
  });

  it('rejects a processor amount above its ceiling before any mail or fee claim is prepared', async () => {
    h.quote.premium = 1_000_000;
    h.invoice.sourcePricingVersion = 1;
    h.models.InvoiceLine.list = async () => ({ data: [
      { id: 'premium', accountId: 'a', invoiceId: 'i', kind: 'PREMIUM', retailAmount: 1_000_000, costAmount: 800000 },
      { id: 'fee', accountId: 'a', invoiceId: 'i', kind: 'BROKER_FEE', brokerFeeQuoteId: 'q', retailAmount: 500, costAmount: 0 },
    ] });
    h.getFee.mockImplementation(async () => ({ amountCents: 50000, terms: authorizedQuoteTerms(h.quote), submittedCents: 0, collectedCents: 0, refundedCents: 0 }));
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    expect(h.begin).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
    expect(h.price).not.toHaveBeenCalled(); expect(h.link).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled(); expect(h.db).not.toHaveBeenCalled();
  });

  it('preserves offline legacy fee-free invoice sending when Stripe is not configured', async () => {
    h.quote.brokerFee = 0;
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    h.models.InvoiceLine.list = async () => ({ data: [{ id: 'premium', accountId: 'a', invoiceId: 'i', kind: 'PREMIUM', retailAmount: 10000, costAmount: 8000 }] });
    expect(await send()).toMatchObject({ ok: true });
    expect(h.mail).toHaveBeenCalledOnce(); expect(h.reserve).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.link).not.toHaveBeenCalled();
  });

  it('preserves an unflagged legacy endorsement and tax without reseeding its policy original charges or unpaid HOA fee', async () => {
    h.invoice.policyId = 'p';
    h.records.set('Policy:p', { ...h.quote, id: 'p', quoteId: 'q', datePolicyBound: '2026-11-04',
      passThroughCharges: [{ id: 'original-tax', kind: 'TAX', description: 'Original policy tax', amountCents: 100000 }] });
    h.models.Policy = { get: async () => ({ data: structuredClone(h.records.get('Policy:p')) }) };
    h.models.InvoiceLine.list = async () => ({ data: [
      { id: 'legacy-endorsement', accountId: 'a', invoiceId: 'i', policyId: 'p', kind: 'ENDORSEMENT', description: 'Legacy endorsement', retailAmount: 1000, costAmount: 800 },
      { id: 'legacy-tax', accountId: 'a', invoiceId: 'i', policyId: 'p', kind: 'TAX', description: 'Endorsement tax', retailAmount: 40, costAmount: 40 },
    ] });
    h.models.InvoiceLine.create = vi.fn();
    h.getFee.mockResolvedValue(undefined);
    expect(await send()).toMatchObject({ ok: true });
    expect(h.price.mock.calls[0][0].unit_amount).toBe(104000);
    expect(h.models.InvoiceLine.create).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
    expect(h.pdf.mock.calls[0][0].lines.map((line: any) => line.kind)).toEqual(['ENDORSEMENT', 'TAX']);
  });

  it('atomically binds a newly reserved resend claim to an existing active payment link', async () => {
    Object.assign(h.invoice, { status: 'SENT', paymentUrl: 'https://buy.stripe.com/known', stripePaymentLinkId: 'pl1', stripeLinkAmountCents: 50000, remittanceBrokerFeeCents: 50000, brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }] });
    expect(await send()).toMatchObject({ ok: true });
    expect(h.publish).toHaveBeenCalledOnce(); expect(h.price).not.toHaveBeenCalled(); expect(h.link).not.toHaveBeenCalled();
    expect(h.order.indexOf('publish')).toBeLessThan(h.order.indexOf('mail'));
  });

  it('does not mint a replacement when binding an active existing link loses its claim', async () => {
    Object.assign(h.invoice, { status: 'SENT', paymentUrl: 'https://buy.stripe.com/known', stripePaymentLinkId: 'pl1', stripeLinkAmountCents: 50000, remittanceBrokerFeeCents: 50000, brokerFeeAllocations: [{ quoteId: 'q', amountCents: 50000 }] });
    h.publish.mockResolvedValue(false);
    expect(await send()).toMatchObject({ ok: false });
    expect(h.link).not.toHaveBeenCalled(); expect(h.deactivate).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('never deactivates a shared idempotent link another invocation already stored', async () => {
    h.publish.mockImplementation(async () => { h.invoice.stripePaymentLinkId = 'pl1'; return false; });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('retains its owned processor link when publication retries exhaust, then recovers the same live link on Send', async () => {
    h.publish.mockResolvedValueOnce(false);
    expect(await send()).toMatchObject({ ok: false });
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
    expect(h.invoice.stripePaymentLinkId).toBeUndefined();
    expect(await send()).toMatchObject({ ok: true });
    expect(h.link.mock.calls.map(call => call[1])).toEqual([{ idempotencyKey: 'broker-fee:stable:link' }, { idempotencyKey: 'broker-fee:stable:link' }]);
    expect(h.retrieve).toHaveBeenCalledTimes(2); expect(h.retrieve).toHaveBeenCalledWith('pl1');
    expect(h.invoice.stripePaymentLinkId).toBe('pl1'); expect(h.mail).toHaveBeenCalledOnce();
  });

  it('rejects an inactive current link even when the idempotent create response reports it active', async () => {
    h.link.mockResolvedValue({ id: 'pl1', url: 'https://buy.stripe.com/known', active: true });
    h.retrieve.mockResolvedValue({ id: 'pl1', url: 'https://buy.stripe.com/known', active: false });
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('inactive') });
    expect(h.publish).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled(); expect(h.complete).not.toHaveBeenCalled();
  });

  it('closes an orphan only after strongly read sources prove its claim ownership was lost', async () => {
    h.publish.mockImplementation(async () => {
      h.getFee.mockResolvedValue({ invoiceSendClaim: { invoiceId: 'other', token: 'replacement' } });
      return false;
    });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.deactivate).toHaveBeenCalledWith('pl1', { active: false });
    expect(h.close).toHaveBeenCalledWith(expect.anything(), 'pl1'); expect(h.mail).not.toHaveBeenCalled();
  });

  it('retains the recoverable link if source state cannot establish that ownership was lost', async () => {
    h.publish.mockImplementation(async () => { h.getFee.mockResolvedValue(undefined); return false; });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.deactivate).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('closes already-open sessions before replacing a definitively failed previous link', async () => {
    Object.assign(h.invoice, { stripePaymentLinkId: 'old', paymentUrl: 'https://buy.stripe.com/old', stripeLinkAmountCents: 50000 });
    h.retrieve.mockImplementation(async id => ({ active: id !== 'old', url: id === 'old' ? 'https://buy.stripe.com/old' : 'https://buy.stripe.com/known' }));
    expect(await send()).toMatchObject({ ok: true });
    expect(h.close).toHaveBeenCalledWith(expect.anything(), 'old');
    expect(h.close.mock.invocationCallOrder[0]).toBeLessThan(h.price.mock.invocationCallOrder[0]);
  });

  it('does not interpret a missing session or intent as permission to replace its old payment path', async () => {
    Object.assign(h.invoice, { stripePaymentLinkId: 'old', paymentUrl: 'https://buy.stripe.com/old', stripeLinkAmountCents: 50000 });
    h.retrieve.mockResolvedValue({ active: false });
    h.close.mockRejectedValue(Object.assign(new Error('Unknown intent'), { code: 'resource_missing' }));
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('payment sessions') });
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('expires open sessions from a published source-priced packet before replacing its link without an HOA fee', async () => {
    h.quote.brokerFee = 0;
    Object.assign(h.invoice, { status: 'SENT', sourcePricingVersion: 1, stripePaymentLinkId: 'old', paymentUrl: 'https://buy.stripe.com/old', stripeLinkAmountCents: 1000000 });
    h.models.InvoiceLine.list = async () => ({ data: [{ id: 'premium', accountId: 'a', invoiceId: 'i', kind: 'PREMIUM', retailAmount: 10000, costAmount: 8000 }] });
    h.retrieve.mockResolvedValue({ active: false, url: 'https://buy.stripe.com/old' });
    const session = { id: 'old-checkout', status: 'open', payment_status: 'unpaid' };
    h.sessions.mockImplementation(async function* () { yield session; });
    h.expire.mockImplementation(async () => { session.status = 'expired'; return {}; });
    expect(await send()).toMatchObject({ ok: true });
    expect(session.status).toBe('expired');
    expect(h.expire).toHaveBeenCalledWith('old-checkout');
    expect(h.expire.mock.invocationCallOrder[0]).toBeLessThan(h.link.mock.invocationCallOrder[0]);
    expect(h.link.mock.invocationCallOrder[0]).toBeLessThan(h.mail.mock.invocationCallOrder[0]);
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
  });

  it('refuses replacing a source-priced no-HOA link if its existing session already submitted payment', async () => {
    h.quote.brokerFee = 0;
    Object.assign(h.invoice, { status: 'SENT', sourcePricingVersion: 1, stripePaymentLinkId: 'old', paymentUrl: 'https://buy.stripe.com/old', stripeLinkAmountCents: 1000000 });
    h.models.InvoiceLine.list = async () => ({ data: [{ id: 'premium', accountId: 'a', invoiceId: 'i', kind: 'PREMIUM', retailAmount: 10000, costAmount: 8000 }] });
    h.retrieve.mockResolvedValue({ active: false });
    h.sessions.mockImplementation(async function* () { yield { id: 'old-checkout', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi-old' }; });
    h.intent.mockResolvedValue({ status: 'processing' });
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining('previous payment sessions') });
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
    expect(h.invoice.stripePaymentLinkId).toBe('old');
  });
});

describe('real adjustment Send proof and source protection', () => {
  it('strongly verifies the paid original and publishes the positive delta with atomic proof guards', async () => {
    adjustmentFixture();
    h.quote.brokerFee = 500;
    h.records.get('Policy:p')!.brokerFee = 500;
    expect(await send()).toMatchObject({ ok: true });
    expect(h.model).toHaveBeenCalledWith('Invoice', 'original');
    expect(h.model).toHaveBeenCalledWith('InvoiceLine', 'original-premium');
    expect(h.model).toHaveBeenCalledWith('Policy', 'p');
    const transaction = h.db.mock.calls.find(([command]) => command.constructor.name === 'TransactWriteCommand')?.[0].input.TransactItems;
    expect(transaction).toEqual(expect.arrayContaining([
      expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'Invoice', Key: { id: 'original' } }) }),
      expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'InvoiceLine', Key: { id: 'original-premium' } }) }),
      expect.objectContaining({ ConditionCheck: expect.objectContaining({ TableName: 'Policy', Key: { id: 'p' } }) }),
    ]));
    expect(h.price.mock.calls[0][0].unit_amount).toBe(25000);
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.publish).not.toHaveBeenCalled();
    expect(h.models.AgencySettings.get).not.toHaveBeenCalled();
    expect(h.pdf.mock.calls[0][0].finance).toBeNull();
    expect(h.pdf.mock.calls[0][0].lines).toHaveLength(1);
    expect(h.pdf.mock.calls[0][0].lines[0].kind).toBe('ENDORSEMENT');
  });

  it.each([
    ['not paid', 'Invoice:original', { status: 'SENT' }],
    ['foreign original account', 'Invoice:original', { accountId: 'other' }],
    ['foreign original policy', 'Invoice:original', { policyId: 'other' }],
    ['earlier adjustment', 'Invoice:original', { sourcePricingVersion: 2 }],
    ['line from another invoice', 'InvoiceLine:original-premium', { invoiceId: 'other' }],
    ['line from another policy', 'InvoiceLine:original-premium', { policyId: 'other' }],
    ['line from another account', 'InvoiceLine:original-premium', { accountId: 'other' }],
    ['non-premium line', 'InvoiceLine:original-premium', { kind: 'BROKER_FEE' }],
    ['nonpositive original premium', 'InvoiceLine:original-premium', { retailAmount: 0 }],
  ])('refuses %s proof before reaching Stripe or email', async (_label, record, patch) => {
    adjustmentFixture();
    Object.assign(h.records.get(record)!, patch);
    expect(await send()).toMatchObject({ ok: false });
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled(); expect(h.begin).not.toHaveBeenCalled();
  });

  it('rejects carrier premium on a DIRECT policy even when the AppSync source is stale AGENCY', async () => {
    adjustmentFixture();
    h.records.get('Policy:p')!.billType = 'DIRECT';
    h.models.Policy.get = async () => ({ data: { ...h.records.get('Policy:p'), billType: 'AGENCY' } });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('does not deliver a payment link if the original proof changes during processor creation', async () => {
    adjustmentFixture();
    h.link.mockImplementation(async () => {
      h.records.get('InvoiceLine:original-premium')!.updatedAt = 'concurrent-change';
      return { id: 'pl1', url: 'https://buy.stripe.com/known' };
    });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.mail).not.toHaveBeenCalled();
  });

  it('sends a negative credit statement without asking for payment or offering inception financing', async () => {
    adjustmentFixture(-250, -200);
    expect(await send()).toMatchObject({ ok: true });
    expect(h.link).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled();
    expect(h.models.AgencySettings.get).not.toHaveBeenCalled();
    const view = h.pdf.mock.calls[0][0];
    expect(view.paymentUrl).toBeNull(); expect(view.finance).toBeNull();
    expect(h.mail.mock.calls[0][1].text).toContain('No payment is due.');
  });

  it('sends offsetting nonzero deltas as a zero-balance statement without a checkout or fake receipt', async () => {
    adjustmentFixture();
    h.models.InvoiceLine.list = async () => ({ data: [
      { id: 'delta', accountId: 'a', invoiceId: 'i', policyId: 'p', kind: 'ENDORSEMENT', description: 'Added building endorsement', retailAmount: 250, costAmount: 200 },
      { id: 'tax-credit', accountId: 'a', invoiceId: 'i', policyId: 'p', kind: 'TAX', description: 'Tax adjustment credit', retailAmount: -250, costAmount: -250 },
    ] });
    expect(await send()).toMatchObject({ ok: true });
    expect(h.link).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled();
    expect(h.models.AgencySettings.get).not.toHaveBeenCalled();
    expect(h.mail.mock.calls[0][1].text).toContain('No payment is due on this invoice.');
    expect(h.invoice.status).toBe('SENT');
  });

  it('requires actual endorsement remittance cost rather than inferring it from the original commission', async () => {
    adjustmentFixture(250, null);
    expect(await send()).toMatchObject({ ok: false });
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'PREMIUM', retailAmount: 10000, costAmount: 8000 },
    { kind: 'BROKER_FEE', retailAmount: 500, costAmount: 0, brokerFeeQuoteId: 'q' },
    { kind: 'TAX', retailAmount: 100, costAmount: 100, sourceQuoteChargeId: 'original-tax' },
  ])('cannot bill the original premium/fee/source charge again through an adjustment ($kind)', async values => {
    adjustmentFixture();
    h.models.InvoiceLine.list = async () => ({ data: [{ id: 'repeated', accountId: 'a', invoiceId: 'i', policyId: 'p', description: 'Repeated original charge', ...values }] });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled();
  });

  it('rejects forced V1 after the paid original even when AppSync omits it and GSI status is stale SENT', async () => {
    adjustmentFixture();
    h.invoice.sourcePricingVersion = 1;
    delete h.invoice.adjustsInvoiceId; delete h.invoice.adjustsPremiumLineId;
    h.accountModels.mockResolvedValue([{ ...h.records.get('Invoice:original'), status: 'SENT' }]);
    h.models.InvoiceLine.list = async () => ({ data: [{ id: 'new-premium', accountId: 'a', invoiceId: 'i', policyId: 'p', kind: 'PREMIUM', description: 'Policy premium', retailAmount: 10000, costAmount: 8000 }] });
    expect(await send()).toMatchObject({ ok: false });
    expect(h.accountModels).toHaveBeenCalledWith('Invoice', 'a');
    expect(h.model).toHaveBeenCalledWith('Invoice', 'original');
    expect(h.model).toHaveBeenCalledWith('InvoiceLine', 'original-premium');
    expect(h.storeDb.mock.calls.some(([command]) => command.constructor.name === 'QueryCommand')).toBe(true);
    expect(h.price).not.toHaveBeenCalled(); expect(h.mail).not.toHaveBeenCalled(); expect(h.begin).not.toHaveBeenCalled();
  });
});

describe('actual fee-free initial quote publication',()=>{
  function initialPacket(){
    h.quote.brokerFee=0;h.invoice.sourcePricingVersion=1;
    h.models.InvoiceLine.list=async()=>({data:[{id:'premium',accountId:'a',invoiceId:'i',kind:'PREMIUM',retailAmount:10000,costAmount:8000}]});
  }
  it('publishes a server-owned Quote pointer with the payment link in the same transaction',async()=>{
    initialPacket();const prior=h.quote.updatedAt;
    expect(await send()).toMatchObject({ok:true});
    expect(h.quote).toMatchObject({sourcePricingInvoiceId:'i'});expect(h.quote.updatedAt>prior).toBe(true);
    const transaction=h.db.mock.calls.map(([command])=>command).find(command=>command.constructor.name==='TransactWriteCommand');
    expect(transaction.input.TransactItems).toEqual(expect.arrayContaining([
      expect.objectContaining({Update:expect.objectContaining({TableName:'Quote',Key:{id:'q'},ExpressionAttributeNames:expect.objectContaining({'#pointer':'sourcePricingInvoiceId'})})}),
      expect.objectContaining({Update:expect.objectContaining({TableName:'Invoice',Key:{id:'i'}})}),
    ]));
  });
  it('an edit that wins during Stripe creation prevents publishing or emailing the stale fee-free link',async()=>{
    initialPacket();h.link.mockImplementation(async()=>{h.quote.brokerFee=500;h.quote.updatedAt='2026-11-04T16:00:00.000Z';return {id:'stale-link',url:'https://buy.stripe.com/stale'};});
    expect(await send()).toMatchObject({ok:false});
    expect(h.mail).not.toHaveBeenCalled();expect(h.deactivate).toHaveBeenCalledWith('stale-link',{active:false});
    expect(h.invoice.stripePaymentLinkId).toBeUndefined();expect(h.quote.sourcePricingInvoiceId).toBeUndefined();
  });
  it('refuses a stale agency-bill snapshot after a fee-free quote switches to DIRECT',async()=>{
    initialPacket();const oldSnapshot=structuredClone(h.quote);h.models.Quote.get=async()=>({data:oldSnapshot});
    h.quote.billType='DIRECT';h.quote.updatedAt='2026-11-04T16:00:00.000Z';
    expect(await send()).toMatchObject({ok:false});expect(h.link).not.toHaveBeenCalled();expect(h.mail).not.toHaveBeenCalled();
  });
  it('does not replace another live published invoice even when the account index omits it',async()=>{
    initialPacket();h.quote.sourcePricingInvoiceId='other';
    h.records.set('Invoice:other',{id:'other',accountId:'a',quoteId:'q',sourcePricingVersion:1,status:'SENT',updatedAt:'2026-11-04T13:00:00Z',stripePaymentLinkId:'other-link'});
    expect(await send()).toMatchObject({ok:false});expect(h.link).not.toHaveBeenCalled();expect(h.mail).not.toHaveBeenCalled();
  });
});
