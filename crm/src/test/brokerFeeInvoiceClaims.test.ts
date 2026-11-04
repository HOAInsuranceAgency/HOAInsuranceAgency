import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import type { BrokerFeeRecord } from '../../../shared/brokerFees';
import type { Write } from '../../amplify/functions/broker-fees/store';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({ rows: new Map<string, Row>(), transact: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  getFee: async (id: string) => structuredClone(h.rows.get(`Fees:fee:${id}`)),
  getModel: async (model: string, id: string) => structuredClone(h.rows.get(`${model}:${id}`)),
  transact: h.transact,
}));
import { completeFeeInvoiceSend, feeInvoiceVoidWrites, publishFeeInvoiceLink, reserveFeeInvoice } from '../../amplify/functions/broker-fees/payments';
import { createPaymentLink } from '../../amplify/functions/send-invoice/stripeLink';

const parts = [{ quoteId: 'q', amountCents: 50000 }];
const quote = { id: 'q', accountId: 'a', carrierId: 'c', premium: 10000, brokerFee: 500, billType: 'AGENCY', status: 'QUOTED', lines: ['Property'], updatedAt: 'q1' };
const fee = () => h.rows.get('Fees:fee:q') as BrokerFeeRecord;
const invoice = (id = 'i') => h.rows.get(`Invoice:${id}`)!;
const cancelled = () => Object.assign(new Error('Version changed'), { name: 'TransactionCanceledException' });
function apply(writes: Write[]) {
  const staged = structuredClone(h.rows);
  for (const write of writes) {
    const action = (write.Put ?? write.ConditionCheck) as Row | undefined;
    if (!action) throw new Error('Unexpected write');
    const id = 'Item' in action ? action.Item.id : action.Key.id;
    const key = `${action.TableName}:${id}`, current = staged.get(key);
    if (action.ConditionExpression === 'attribute_not_exists(id)' && current) throw cancelled();
    if (action.ConditionExpression === '#v = :v' && current?.[action.ExpressionAttributeNames!['#v']] !== action.ExpressionAttributeValues![':v']) throw cancelled();
    if (write.Put) staged.set(key, structuredClone(write.Put.Item!));
  }
  h.rows.clear(); staged.forEach((value, key) => h.rows.set(key, value));
}
function linkWrite(id = 'i', linkId = 'pl1'): Write {
  const old = invoice(id);
  return { Put: { TableName: 'Invoice', Item: { ...old, stripePaymentLinkId: linkId, updatedAt: `${old.updatedAt}-link` }, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'updatedAt' }, ExpressionAttributeValues: { ':v': old.updatedAt } } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T15:00:00Z'));
  process.env.BROKER_FEE_TABLE = 'Fees'; process.env.ACCESS_TABLES = JSON.stringify({ Quote: 'Quote', Invoice: 'Invoice', PfLoan: 'PfLoan' });
  h.rows.clear(); h.rows.set('Quote:q', structuredClone(quote));
  h.rows.set('Invoice:i', { id: 'i', accountId: 'a', quoteId: 'q', status: 'DRAFT', updatedAt: 'i1', brokerFeeAllocations: parts });
  h.rows.set('Fees:fee:q', { id: 'fee:q', kind: 'FEE', accountId: 'a', quoteId: 'q', amountCents: 50000, terms: authorizedQuoteTerms(quote), version: 1, submittedCents: 0, collectedCents: 0, refundedCents: 0 });
  h.transact.mockImplementation(async writes => apply(writes));
});
afterEach(() => vi.useRealTimers());

