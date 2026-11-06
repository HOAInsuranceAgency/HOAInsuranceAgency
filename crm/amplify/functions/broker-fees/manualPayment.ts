import { parseAccessIndexes, resolveAccessIndex } from '../storage/index-config';
import { modelIndexKey } from '../storage/model-indexes';
import { agencyDay } from '../../../../shared/agencyTime';
import Stripe from 'stripe';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { collectCompletePages } from '../storage/pages';
import { AccountAccess } from '../crm-access/access';
import { assertUserSession, activeTeamUserCheck } from '../crm-access/user-status';
import { id, type Identity } from '../crm-access/policy';
import type { RoleRequest } from '../crm-access/active-role';
import { feeAllocations } from '../../../../shared/brokerFees';
import { invoiceBrokerFeeAllocations } from '../send-invoice/brokerFeeInvoice';
import { validateInvoiceSourceCharges } from '../send-invoice/passThroughInvoice';
import { assertAdjustmentInvoiceProof, assertInitialInvoiceAvailable } from '../send-invoice/adjustmentInvoice';
import { invoiceTotals } from '../../../../shared/invoiceTotals';
import { db, getFee, getModel, modelTable, versionCheck, type Write } from './store';
import { assertBrokerFeeSigned } from './bindValidation';
import { assertNoFeeLoanCheckout, syncBrokerFeePayment } from './payments';
import { closeInvoiceCheckoutSessions } from '../invoiceCheckout';

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
  let source=policy??quote;
  if(source&&source.accountId!==invoice.accountId)throw new Error('The invoice source could not be verified.');
  await assertInitialInvoiceAvailable(invoice);
  const adjustmentProof=await assertAdjustmentInvoiceProof(invoice);
  if(adjustmentProof)source=adjustmentProof.policy;
  const indexError = () => new Error('Invoice line access is not configured.');
  const index = resolveAccessIndex(parseAccessIndexes(process.env.ACCESS_INDEXES, indexError), modelIndexKey('InvoiceLine', 'invoiceId'), { error: indexError });
  const lines = await collectCompletePages<Record<string, unknown>>(async cursor => {
    const result=await db.send(new QueryCommand({TableName:modelTable('InvoiceLine'),IndexName:index,KeyConditionExpression:'invoiceId = :invoice',ExpressionAttributeValues:{':invoice':invoice.id},ExclusiveStartKey:cursor,Limit:100}));
    const items: Record<string, unknown>[] = [];
    for(const item of result.Items??[]){const current=await getModel<Record<string,unknown>>('InvoiceLine',String(item.id));if(current&&current.invoiceId===invoice.id)items.push(current);}
    return { items, next: result.LastEvaluatedKey };
  }, { maxPages: 100, maxRows: 70, error: () => new Error('This invoice needs a smaller reviewed payment allocation.') });
  const fee=quoteId?await getFee(quoteId):undefined;
  validateInvoiceSourceCharges({invoice:{accountId:String(invoice.accountId),policyId:invoice.policyId as string|undefined,status:invoice.status as string|undefined,sourcePricingVersion:invoice.sourcePricingVersion as number|undefined},source:source?{id:String(source.id),accountId:String(source.accountId),premium:source.premium as number|undefined,billType:source.billType as string|undefined,passThroughCharges:source.passThroughCharges}:null,lines});
  if(invoice.sourcePricingVersion===2&&invoiceTotals(lines).retail<=0)throw new Error('A zero or credit adjustment is not an incoming payment and cannot be marked paid.');
  const allocations=invoiceBrokerFeeAllocations({invoice:{accountId:String(invoice.accountId),status:String(invoice.status),sourcePricingVersion:invoice.sourcePricingVersion as number|undefined},source:source?{accountId:String(source.accountId),brokerFee:source.brokerFee as number|undefined,billType:source.billType as string|undefined}:null,quoteId,policyId:policy?String(policy.id):undefined,lines,alreadySubmitted:!!fee&&(fee.submittedCents>0||fee.collectedCents>0)});
  const frozen=feeAllocations(invoice.brokerFeeAllocations);
  const comparable=(a:typeof allocations)=>a.map(row=>({quoteId:row.quoteId,amountCents:row.amountCents}));
  if(frozen.length&&JSON.stringify(comparable(frozen))!==JSON.stringify(comparable(allocations)))throw new Error('The invoice differs from its issued fee payment allocation.');
  if(quote&&allocations.length)await assertBrokerFeeSigned(quote);
  const invoiceGuards:Write[]=[...(adjustmentProof?.guards??[])];
  if(fee&&allocations.length) {
    const claim=fee.invoiceSendClaim;
    if(claim?.phase==='PREPARING')throw new Error('The broker fee invoice payment link is still being prepared. Finish or recover its Send action before recording an outside payment.');
    if(claim&&claim.invoiceId!==invoice.id) {
      const previousInvoice=await getModel<Record<string,unknown>>('Invoice',claim.invoiceId);
      if(!previousInvoice||previousInvoice.accountId!==invoice.accountId||previousInvoice.status!=='VOID')throw new Error('Void the other issued broker fee invoice before recording an outside payment on this invoice.');
      invoiceGuards.push(versionCheck(modelTable('Invoice'),previousInvoice as {id:string;updatedAt:string}));
    } else if(claim&&(!claim.linkId||claim.linkId!==invoice.stripePaymentLinkId))throw new Error('The issued broker fee payment link could not be verified. Review its Send action before recording an outside payment.');
  }
  const loanGuards=fee&&allocations.length?await assertNoFeeLoanCheckout(fee):[];
  const workflow=await access.get('Communication',`workflow:${invoice.accountId}`);
  const guards:Write[]=[activeTeamUserCheck(access.actor),...invoiceGuards,...loanGuards,...lines.map(line=>versionCheck(modelTable('InvoiceLine'),line as {id:string;updatedAt:string})),...(source?[versionCheck(modelTable(policy?'Policy':'Quote'),source as {id:string;updatedAt:string})]:[])];
  if(!access.admin){
    if(!workflow)throw new Error('The account assignment could not be verified.');
    guards.push({ConditionCheck:{TableName:modelTable('Communication'),Key:{id:`workflow:${invoice.accountId}`},ConditionExpression:'#data = :data',ExpressionAttributeNames:{'#data':'data'},ExpressionAttributeValues:{':data':workflow.data}}});
  }
  if(invoice.stripePaymentLinkId&&invoice.status!=='PAID') {
    const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new Error('Payment configuration is unavailable; the existing payment link cannot be closed.');
    const stripe=new Stripe(key);
    await stripe.paymentLinks.update(String(invoice.stripePaymentLinkId),{active:false});
    try { await closeInvoiceCheckoutSessions(stripe,String(invoice.stripePaymentLinkId)); }
    catch(error) {
      if(error instanceof Error && error.message.includes('before replacing or voiding its link.'))throw new Error(error.message.replace('before replacing or voiding its link.','before recording an outside payment.'));
      throw error;
    }
  }
  const now=new Date().toISOString(),paidAt=typeof invoice.paidAt==='string'?invoice.paidAt:agencyDay(now);
  const update:Write={Update:{TableName:modelTable('Invoice'),Key:{id:invoice.id},UpdateExpression:'SET #status = :paid, paidAt = :date, updatedAt = :now, lastWriteBy = :actor REMOVE paymentUrl, brokerFeeFinanceUrl',ConditionExpression:'updatedAt = :old AND #status = :status',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':paid':'PAID',':date':paidAt,':now':now,':actor':'broker-fee-manual-payment',':old':invoice.updatedAt,':status':invoice.status}}};
  await syncBrokerFeePayment({sourceId:`manual-invoice:${invoice.id}`,accountId:String(invoice.accountId),allocations,status:'PAID',receivedOn:paidAt,confirmedBy:access.actor},[...guards,...(invoice.status==='PAID'?[]:[update])],fee&&allocations.length?{[fee.quoteId]:fee.version}:undefined);
  return {ok:true,invoice:{...invoice,status:'PAID',paidAt}};
}
