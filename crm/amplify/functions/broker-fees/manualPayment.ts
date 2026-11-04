import Stripe from 'stripe';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AccountAccess } from '../crm-access/access';
import { assertUserSession, activeTeamUserCheck } from '../crm-access/user-status';
import { id, type Identity } from '../crm-access/policy';
import type { RoleRequest } from '../crm-access/active-role';
import { feeAllocations } from '../../../../shared/brokerFees';
import { invoiceBrokerFeeAllocations } from '../send-invoice/brokerFeeInvoice';
import { db, getFee, getModel, modelTable, versionCheck, type Write } from './store';
import { assertBrokerFeeSigned } from './bindValidation';
import { assertNoFeeLoanCheckout, syncBrokerFeePayment } from './payments';

/** Preserve Mark paid, using the same source validation as online billing. */
export async function confirmInvoicePayment(event:{identity?:Identity;request?:RoleRequest},input:Record<string,unknown>) {
  await assertUserSession(event.identity);
  const access=new AccountAccess(event.identity,undefined,event.request);
  const invoice=await access.requireRecord('Invoice',id(input.invoiceId));
  if(['VOID','PROCESSING'].includes(String(invoice.status)))throw new Error('A void invoice or payment still clearing cannot be marked paid.');
  if(invoice.status==='PAID' && invoice.lastWriteBy!=='broker-fee-manual-payment')return {ok:true,invoice};
  const policy=invoice.policyId?await access.requireRecord('Policy',id(invoice.policyId)):undefined;
  const quoteId=id(policy?.quoteId)||id(invoice.quoteId);
  const quote=quoteId?await access.requireRecord('Quote',quoteId):undefined;
  const source=policy??quote;
  if(source&&source.accountId!==invoice.accountId)throw new Error('The invoice source could not be verified.');
  const index=(JSON.parse(process.env.ACCESS_INDEXES??'{}') as Record<string,string>)['InvoiceLine.invoiceId'];
  if(!index)throw new Error('Invoice line access is not configured.');
  let cursor:Record<string,unknown>|undefined;
  const lines:Record<string,unknown>[]=[];
  do {
    const result=await db.send(new QueryCommand({TableName:modelTable('InvoiceLine'),IndexName:index,KeyConditionExpression:'invoiceId = :invoice',ExpressionAttributeValues:{':invoice':invoice.id},ExclusiveStartKey:cursor,Limit:100}));
    for(const item of result.Items??[]){const current=await getModel<Record<string,unknown>>('InvoiceLine',String(item.id));if(current&&current.invoiceId===invoice.id)lines.push(current);}
    cursor=result.LastEvaluatedKey;
    if(lines.length>70)throw new Error('This invoice needs a smaller reviewed payment allocation.');
  }while(cursor);
  const fee=quoteId?await getFee(quoteId):undefined;
  const allocations=invoiceBrokerFeeAllocations({invoice:{accountId:String(invoice.accountId),status:String(invoice.status)},source:source?{accountId:String(source.accountId),brokerFee:source.brokerFee as number|undefined,billType:source.billType as string|undefined}:null,quoteId,policyId:policy?String(policy.id):undefined,lines,alreadySubmitted:!!fee&&(fee.submittedCents>0||fee.collectedCents>0)});
  const frozen=feeAllocations(invoice.brokerFeeAllocations);
  const comparable=(a:typeof allocations)=>a.map(row=>({quoteId:row.quoteId,amountCents:row.amountCents}));
  if(frozen.length&&JSON.stringify(comparable(frozen))!==JSON.stringify(comparable(allocations)))throw new Error('The invoice differs from its issued fee payment allocation.');
  if(quote&&allocations.length)await assertBrokerFeeSigned(quote);
  const loanGuards=fee&&allocations.length?await assertNoFeeLoanCheckout(fee):[];
  const workflow=await access.get('Communication',`workflow:${invoice.accountId}`);
  const guards:Write[]=[activeTeamUserCheck(access.actor),...loanGuards,...lines.map(line=>versionCheck(modelTable('InvoiceLine'),line as {id:string;updatedAt:string})),...(source?[versionCheck(modelTable(policy?'Policy':'Quote'),source as {id:string;updatedAt:string})]:[])];
  if(!access.admin){
    if(!workflow)throw new Error('The account assignment could not be verified.');
    guards.push({ConditionCheck:{TableName:modelTable('Communication'),Key:{id:`workflow:${invoice.accountId}`},ConditionExpression:'#data = :data',ExpressionAttributeNames:{'#data':'data'},ExpressionAttributeValues:{':data':workflow.data}}});
  }
  if(invoice.stripePaymentLinkId&&invoice.status!=='PAID') {
    const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new Error('Payment configuration is unavailable; the existing payment link cannot be closed.');
    const stripe=new Stripe(key);
    await stripe.paymentLinks.update(String(invoice.stripePaymentLinkId),{active:false});
    let count=0;
    for await(const session of stripe.checkout.sessions.list({payment_link:String(invoice.stripePaymentLinkId),limit:100})) {
      if(++count>500)throw new Error('The payment session history needs review before recording an outside payment.');
      if(session.payment_status==='paid')throw new Error('An online payment has already been submitted. Wait for its payment status to update.');
      if(session.status==='complete'){
        const intentId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
        const intent=intentId?await stripe.paymentIntents.retrieve(intentId):undefined;
        if(!intent||!['requires_payment_method','canceled'].includes(intent.status))throw new Error('An online payment has already been submitted. Wait for its payment status to update.');
      }
      if(session.status==='open')await stripe.checkout.sessions.expire(session.id);
    }
  }
  const now=new Date().toISOString(),paidAt=typeof invoice.paidAt==='string'?invoice.paidAt:new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const update:Write={Update:{TableName:modelTable('Invoice'),Key:{id:invoice.id},UpdateExpression:'SET #status = :paid, paidAt = :date, updatedAt = :now, lastWriteBy = :actor REMOVE paymentUrl, brokerFeeFinanceUrl',ConditionExpression:'updatedAt = :old AND #status = :status',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':paid':'PAID',':date':paidAt,':now':now,':actor':'broker-fee-manual-payment',':old':invoice.updatedAt,':status':invoice.status}}};
  await syncBrokerFeePayment({sourceId:`manual-invoice:${invoice.id}`,accountId:String(invoice.accountId),allocations,status:'PAID',receivedOn:paidAt,confirmedBy:access.actor},[...guards,...(invoice.status==='PAID'?[]:[update])],fee&&allocations.length?{[fee.quoteId]:fee.version}:undefined);
  return {ok:true,invoice:{...invoice,status:'PAID',paidAt}};
}