describe('durable broker fee invoice send ownership', () => {
  it('holds the claim while a reserved invoice is DRAFT and resumes the same processor attempt', async () => {
    const claim = await reserveFeeInvoice(quote, 'i', 1050000);
    expect(claim).toMatchObject({ invoiceId: 'i', phase: 'PREPARING', totalCents: 1050000, previousLinkId: null });
    expect(fee().issuedInvoiceIds).toEqual(['i']);
    await expect(reserveFeeInvoice(quote, 'i', 1050000)).resolves.toEqual(claim);
    await expect(reserveFeeInvoice(quote, 'i', 1060000)).rejects.toThrow('different invoice charges');
    await expect(completeFeeInvoiceSend('i', parts, claim!.token)).rejects.toThrow('invoice changed');
    await expect(feeInvoiceVoidWrites(invoice())).rejects.toThrow('Retry Send');
    expect(fee().invoiceSendClaim).toEqual(claim);
  });

  it('publishes the source pointer atomically and holds PREPARING until SENT', async () => {
    const claim = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    expect(await publishFeeInvoiceLink('i', parts, claim.token, 'pl1', linkWrite())).toBe(true);
    expect(fee().invoiceSendClaim).toMatchObject({ phase: 'PREPARING', linkId: 'pl1' });
    await expect(completeFeeInvoiceSend('i', parts, claim.token)).rejects.toThrow('invoice changed');
    Object.assign(invoice(), { status: 'SENT', updatedAt: 'sent' });
    await completeFeeInvoiceSend('i', parts, claim.token);
    expect(fee().invoiceSendClaim).toMatchObject({ phase: 'PUBLISHED', linkId: 'pl1' });
    // A late retry recognizes the already-published identical source.
    expect(await publishFeeInvoiceLink('i', parts, claim.token, 'pl1', linkWrite())).toBe(true);
    await completeFeeInvoiceSend('i', parts, claim.token);
  });

  it('keeps the reservation on an uncertain publication failure and never publishes with the wrong owner token', async () => {
    const claim = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    h.transact.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(publishFeeInvoiceLink('i', parts, claim.token, 'pl1', linkWrite())).rejects.toThrow('Storage unavailable');
    expect(fee().invoiceSendClaim).toEqual(claim); expect(invoice().stripePaymentLinkId).toBeUndefined();
    expect(await publishFeeInvoiceLink('i', parts, 'another-token', 'pl2', linkWrite('i', 'pl2'))).toBe(false);
    expect(invoice().stripePaymentLinkId).toBeUndefined();
  });

  it('prevents another invoice taking either an unpublished or published live claim', async () => {
    const claim = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    h.rows.set('Invoice:replacement', { ...invoice(), id: 'replacement', updatedAt: 'replacement' });
    await expect(reserveFeeInvoice(quote, 'replacement', 1050000)).rejects.toThrow('Finish or void');
    await publishFeeInvoiceLink('i', parts, claim.token, 'pl1', linkWrite());
    Object.assign(invoice(), { status: 'SENT', updatedAt: 'sent' });
    await completeFeeInvoiceSend('i', parts, claim.token);
    await expect(reserveFeeInvoice(quote, 'replacement', 1050000)).rejects.toThrow('Finish or void');
    h.rows.delete('Invoice:i');
    await expect(reserveFeeInvoice(quote, 'replacement', 1050000)).rejects.toThrow('Finish or void');
  });

  it('reuses an active same-invoice link on resend with a new frozen claim owner', async () => {
    const first = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    await publishFeeInvoiceLink('i', parts, first.token, 'pl1', linkWrite());
    Object.assign(invoice(), { status: 'SENT', updatedAt: 'sent' });
    await completeFeeInvoiceSend('i', parts, first.token);
    const next = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    expect(next.token).not.toBe(first.token); expect(next.previousLinkId).toBe('pl1');
    expect(await publishFeeInvoiceLink('i', parts, next.token, 'pl1', linkWrite())).toBe(true);
    await completeFeeInvoiceSend('i', parts, next.token);
    expect(fee().invoiceSendClaim).toMatchObject({ token: next.token, phase: 'PUBLISHED', linkId: 'pl1' });
  });

  it('releases ownership only in the same version-fenced transaction as a verified VOID', async () => {
    const claim = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    await publishFeeInvoiceLink('i', parts, claim.token, 'pl1', linkWrite());
    const writes = await feeInvoiceVoidWrites(invoice());
    const old = structuredClone(invoice());
    apply([{ Put: { TableName: 'Invoice', Item: { ...old, status: 'VOID', updatedAt: 'void' }, ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'updatedAt' }, ExpressionAttributeValues: { ':v': old.updatedAt } } }, ...writes]);
    expect(fee().invoiceSendClaim).toBeUndefined(); expect(invoice().status).toBe('VOID');
    expect(await publishFeeInvoiceLink('i', parts, claim.token, 'pl2', linkWrite('i', 'pl2'))).toBe(false);
    h.rows.set('Invoice:replacement', { ...old, id: 'replacement', status: 'DRAFT', updatedAt: 'replacement' });
    await expect(reserveFeeInvoice(quote, 'replacement', 1050000)).resolves.toMatchObject({ invoiceId: 'replacement' });
  });

  it('rejects stale release writes if Send has taken a newer claim generation', async () => {
    const first = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    await publishFeeInvoiceLink('i', parts, first.token, 'pl1', linkWrite());
    Object.assign(invoice(), { status: 'SENT', updatedAt: 'sent' });
    await completeFeeInvoiceSend('i', parts, first.token);
    const stale = await feeInvoiceVoidWrites(invoice());
    await reserveFeeInvoice(quote, 'i', 1050000);
    expect(() => apply(stale)).toThrow('Version changed');
    expect(fee().invoiceSendClaim?.phase).toBe('PREPARING');
  });

  it('holds old uncertain no-link attempts after the processor idempotency recovery window', async () => {
    const claim = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    await expect(reserveFeeInvoice(quote, 'i', 1050000)).rejects.toThrow('too old');
    expect(fee().invoiceSendClaim).toEqual(claim);
  });

  it('allows known-link recovery after that window and refuses payment already submitted elsewhere', async () => {
    const claim = (await reserveFeeInvoice(quote, 'i', 1050000))!;
    await publishFeeInvoiceLink('i', parts, claim.token, 'pl1', linkWrite());
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    await expect(reserveFeeInvoice(quote, 'i', 1050000)).resolves.toMatchObject({ token: claim.token, linkId: 'pl1' });
    fee().submittedCents = 50000;
    await expect(reserveFeeInvoice(quote, 'i', 1050000)).rejects.toThrow('submitted or received');
  });
});

