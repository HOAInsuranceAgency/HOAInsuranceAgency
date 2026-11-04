import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), sync: vi.fn(), verify: vi.fn(), retrieve: vi.fn(), charge: vi.fn(), pf: vi.fn(), event: {} as Record<string, unknown> }));
vi.mock('stripe', () => ({ default: class { webhooks = { constructEvent: m.verify }; paymentIntents = { retrieve: m.retrieve }; charges = { retrieve: m.charge }; } }));
vi.mock('../../amplify/functions/broker-fees/payments', () => ({ syncBrokerFeePayment: m.sync }));
vi.mock('../../amplify/functions/stripe-webhook/pf', () => ({ applyPfEvent: m.pf }));
vi.mock('../../amplify/functions/stripe-webhook/persist', () => ({ readInvoice: m.read, writePaymentState: m.write }));
vi.mock('../../amplify/functions/transactional-mail/client', () => ({ TransactionalMailClient: class { send = vi.fn(); } }));
import { handler } from '../../amplify/functions/stripe-webhook/handler';
const allocations = [{ quoteId: 'q1', amountCents: 50000 }];
let invoice: Record<string, unknown>;
const envelope = { headers: { 'stripe-signature': 'verified-fixture' }, body: '{}' };
function payment(type: string) {
  return { type, created: 1793782800, data: { object: { id: 'pi1', amount: 1050000, amount_received: type.endsWith('succeeded') ? 1050000 : 0, created: 1793782700,
    metadata: { invoiceId: 'i1', brokerFeeAccountId: 'a1', brokerFeeAllocations: JSON.stringify(allocations) } } } };
}
beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
  process.env.STRIPE_SECRET_KEY = 'fixture';
  delete process.env.ACCOUNTING_MAILBOX;
  delete process.env.PF_LOAN_TABLE;
  invoice = { id: 'i1', accountId: 'a1', status: 'SENT', stripeEventAt: null, stripePaymentIntentId: null, stripeIntentCreatedAt: null,
    stripeLinkAmountCents: 1050000, stripePaymentLinkId: "plink1", brokerFeeAllocations: allocations, remittanceBrokerFeeCents: 50000 };
  m.verify.mockImplementation(() => m.event);
  m.read.mockImplementation(async () => ({ ...invoice }));
  m.write.mockImplementation(async (update) => { invoice = { ...invoice, status: update.status, stripePaymentIntentId: update.paymentIntentId, stripeEventAt: update.occurredAt }; return true; });
  m.sync.mockResolvedValue(undefined);
  m.pf.mockResolvedValue("submitted");
  m.retrieve.mockResolvedValue({ metadata: { brokerFeeAccountId: 'a1', brokerFeeAllocations: JSON.stringify(allocations) } });
  m.charge.mockResolvedValue({ id: 'ch1', payment_intent: 'pi1', paid: true, amount: 1050000, amount_refunded: 0, currency: 'usd' });
});
describe('verified broker fee payments', () => {
  it('records ACH submission even when amount_received is still zero', async () => {
    m.event = payment('payment_intent.processing');
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'pi1', status: 'PROCESSING', allocations }));
  });
  it('retries ledger posting after an already persisted PAID transition', async () => {
    m.event = payment('payment_intent.succeeded');
    m.sync.mockRejectedValueOnce(new Error('ledger unavailable'));
    expect((await handler(envelope)).statusCode).toBe(500);
    expect(invoice.status).toBe('PAID');
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).toHaveBeenCalledTimes(2);
    expect(m.write).toHaveBeenCalledTimes(1);
  });
  it('rejects a received amount that differs from the charge snapshot', async () => {
    m.event = payment('payment_intent.succeeded');
    (m.event.data as {object:{amount_received:number}}).object.amount_received = 50000;
    expect((await handler(envelope)).statusCode).toBe(500);
    expect(m.sync).not.toHaveBeenCalled();
    expect(invoice.status).toBe("SENT");
  });
  it('records the exact fee on a full mixed premium-and-fee refund', async () => {
    m.event = { type: 'charge.refunded', created: 1793782800, data: { object: { id: 'ch1', payment_intent: 'pi1', created: 1793782700, amount: 1050000, amount_refunded: 1050000, refunded: true } } };
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).toHaveBeenLastCalledWith(expect.objectContaining({ sourceId: 'pi1', status: 'REFUNDED', refundedCents: 50000 }));
    expect(m.sync).toHaveBeenCalledTimes(1);
  });
  it('does not guess the fee component of a gross partial refund', async () => {
    m.event = { type: 'charge.refunded', created: 1793782800, data: { object: { id: 'ch1', payment_intent: 'pi1', amount: 1050000, amount_refunded: 20000, refunded: false, refunds: { data: [{ status: 'succeeded', amount: 20000, metadata: {} }] } } } };
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).not.toHaveBeenCalled();
  });
  it('reverses the fee after a verified final lost dispute of the full charge', async () => {
    m.event = { type: 'charge.dispute.closed', created: 1793782800, data: { object: { id: 'dp1', status: 'lost', charge: 'ch1', payment_intent: 'pi1', amount: 1050000, currency: 'usd' } } };
    m.retrieve.mockResolvedValue({ id: 'pi1', amount: 1050000, amount_received: 1050000, currency: 'usd', metadata: { brokerFeeAccountId: 'a1', brokerFeeAllocations: JSON.stringify(allocations) } });
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'pi1', status: 'REFUNDED', refundedCents: 50000 }));
  });
  it('does not reverse fee earnings for a won dispute or an unallocated partial dispute', async () => {
    m.retrieve.mockResolvedValue({ id: 'pi1', amount: 1050000, amount_received: 1050000, currency: 'usd', metadata: { brokerFeeAccountId: 'a1', brokerFeeAllocations: JSON.stringify(allocations) } });
    for (const [status, amount] of [['won', 1050000], ['lost', 10000]] as const) {
      m.event = { type: 'charge.dispute.closed', created: 1793782800, data: { object: { id: 'dp1', status, charge: 'ch1', payment_intent: 'pi1', amount, currency: 'usd' } } };
      expect((await handler(envelope)).statusCode).toBe(200);
    }
    expect(m.sync).not.toHaveBeenCalled();
  });
});

