import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';

const m = vi.hoisted(() => ({ send: vi.fn(), list: vi.fn(), lookup: vi.fn(), checkout: vi.fn(), debit: vi.fn(), source: vi.fn(), signed: vi.fn(), fee: vi.fn(), invoices: vi.fn(), model: vi.fn(), void: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }),
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  PfLoan: { list: m.list, listPfLoanByElectionToken: m.lookup },
  AgencySettings: { get: async () => ({ data: { premiumFinanceEnabled: true } }) },
  Account: { get: async () => ({ data: { name: "Test HOA" } }) },
  Invoice: { list: m.invoices },
  Quote: { get: m.source }, Policy: { get: m.source },
} }) }));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: m.send }) },
}));
vi.mock("stripe", () => ({ default: class {
  checkout = { sessions: { create: m.checkout } };
  paymentIntents = { create: m.debit };
} }));
vi.mock("../../amplify/functions/void-invoice/handler", () => ({ handler: m.void }));
vi.mock("../../amplify/functions/broker-fees/store", async original => ({ ...await original<typeof import("../../amplify/functions/broker-fees/store")>(), getFee: m.fee, getModel: m.model }));
vi.mock("../../amplify/functions/broker-fees/bindValidation", () => ({ assertBrokerFeeSigned: m.signed }));
import { handler as elect } from "../../amplify/functions/pf-election/handler";
import { handler as collect } from "../../amplify/functions/pf-autopay/handler";
import { SECURITY_INTEREST_AND_AUTHORITY } from "../../amplify/functions/pf-agreement/agreementTerms";

const loan = {
  id: "loan-1", accountId: "account-1", policyId: "policy-1", state: "RI", status: "QUOTED",
  premium: 33742.08, downPayment: 8435.52, originationFee: 10, months: 11,
  electedAt: "2026-09-04T12:00:00Z", agreementSignedAt: "2026-09-04T12:00:00Z",
  electionToken: "a".repeat(43), electionTokenExpiresAt: "2099-01-01T00:00:00Z",
  nextDueAt: "2026-10-03", paidThrough: 0,
  schedule: JSON.stringify([{ n: 1, dueDate: "2026-10-03", payment: 2464.75, principal: 2169.51, interest: 295.24, balance: 23137.05 }]),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PF_LOAN_TABLE = "Loans";
  process.env.BROKER_FEE_TABLE = "Fees";
  process.env.ACCESS_TABLES = JSON.stringify({Invoice:"Invoices"});
  process.env.AGENCY_SETTINGS_TABLE = "Settings";
  process.env.STRIPE_SECRET_KEY = "test-placeholder";
  process.env.SITE_URL = "https://example.test";
  delete process.env.PF_COMPLIANCE_LOG_TABLE;
  m.lookup.mockResolvedValue({ data: [{ ...loan }] });
  m.list.mockResolvedValue({ data: [] });
  m.send.mockResolvedValue({ Item: { premiumFinanceEnabled: true } });
  m.checkout.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/session", expires_at: 4070908800 });
  m.debit.mockResolvedValue({ id: "pi_monthly" });
  m.source.mockResolvedValue({ data: {id:"q1",accountId:"account-1",brokerFee:500} });
  m.signed.mockResolvedValue({});
  m.invoices.mockResolvedValue({data:[]});
  m.model.mockResolvedValue(undefined);
  m.void.mockResolvedValue({ok:true});
  m.fee.mockResolvedValue({id:"fee:q1",version:1,issuedLoanIds:[loan.id],accountId:"account-1",quoteId:"q1",amountCents:50000,submittedCents:0,collectedCents:0,refundedCents:0});
});

