import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const h = vi.hoisted(() => ({ rows: new Map<string, any>(), models: new Map<string, any>(), objects: new Map<string, Uint8Array>(), beforeCommit: undefined as (() => void) | undefined, modelReads: [] as [string, string][], indexInvoices: undefined as any[] | undefined, invoiceInFlight: 0, maxInvoiceInFlight: 0, failedInvoice: undefined as string | undefined }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class { async send(command: any) { if (command.constructor.name === 'PutObjectCommand') h.objects.set(command.input.Key, command.input.Body); return {}; } }, PutObjectCommand: class PutObjectCommand { constructor(public input: any) {} }, GetObjectCommand: class GetObjectCommand { constructor(public input: any) {} } }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://documents.example.test/signed.pdf' }));
vi.mock('../../amplify/functions/broker-fees/disclosurePdf', () => ({ createBrokerFeeDisclosurePdf: async () => ({ bytes: new TextEncoder().encode('%PDF-1.7 signed test fixture') }) }));
vi.mock('../../amplify/functions/broker-fees/store', async original => {
  const actual = await original<typeof import('../../amplify/functions/broker-fees/store')>();
  return { ...actual, table: () => 'Fees', modelTable: (model: string) => model,
    getRow: async (id: string) => h.rows.get(id), getFee: async (id: string) => h.rows.get(`fee:${id}`), getAgreement: async (id: string) => h.rows.get(id),
    getModel: async (model: string, id: string) => {
      h.modelReads.push([model, id]);
      if (model !== 'Invoice') return h.models.get(`${model}:${id}`);
      h.invoiceInFlight++; h.maxInvoiceInFlight = Math.max(h.maxInvoiceInFlight, h.invoiceInFlight);
      try { await Promise.resolve(); if (h.failedInvoice === id) throw new Error('Temporary invoice read failure'); return h.models.get(`${model}:${id}`); }
      finally { h.invoiceInFlight--; }
    },
    accountModels: async (model: string, accountId: string) => model === 'Invoice' && h.indexInvoices ? h.indexInvoices : [...h.models.entries()].filter(([key, value]) => key.startsWith(`${model}:`) && value.accountId === accountId).map(([, value]) => value),
    transact: async (writes: any[]) => {
      const before = h.beforeCommit; h.beforeCommit = undefined; before?.();
      for (const write of writes) {
        const item = write.Put || write.ConditionCheck || write.Update, key = item.Item?.id || item.Key.id, prior = item.TableName === process.env.BROKER_FEE_TABLE || item.TableName === 'Fees' ? h.rows.get(key) : h.models.get(`${item.TableName}:${key}`);
        if (item.ConditionExpression === 'attribute_not_exists(id)' && prior || item.ExpressionAttributeValues?.[':v'] !== undefined && prior?.[item.ExpressionAttributeNames['#v']] !== item.ExpressionAttributeValues[':v']) throw Object.assign(new Error('Concurrent update'), { name: 'TransactionCanceledException' });
        if (write.Update && prior?.updatedAt !== item.ExpressionAttributeValues[':old']) throw Object.assign(new Error('Concurrent update'), { name: 'TransactionCanceledException' });
      }
      for (const write of writes) if (write.Put) { const item = structuredClone(write.Put.Item); if (write.Put.TableName === 'Fees') h.rows.set(item.id, item); else h.models.set(`${write.Put.TableName}:${item.id}`, item); }
      for (const { Update: update } of writes.filter(write => write.Update)) { const key = `${update.TableName}:${update.Key.id}`; h.models.set(key, { ...h.models.get(key), brokerFeeHistory: update.ExpressionAttributeValues[':history'], updatedAt: update.ExpressionAttributeValues[':now'] }); }
    },
  };
});
import { prepareBrokerFeeAgreement, brokerFeeDisclosure, signBrokerFeeDisclosure, jurisdictionRule, safePaymentUrl, type BrokerFeeJurisdictionRule } from '../../amplify/functions/broker-fees/agreements';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import type { BrokerFeeQuote } from '../../../shared/brokerFees';
const NOW = '2026-11-04T15:00:00.000Z';
const rule = (): BrokerFeeJurisdictionRule => ({ approved: true, version: 'review1', reviewedAt: '2026-11-01T15:00:00Z', reviewedBy: 'Owner', evidenceUrl: 'https://regulator.example.test/fees', allowedLines: ['Property'], allowedBillTypes: ['AGENCY', 'DIRECT'], allowsCarrierCommission: true, maxFeeCents: 100000, forms: [{ title: 'Approved state disclosure', paragraphs: ['State disclosure text reviewed for this program.'] }] });
const snapshot = (id = 'q1'): BrokerFeeQuote => { const quote = h.models.get(`Quote:${id}`); return { ...quote, carrierName: 'Example Mutual', terms: authorizedQuoteTerms(quote) }; };
const signer = { signerName: 'Pat Manager', signerEmail: 'pat@example.com', signerRole: 'Property Manager', consent: true };
const prepared = async (quotes = [snapshot()]) => { const value = await prepareBrokerFeeAgreement('a1', quotes); return { ...value, token: new URL(value.url).searchParams.get('t')! }; };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); h.rows.clear(); h.models.clear(); h.objects.clear(); h.beforeCommit = undefined; h.modelReads = []; h.indexInvoices = undefined; h.invoiceInFlight = 0; h.maxInvoiceInFlight = 0; h.failedInvoice = undefined;
  process.env.BROKER_FEE_TABLE = 'Fees'; process.env.SITE_URL = 'https://agency.example.test'; process.env.DOCUMENT_BUCKET = 'Documents';
  h.models.set('Account:a1', { id: 'a1', name: 'Maple HOA', state: 'MA', updatedAt: NOW });
  h.models.set('AgencySettings:AGENCY', { id: 'AGENCY', updatedAt: NOW, brokerFeeJurisdictions: { MA: rule() } });
  h.models.set('Quote:q1', { id: 'q1', accountId: 'a1', carrierId: 'carrier1', lines: ['Property'], premium: 12000, commissionPct: 15, notes: 'PRIVATE NOTES', brokerFee: 250, billType: 'AGENCY', status: 'QUOTED', effectiveDate: '2027-01-01', expirationDate: '2028-01-01', updatedAt: NOW });
});
describe('broker fee client disclosure', () => {
  it('retains optional policy display fields in the public terms returned for an issued disclosure', async () => {
    const quote = h.models.get('Quote:q1');
    quote.effectiveDate = null; delete quote.expirationDate; quote.premium = null;
    const p = await prepared([{ ...snapshot(), carrierName: undefined }]);
    expect(await brokerFeeDisclosure(p.token)).toMatchObject({
      state: 'open', totalCents: 25000,
      quotes: [{ id: 'q1', premium: null, effectiveDate: null, brokerFee: 250 }],
    });
  });
  it('retains all issued payment references when replacing stale fee terms', async () => {
    await prepared();
    Object.assign(h.rows.get('fee:q1'), { issuedInvoiceIds:['old-invoice'],issuedLoanIds:['old-loan'] });
    h.models.set('PfLoan:old-loan',{id:'old-loan',accountId:'a1',status:'QUOTED',updatedAt:NOW,brokerFeeAllocations:[{quoteId:'q1',amountCents:25000}]});
    h.models.get('Quote:q1').premium=13000;
    await prepared();
    expect(h.rows.get('fee:q1')).toMatchObject({issuedInvoiceIds:['old-invoice'],issuedLoanIds:['old-loan'],terms:authorizedQuoteTerms(h.models.get('Quote:q1'))});
  });
  it('cannot replace stale disclosure terms around a live financing checkout', async () => {
    await prepared();
    Object.assign(h.rows.get('fee:q1'),{issuedLoanIds:['old-loan']});
    h.models.set('PfLoan:old-loan',{id:'old-loan',accountId:'a1',status:'QUOTED',updatedAt:NOW,brokerFeeAllocations:[{quoteId:'q1',amountCents:25000}],electionCheckoutUrl:'https://checkout.stripe.com/c/pay',electionCheckoutExpiresAt:'2099-01-01'});
    h.models.get('Quote:q1').premium=13000;
    await expect(prepared()).rejects.toThrow('financing payment');
    expect(h.rows.get('fee:q1').issuedLoanIds).toEqual(['old-loan']);
  });
  it('rejects direct-bill broker fees before preparing an agreement', async () => {
    h.models.get('Quote:q1').billType = 'DIRECT';
    await expect(prepared()).rejects.toThrow('Broker fees require agency billing.');
    expect(h.rows.size).toBe(0);
  });
  it('closes an existing unsigned direct-bill fee link and prevents signing it', async () => {
    const p = await prepared();
    const quote = h.models.get('Quote:q1'); quote.billType = 'DIRECT';
    const agreement = h.rows.get(p.agreementId), terms = authorizedQuoteTerms(quote);
    agreement.quotes[0] = { ...agreement.quotes[0], billType: 'DIRECT', terms };
    h.rows.get('fee:q1').terms = terms;
    expect(await brokerFeeDisclosure(p.token)).toMatchObject({ state: 'closed' });
    await expect(signBrokerFeeDisclosure(p.token, signer)).rejects.toThrow('Broker fees require agency billing.');
    expect(h.rows.get('fee:q1').signedAt).toBeUndefined();
  });
  it('stores only a token hash and returns an explicit public projection', async () => {
    const p = await prepared(), dto = await brokerFeeDisclosure(p.token);
    expect(h.rows.has(`token:${createHash('sha256').update(p.token).digest('hex')}`)).toBe(true);
    expect(JSON.stringify([...h.rows.values()])).not.toContain(p.token);
    expect(dto).toMatchObject({ state: 'open', totalCents: 25000, accountName: 'Maple HOA' });
    expect(JSON.stringify(dto)).not.toMatch(/PRIVATE NOTES|commissionPct|terms|carrier1/);
    expect(dto.payments).toBeUndefined(); expect(dto.downloadUrl).toBeUndefined();
  });
  it('atomically files one immutable signed PDF for all policies and signs every positive fee', async () => {
    h.models.set('Quote:q2', { ...h.models.get('Quote:q1'), id: 'q2', brokerFee: 100 });
    const p = await prepared([snapshot(), snapshot('q2')]), result = await signBrokerFeeDisclosure(p.token, signer, '192.0.2.1');
    expect(result).toMatchObject({ state: 'signed', totalCents: 35000, downloadUrl: 'https://documents.example.test/signed.pdf' });
    expect(h.rows.get('fee:q1')).toMatchObject({ agreementId: p.agreementId, signedAt: NOW }); expect(h.rows.get('fee:q2').signedAt).toBe(NOW);
    const documents = [...h.models.entries()].filter(([key]) => key.startsWith('Document:')).map(([, value]) => value);
    expect(documents).toHaveLength(1); expect(documents[0]).toMatchObject({ entityId: 'a1', category: 'BROKER_FEE_DISCLOSURE', quoteIds: ['q1', 'q2'], policyIds: [], signatureEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(documents[0].s3Key).toContain(`documents/ACCOUNT/a1/${documents[0].id}/`);
    expect(h.rows.get(p.agreementId).signature).toMatchObject({ email: 'pat@example.com', consent: true, ip: '192.0.2.1' });
    expect(h.models.get('Account:a1').brokerFeeHistory).toBe(true);
  });
  it('keeps an existing signature on retries without creating another file', async () => {
    const p = await prepared(); await signBrokerFeeDisclosure(p.token, signer); const objectCount = h.objects.size;
    await signBrokerFeeDisclosure(p.token, { ...signer, signerName: 'Different Person' });
    expect(h.rows.get(p.agreementId).signature.name).toBe('Pat Manager'); expect(h.objects.size).toBe(objectCount);
  });
  it.each(['fee', 'premium', 'billing', 'deleted', 'expired', 'state forms'])('refuses stale %s disclosure links', async change => {
    const p = await prepared();
    if (change === 'fee') h.models.get('Quote:q1').brokerFee = 251;
    if (change === 'premium') h.models.get('Quote:q1').premium = 13000;
    if (change === 'billing') h.models.get('Quote:q1').billType = 'DIRECT';
    if (change === 'deleted') h.models.set('Communication:deleted-account:a1', { id: 'deleted-account:a1' });
    if (change === 'expired') vi.advanceTimersByTime(15 * 86_400_000);
    if (change === 'state forms') h.models.get('AgencySettings:AGENCY').brokerFeeJurisdictions.MA.forms[0].paragraphs[0] = 'New required terms';
    await expect(signBrokerFeeDisclosure(p.token, signer)).rejects.toThrow(); expect(h.models.has('Document:')).toBe(false); expect(h.rows.get('fee:q1').signedAt).toBeUndefined();
  });
  it('preserves fee consent when only private notes or the carrier commission percentage changes', async () => {
    const p = await prepared(); await signBrokerFeeDisclosure(p.token, signer);
    h.models.get('Quote:q1').notes = 'Updated internal note'; h.models.get('Quote:q1').commissionPct = 20;
    expect((await brokerFeeDisclosure(p.token)).state).toBe('signed');
    expect(h.rows.get('fee:q1').signedAt).toBe(NOW);
  });
  it('discloses and freezes carrier compensation only when the reviewed state rule requires it', async () => {
    h.models.get('AgencySettings:AGENCY').brokerFeeJurisdictions.MA.discloseCarrierCommission = true;
    const p = await prepared(), dto = await brokerFeeDisclosure(p.token);
    expect(dto.quotes?.[0]).toMatchObject({ agencyCommissionPct: 15, agencyCommissionCents: 180000 });
    h.models.get('Quote:q1').commissionPct = 20;
    await expect(signBrokerFeeDisclosure(p.token, signer)).rejects.toThrow('no longer available');
    expect(h.rows.get('fee:q1').signedAt).toBeUndefined();
  });
  it('fences account deletion racing the signature transaction', async () => {
    const p = await prepared(); h.beforeCommit = () => h.models.set('Communication:deleted-account:a1', { id: 'deleted-account:a1' });
    await expect(signBrokerFeeDisclosure(p.token, signer)).rejects.toThrow('Concurrent');
    expect(h.rows.get(p.agreementId).signature).toBeUndefined(); expect([...h.models.keys()].some(key => key.startsWith('Document:'))).toBe(false);
  });
  it('requires affirmative e-consent and meaningful signer identity', async () => {
    const p = await prepared();
    await expect(signBrokerFeeDisclosure(p.token, { ...signer, consent: false })).rejects.toThrow('consent');
    await expect(signBrokerFeeDisclosure(p.token, { ...signer, signerEmail: 'invalid' })).rejects.toThrow('email');
    expect(h.objects.size).toBe(0);
  });
  it('exposes only issued, signed-fee payment links and only approved payment hosts', async () => {
    const p = await prepared();
    h.models.set('Invoice:i1', { id: 'i1', accountId: 'a1', number: 'INV-1', status: 'SENT', paymentUrl: 'https://buy.stripe.com/example', brokerFeeFinanceUrl: 'https://agency.example.test/finance/?t=existing-token', brokerFeeAllocations: JSON.stringify([{ quoteId: 'q1', amountCents: 25000 }]) });
    expect((await brokerFeeDisclosure(p.token)).payments).toBeUndefined();
    const signed = await signBrokerFeeDisclosure(p.token, signer); expect(signed.payments).toHaveLength(2);
    h.models.get('Invoice:i1').paymentUrl = 'https://attacker.example.test/checkout'; h.models.get('Invoice:i1').brokerFeeFinanceUrl = 'https://attacker.example.test/finance/?t=token';
    expect((await brokerFeeDisclosure(p.token)).payments).toEqual([]);
    h.models.get('Invoice:i1').status = 'PAID'; expect((await brokerFeeDisclosure(p.token)).payments).toEqual([]);
  });
  it('does not expose an invoice that also collects an unsigned second fee', async () => {
    const p = await prepared(); h.models.set('Invoice:i1', { id: 'i1', accountId: 'a1', status: 'SENT', paymentUrl: 'https://buy.stripe.com/example', brokerFeeAllocations: [{ quoteId: 'q1', amountCents: 25000 }, { quoteId: 'q2', amountCents: 10000 }] });
    expect((await signBrokerFeeDisclosure(p.token, signer)).payments).toEqual([]);
  });
  it('strongly reads only plausible covered invoices in bounded batches and rechecks stale index facts', async () => {
    h.models.set('Quote:q2', { ...h.models.get('Quote:q1'), id: 'q2', brokerFee: 100 });
    const p = await prepared([snapshot(), snapshot('q2')]); await signBrokerFeeDisclosure(p.token, signer);
    const base = { accountId: 'a1', status: 'SENT', quoteId: 'q1', paymentUrl: 'https://buy.stripe.com/live', brokerFeeAllocations: [{ quoteId: 'q1', amountCents: 25000 }] };
    const indexed: any[] = [];
    for (let i = 0; i < 400; i++) {
      const row = { ...base, id: `unrelated-${i}`, ...(i < 150 ? { status: 'PAID' } : i < 300 ? { quoteId: 'other-quote', brokerFeeAllocations: [{ quoteId: 'other-quote', amountCents: 25000 }] } : i < 350 ? { paymentUrl: 'https://unapproved.example.test/pay' } : { brokerFeeAllocations: '{invalid-index-projection' }) };
      indexed.push(row); h.models.set(`Invoice:${row.id}`, row);
    }
    const add = (id: string, current: Record<string, unknown> = {}, index: Record<string, unknown> = {}) => {
      h.models.set(`Invoice:${id}`, { ...base, id, ...current }); indexed.push({ ...base, id, ...index });
    };
    // A rollover can retain an older quote anchor; frozen fee allocations
    // identify the covered quote even when only the policy anchor is current.
    add('live', { quoteId: 'old-quote-anchor', policyId: 'bound-q1', paymentUrl: 'https://buy.stripe.com/live', brokerFeeFinanceUrl: 'https://agency.example.test/finance/?t=existing-one' });
    add('finance-only', { quoteId: undefined, policyId: 'bound-q2', brokerFeeAllocations: [{ quoteId: 'q2', policyId: 'bound-q2', amountCents: 10000 }], paymentUrl: undefined, brokerFeeFinanceUrl: 'https://agency.example.test/finance/?t=existing-two' }, { quoteId: undefined, policyId: 'bound-q2', brokerFeeAllocations: [{ quoteId: 'q2', policyId: 'bound-q2', amountCents: 10000 }], paymentUrl: undefined, brokerFeeFinanceUrl: 'https://agency.example.test/finance/?t=existing-two' });
    add('retry-after-failure', { paymentUrl: 'https://buy.stripe.com/retry' }, { status: 'PROCESSING' });
    add('now-paid', { status: 'PAID' }); add('now-void', { status: 'VOID' }); add('still-clearing', { status: 'PROCESSING' });
    add('changed-url', { paymentUrl: 'https://unapproved.example.test/pay' }); add('changed-account', { accountId: 'other-account' });
    add('changed-allocation', { brokerFeeAllocations: [{ quoteId: 'other-quote', amountCents: 25000 }] });
    add('unsigned-other-fee', { brokerFeeAllocations: [{ quoteId: 'q1', amountCents: 25000 }, { quoteId: 'unsigned-quote', amountCents: 1000 }] });
    add('missing'); h.models.delete('Invoice:missing');
    const candidateIds = indexed.slice(400).map(invoice => invoice.id); indexed.push({ ...indexed[400] }); // Duplicate GSI appearance needs only one strong read.
    h.indexInvoices = indexed; h.modelReads = []; h.maxInvoiceInFlight = 0;
    const dto = await brokerFeeDisclosure(p.token);
    expect(h.modelReads.filter(([model]) => model === 'Invoice').map(([, id]) => id)).toEqual(candidateIds);
    expect(h.maxInvoiceInFlight).toBe(5); expect(h.invoiceInFlight).toBe(0);
    expect(dto.payments?.map(payment => payment.url)).toEqual(['https://buy.stripe.com/live', 'https://agency.example.test/finance/?t=existing-one', 'https://agency.example.test/finance/?t=existing-two', 'https://buy.stripe.com/retry']);
  });
  it('propagates a candidate invoice read failure instead of presenting an incomplete payment list', async () => {
    const p = await prepared(); await signBrokerFeeDisclosure(p.token, signer);
    h.indexInvoices = [{ id: 'unavailable', accountId: 'a1', status: 'SENT', paymentUrl: 'https://buy.stripe.com/live', brokerFeeAllocations: [{ quoteId: 'q1', amountCents: 25000 }] }];
    h.failedInvoice = 'unavailable';
    await expect(brokerFeeDisclosure(p.token)).rejects.toThrow('Temporary invoice read failure');
  });
  it('does not discard a prior signature when preparing another email for the same quote terms', async () => {
    const p = await prepared(); await signBrokerFeeDisclosure(p.token, signer); const original = structuredClone(h.rows.get('fee:q1'));
    const resend = await prepared(); expect(h.rows.get('fee:q1')).toEqual(original); expect(resend.agreementId).toBe(p.agreementId); expect(resend.token).not.toBe(p.token); expect((await brokerFeeDisclosure(resend.token)).state).toBe('signed');
  });
  it('renews access to an existing signed agreement without requiring another signature', async () => {
    const p = await prepared(); await signBrokerFeeDisclosure(p.token, signer); vi.advanceTimersByTime(15 * 86_400_000);
    expect((await brokerFeeDisclosure(p.token)).state).toBe('closed');
    const resend = await prepared(); expect(resend.agreementId).toBe(p.agreementId); expect((await brokerFeeDisclosure(resend.token)).state).toBe('signed');
  });
  it('uses the current combined disclosure for a single-policy invoice without adding another signing event', async () => {
    h.models.set('Quote:q2', { ...h.models.get('Quote:q1'), id: 'q2', brokerFee: 100 });
    const proposal = await prepared([snapshot(), snapshot('q2')]);
    const invoice = await prepareBrokerFeeAgreement('a1', [snapshot()], undefined, { reuseContainingAgreement: true });
    expect(invoice.agreementId).toBe(proposal.agreementId);
    const dto = await brokerFeeDisclosure(new URL(invoice.url).searchParams.get('t')!); expect(dto.totalCents).toBe(35000); expect(dto.quotes).toHaveLength(2);
    await signBrokerFeeDisclosure(new URL(invoice.url).searchParams.get('t')!, signer);
    expect(h.rows.get('fee:q1').signedAt).toBe(NOW); expect(h.rows.get('fee:q2').signedAt).toBe(NOW);
  });
  it('keeps an explicitly revised proposal limited to its chosen policies and refuses stale combined reuse', async () => {
    h.models.set('Quote:q2', { ...h.models.get('Quote:q1'), id: 'q2', brokerFee: 100 });
    const proposal = await prepared([snapshot(), snapshot('q2')]);
    h.models.get('Quote:q2').brokerFee = 200;
    const invoice = await prepareBrokerFeeAgreement('a1', [snapshot()], undefined, { reuseContainingAgreement: true });
    expect(invoice.agreementId).not.toBe(proposal.agreementId);
    const revised = await prepared([snapshot()]); expect(revised.agreementId).not.toBe(proposal.agreementId); expect(h.rows.get(revised.agreementId).quotes).toHaveLength(1);
    const invoiceAgain = await prepareBrokerFeeAgreement('a1', [snapshot()], undefined, { reuseContainingAgreement: true }); expect(invoiceAgain.agreementId).toBe(revised.agreementId);
  });
});
describe('reviewed broker fee jurisdiction restrictions', () => {
  it('requires explicit state approval and caps and product restrictions', () => {
    expect(() => jurisdictionRule({}, 'MA', [snapshot()])).toThrow('not been configured');
    expect(() => jurisdictionRule({ MA: { ...rule(), maxFeeCents: 100 } }, 'MA', [snapshot()])).toThrow('exceeds');
    expect(() => jurisdictionRule({ MA: { ...rule(), allowedLines: ['Auto'] } }, 'MA', [snapshot()])).toThrow('coverage lines');
    expect(() => jurisdictionRule({ MA: { ...rule(), allowedBillTypes: ['DIRECT'] } }, 'MA', [snapshot()])).toThrow('billing method');
    expect(() => jurisdictionRule({ MA: { ...rule(), allowsCarrierCommission: false } }, 'MA', [snapshot()])).toThrow('not been configured');
  });
  it('requires actual one-time agency signer authorization when countersignature is required', () => {
    expect(() => jurisdictionRule({ MA: { ...rule(), requiresBrokerSignature: true } }, 'MA', [snapshot()])).toThrow('authorized agency signer');
    expect(() => jurisdictionRule({ MA: { ...rule(), requiresBrokerSignature: true, agencySigner: { name: 'Agent', title: 'Broker', licenseNumber: '123', authorized: true, authorizedBy: 'owner-id', authorizedAt: '2026-11-01T15:00:00Z' } } }, 'MA', [snapshot()])).not.toThrow();
  });
  it.each(['http://buy.stripe.com/x', 'https://buy.stripe.com.attacker.test/x', 'javascript:alert(1)', 'https://user:password@buy.stripe.com/x'])('rejects unsafe payment destination %s', value => expect(safePaymentUrl(value)).toBe(false));
});
