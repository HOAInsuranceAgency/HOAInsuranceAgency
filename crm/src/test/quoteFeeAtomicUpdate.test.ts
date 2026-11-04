// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
type Row = Record<string, any>;
const h = vi.hoisted(() => ({ models: new Map<string, Row>(), fees: new Map<string, Row>(), beforeCommit: undefined as undefined | (() => void), omitIndex:false, transactions: [] as any[][] }));
vi.mock('../../amplify/functions/broker-fees/store', async load => {
  const actual = await load<typeof import('../../amplify/functions/broker-fees/store')>();
  return { ...actual, db:{send:async(command:any)=>({Item:structuredClone(h.models.get(`${command.input.TableName}:${command.input.Key.pk}`))})}, modelTable: (model:string) => model, table: () => 'Fees',
    accountModels: async (model:string,accountId:string) => h.omitIndex ? [] : structuredClone([...h.models.entries()].filter(([key,row])=>key.startsWith(`${model}:`)&&row.accountId===accountId).map(([,row])=>row)),
    getModel: async (model:string,key:string) => structuredClone(h.models.get(`${model}:${key}`)),
    getFee: async (key:string) => structuredClone(h.fees.get(`fee:${key}`)),
    getAgreement: async (key:string) => structuredClone(h.fees.get(key)),
    transact: async (writes:any[]) => {
      const before = h.beforeCommit; h.beforeCommit = undefined; before?.();
      h.transactions.push(structuredClone(writes));
      const stagedModels = structuredClone(h.models), stagedFees = structuredClone(h.fees);
      for (const write of writes) {
        const item = write.Update ?? write.Put ?? write.ConditionCheck;
        const key = item.Key?.id ?? item.Key?.userId ?? item.Key?.pk ?? item.Item?.id;
        const store = item.TableName === 'Fees' ? stagedFees : stagedModels;
        const recordKey = item.TableName === 'Fees' ? key : `${item.TableName}:${key}`;
        const prior = store.get(recordKey), names = item.ExpressionAttributeNames ?? {}, values = item.ExpressionAttributeValues ?? {};
        const condition = item.ConditionExpression ?? '';
        const fail = () => { throw Object.assign(new Error('Concurrent update'), {name:'TransactionCanceledException'}); };
        if (condition === 'attribute_not_exists(id)' && prior) fail();
        for (const term of condition.split(' AND ')) {
          const absent = /^attribute_not_exists\((#?\w+)\)$/.exec(term);
          if (absent && prior && Object.hasOwn(prior, names[absent[1]] ?? absent[1])) fail();
          const equality = /^(#[A-Za-z0-9]+|updatedAt) = (:[A-Za-z0-9]+)$/.exec(term);
          if (equality && JSON.stringify(prior?.[names[equality[1]] ?? equality[1]]) !== JSON.stringify(values[equality[2]])) fail();
        }
        if (write.Put) store.set(recordKey, structuredClone(item.Item));
        if (write.Update) {
          const next = {...prior};
          const [set, remove] = item.UpdateExpression.replace(/^SET /,'').split(' REMOVE ');
          for (const assignment of set.split(', ')) { const [field,token] = assignment.split(' = '); next[names[field] ?? field] = structuredClone(values[token]); }
          for (const field of remove?.split(', ') ?? []) delete next[names[field] ?? field];
          store.set(recordKey,next);
        }
      }
      h.models = stagedModels; h.fees = stagedFees;
    },
  };
});
import { AccountAccess } from '../../amplify/functions/crm-access/access';
import { updateFeeQuoteAtomically } from '../../amplify/functions/crm-access/quote-fee-update';
import { assertNoFeeLoanCheckout, reserveFeeInvoice } from '../../amplify/functions/broker-fees/payments';
const NOW = '2026-11-04T18:00:00.000Z';
const quote = () => h.models.get('Quote:q')!;
const fee = () => h.fees.get('fee:q')!;
const reader = async (model:string,key:string) => structuredClone(h.models.get(`${model}:${key}`));
const access = (actor='alice',groups:string[] = []) => new AccountAccess({sub:actor,groups}, reader);
const save = (input:Row = {id:'q',premium:12000}, context:Row = {}) => updateFeeQuoteAtomically(access(), {model:'Quote',field:'updateQuote',operation:'update',nativeConditions:[],arguments:{input},...context});
beforeEach(() => {
  h.models.clear(); h.fees.clear(); h.transactions = []; h.beforeCommit = undefined; h.omitIndex=false;
  process.env.HOA_TRANSACTIONAL_MAIL_TABLE='HOA-TransactionalMail';process.env.HOA_MIGRATION_APP_ID='d1nuh9rw1hcuxo';process.env.HOA_MIGRATION_BRANCH='codex-hoa-account-migration';
  process.env.USER_ACCESS_TABLE = 'Team'; process.env.BROKER_FEE_TABLE = 'Fees';
  h.models.set('Quote:q',{id:'q',__typename:'Quote',accountId:'a',status:'QUOTED',premium:10000,brokerFee:500,billType:'AGENCY',lines:['Property'],notes:'private',createdAt:NOW,updatedAt:NOW});
  h.models.set('Communication:workflow:a',{id:'workflow:a',data:{salespersonId:'alice'}});
  h.models.set('PfLoan:loan',{id:'loan',accountId:'a',status:'QUOTED',updatedAt:NOW,brokerFeeAllocations:[{quoteId:'q',amountCents:50000}]});
  h.models.set('Invoice:old',{id:'old',accountId:'a',quoteId:'q',status:'VOID',updatedAt:NOW});
  h.fees.set('fee:q',{id:'fee:q',kind:'FEE',accountId:'a',quoteId:'q',amountCents:50000,terms:authorizedQuoteTerms(quote()),version:4,agreementId:'old-agreement',signedAt:NOW,submittedCents:0,collectedCents:0,refundedCents:0,issuedLoanIds:['loan'],issuedInvoiceIds:['old']});
});
describe('atomic native fee-bearing Quote edits', () => {
  it('commits Quote, consent reset and old offer invalidation together without losing issued history', async () => {
    const result = await save({id:'q',premium:12000,notes:null,lastWriteBy:'alice'});
    expect(result).toMatchObject({committed:true,quote:{premium:12000,createdAt:NOW,__typename:'Quote'}});
    expect(quote().premium).toBe(12000); expect(quote()).not.toHaveProperty('notes');
    expect(fee()).toMatchObject({version:5,issuedLoanIds:['loan'],issuedInvoiceIds:['old'],terms:authorizedQuoteTerms(quote())});
    expect(fee()).not.toHaveProperty('signedAt'); expect(fee()).not.toHaveProperty('agreementId');
    expect(h.models.get('PfLoan:loan')).toMatchObject({status:'CANCELLED',brokerFeeAllocations:[{quoteId:'q',amountCents:50000}]});
    expect(h.transactions).toHaveLength(1);
    expect(h.transactions[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Team',Key:{userId:'alice'}})}),
      expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Communication',Key:{id:'workflow:a'}})}),
      expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Invoice',Key:{id:'old'}})}),
    ]));
  });
  it('checkout winning after all reads cancels the entire financial edit', async () => {
    h.beforeCommit = () => { const loan = h.models.get('PfLoan:loan')!; loan.electionCheckoutUrl='claim:payable'; loan.updatedAt='2026-11-04T19:00:00Z'; };
    await expect(save()).rejects.toThrow('Concurrent update');
    expect(quote().premium).toBe(10000); expect(fee().version).toBe(4); expect(fee().signedAt).toBe(NOW);
    expect(h.models.get('PfLoan:loan')?.electionCheckoutUrl).toBe('claim:payable');
  });
  it('a same-millisecond checkout slot claim also cancels the edit', async () => {
    h.beforeCommit = () => { h.models.get('PfLoan:loan')!.electionCheckoutUrl = 'claim:same-millisecond'; };
    await expect(save()).rejects.toThrow('Concurrent update');
    expect(quote().premium).toBe(10000); expect(fee().version).toBe(4);
  });
  it('quote winning makes both old loan state and fee-version checkout conditions fail', async () => {
    const previousFee = structuredClone(fee()), oldLoan = structuredClone(h.models.get('PfLoan:loan')!);
    await save();
    const { transact } = await import('../../amplify/functions/broker-fees/store');
    // These are the same independent fences used by the public PF claim.
    await expect(transact([{ConditionCheck:{TableName:'Fees',Key:{id:'fee:q'},ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':previousFee.version}}},
      {Update:{TableName:'PfLoan',Key:{id:'loan'},UpdateExpression:'SET electionCheckoutUrl = :url',ConditionExpression:'#status = :quoted AND updatedAt = :old',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':quoted':'QUOTED',':old':oldLoan.updatedAt,':url':'claim:payable'}}}])).rejects.toThrow('Concurrent update');
    expect(h.models.get('PfLoan:loan')?.electionCheckoutUrl).toBeUndefined();
  });
  it('a newly reserved loan between reads and commit invalidates the fee reset', async () => {
    h.beforeCommit=()=>{fee().issuedLoanIds.push('new-loan');fee().version++;};
    await expect(save()).rejects.toThrow('Concurrent update'); expect(quote().premium).toBe(10000); expect(fee().issuedLoanIds).toEqual(['loan','new-loan']);
  });
  it.each(['premium','brokerFee','passThroughCharges','clientConditions','billType','status'])('fences %s changes affecting accepted terms or withdrawal', async field => {
    const values:Row={premium:11000,brokerFee:400,passThroughCharges:[{id:'tax',kind:'TAX',description:'Tax',amountCents:100}],clientConditions:'Inspection required',billType:'AGENCY',status:'LOST'};
    const input:Row={id:'q',[field]:values[field]};
    if(field==='billType'){quote().billType='DIRECT';quote().brokerFee=0;input.brokerFee=500;}
    const result=await save(input); expect(result.committed).toBe(true);expect(h.models.get('PfLoan:loan')?.status).toBe('CANCELLED');
  });
  it('rejects standalone fee-bearing account moves even for an administrator',async()=>{
    await expect(updateFeeQuoteAtomically(access('owner',['OWNER']),{model:'Quote',field:'updateQuote',operation:'update',arguments:{input:{id:'q',accountId:'other'}}})).rejects.toThrow('retain its original account');
    expect(h.transactions).toHaveLength(0);expect(quote().accountId).toBe('a');
  });
  it('leaves private-only edits on Amplify native path', async () => {
    expect(await save({id:'q',notes:'changed'})).toEqual({committed:false}); expect(h.transactions).toHaveLength(0); expect(fee().signedAt).toBe(NOW);
  });
  it.each([{adminField:true},{__typename:'Injected'},{updatedAt:'2000-01-01'},{createdAt:null}])('rejects unknown or server metadata fields before any write: %j', async extra => {
    await expect(save({id:'q',premium:12000,...extra})).rejects.toThrow('unsupported fields'); expect(h.transactions).toHaveLength(0);
  });
  it.each([{field:'crmAccess'},{model:'Policy'},{operation:'create'}])('requires fixed native context %j', async context=>{
    await expect(save(undefined,context)).rejects.toThrow('not available');expect(h.transactions).toHaveLength(0);
  });
  it('does not bypass native client conditions, auth filters or ownership', async()=>{
    await expect(save(undefined,{arguments:{input:{id:'q',premium:12000},condition:{status:{eq:'PRESENTED'}}}})).rejects.toThrow('Conditional financial');
    await expect(save(undefined,{nativeConditions:[{status:{eq:'PRESENTED'}}]})).rejects.toThrow('Conditional financial');
    await expect(save(undefined,{nativeAuthFilter:{owner:{eq:'someone'}}})).rejects.toThrow('Conditional financial');
    await expect(updateFeeQuoteAtomically(access('bob'),{model:'Quote',field:'updateQuote',operation:'update',arguments:{input:{id:'q',premium:12000}}})).rejects.toThrow('not available');
    expect(h.transactions).toHaveLength(0);
  });
  it('an absent fee row is atomically fenced without creating a new ledger record',async()=>{
    h.fees.delete('fee:q');h.beforeCommit=()=>h.fees.set('fee:q',{id:'fee:q',version:1});
    await expect(save()).rejects.toThrow('Concurrent update');expect(quote().premium).toBe(10000);
  });
  it.each(['missing','invalid expiry','active','wrong account'])('fails closed on unverified existing financing: %s', async mode=>{
    if(mode==='missing')h.models.delete('PfLoan:loan');
    if(mode==='invalid expiry')Object.assign(h.models.get('PfLoan:loan')!,{electionCheckoutUrl:'https://checkout.stripe.com/c/pay',electionCheckoutExpiresAt:'bad'});
    if(mode==='active')h.models.get('PfLoan:loan')!.status='ACTIVE';
    if(mode==='wrong account')h.models.get('PfLoan:loan')!.accountId='other';
    await expect(save()).rejects.toThrow();expect(h.transactions).toHaveLength(0);
  });
});

describe('fee reset history in payment reservations',()=>{
  it('retains old invoice and financing references after an authorized terms replacement',async()=>{
    quote().premium=12000;
    h.models.set('Invoice:new',{id:'new',accountId:'a',quoteId:'q',status:'DRAFT',updatedAt:NOW});
    await reserveFeeInvoice('q','new',1250000);
    expect(fee()).toMatchObject({issuedLoanIds:['loan'],issuedInvoiceIds:['old','new'],terms:authorizedQuoteTerms(quote())});
    expect(h.transactions[0].some(write=>write.ConditionCheck?.TableName==='PfLoan')).toBe(true);
  });
  it('cannot erase old financing history to open another payment path after repricing',async()=>{
    quote().premium=12000;
    Object.assign(h.models.get('PfLoan:loan')!,{electionCheckoutUrl:'https://checkout.stripe.com/c/pay',electionCheckoutExpiresAt:'2099-01-01'});
    h.models.set('Invoice:new',{id:'new',accountId:'a',quoteId:'q',status:'DRAFT',updatedAt:NOW});
    await expect(reserveFeeInvoice('q','new',1250000)).rejects.toThrow('financing payment');
    expect(fee().issuedLoanIds).toEqual(['loan']);expect(h.transactions).toHaveLength(0);
    await expect(assertNoFeeLoanCheckout(fee() as any)).rejects.toThrow('financing payment');
  });
});

describe('first broker fee and whole-source payment history',()=>{
  const feeFree=()=>{h.fees.clear();quote().brokerFee=0;h.models.delete('Invoice:old');h.models.delete('PfLoan:loan');};
  const addFee=()=>save({id:'q',brokerFee:500});
  it.each(['PAID','PROCESSING','SENT'])('refuses adding a first fee around prior %s billing',async status=>{
    feeFree();h.models.set('Invoice:first',{id:'first',accountId:'a',quoteId:'q',status,updatedAt:NOW});
    await expect(addFee()).rejects.toThrow('existing quote invoice');expect(quote().brokerFee).toBe(0);expect(h.transactions).toHaveLength(0);
  });
  it('cancels old fee-free QUOTED loans and touches an unsent draft atomically',async()=>{
    feeFree();h.models.set('PfLoan:free',{id:'free',accountId:'a',quoteId:'q',status:'QUOTED',updatedAt:NOW});
    h.models.set('Invoice:draft',{id:'draft',accountId:'a',quoteId:'q',status:'DRAFT',updatedAt:NOW});
    expect(await addFee()).toMatchObject({committed:true});
    expect(h.models.get('PfLoan:free')?.status).toBe('CANCELLED');expect(h.models.get('Invoice:draft')?.updatedAt).not.toBe(NOW);
    expect(h.fees.size).toBe(0); // No synthetic fee-free ledger lifecycle.
  });
  it('a same-timestamp draft send reservation defeats the financial edit',async()=>{
    feeFree();h.models.set('Invoice:draft',{id:'draft',accountId:'a',quoteId:'q',status:'DRAFT',updatedAt:NOW});
    h.beforeCommit=()=>{h.models.get('Invoice:draft')!.invoiceSendOperation={key:'reserved'};};
    await expect(addFee()).rejects.toThrow('Concurrent update');expect(quote().brokerFee).toBe(0);
  });
  it('refuses a live fee-free financing checkout without requiring a FeeRecord',async()=>{
    feeFree();h.models.set('PfLoan:free',{id:'free',accountId:'a',quoteId:'q',status:'QUOTED',updatedAt:NOW,electionCheckoutUrl:'https://checkout.stripe.com/c/pay',electionCheckoutExpiresAt:'2099-01-01'});
    await expect(addFee()).rejects.toThrow('financing payment');expect(quote().brokerFee).toBe(0);
  });
  it.each(['missing','mismatch','live'])('strongly verifies the private invoice pointer despite an empty index: %s',async kind=>{
    feeFree();(quote() as Row).sourcePricingInvoiceId='held';
    if(kind!=='missing')h.models.set('Invoice:held',{id:'held',accountId:'a',quoteId:kind==='mismatch'?'other':'q',status:'SENT',updatedAt:NOW});
    // It is deliberately absent from the index candidate path.
    h.omitIndex=true;
    await expect(addFee()).rejects.toThrow();expect(quote().brokerFee).toBe(0);
  });
  it('allows the known source owner after a strongly verified V1 VOID',async()=>{
    feeFree();quote().sourcePricingInvoiceId='held';h.omitIndex=true;
    h.models.set('Invoice:held',{id:'held',accountId:'a',quoteId:'q',status:'VOID',sourcePricingVersion:1,stripePaymentLinkId:'closed',updatedAt:NOW});
    expect(await addFee()).toMatchObject({committed:true});expect(quote().sourcePricingInvoiceId).toBe('held');
  });
  it('does not treat a legacy VOID link as proof its Checkout sessions were closed',async()=>{
    feeFree();h.models.set('Invoice:legacy',{id:'legacy',accountId:'a',quoteId:'q',status:'VOID',stripePaymentLinkId:'legacy-link',updatedAt:NOW});
    await expect(addFee()).rejects.toThrow('legacy invoice payment sessions');expect(quote().brokerFee).toBe(0);
  });
  it('uses a live loan pointer even when the account index has not caught up',async()=>{
    feeFree();quote().sourcePricingLoanId='held';h.omitIndex=true;
    h.models.set('PfLoan:held',{id:'held',accountId:'a',quoteId:'q',status:'QUOTED',updatedAt:NOW,electionCheckoutUrl:'claim-held',electionCheckoutExpiresAt:'2099-01-01'});
    await expect(addFee()).rejects.toThrow('financing payment');expect(quote().brokerFee).toBe(0);
  });
  it('blocks source billing reparenting even when the quote has never had a fee',async()=>{
    feeFree();h.models.set('Invoice:first',{id:'first',accountId:'a',quoteId:'q',status:'VOID',updatedAt:NOW});
    await expect(updateFeeQuoteAtomically(access('owner',['OWNER']),{model:'Quote',field:'updateQuote',operation:'update',arguments:{input:{id:'q',accountId:'other'}}})).rejects.toThrow('billing history');
    expect(quote().accountId).toBe('a');
  });
  it('bounds the complete source-history check rather than dropping excess records',async()=>{
    feeFree();for(let n=0;n<61;n++)h.models.set(`Invoice:${n}`,{id:String(n),accountId:'a',quoteId:'q',status:'VOID',updatedAt:NOW});
    await expect(addFee()).rejects.toThrow('Too many quote billing records');expect(h.transactions).toHaveLength(0);
  });
});

describe('private Quote publication pointers serialize both race orders',()=>{
  const freeInvoice=()=>{h.fees.clear();quote().brokerFee=0;h.models.delete('Invoice:old');h.models.delete('PfLoan:loan');h.models.set('Invoice:initial',{id:'initial',accountId:'a',quoteId:'q',sourcePricingVersion:1,status:'DRAFT',updatedAt:NOW});return h.models.get('Invoice:initial')!;};
  it('an edit winning prevents an already prepared old link from publishing',async()=>{
    const invoice=freeInvoice();const {initialQuotePublicationWrites}=await import('../../amplify/functions/quote-source-billing');
    const stalePublication=await initialQuotePublicationWrites(invoice,structuredClone(quote()));
    await save({id:'q',brokerFee:500});
    const {transact}=await import('../../amplify/functions/broker-fees/store');
    await expect(transact(stalePublication)).rejects.toThrow('Concurrent update');expect(quote().sourcePricingInvoiceId).toBeUndefined();
  });
  it('publication winning changes the exact source version and defeats an in-flight edit',async()=>{
    const invoice=freeInvoice();const {initialQuotePublicationWrites}=await import('../../amplify/functions/quote-source-billing');
    const publication=await initialQuotePublicationWrites(invoice,structuredClone(quote()));
    const touch=publication.find(row=>row.Update?.TableName==='Quote')!.Update!;
    h.beforeCommit=()=>{Object.assign(quote(),{sourcePricingInvoiceId:'initial',updatedAt:touch.ExpressionAttributeValues![':now']});h.models.get('Invoice:initial')!.stripePaymentLinkId='published';};
    await expect(save({id:'q',brokerFee:500})).rejects.toThrow('Concurrent update');expect(quote().brokerFee).toBe(0);
    h.omitIndex=true;await expect(save({id:'q',brokerFee:500})).rejects.toThrow('existing quote invoice');
  });
  it('a pointer publication still defeats an edit if another metadata writer repeats the old timestamp',async()=>{
    freeInvoice();
    h.beforeCommit=()=>{quote().sourcePricingInvoiceId='initial'; /* native note save keeps the old updatedAt */};
    await expect(save({id:'q',brokerFee:500})).rejects.toThrow('Concurrent update');
    expect(quote().brokerFee).toBe(0);expect(quote().sourcePricingInvoiceId).toBe('initial');
  });
  it('an invoice publication also fences a concurrent loan pointer after a repeated timestamp',async()=>{
    const invoice=freeInvoice();const {initialQuotePublicationWrites}=await import('../../amplify/functions/quote-source-billing');
    const publication=await initialQuotePublicationWrites(invoice,structuredClone(quote()));
    quote().sourcePricingLoanId='live-loan';
    const {transact}=await import('../../amplify/functions/broker-fees/store');
    await expect(transact(publication)).rejects.toThrow('Concurrent update');expect(quote().sourcePricingInvoiceId).toBeUndefined();
  });
  it('a different initial invoice cannot replace a live pointer owner',async()=>{
    const invoice=freeInvoice();quote().sourcePricingInvoiceId='other';h.models.set('Invoice:other',{id:'other',accountId:'a',quoteId:'q',sourcePricingVersion:1,status:'SENT',updatedAt:NOW});
    const {initialQuotePublicationWrites}=await import('../../amplify/functions/quote-source-billing');
    await expect(initialQuotePublicationWrites(invoice,structuredClone(quote()))).rejects.toThrow('existing quote invoice');
  });
  it('allows a different owner only with the old VOID version in the publication transaction',async()=>{
    const invoice=freeInvoice();quote().sourcePricingInvoiceId='other';h.models.set('Invoice:other',{id:'other',accountId:'a',quoteId:'q',sourcePricingVersion:1,status:'VOID',updatedAt:NOW});
    const {initialQuotePublicationWrites}=await import('../../amplify/functions/quote-source-billing');const writes=await initialQuotePublicationWrites(invoice,structuredClone(quote()));
    expect(writes).toEqual(expect.arrayContaining([expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Invoice',Key:{id:'other'}})})]));
  });
});

describe('all source-priced financial quote edits without a broker fee',()=>{
 const free=()=>{h.fees.clear();quote().brokerFee=0;h.models.delete('Invoice:old');h.models.delete('PfLoan:loan');};
 const charges=[{id:'tax',kind:'TAX',description:'Surplus lines tax',amountCents:5000}];
 it.each([{premium:12000},{passThroughCharges:charges},{clientConditions:'Inspection required'},{billType:'DIRECT'}])('does not bypass an existing live source invoice on %j',async change=>{
  free();h.models.set('Invoice:published',{id:'published',accountId:'a',quoteId:'q',status:'SENT',sourcePricingVersion:1,stripePaymentLinkId:'live',updatedAt:NOW});
  await expect(save({id:'q',...change})).rejects.toThrow('existing quote invoice');expect(h.transactions).toHaveLength(0);
 });
 it('cancels safely quoted finance offers on a supplier-charge edit while creating no FeeRecord',async()=>{
  free();h.models.set('PfLoan:free',{id:'free',accountId:'a',quoteId:'q',status:'QUOTED',updatedAt:NOW});
  expect(await save({id:'q',passThroughCharges:charges})).toMatchObject({committed:true});
  expect(h.models.get('PfLoan:free')?.status).toBe('CANCELLED');expect(h.fees.size).toBe(0);
 });
 it('allows financial edits with no billing history and preserves private-only native saves',async()=>{
  free();expect(await save({id:'q',passThroughCharges:charges})).toMatchObject({committed:true});expect(h.fees.size).toBe(0);
  h.transactions=[];expect(await save({id:'q',notes:'Private notes'})).toEqual({committed:false});expect(h.transactions).toHaveLength(0);
 });
 it('automatically retires an expired interrupted VOID send in the financial edit transaction',async()=>{
  free();const expired=Date.now()-1;
  h.models.set('Invoice:withdrawn',{id:'withdrawn',accountId:'a',quoteId:'q',status:'VOID',sourcePricingVersion:1,stripePaymentLinkId:'closed',updatedAt:NOW,invoiceSendOperation:{version:1,key:'invoice:withdrawn:old-send',recipients:'a'.repeat(64),previousSentAt:null,leaseId:'expired-worker',leaseUntil:expired}});
  expect(await save({id:'q',passThroughCharges:charges})).toMatchObject({committed:true});
  const invoice=h.models.get('Invoice:withdrawn')!;
  expect(invoice.invoiceSendOperation.retired).toMatchObject({reason:'VOID',invoiceId:'withdrawn',closedLinkId:'closed'});
  const actions=h.transactions[0];expect(actions.filter(write=>write.Update?.TableName==='Invoice')).toHaveLength(1);
  expect(actions.some(write=>write.Update?.TableName==='HOA-TransactionalMail')).toBe(true);
 });
});
