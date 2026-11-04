import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
const h = vi.hoisted(() => ({
  invoice: {} as Record<string, any>, quote: {} as Record<string, any>, models: {} as Record<string, any>, order: [] as string[],
  db: vi.fn(), mail: vi.fn(), begin: vi.fn(), finish: vi.fn(), reserve: vi.fn(), publish: vi.fn(), complete: vi.fn(),
  price: vi.fn(), link: vi.fn(), retrieve: vi.fn(), deactivate: vi.fn(), close: vi.fn(), getFee: vi.fn(),
}));
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: h.models }) }));
vi.mock('@aws-amplify/backend/function/runtime', () => ({ getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }) }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({ ...await original<object>(), DynamoDBDocumentClient: { from: () => ({ send: h.db }) } }));
vi.mock('../../amplify/functions/transactional-mail/client', () => ({ TransactionalMailClient: class { send = h.mail; } }));
vi.mock('../../amplify/functions/send-invoice/sendOperation', () => ({ beginInvoiceSend: h.begin, completeInvoiceSend: h.finish, InvoiceSendBlocked: class extends Error {} }));
vi.mock('../../amplify/functions/broker-fees/store', () => ({ getFee: h.getFee, getModel: async () => structuredClone(h.invoice) }));
vi.mock('../../amplify/functions/broker-fees/payments', () => ({ reserveFeeInvoice: h.reserve, publishFeeInvoiceLink: h.publish, completeFeeInvoiceSend: h.complete, reserveFeeLoan: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/bindValidation', () => ({ assertBrokerFeeSigned: async () => ({}) }));
vi.mock('../../amplify/functions/broker-fees/agreements', () => ({ prepareBrokerFeeAgreement: async () => ({ url: 'https://agency.test/sign' }) }));
vi.mock('../../amplify/functions/send-invoice/pdf', () => ({ pdfFilename: () => 'invoice.pdf', renderInvoicePdf: async () => new Uint8Array([37, 80, 68, 70]) }));
vi.mock('../../amplify/functions/invoiceCheckout', () => ({ closeInvoiceCheckoutSessions: h.close }));
vi.mock('stripe', () => ({ default: class {
  prices = { create: h.price }; paymentLinks = { create: h.link, retrieve: h.retrieve, update: h.deactivate };
} }));
import { handler } from '../../amplify/functions/send-invoice/handler';

const claim = { invoiceId: 'i', token: 'stable', createdAt: '2026-11-04T15:00:00Z', phase: 'PREPARING' as const, totalCents: 50000, previousLinkId: null };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('HOA_TRANSACTIONAL_MAIL_PROVIDER', 'resend'); vi.stubEnv('STRIPE_SECRET_KEY', 'fixture'); vi.stubEnv('INVOICE_TABLE', 'Invoice');
  vi.stubEnv('PF_LOAN_TABLE', ''); vi.stubEnv('SITE_URL', '');
  h.order.length = 0;
  h.quote = { id: 'q', accountId: 'a', carrierId: 'c', premium: 10000, brokerFee: 500, billType: 'DIRECT', lines: ['Property'], status: 'QUOTED', updatedAt: 'q1' };
  h.invoice = { id: 'i', accountId: 'a', quoteId: 'q', number: 'INV1', status: 'DRAFT', updatedAt: 'i1' };
  const lines = [{ id: 'fee', invoiceId: 'i', accountId: 'a', brokerFeeQuoteId: 'q', kind: 'BROKER_FEE', description: 'Broker fee', retailAmount: 500, costAmount: 0 }];
  h.models = {
    Invoice: { get: async () => ({ data: structuredClone(h.invoice) }), list: async () => ({ data: [structuredClone(h.invoice)] }) },
    Account: { get: async () => ({ data: { id: 'a', name: 'Cedar HOA', state: 'MA' } }) },
    Quote: { get: async () => ({ data: structuredClone(h.quote) }) }, Carrier: { get: async () => ({ data: { name: 'Carrier' } }) },
    InvoiceLine: { list: async () => ({ data: structuredClone(lines) }) },
    Contact: { list: async () => ({ data: [{ id: 'contact', email: 'board@example.test', isPrimary: true }] }) },
  };
  h.getFee.mockImplementation(async () => ({ signedAt: 'signed', amountCents: 50000, terms: authorizedQuoteTerms(h.quote), submittedCents: 0, collectedCents: 0, refundedCents: 0 }));
  h.begin.mockImplementation(async () => { h.order.push('begin'); return { operation: { key: 'mail-operation' } }; });
  h.reserve.mockImplementation(async () => { h.order.push('reserve'); return structuredClone(claim); });
  h.price.mockResolvedValue({ id: 'price1' }); h.link.mockResolvedValue({ id: 'pl1', url: 'https://buy.stripe.com/known' });
  h.retrieve.mockResolvedValue({ active: true, url: 'https://buy.stripe.com/known' }); h.deactivate.mockResolvedValue({}); h.close.mockResolvedValue(undefined);
  h.publish.mockImplementation(async (_id, _parts, _token, linkId, write) => {
    h.order.push('publish'); const values = write.Update.ExpressionAttributeValues;
    Object.assign(h.invoice, { stripePaymentLinkId: linkId, paymentUrl: values[':url'], stripeLinkAmountCents: values[':cents'] }); return true;
  });
  h.mail.mockImplementation(async () => { h.order.push('mail'); return { MessageId: 'mail1' }; });
  h.db.mockImplementation(async command => { h.order.push('record'); if (command.input.ExpressionAttributeValues[':sent']) h.invoice.status = 'SENT'; return {}; });
  h.complete.mockImplementation(async () => { h.order.push('complete'); }); h.finish.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const send = () => handler({ arguments: { invoiceId: 'i', toEmail: 'board@example.test' } });

describe('real broker fee invoice send claim sequencing', () => {
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

  it('closes already-open sessions before replacing a definitively failed previous link', async () => {
    Object.assign(h.invoice, { stripePaymentLinkId: 'old', paymentUrl: 'https://buy.stripe.com/old', stripeLinkAmountCents: 50000 });
    h.retrieve.mockResolvedValue({ active: false, url: 'https://buy.stripe.com/old' });
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
});
