import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPaidOriginalPremium, validateAdjustmentLines } from '../../../shared/invoiceAdjustments';
import { assertAdjustmentInvoiceProof, assertInitialInvoiceAvailable } from '../../amplify/functions/send-invoice/adjustmentInvoice';
import { validateInvoiceSourceCharges } from '../../amplify/functions/send-invoice/passThroughInvoice';
import { brokerFeeInvoiceRefresh, invoiceBrokerFeeAllocations } from '../../amplify/functions/send-invoice/brokerFeeInvoice';
const at='2026-11-04T15:00:00Z';
const policy={id:'p',accountId:'a',quoteId:'q',billType:'AGENCY',brokerFee:500,premium:10000,status:'CANCELLED',updatedAt:at};
const original={id:'original',accountId:'a',policyId:'p',quoteId:'q',status:'PAID',sourcePricingVersion:1,updatedAt:at};
const premium={id:'original-premium',invoiceId:'original',accountId:'a',policyId:'p',kind:'PREMIUM',retailAmount:10000,updatedAt:at};
const invoice={id:'adjustment',accountId:'a',policyId:'p',status:'DRAFT',sourcePricingVersion:2,adjustsInvoiceId:'original',adjustsPremiumLineId:'original-premium'};
const endorsement={id:'delta',accountId:'a',kind:'ENDORSEMENT',description:'Additional audit premium',retailAmount:1000,costAmount:800};
let records:Map<string,Record<string,unknown>>;
const reader=vi.fn(async(model:string,id:string)=>records.get(`${model}:${id}`));
beforeEach(()=>{reader.mockClear();records=new Map([['Policy:p',{...policy}],['Invoice:original',{...original}],['InvoiceLine:original-premium',{...premium}]]);process.env.ACCESS_TABLES=JSON.stringify({Invoice:'invoices',InvoiceLine:'lines'});});

describe('paid original adjustment proof',()=>{
  it('recognizes paid inception premium, including a quote invoice whose policy rollover is absent',()=>{
    expect(isPaidOriginalPremium(policy,original,premium)).toBe(true);
    expect(isPaidOriginalPremium(policy,{...original,policyId:null,sourcePricingVersion:undefined},{...premium,policyId:null})).toBe(true);
  });
  it('recognizes only matching line-level policy provenance on an unflagged headless legacy original',async()=>{
    const headless={...original,policyId:null,quoteId:null,sourcePricingVersion:undefined};
    expect(isPaidOriginalPremium(policy,headless,premium)).toBe(true);
    expect(isPaidOriginalPremium(policy,headless,{...premium,policyId:'another-policy'})).toBe(false);
    expect(isPaidOriginalPremium(policy,{...headless,sourcePricingVersion:1},premium)).toBe(false);
    expect(isPaidOriginalPremium(policy,{...headless,policyId:'another-policy'},premium)).toBe(false);
    records.set('Invoice:original',headless);
    await expect(assertAdjustmentInvoiceProof(invoice,reader)).resolves.toMatchObject({policy});
  });
  it.each([{status:'SENT'},{accountId:'other'},{policyId:'other'},{quoteId:'other'},{sourcePricingVersion:2},{adjustsInvoiceId:'another'},{adjustsPremiumLineId:'another'}])('rejects an ineligible original %j',patch=>{
    expect(isPaidOriginalPremium(policy,{...original,...patch},premium)).toBe(false);
  });
  it.each([{invoiceId:'other'},{accountId:'other'},{policyId:'other'},{kind:'ENDORSEMENT'},{retailAmount:0},{retailAmount:-100},{retailAmount:.001}])('rejects the wrong original premium line %j',patch=>{
    expect(isPaidOriginalPremium(policy,original,{...premium,...patch})).toBe(false);
  });
  it('reads actual original records and returns atomic original invoice and premium-line version guards',async()=>{
    const proof=await assertAdjustmentInvoiceProof(invoice,reader);
    expect(reader.mock.calls).toEqual([['Policy','p'],['Invoice','original'],['InvoiceLine','original-premium']]);
    expect(proof?.policy).toEqual(policy);
    expect(proof?.guards).toEqual(expect.arrayContaining([expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'invoices',Key:{id:'original'},ExpressionAttributeValues:{':v':at}})}),expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'lines',Key:{id:'original-premium'}})})]));
  });
  it.each([{policyId:null},{quoteId:'q'},{adjustsInvoiceId:'adjustment'},{adjustsPremiumLineId:'missing'}])('cannot replace trusted original proof with caller references %j',async patch=>{
    await expect(assertAdjustmentInvoiceProof({...invoice,...patch},reader)).rejects.toThrow();
  });
  it('rejects a changed original source or a premium line that no longer belongs to it',async()=>{
    records.get('Invoice:original')!.status='VOID';await expect(assertAdjustmentInvoiceProof(invoice,reader)).rejects.toThrow('could not be verified');
    records.get('Invoice:original')!.status='PAID';records.get('InvoiceLine:original-premium')!.invoiceId='other';await expect(assertAdjustmentInvoiceProof(invoice,reader)).rejects.toThrow('could not be verified');
  });
});

