import { describe, expect, it } from 'vitest';
import { invoiceBrokerFeeAllocations, brokerFeeInvoiceRefresh } from '../../amplify/functions/send-invoice/brokerFeeInvoice';
const invoice = { accountId:'a1',status:'DRAFT' };
const source = { accountId:'a1',brokerFee:500,billType:'AGENCY' };
const line = {kind:'BROKER_FEE',accountId:'a1',brokerFeeQuoteId:'q1',retailAmount:500,costAmount:0};
const valid = {invoice,source,quoteId:'q1',lines:[line],alreadySubmitted:false};
describe('source-backed broker fee invoice validation',()=>{
  it('freezes the exact original quote and amount',()=>{
    expect(invoiceBrokerFeeAllocations(valid)).toEqual([{quoteId:'q1',amountCents:50000}]);
  });
  it.each([{brokerFeeQuoteId:'other'},{accountId:'other'},{retailAmount:600},{costAmount:1},{policyId:'other'}])('refuses an arbitrary fee line %j',patch=>{
    expect(()=>invoiceBrokerFeeAllocations({...valid,lines:[{...line,...patch}]})).toThrow();
  });
  it('requires the fee once and allows later premium billing without recharging it',()=>{
    expect(()=>invoiceBrokerFeeAllocations({...valid,lines:[]})).toThrow('missing');
    expect(()=>invoiceBrokerFeeAllocations({...valid,lines:[line,line]})).toThrow();
    expect(()=>invoiceBrokerFeeAllocations({...valid,alreadySubmitted:true})).toThrow('already submitted');
    expect(invoiceBrokerFeeAllocations({...valid,lines:[],alreadySubmitted:true})).toEqual([]);
  });
  it('does not turn a direct-bill placement into a carrier premium invoice',()=>{
    expect(invoiceBrokerFeeAllocations({...valid,source:{...source,billType:'DIRECT'}})).toHaveLength(1);
    expect(()=>invoiceBrokerFeeAllocations({...valid,source:{...source,billType:'DIRECT'},lines:[line,{kind:'PREMIUM',retailAmount:10000}]})).toThrow('direct bill');
  });
  it('requires the existing billing choice before payment is prepared',()=>{
    expect(()=>invoiceBrokerFeeAllocations({...valid,source:{...source,billType:null}})).toThrow('billing method');
  });
});

describe("derived fee refresh before sending",()=>{
  const draft={invoice:{...invoice,id:'i1'},source,quoteId:'q1',lines:[{...line,id:'l1'}],alreadySubmitted:false};
  it("refreshes a changed source fee without allowing free-form invoice fees",()=>{
    expect(brokerFeeInvoiceRefresh({...draft,source:{...source,brokerFee:600}}).upsert).toMatchObject({id:'l1',retailAmount:600,costAmount:0,brokerFeeQuoteId:'q1'});
    expect(brokerFeeInvoiceRefresh({...draft,source:{...source,brokerFee:600},lines:[{...line,id:'l1',brokerFeeQuoteId:'other'}]}).upsert).toBeUndefined();
  });
  it("recovers a missing generated fee and removes a fee waived before submission",()=>{
    expect(brokerFeeInvoiceRefresh({...draft,lines:[]}).upsert).toMatchObject({id:'broker-fee-i1',retailAmount:500});
    expect(brokerFeeInvoiceRefresh({...draft,source:{...source,brokerFee:0}}).remove).toEqual(['l1']);
  });
  it("never rewrites an amount after payment is submitted",()=>{
    expect(brokerFeeInvoiceRefresh({...draft,source:{...source,brokerFee:600},alreadySubmitted:true})).toEqual({remove:[],upsert:undefined});
  });
  it("removes carrier premium when the quoted billing method becomes direct",()=>{
    expect(brokerFeeInvoiceRefresh({...draft,source:{...source,billType:'DIRECT'},lines:[...draft.lines,{id:'premium1',kind:'PREMIUM',retailAmount:10000}]}).remove).toEqual(['premium1']);
  });
});