describe("billing initiation", () => {
  it("includes signing authority in the same agreement and requires that signature before deposit", async () => {
    const terms = await elect({ arguments: { token: loan.electionToken } });
    expect(terms).toMatchObject({ agreementTerms: expect.arrayContaining([SECURITY_INTEREST_AND_AUTHORITY]) });
    m.lookup.mockResolvedValue({ data: [{ ...loan, agreementSignedAt: null }] });
    expect(await elect({ arguments: { accept: true, token: loan.electionToken } })).toMatchObject({
      ok: false, error: expect.stringContaining("sign the agreement first"),
    });
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("creates the real Checkout request with premium plus fee and a reusable monthly mandate", async () => {
    expect(await elect({ arguments: { accept: true, token: loan.electionToken } })).toMatchObject({ state: "checkout" });
    const params = m.checkout.mock.calls[0][0];
    expect(params.line_items.map((r: { price_data: { unit_amount: number } }) => r.price_data.unit_amount)).toEqual([843552, 1000]);
    expect(params.payment_intent_data).toEqual({ setup_future_usage: "off_session",
      metadata: { pfLoanId: loan.id, pfKind: "down", pfBillingVersion: "3" } });
    expect(params.payment_method_types).toEqual(["us_bank_account"]);
    expect(m.send.mock.calls.some(([c]) => c.input.ExpressionAttributeValues?.[":version"] === 3)).toBe(true);
  });

  it("does not reopen a still-payable legacy session without the fee", async () => {
    m.lookup.mockResolvedValue({ data: [{ ...loan, electionCheckoutUrl: "https://checkout.stripe.test/old",
      electionCheckoutExpiresAt: "2099-01-01T00:00:00Z" }] });
    expect(await elect({ arguments: { accept: true, token: loan.electionToken } })).toMatchObject({ state: "closed" });
    expect(m.checkout).not.toHaveBeenCalled();
  });

  it("recovers a settled legacy election and automatically debits its first due installment", async () => {
    m.list.mockResolvedValue({ data: [{ ...loan, status: "ACCEPTED", nextDueAt: "2020-01-01",
      downPaidAt: "2020-01-01T00:00:00Z", downPaymentIntentId: "pi_down",
      stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }] });
    await collect();
    expect(m.debit).toHaveBeenCalledWith(expect.objectContaining({ amount: 246475, off_session: true,
      customer: "cus_1", payment_method: "pm_1", confirm: true }), { idempotencyKey: "pf-auto-loan-1-1" });
    const writes = m.send.mock.calls.map(([c]) => c.input);
    expect(writes[0].ExpressionAttributeValues[":active"]).toBe("ACTIVE");
    expect(writes[1].ConditionExpression).toContain("attribute_not_exists(autopayPendingIntentId)");
  });

  it("leaves unsettled legacy elections and future installments uncharged", async () => {
    m.list.mockResolvedValue({ data: [{ ...loan, status: "ACCEPTED" }, { ...loan, status: "ACTIVE",
      nextDueAt: "2099-01-01", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }] });
    await collect();
    expect(m.debit).not.toHaveBeenCalled();
  });

  it("does not debit when another worker owns the installment", async () => {
    m.list.mockResolvedValue({ data: [{ ...loan, status: "ACTIVE", nextDueAt: "2020-01-01",
      stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }] });
    m.send.mockRejectedValue(Object.assign(new Error("claimed"), { name: "ConditionalCheckFailedException" }));
    await collect();
    expect(m.debit).not.toHaveBeenCalled();
  });
});

describe("upfront broker fee in the existing financing checkout", () => {
  const allocations=[{quoteId:"q1",policyId:"policy-1",amountCents:50000}];
  it("collects 100% of the fee alongside premium down payment and origination fee", async () => {
    m.lookup.mockResolvedValue({data:[{...loan,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify(allocations)}]});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:"checkout"});
    const request=m.checkout.mock.calls[0][0];
    expect(request.line_items.map((r:{price_data:{unit_amount:number}})=>r.price_data.unit_amount)).toEqual([843552,50000,1000]);
    expect(request.payment_intent_data.metadata).toMatchObject({pfBillingVersion:"3",brokerFeeAccountId:"account-1",brokerFeeAllocations:expect.any(String)});
    expect(JSON.parse(request.payment_intent_data.metadata.brokerFeeAllocations)).toEqual(allocations);
    expect(m.signed).toHaveBeenCalledWith(expect.objectContaining({id:"q1",brokerFee:500}));
  });
  it("refuses a bookmarked financing token until the current fee disclosure is signed", async () => {
    m.lookup.mockResolvedValue({data:[{...loan,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify(allocations)}]});
    m.signed.mockRejectedValue(new Error("Sign the current broker fee disclosure."));
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({ok:false});
    expect(m.checkout).not.toHaveBeenCalled();
  });
});