describe('trusted initial versus adjustment classification',()=>{
  const initial={id:'new-initial',accountId:'a',policyId:'p',status:'DRAFT',sourcePricingVersion:1};
  const invoices=vi.fn(async()=>[{...original,status:'DRAFT'}]);
  const lineIds=vi.fn(async()=>['original-premium']);
  it('rejects a forced initial against actual paid history even when the index still says draft',async()=>{
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices,lineIds})).rejects.toThrow('already has a paid original');
    expect(invoices).toHaveBeenCalledWith('a');expect(reader).toHaveBeenCalledWith('Invoice','original');expect(reader).toHaveBeenCalledWith('InvoiceLine','original-premium');
  });
  it('does not classify fee-only or adjustment-only payments as an original premium receipt',async()=>{
    records.get('InvoiceLine:original-premium')!.kind='BROKER_FEE';
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices,lineIds})).resolves.toBeUndefined();
    records.get('InvoiceLine:original-premium')!.kind='PREMIUM';records.get('Invoice:original')!.sourcePricingVersion=2;
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices,lineIds})).resolves.toBeUndefined();
  });
  it('handles a paid pre-bind quote invoice whose policy rollover is missing',async()=>{
    records.get('Invoice:original')!.policyId=null;records.get('InvoiceLine:original-premium')!.policyId=null;
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices,lineIds})).rejects.toThrow('already has a paid original');
  });
  it('discovers headless legacy originals only for an exact policy premium line, never a quote-only guess',async()=>{
    const headless={...original,policyId:null,quoteId:null,sourcePricingVersion:undefined};records.set('Invoice:original',headless);
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices:async()=>[headless],lineIds})).rejects.toThrow('already has a paid original');
    records.get('InvoiceLine:original-premium')!.policyId='other';
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices:async()=>[headless],lineIds})).resolves.toBeUndefined();
    records.set('Quote:q',{id:'q',accountId:'a'});records.get('InvoiceLine:original-premium')!.policyId='p';
    await expect(assertInitialInvoiceAvailable({...initial,policyId:null,quoteId:'q'},{reader,invoices:async()=>[headless],lineIds})).resolves.toBeUndefined();
  });
  it('never trusts a stale parent or swallows an incomplete history query',async()=>{
    records.get('Invoice:original')!.accountId='other';
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices,lineIds})).resolves.toBeUndefined();
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices:async()=>{throw new Error('Incomplete invoice pagination');},lineIds})).rejects.toThrow('Incomplete invoice pagination');
    records.get('Invoice:original')!.accountId='a';
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices,lineIds:async()=>{throw new Error('Incomplete original line pagination');}})).rejects.toThrow('Incomplete original line pagination');
  });
  it('bounds matching-history size and current reads to batches of five',async()=>{
    const candidates=Array.from({length:20},(_,index)=>({...original,id:`history-${index}`,status:'SENT'}));
    candidates.forEach(row=>records.set(`Invoice:${row.id}`,row));let inFlight=0,maximum=0;
    const boundedReader=async(model:string,id:string)=>{inFlight++;maximum=Math.max(maximum,inFlight);await Promise.resolve();inFlight--;return records.get(`${model}:${id}`);};
    await assertInitialInvoiceAvailable(initial,{reader:boundedReader,invoices:async()=>candidates,lineIds});expect(maximum).toBeLessThanOrEqual(5);
    await expect(assertInitialInvoiceAvailable(initial,{reader,invoices:async()=>Array.from({length:101},(_,index)=>({...original,id:`too-many-${index}`})),lineIds})).rejects.toThrow('could not be verified completely');
  });
});

