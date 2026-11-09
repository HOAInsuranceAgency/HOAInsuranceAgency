import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({send:vi.fn(),deactivate:vi.fn(),list:vi.fn(),expire:vi.fn(),intent:vi.fn(),feeWrites:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:m.send})}}));
vi.mock('stripe',()=>({default:class{paymentLinks={update:m.deactivate};checkout={sessions:{list:m.list,expire:m.expire}};paymentIntents={retrieve:m.intent};}}));
vi.mock('../../amplify/functions/broker-fees/payments',()=>({feeInvoiceVoidWrites:m.feeWrites}));
import { handler } from '../../amplify/functions/void-invoice/handler';
let row:Record<string,unknown>, sessions:Record<string,unknown>[];
beforeEach(()=>{
 vi.clearAllMocks();process.env.INVOICE_TABLE='Invoices';process.env.STRIPE_SECRET_KEY='fixture';
 m.feeWrites.mockResolvedValue([]);
 row={id:'i1',number:'INV1',status:'SENT',stripePaymentLinkId:'plink1',brokerFeeAllocations:JSON.stringify([{quoteId:'q1',amountCents:50000}])};sessions=[];
 m.send.mockImplementation(async c=>c.constructor.name==='GetCommand'?{Item:{...row}}:(row.status='VOID',{}));
 m.deactivate.mockResolvedValue({});m.expire.mockResolvedValue({});
 m.list.mockImplementation(()=> (async function*(){for(const session of sessions)yield session;})());
 m.intent.mockResolvedValue({status:'requires_action'});
});

it.each([{sourcePricingVersion:3},{groupedPolicyIds:['p1','p2']}])('keeps a grouped draft on the separate-draft restore path',async grouped=>{
 Object.assign(row,grouped,{status:'DRAFT'});
 expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false,error:expect.stringContaining('restore the separate drafts')});
 expect(m.send.mock.calls.map(([command])=>command.constructor.name)).toEqual(['GetCommand']);
 expect(m.feeWrites).not.toHaveBeenCalled();
 expect(m.deactivate).not.toHaveBeenCalled();
 expect(row.status).toBe('DRAFT');
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

describe('voiding source-priced packets without an HOA broker fee',()=>{
 beforeEach(()=>{
  row.brokerFeeAllocations=[];
  row.remittanceBrokerFeeCents=0;
  row.sourcePricingVersion=1;
  row.quoteId='q1';
 });
 it('expires already-open payment sessions before VOID without writing a fee ledger',async()=>{
  sessions=[{id:'old1',status:'open',payment_status:'unpaid'},{id:'old2',status:'open',payment_status:'unpaid'}];
  m.expire.mockImplementation(async id=>{sessions.find(session=>session.id===id)!.status='expired';return{};});
  expect(await handler({arguments:{invoiceId:'i1'}})).toEqual({ok:true});
  expect(sessions.every(session=>session.status==='expired')).toBe(true);
  expect(m.expire.mock.calls).toEqual([['old1'],['old2']]);
  expect(m.expire.mock.invocationCallOrder.at(-1)!).toBeLessThan(m.send.mock.invocationCallOrder.at(-1)!);
  expect(row.status).toBe('VOID');
  expect(m.send.mock.calls.some(([command])=>command.constructor.name==='TransactWriteCommand')).toBe(false);
  expect(m.send.mock.calls.filter(([command])=>command.constructor.name==='UpdateCommand')).toHaveLength(1);
 });
 it.each(['processing','requires_action'])('refuses an already-completed checkout whose debit is %s',async status=>{
  sessions=[{id:'old1',status:'complete',payment_status:'unpaid',payment_intent:'pi1'}];
  m.intent.mockResolvedValue({status});
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false,error:expect.stringContaining('submitted')});
  expect(row.status).toBe('SENT');
  expect(m.send.mock.calls.some(([command])=>command.constructor.name==='UpdateCommand')).toBe(false);
 });
 it('refuses unknown session state instead of leaving an unverified old checkout payable',async()=>{
  sessions=[{id:'old1',status:'unknown',payment_status:'unpaid'}];
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false,error:expect.stringContaining('verified')});
  expect(row.status).toBe('SENT');
 });
 it('retains SENT if an old checkout cannot be expired',async()=>{
  sessions=[{id:'old1',status:'open',payment_status:'unpaid'}];
  m.expire.mockRejectedValue(new Error('Processor unavailable'));
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false});
  expect(row.status).toBe('SENT');
 });
});


describe('atomic release of the fee invoice send owner',()=>{
 const release={Put:{TableName:'Fees',Item:{id:'fee:q1',version:4},ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':3}}};
 it('commits invoice VOID and private claim release in the same transaction after checkout cleanup',async()=>{
  m.feeWrites.mockResolvedValue([release]);sessions=[{id:'cs1',status:'open',payment_status:'unpaid'}];
  expect(await handler({arguments:{invoiceId:'i1'}})).toEqual({ok:true});
  const transaction=m.send.mock.calls.find(([command])=>command.constructor.name==='TransactWriteCommand');
  expect(transaction?.[0].input.TransactItems).toEqual([expect.objectContaining({Update:expect.objectContaining({Key:{id:'i1'},ConditionExpression:expect.stringContaining('#link = :seenLink')})}),release]);
  expect(m.expire.mock.invocationCallOrder[0]).toBeLessThan(m.send.mock.invocationCallOrder.at(-1)!);
  expect(m.send.mock.calls.some(([command])=>command.constructor.name==='UpdateCommand')).toBe(false);
 });
 it('refuses an unresolved send before deactivating anything or releasing its claim',async()=>{
  row.status='DRAFT';delete row.stripePaymentLinkId;
  m.feeWrites.mockRejectedValue(new Error('Retry Send to recover the unknown payment link'));
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false});
  expect(row.status).toBe('DRAFT');expect(m.deactivate).not.toHaveBeenCalled();
  expect(m.send.mock.calls.some(([command])=>command.constructor.name==='TransactWriteCommand')).toBe(false);
 });
 it('retains the owner when a submitted checkout or processor failure prevents cleanup',async()=>{
  m.feeWrites.mockResolvedValue([release]);sessions=[{id:'cs1',status:'complete',payment_status:'unpaid',payment_intent:'pi1'}];
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false});
  expect(row.status).toBe('SENT');
  expect(m.send.mock.calls.some(([command])=>command.constructor.name==='TransactWriteCommand')).toBe(false);
 });
 it('does not release ownership when payment wins the conditional VOID transaction',async()=>{
  m.feeWrites.mockResolvedValue([release]);
  m.send.mockImplementation(async command=>{
   if(command.constructor.name==='GetCommand')return {Item:{...row}};
   if(command.constructor.name==='TransactWriteCommand'){row.status='PAID';throw Object.assign(new Error('Paid first'),{name:'TransactionCanceledException'});}
   throw new Error('Expected atomic transaction');
  });
  expect(await handler({arguments:{invoiceId:'i1'}})).toMatchObject({ok:false,error:expect.stringContaining('paid')});
  expect(row.status).toBe('PAID');
  expect(m.send.mock.calls.filter(([command])=>command.constructor.name==='TransactWriteCommand')).toHaveLength(1);
 });
});