describe("completed fee checkout before microdeposit verification",()=>{
  const submitted=()=>({type:'checkout.session.completed',created:1793782800,data:{object:{id:'cs1',mode:'payment',status:'complete',currency:'usd',payment_intent:'pi1',payment_link:'plink1',amount_total:1050000,metadata:{invoiceId:'i1'}}}});
  it("freezes authorized fees during verification without recording collected revenue",async()=>{
    m.event=submitted();
    m.retrieve.mockResolvedValue({id:'pi1',created:1793782700,status:'requires_action',amount:1050000,amount_received:0,currency:'usd',metadata:{invoiceId:'i1',brokerFeeAllocations:JSON.stringify(allocations),brokerFeeAccountId:'a1'}});
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(invoice.status).toBe('PROCESSING');
    expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({sourceId:'pi1',status:'PROCESSING',allocations}));
  });
  it("rejects a session for a different issued payment link",async()=>{
    m.event=submitted();
    m.retrieve.mockResolvedValue({id:'pi1',created:1793782700,status:'requires_action',amount:1050000,currency:'usd',metadata:{invoiceId:'i1',brokerFeeAllocations:JSON.stringify(allocations)}});
    invoice.stripePaymentLinkId='different';
    expect((await handler(envelope)).statusCode).toBe(500);
    expect(invoice.status).toBe('SENT');
    expect(m.sync).not.toHaveBeenCalled();
  });
});

it("records financed fee submission from a verified completed checkout before bank verification",async()=>{
  const metadata={pfLoanId:'loan1',pfKind:'down',pfBillingVersion:'3',brokerFeeAllocations:JSON.stringify(allocations),brokerFeeAccountId:'a1'};
  m.event={type:'checkout.session.completed',created:1793782800,data:{object:{id:'cs1',mode:'payment',status:'complete',currency:'usd',payment_intent:'pi1',amount_total:301000,metadata}}};
  m.retrieve.mockResolvedValue({id:'pi1',created:1793782700,status:'requires_action',amount:301000,amount_received:0,currency:'usd',metadata});
  expect((await handler(envelope)).statusCode).toBe(200);
  expect(m.pf).toHaveBeenCalledTimes(2);
  expect(m.pf).toHaveBeenNthCalledWith(1,expect.objectContaining({outcome:'COMMITTED',loanId:'loan1'}));
  expect(m.pf).toHaveBeenNthCalledWith(2,expect.objectContaining({outcome:'PROCESSING',billingVersion:3,amount:3010}));
  expect(m.sync).not.toHaveBeenCalled();
});

describe("verified dispute fee allocation",()=>{
  beforeEach(()=>m.retrieve.mockResolvedValue({id:'pi1',amount:1050000,currency:'usd',metadata:{brokerFeeAccountId:'a1',brokerFeeAllocations:JSON.stringify(allocations)}}));
  it("reverses the full fee when a lost dispute consumes every remaining dollar after a refund",async()=>{
    m.charge.mockResolvedValue({id:'ch1',payment_intent:'pi1',paid:true,amount:1050000,amount_refunded:20000,currency:'usd'});
    m.event={type:'charge.dispute.closed',created:1793782800,data:{object:{id:'dp1',status:'lost',charge:'ch1',payment_intent:'pi1',amount:1030000,currency:'usd'}}};
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({status:'REFUNDED',refundedCents:50000}));
  });
  it("uses an explicitly reviewed cumulative fee loss for a partial gross dispute",async()=>{
    m.event={type:'charge.dispute.closed',created:1793782800,data:{object:{id:'dp1',status:'lost',charge:'ch1',payment_intent:'pi1',amount:20000,currency:'usd',metadata:{brokerFeeRefundCents:'10000'}}}};
    expect((await handler(envelope)).statusCode).toBe(200);
    expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({status:'REFUNDED',refundedCents:10000}));
  });
});

it("uses the agency New York receipt day near midnight UTC",async()=>{
 m.event=payment('payment_intent.succeeded');m.event.created=Date.parse('2026-11-04T01:30:00Z')/1000;
 expect((await handler(envelope)).statusCode).toBe(200);
 expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({status:'PAID',receivedOn:'2026-11-03'}));
});
it("records an older verified charge from its immutable metadata even if the display snapshot changed",async()=>{
 m.event=payment('payment_intent.succeeded');
 const object=(m.event.data as {object:{metadata:Record<string,string>}}).object;object.metadata.invoiceTotalCents='1050000';
 invoice.stripeLinkAmountCents=1200000;
 expect((await handler(envelope)).statusCode).toBe(200);
 expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({status:'PAID',allocations}));
});