describe('signed adjustment line rules',()=>{
  it('allows signed endorsement/audit deltas and at-cost supplier credits while excluding source inception charges',()=>{
    for(const sign of [1,-1])expect(()=>validateAdjustmentLines([{...endorsement,retailAmount:sign*1000,costAmount:sign*800},{kind:'TAX',description:'Adjusted tax',retailAmount:sign*40,costAmount:sign*40}])).not.toThrow();
    expect(()=>validateAdjustmentLines([{...endorsement,retailAmount:null,costAmount:null},{kind:'TAX',retailAmount:0,costAmount:0}],{complete:false})).not.toThrow();
    expect(()=>validateInvoiceSourceCharges({invoice,source:{...policy,passThroughCharges:'not needed for this adjustment'},lines:[endorsement]})).not.toThrow();
  });
  it.each(['PREMIUM','BROKER_FEE','OTHER','INTEREST'])('rejects repeated or hidden %s charges',kind=>{expect(()=>validateAdjustmentLines([{...endorsement,kind}])).toThrow('Original premium and broker fees');});
  it('does not seed or allocate the original broker fee on an adjustment even if the old receipt ledger is missing',()=>{
    expect(brokerFeeInvoiceRefresh({invoice,source:policy,quoteId:'q',policyId:'p',lines:[endorsement],alreadySubmitted:false})).toEqual({remove:[],upsert:undefined});
    expect(invoiceBrokerFeeAllocations({invoice,source:policy,quoteId:'q',policyId:'p',lines:[endorsement],alreadySubmitted:false})).toEqual([]);
    expect(()=>invoiceBrokerFeeAllocations({invoice,source:policy,quoteId:'q',policyId:'p',lines:[{...endorsement,kind:'BROKER_FEE'}],alreadySubmitted:true})).toThrow('original broker fee');
  });
  it('requires actual cost with the same premium sign and exact-cost supplier/tax adjustments',()=>{
    for(const costAmount of [undefined,null,-800])expect(()=>validateAdjustmentLines([{...endorsement,costAmount}])).toThrow();
    expect(()=>validateAdjustmentLines([{...endorsement,costAmount:0}])).not.toThrow();
    expect(()=>validateAdjustmentLines([{...endorsement,kind:'TAX'}])).toThrow('without agency markup');
    expect(()=>validateAdjustmentLines([{...endorsement,sourceQuoteChargeId:'initial-tax'}])).toThrow('Original premium');
    expect(()=>validateAdjustmentLines([{...endorsement,retailAmount:0,costAmount:0}])).toThrow('nonzero');
  });
  it.each([1000,-1000])('rejects direct-bill endorsement premium %s while allowing tax-only adjustments',amount=>{
    expect(()=>validateAdjustmentLines([{...endorsement,retailAmount:amount,costAmount:amount}],{billType:'DIRECT'})).toThrow('carrier collects');
    expect(()=>validateAdjustmentLines([{kind:'TAX',description:'Tax adjustment',retailAmount:amount,costAmount:amount}],{billType:'DIRECT'})).not.toThrow();
  });
});