describe("old financing offer after the broker fee was collected separately",()=>{
  const allocations=[{quoteId:'q1',policyId:'policy-1',amountCents:50000}];
  const feeOnlyInvoice={id:'fee-invoice',policyId:'policy-1',status:'PAID',remittanceBrokerFeeCents:50000,remittanceCarrierCents:0,remittanceCommissionCents:0,remittanceInterestCents:0};
  function oldOffer(extra:Record<string,unknown>={}) {
    m.lookup.mockResolvedValue({data:[{...loan,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify(allocations),...extra}]});
  }
  it('blocks an old combined offer after a fee-only invoice paid its fee',async()=>{
    oldOffer();m.invoices.mockResolvedValue({data:[feeOnlyInvoice]});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed',reason:expect.stringContaining('reissue premium financing')});
    expect(m.checkout).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
  });
  it.each([{submittedCents:50000,collectedCents:0},{submittedCents:50000,collectedCents:50000}])('blocks new and cached checkout when another fee payment is pending or paid: %j',async balance=>{
    oldOffer({electionCheckoutUrl:'https://checkout.stripe.test/old',electionCheckoutExpiresAt:'2099-01-01T00:00:00Z',electionCheckoutBillingVersion:3});
    m.fee.mockResolvedValue({accountId:'account-1',amountCents:50000,refundedCents:0,...balance});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed',reason:expect.stringContaining('already been paid or submitted')});
    expect(m.checkout).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
  });
  it('preserves retry after a definitively failed fee payment',async()=>{
    oldOffer();m.fee.mockResolvedValue({id:'fee:q1',version:1,issuedLoanIds:[loan.id],accountId:'account-1',amountCents:50000,submittedCents:0,collectedCents:0,refundedCents:0,paymentSources:{old:{status:'FAILED',amountCents:50000,refundedCents:0}}});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    expect(m.checkout).toHaveBeenCalledTimes(1);
  });
  it('allows a new premium-only financing offer after the fee was already collected',async()=>{
    oldOffer({brokerFeeCents:0,brokerFeeAllocations:[]});m.invoices.mockResolvedValue({data:[feeOnlyInvoice]});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    const request=m.checkout.mock.calls[0][0];
    expect(request.line_items.map((row:{price_data:{unit_amount:number}})=>row.price_data.unit_amount)).toEqual([843552,1000]);
    expect(m.fee).not.toHaveBeenCalled();
  });
});

