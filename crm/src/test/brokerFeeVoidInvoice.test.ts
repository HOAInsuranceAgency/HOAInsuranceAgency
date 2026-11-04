import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({send:vi.fn(),deactivate:vi.fn(),list:vi.fn(),expire:vi.fn(),intent:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:m.send})}}));
vi.mock('stripe',()=>({default:class{paymentLinks={update:m.deactivate};checkout={sessions:{list:m.list,expire:m.expire}};paymentIntents={retrieve:m.intent};}}));
import { handler } from '../../amplify/functions/void-invoice/handler';
let row:Record<string,unknown>, sessions:Record<string,unknown>[];
beforeEach(()=>{
 vi.clearAllMocks();process.env.INVOICE_TABLE='Invoices';process.env.STRIPE_SECRET_KEY='fixture';
 row={id:'i1',number:'INV1',status:'SENT',stripePaymentLinkId:'plink1',brokerFeeAllocations:JSON.stringify([{quoteId:'q1',amountCents:50000}])};sessions=[];
 m.send.mockImplementation(async c=>c.constructor.name==='GetCommand'?{Item:{...row}}:(row.status='VOID',{}));
 m.deactivate.mockResolvedValue({});m.expire.mockResolvedValue({});
 m.list.mockImplementation(()=> (async function*(){for(const session of sessions)yield session;})());
 m.intent.mockResolvedValue({status:'requires_action'});
});
describe('voiding an issued broker fee invoice',()=>{
 it('expires every open checkout before releasing the invoice',async()=>{
  sessions=[{id:'cs1',status:'open',payment_status:'unpaid'},{id:'cs2',status:'open',payment_status:'unpaid'}];
  expect(await handler({arguments:{invoiceId:'i1'}})).toEqual({ok:true});
  expect(m.expire.mock.calls).toEqual([['cs1'],['cs2']]);
  expect(m.deactivate.mock.invocationCallOrder[0]).toBeLessThan(m.expire.mock.invocationCallOrder[0]);
  expect(m.expire.mock.invocationCallOrder[1]).toBeLessThan(m.send.mock.invocationCallOrder[1]);
  expect(row.status).toBe('VOID');
 });
 it('refuses an already submitted microdeposit checkout',async()=>{
  sessions=[{id:'cs1',status:'complete',payment_status:'unpaid',payment_intent:'pi1'}];
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false,error:expect.stringContaining('submitted')});
  expect(row.status).toBe('SENT');
 });
 it('leaves the fee obligation frozen if a session cannot be expired',async()=>{
  sessions=[{id:'cs1',status:'open',payment_status:'unpaid'}];m.expire.mockRejectedValue(new Error('processor unavailable'));
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false});
  expect(row.status).toBe('SENT');
 });
 it('can void a completed checkout after its debit has definitively failed',async()=>{
  sessions=[{id:'cs1',status:'complete',payment_status:'unpaid',payment_intent:'pi1'}];m.intent.mockResolvedValue({status:'requires_payment_method'});
  expect(await handler({arguments:{invoiceId:'i1'}})).toEqual({ok:true});
 });
 it('keeps existing non-fee invoice behavior',async()=>{
  row.brokerFeeAllocations=[];
  expect(await handler({arguments:{invoiceId:'i1'}})).toEqual({ok:true});
  expect(m.list).not.toHaveBeenCalled();
 });
});
