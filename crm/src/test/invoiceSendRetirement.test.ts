// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash } from '../../amplify/functions/transactional-mail/contract';
type Row=Record<string,any>;
const h=vi.hoisted(()=>({rows:new Map<string,Row>(),send:vi.fn(),deactivate:vi.fn(),sessions:vi.fn(),expire:vi.fn(),intent:vi.fn(),fees:vi.fn()}));
vi.mock('@aws-sdk/lib-dynamodb',async load=>({...await load<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:h.send})}}));
vi.mock('stripe',()=>({default:class{paymentLinks={update:h.deactivate};checkout={sessions:{list:h.sessions,expire:h.expire}};paymentIntents={retrieve:h.intent};}}));
vi.mock('../../amplify/functions/broker-fees/payments',()=>({feeInvoiceVoidWrites:h.fees}));
import {handler as voidInvoice} from '../../amplify/functions/void-invoice/handler';
import {beginInvoiceSend,completeInvoiceSend,invoiceSendSettled,isRetiredInvoiceSend,voidedInvoiceSendRetirementWrites} from '../../amplify/functions/send-invoice/sendOperation';
const NOW=Date.parse('2026-11-04T18:00:00.000Z'), old='2026-11-04T17:55:00.000Z';
const operation=()=>({version:1 as const,key:'invoice:i:failed-send',recipients:hash('board@example.test'),previousSentAt:null,leaseId:'original',leaseUntil:NOW-1});
const opKey=()=>`OP#hoa/main/invoice/${hash(operation().key)}`;
const invoice=()=>h.rows.get('Invoices:i')! as Row & {id:string};
const error=()=>Object.assign(new Error('Concurrent write'),{name:'TransactionCanceledException'});
function write(actions:any[]){
 const staged=structuredClone(h.rows);
 for(const action of actions){
  const item=action.Update??action.ConditionCheck,key=`${item.TableName}:${item.Key.id??item.Key.pk}`,row=staged.get(key),names=item.ExpressionAttributeNames??{},values=item.ExpressionAttributeValues??{};
  for(const condition of item.ConditionExpression.split(' AND ')){
   const equal=/^(#?\w+) = (:\w+)$/.exec(condition),absent=/^attribute_not_exists\((#?\w+)\)$/.exec(condition);
   if(equal&&JSON.stringify(row?.[names[equal[1]]??equal[1]])!==JSON.stringify(values[equal[2]]))throw error();
   if(absent&&row&&Object.hasOwn(row,names[absent[1]]??absent[1]))throw error();
  }
  if(action.Update){const next={...row,...item.Key};const [set,remove]=item.UpdateExpression.replace(/^SET /,'').split(' REMOVE ');
   for(const part of set.split(', ')){const [field,value]=part.split(' = ');next[names[field]??field]=structuredClone(values[value]);}
   for(const field of remove?.split(', ')??[])delete next[names[field]??field];staged.set(key,next);
  }
 }
 h.rows=staged;
}
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(NOW);vi.clearAllMocks();h.rows.clear();
 vi.stubEnv('INVOICE_TABLE','Invoices');vi.stubEnv('HOA_TRANSACTIONAL_MAIL_TABLE','Mail');vi.stubEnv('STRIPE_SECRET_KEY','fixture');
 vi.stubEnv('HOA_MIGRATION_APP_ID','d1nuh9rw1hcuxo');vi.stubEnv('HOA_MIGRATION_BRANCH','codex-hoa-account-migration');
 // The deployed table binding is exact. The fixture uses the same name as production.
 vi.stubEnv('HOA_TRANSACTIONAL_MAIL_TABLE','HOA-TransactionalMail');
 h.rows.set('Invoices:i',{id:'i',accountId:'a',quoteId:'q',status:'SENT',sourcePricingVersion:1,updatedAt:old,stripePaymentLinkId:'link',paymentUrl:'https://buy.stripe.com/known',invoiceSendOperation:operation()});
 h.rows.set(`HOA-TransactionalMail:${opKey()}`,{pk:opKey(),state:'DEFERRED',attempt:1,payloadHash:hash('payload'),payloadKey:'saved-envelope',provider:'ses',updatedAt:old});
 h.send.mockImplementation(async command=>{
  const input=command.input;
  if(command.constructor.name==='GetCommand')return {Item:structuredClone(h.rows.get(`${input.TableName}:${input.Key.id??input.Key.pk}`))};
  if(command.constructor.name==='TransactWriteCommand'){write(input.TransactItems);return{};}
  if(command.constructor.name==='UpdateCommand'){try{write([{Update:input}]);}catch(e){throw Object.assign(e as Error,{name:'ConditionalCheckFailedException'});}return{};}
  throw new Error('Unexpected command');
 });
 h.deactivate.mockResolvedValue({});h.sessions.mockImplementation(async function*(){yield{id:'cs',status:'open',payment_status:'unpaid'};});h.expire.mockResolvedValue({});h.intent.mockResolvedValue({status:'requires_payment_method'});h.fees.mockResolvedValue([]);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
const storedMail=()=>h.rows.get(`HOA-TransactionalMail:${opKey()}`)!;
describe('retiring interrupted invoice sends through existing Void',()=>{
 it('closes every session, then atomically retires the send and mail replay without changing delivery evidence',async()=>{
  const mailBefore=structuredClone(storedMail());
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toEqual({ok:true});
  expect(invoice()).toMatchObject({status:'VOID',invoiceSendOperation:{...operation(),retired:{reason:'VOID',invoiceId:'i',closedLinkId:'link',retiredAt:new Date(NOW).toISOString()}}});
  expect(storedMail()).toMatchObject({...mailBefore,retiredAt:new Date(NOW).toISOString(),retiredInvoiceId:'i'});
  expect(h.expire.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder.at(-1)!);
  const transaction=h.send.mock.calls.find(([command])=>command.constructor.name==='TransactWriteCommand')![0].input.TransactItems;
  expect(transaction).toHaveLength(2);expect(transaction[0].Update.ConditionExpression).toContain('#op = :seenOperation');
  expect(isRetiredInvoiceSend(invoice())).toBe(true);expect(invoiceSendSettled(invoice())).toBe(true);
 });
 it('refuses a live invoice worker before touching Stripe or releasing fees',async()=>{
  invoice().invoiceSendOperation.leaseUntil=NOW+1;
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toMatchObject({ok:false,error:expect.stringContaining('still in progress')});
  expect(h.deactivate).not.toHaveBeenCalled();expect(h.fees).not.toHaveBeenCalled();expect(invoice().status).toBe('SENT');
 });
 it('repairs an already-VOID interrupted send on the same existing action',async()=>{
  invoice().status='VOID';delete invoice().paymentUrl;
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toEqual({ok:true});expect(isRetiredInvoiceSend(invoice())).toBe(true);
  expect(h.expire).toHaveBeenCalledWith('cs');
 });
 it('does not retire when checkout verification fails',async()=>{
  h.expire.mockRejectedValue(new Error('Stripe unavailable'));
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toMatchObject({ok:false});expect(invoice().status).toBe('SENT');expect(storedMail().retiredAt).toBeUndefined();
 });
 it('a new send owner inserted during cleanup prevents retirement even at the same timestamp',async()=>{
  h.deactivate.mockImplementation(async()=>{invoice().invoiceSendOperation={...operation(),leaseId:'new-owner',leaseUntil:NOW+120000};return{};});
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toMatchObject({ok:false,error:expect.stringContaining('still in progress')});
  expect(invoice().status).toBe('SENT');expect(invoice().invoiceSendOperation.leaseId).toBe('new-owner');expect(storedMail().retiredAt).toBeUndefined();
 });
 it('an initially absent owner is also fenced against a racing reservation',async()=>{
  delete invoice().invoiceSendOperation;
  h.deactivate.mockImplementation(async()=>{invoice().invoiceSendOperation={...operation(),leaseUntil:NOW+120000};return{};});
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toMatchObject({ok:false});expect(invoice().status).toBe('SENT');
  const transaction=h.send.mock.calls.find(([command])=>command.constructor.name==='UpdateCommand')![0].input;
  expect(transaction.ConditionExpression).toContain('attribute_not_exists(#op)');
 });
 it('a recovery claim that wins first retains its fresh SENDING hold',async()=>{
  h.deactivate.mockImplementation(async()=>{Object.assign(storedMail(),{state:'SENDING',attempt:2,updatedAt:new Date(NOW).toISOString()});return{};});
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toMatchObject({ok:false,error:expect.stringContaining('email is still in progress')});
  expect(invoice().status).toBe('SENT');expect(storedMail().retiredAt).toBeUndefined();
 });
 it.each(['ACCEPTED','UNKNOWN','SENDING','REJECTED','SUPPRESSED'])('preserves %s evidence while preventing future replay after all workers drain',async state=>{
  Object.assign(storedMail(),{state,providerId:'recorded-provider',updatedAt:old});
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toEqual({ok:true});
  expect(storedMail()).toMatchObject({state,providerId:'recorded-provider',retirementReason:'INVOICE_VOID'});
 });
 it('tombstones an absent exact mail operation instead of permitting a later replay reservation',async()=>{
  h.rows.delete(`HOA-TransactionalMail:${opKey()}`);
  expect(await voidInvoice({arguments:{invoiceId:'i'}})).toEqual({ok:true});expect(storedMail()).toMatchObject({pk:opKey(),retiredInvoiceId:'i'});
 });
 it('old begin/completion cannot revive a retired send',async()=>{
  const previous=structuredClone(operation());await voidInvoice({arguments:{invoiceId:'i'}});
  await expect(beginInvoiceSend(invoice(),['board@example.test'],undefined,{database:{send:h.send} as never})).rejects.toThrow('changed');
  await expect(completeInvoiceSend('i',previous,'provider',{ok:true,sentTo:'board@example.test',subject:'Invoice',sentAt:old},{database:{send:h.send} as never})).rejects.toThrow('Concurrent write');
  expect(invoice().status).toBe('VOID');expect(isRetiredInvoiceSend(invoice())).toBe(true);
 });
});
describe('automatic repair on existing financial edit/reissue transactions',()=>{
 it('returns one invoice update plus exact mail marker for expired source-priced VOID, without a new user action',async()=>{
  invoice().status='VOID';delete invoice().paymentUrl;
  const writes=await voidedInvoiceSendRetirementWrites(invoice(),{database:{send:h.send} as never,invoiceTable:'Invoices'});write(writes);
  expect(isRetiredInvoiceSend(invoice())).toBe(true);expect(storedMail().retiredInvoiceId).toBe('i');expect(writes).toHaveLength(2);
 });
 it('does not infer closure for legacy linked VOID invoices',async()=>{
  invoice().status='VOID';delete invoice().sourcePricingVersion;
  await expect(voidedInvoiceSendRetirementWrites(invoice(),{database:{send:h.send} as never,invoiceTable:'Invoices'})).rejects.toThrow('payment sessions');
 });
 it('rejects a forged retired marker whose invoice/link or lease proof differs',()=>{
  invoice().status='VOID';invoice().invoiceSendOperation.retired={reason:'VOID',invoiceId:'other',closedLinkId:'link',retiredAt:new Date(NOW).toISOString()};
  expect(invoiceSendSettled(invoice())).toBe(false);
  invoice().invoiceSendOperation.retired.invoiceId='i';invoice().invoiceSendOperation.leaseUntil=NOW+1;expect(invoiceSendSettled(invoice())).toBe(false);
 });
});