describe("atomic fee source checks when claiming a financing checkout",()=>{
  const feeLoan=()=>({...loan,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify([{quoteId:'q1',policyId:'policy-1',amountCents:50000}])});
  it('guards the exact fee version in the same transaction that reserves the real checkout slot',async()=>{
    m.lookup.mockResolvedValue({data:[feeLoan()]});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    const claim=m.send.mock.calls.map(([command])=>command.input).find(input=>input.TransactItems?.some((item:{Update?:{UpdateExpression?:string}})=>item.Update?.UpdateExpression?.includes('electionCheckoutUrl = :claim')));
    expect(claim.TransactItems).toContainEqual(expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Fees',Key:{id:'fee:q1'},ExpressionAttributeValues:{':v':1}})}));
  });
  it('does not create a Stripe checkout when another payment reservation wins the fee version race',async()=>{
    m.lookup.mockResolvedValue({data:[feeLoan()]});
    m.send.mockImplementation(async command=>{
      const items=command.input.TransactItems;
      if(items?.some((item:{Update?:{UpdateExpression?:string}})=>item.Update?.UpdateExpression?.includes('electionCheckoutUrl = :claim'))) {
        throw Object.assign(new Error('Fee changed'),{name:'TransactionCanceledException',CancellationReasons:items.map((item:{ConditionCheck?:{TableName?:string}})=>({Code:item.ConditionCheck?.TableName==='Fees'?'ConditionalCheckFailed':'None'}))});
      }
      return {Item:{premiumFinanceEnabled:true}};
    });
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed'});
    expect(m.checkout).not.toHaveBeenCalled();
  });
});

describe('fee-free prebind financing serializes with first-fee quote edits',()=>{
  const sourceTime='2026-11-04T16:00:00.000Z';
  const quoteLoan=()=>({...loan,policyId:undefined,quoteId:'q1',brokerFeeCents:0,brokerFeeAllocations:[]});
  const quoteSource=(extra:Record<string,unknown>={})=>({id:'q1',accountId:'account-1',status:'QUOTED',billType:'AGENCY',premium:loan.premium,brokerFee:0,updatedAt:sourceTime,...extra});
  const checkoutClaim=()=>m.send.mock.calls.map(([command])=>command.input).find(input=>input.TransactItems?.some((item:{Update?:{UpdateExpression?:string}})=>item.Update?.UpdateExpression?.includes('electionCheckoutUrl = :claim')));
  function setup(source:Record<string,unknown>=quoteSource()) {
    process.env.ACCESS_TABLES=JSON.stringify({Invoice:'Invoices',Quote:'Quotes',PfLoan:'Loans'});
    m.lookup.mockResolvedValue({data:[quoteLoan()]});
    m.model.mockImplementation(async(model,id)=>model==='Quote'&&id==='q1'?{...source}:undefined);
  }
  it('refuses the old fee-free finance link after an unpaid first fee was added',async()=>{
    setup(quoteSource({brokerFee:500}));
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({ok:false});
    expect(m.fee).toHaveBeenCalledWith('q1');expect(checkoutClaim()).toBeUndefined();expect(m.checkout).not.toHaveBeenCalled();
  });
  it('publishes the private source-loan pointer in the transaction that claims the real checkout',async()=>{
    setup();
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    const claim=checkoutClaim();
    expect(claim.TransactItems).toContainEqual(expect.objectContaining({Update:expect.objectContaining({TableName:'Quotes',Key:{id:'q1'},UpdateExpression:'SET #pointer = :id, updatedAt = :now',ConditionExpression:expect.stringContaining('updatedAt = :old'),ExpressionAttributeNames:expect.objectContaining({'#pointer':'sourcePricingLoanId'}),ExpressionAttributeValues:expect.objectContaining({':old':sourceTime,':id':loan.id})})}));
    expect(claim.TransactItems.some((item:{Put?:{TableName?:string}})=>item.Put?.TableName==='Fees')).toBe(false);
    expect(m.checkout.mock.calls[0][0].line_items.map((row:{price_data:{unit_amount:number}})=>row.price_data.unit_amount)).toEqual([843552,1000]);
    expect(m.fee).not.toHaveBeenCalled();
  });
  it.each([null,undefined])('preserves existing fee-free financing when the quote billing choice is %s',async billType=>{
    setup(quoteSource({billType}));
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    expect(checkoutClaim().TransactItems).toContainEqual(expect.objectContaining({Update:expect.objectContaining({TableName:'Quotes',ExpressionAttributeNames:expect.objectContaining({'#pointer':'sourcePricingLoanId'})})}));
    expect(m.checkout).toHaveBeenCalledTimes(1);expect(m.fee).not.toHaveBeenCalled();
  });
  it('does not create Checkout when the fee edit wins after the source read but before the atomic claim',async()=>{
    setup();
    m.send.mockImplementation(async command=>{
      const items=command.input.TransactItems;
      if(items?.some((item:{Update?:{UpdateExpression?:string}})=>item.Update?.UpdateExpression?.includes('electionCheckoutUrl = :claim'))) {
        // The edited source has a later timestamp; the quote pointer update
        // must cancel the entire transaction, including the loan slot claim.
        const sourceWrite=items.find((item:{Update?:{TableName?:string}})=>item.Update?.TableName==='Quotes');
        expect(sourceWrite.Update.ExpressionAttributeValues[':old']).toBe(sourceTime);
        throw Object.assign(new Error('Quote changed'),{name:'TransactionCanceledException',CancellationReasons:items.map((item:{Update?:{TableName?:string}})=>({Code:item.Update?.TableName==='Quotes'?'ConditionalCheckFailed':'None'}))});
      }
      return {Item:{premiumFinanceEnabled:true}};
    });
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed'});
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it('preserves premium-only financing when the source fee was already paid and guards that receipt version',async()=>{
    const source=quoteSource({brokerFee:500});setup(source);
    m.fee.mockResolvedValue({id:'fee:q1',version:9,accountId:'account-1',quoteId:'q1',signedAt:sourceTime,amountCents:50000,terms:authorizedQuoteTerms(source),submittedCents:50000,collectedCents:50000,refundedCents:0});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    expect(checkoutClaim().TransactItems).toContainEqual(expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Fees',Key:{id:'fee:q1'},ExpressionAttributeValues:{':v':9}})}));
    expect(m.checkout.mock.calls[0][0].line_items.map((row:{price_data:{unit_amount:number}})=>row.price_data.unit_amount)).toEqual([843552,1000]);
  });
  it('can replace an expired quoted sibling without targeting its loan twice in the checkout transaction',async()=>{
    const source=quoteSource({sourcePricingLoanId:'older-loan'});setup(source);
    const prior={...quoteLoan(),id:'older-loan',quotedAt:'2026-10-01T12:00:00Z',updatedAt:sourceTime,electionCheckoutUrl:'https://checkout.stripe.test/expired',electionCheckoutExpiresAt:'2026-10-01T13:00:00Z'};
    m.lookup.mockResolvedValue({data:[{...quoteLoan(),quotedAt:'2026-11-04T12:00:00Z'}]});
    m.list.mockResolvedValue({data:[prior]});
    m.model.mockImplementation(async(model,id)=>model==='Quote'&&id==='q1'?source:model==='PfLoan'&&id===prior.id?prior:undefined);
    m.send.mockImplementation(async command=>{
      if(command.input.TransactItems){
        const keys=command.input.TransactItems.map((item:{Update?:{TableName?:string;Key?:unknown};ConditionCheck?:{TableName?:string;Key?:unknown};Put?:{TableName?:string;Item?:{id?:string}}})=>{
          const action=item.Update??item.ConditionCheck;
          return action?JSON.stringify([action.TableName,action.Key]):JSON.stringify([item.Put?.TableName,{id:item.Put?.Item?.id}]);
        });
        if(new Set(keys).size!==keys.length)throw Object.assign(new Error('Transaction cannot include multiple operations on one item'),{name:'ValidationException'});
      }
      return {Item:{premiumFinanceEnabled:true}};
    });
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    const guards=checkoutClaim().TransactItems.filter((item:{ConditionCheck?:{TableName?:string;Key?:{id?:string}}})=>item.ConditionCheck?.TableName==='Loans'&&item.ConditionCheck.Key?.id===prior.id);
    expect(guards).toHaveLength(1);expect(m.checkout).toHaveBeenCalledTimes(1);
  });
});


describe('financing excludes every durably reserved fee invoice',()=>{
  const parts=[{quoteId:'q1',policyId:'policy-1',amountCents:50000}];
  const balance={id:'fee:q1',version:3,issuedLoanIds:[loan.id],issuedInvoiceIds:['replacement'],accountId:'account-1',quoteId:'q1',amountCents:50000,submittedCents:0,collectedCents:0,refundedCents:0};
  const published={id:'replacement',accountId:'account-1',policyId:'policy-1',quoteId:'q1',status:'SENT',updatedAt:'published',stripePaymentLinkId:'plink_replacement',stripeLinkAmountCents:3424208,brokerFeeAllocations:JSON.stringify(parts)};
  function setup(extra:Record<string,unknown>={}){
    m.lookup.mockResolvedValue({data:[{...loan,brokerFeeCents:50000,brokerFeeAllocations:JSON.stringify(parts),...extra}]});
    m.fee.mockResolvedValue({...balance});
  }
  it('blocks a paused send after fee reservation even when the GSI has no replacement invoice',async()=>{
    setup();m.fee.mockResolvedValue({...balance,invoiceSendClaim:{invoiceId:'replacement',token:'owner',phase:'PREPARING',totalCents:3424208,previousLinkId:null}});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed',reason:expect.stringContaining('preparing')});
    expect(m.checkout).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();
  });
  it('does not reuse a cached checkout while a send remains PREPARING after link storage',async()=>{
    setup({electionCheckoutUrl:'https://checkout.stripe.test/old',electionCheckoutExpiresAt:'2099-01-01T00:00:00Z',electionCheckoutBillingVersion:3});
    m.invoices.mockResolvedValue({data:[published]});
    m.fee.mockResolvedValue({...balance,invoiceSendClaim:{invoiceId:'replacement',token:'owner',phase:'PREPARING',totalCents:3424208,previousLinkId:null,linkId:'plink_replacement'}});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed',reason:expect.stringContaining('preparing')});
    expect(m.checkout).not.toHaveBeenCalled();expect(m.void).not.toHaveBeenCalled();
  });
  it('fails closed for an unpublished DRAFT reservation or missing invoice reference',async()=>{
    setup();m.model.mockResolvedValue({...published,status:'DRAFT'});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed'});
    m.model.mockResolvedValue(undefined);
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({ok:false});
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it('strongly closes a published replacement missed by a stale VOID GSI row and fences fresh versions',async()=>{
    setup();let invoice={...published};let fee={...balance};
    m.invoices.mockResolvedValue({data:[{...published,status:'VOID'}]});
    m.model.mockImplementation(async()=>({...invoice}));m.fee.mockImplementation(async()=>({...fee}));
    m.void.mockImplementation(async()=>{invoice={...invoice,status:'VOID',updatedAt:'closed'};fee={...fee,version:4};return {ok:true};});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'checkout'});
    expect(m.void).toHaveBeenCalledWith({arguments:{invoiceId:'replacement'}});
    const claim=m.send.mock.calls.map(([command])=>command.input).find(input=>input.TransactItems?.some((item:{Update?:{UpdateExpression?:string}})=>item.Update?.UpdateExpression?.includes('electionCheckoutUrl = :claim')));
    expect(claim.TransactItems).toContainEqual(expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Invoices',Key:{id:'replacement'},ExpressionAttributeValues:{':v':'closed'}})}));
    expect(claim.TransactItems).toContainEqual(expect.objectContaining({ConditionCheck:expect.objectContaining({TableName:'Fees',Key:{id:'fee:q1'},ExpressionAttributeValues:{':v':4}})}));
  });
  it('rejects another invoice reservation that appears while the old payment link is closing',async()=>{
    setup();m.model.mockResolvedValue({...published,status:'VOID'});
    m.fee.mockResolvedValueOnce({...balance}).mockResolvedValue({...balance,version:4,issuedInvoiceIds:['replacement','next'],invoiceSendClaim:{invoiceId:'next',token:'next',phase:'PREPARING',totalCents:3424208}});
    expect(await elect({arguments:{accept:true,token:loan.electionToken}})).toMatchObject({state:'closed',reason:expect.stringContaining('preparing')});
    expect(m.checkout).not.toHaveBeenCalled();
  });
});