it('uses stable distinct idempotency keys for BOTH price and link when recovering an unknown processor response', async () => {
  const prices = new Map<string, any>(), links = new Map<string, any>(); let loseResponse = true;
  const createPrice = vi.fn(async (_params, options) => {
    if (!prices.has(options.idempotencyKey)) prices.set(options.idempotencyKey, { id: 'price1' });
    return prices.get(options.idempotencyKey);
  });
  const createLink = vi.fn(async (_params, options) => {
    if (!links.has(options.idempotencyKey)) links.set(options.idempotencyKey, { id: 'pl1', url: 'https://buy.stripe.com/known' });
    if (loseResponse) { loseResponse = false; throw new Error('Response lost'); }
    return links.get(options.idempotencyKey);
  });
  const stripe = { prices: { create: createPrice }, paymentLinks: { create: createLink, retrieve: vi.fn().mockResolvedValue({ id: 'pl1', url: 'https://buy.stripe.com/known', active: true }) } };
  const request = { invoiceId: 'i', invoiceNumber: 'INV1', associationName: 'Cedar HOA', total: 10500, accountId: 'a', brokerFeeAllocations: parts, idempotencyToken: 'frozen-token' };
  await expect(createPaymentLink(stripe as any, request)).rejects.toThrow('Response lost');
  await expect(createPaymentLink(stripe as any, request)).resolves.toEqual({ id: 'pl1', url: 'https://buy.stripe.com/known' });
  expect(prices.size).toBe(1); expect(links.size).toBe(1);
  expect(createPrice.mock.calls.map(call => call[1])).toEqual([{ idempotencyKey: 'broker-fee:frozen-token:price' }, { idempotencyKey: 'broker-fee:frozen-token:price' }]);
  expect(createLink.mock.calls.map(call => call[1])).toEqual([{ idempotencyKey: 'broker-fee:frozen-token:link' }, { idempotencyKey: 'broker-fee:frozen-token:link' }]);
});
