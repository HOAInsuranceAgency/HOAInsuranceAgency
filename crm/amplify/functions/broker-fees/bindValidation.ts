import { BROKER_FEE_TERMS_VERSION, assertBrokerFeeAgencyBilling, brokerFeeCents } from '../../../../shared/brokerFees';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import { jurisdictionRule } from './agreements';
import { accountAgreements, getFee, getAgreement, getModel, modelTable, table, versionCheck, feePut, type Write } from './store';

export async function assertBrokerFeeSigned(quote:Record<string,unknown>) {
  assertBrokerFeeAgencyBilling(quote as {brokerFee?:number|null;billType?:string|null});
  const amount=brokerFeeCents(quote.brokerFee as number|undefined);
  if(!amount)return undefined;
  const fee=await getFee(String(quote.id));
  const agreement=fee?.agreementId?await getAgreement(fee.agreementId):undefined;
  if(!fee?.signedAt || !agreement?.signature || !agreement.signedDocumentId || fee.amountCents!==amount || fee.accountId!==quote.accountId || fee.terms!==authorizedQuoteTerms(quote) || !agreement.quotes.some(q=>q.id===quote.id && q.terms===fee.terms)) throw new Error('The client must electronically sign the current broker fee disclosure before continuing.');
  const disclosedQuote=agreement.quotes.find(q=>q.id===quote.id);
  if(disclosedQuote?.agencyCommissionPct!==undefined&&disclosedQuote.agencyCommissionPct!==quote.commissionPct)throw new Error('The disclosed insurer commission changed. Obtain a current fee disclosure.');
  const account=await getModel<Record<string,unknown>>('Account',String(quote.accountId));
  const settings=await getModel<Record<string,unknown>>('AgencySettings','AGENCY');
  if(!account || agreement.accountName!==String(account.legalName||account.name) || agreement.jurisdiction!==String(account.state??'').trim().toUpperCase()) throw new Error('The insured or jurisdiction changed. Obtain a current fee disclosure.');
  const rule=jurisdictionRule(settings?.brokerFeeJurisdictions,agreement.jurisdiction,agreement.quotes);
  if(agreement.termsVersion!==`${BROKER_FEE_TERMS_VERSION}:${rule.version}` || JSON.stringify(agreement.stateForms)!==JSON.stringify(rule.forms)) throw new Error('The fee disclosure requirements changed. Obtain the current disclosure.');
  const expectedSigner=rule.requiresBrokerSignature&&rule.agencySigner?{name:rule.agencySigner.name,title:rule.agencySigner.title,licenseNumber:rule.agencySigner.licenseNumber,authorizedBy:rule.agencySigner.authorizedBy!,authorizedAt:rule.agencySigner.authorizedAt!}:undefined;
  if(JSON.stringify(expectedSigner)!==JSON.stringify(agreement.agencySigner))throw new Error('The agency signing authority changed. Obtain a current fee disclosure.');
  return {fee,agreement,settings,rule};
}

/** A fee-free term can be covered by the same signed package as fee-bearing terms.
 * Linking that evidence never creates a fee or makes consent/payment a bind requirement. */
async function feeFreeDisclosureBindWrites(quote:Record<string,unknown>,policyId:string):Promise<Write[]> {
  const accountId=String(quote.accountId),terms=authorizedQuoteTerms(quote);
  const agreements=(await accountAgreements(accountId,String(quote.id))).filter(agreement=>
    agreement.accountId===accountId && agreement.signature?.consent===true && Number.isFinite(Date.parse(agreement.signature.signedAt)) && agreement.signedDocumentId &&
    agreement.quotes.some(frozen=>frozen.id===quote.id && frozen.accountId===accountId && (frozen.brokerFee??0)===0 && frozen.terms===terms &&
      (frozen.agencyCommissionPct===undefined || frozen.agencyCommissionPct===quote.commissionPct))
  ).sort((a,b)=>Date.parse(b.signature!.signedAt)-Date.parse(a.signature!.signedAt)||b.id.localeCompare(a.id));
  if(!agreements.length)return[];
  const account=await getModel<Record<string,unknown>>('Account',accountId);
  if(!account)return[];
  for(const agreement of agreements){
    if(agreement.accountName!==String(account.legalName||account.name) || agreement.jurisdiction!==String(account.state??'').trim().toUpperCase())continue;
    const doc=await getModel<Record<string,unknown>>('Document',agreement.signedDocumentId!);
    if(!doc || doc.entityType!=='ACCOUNT' || doc.entityId!==accountId || doc.category!=='BROKER_FEE_DISCLOSURE' || doc.brokerFeeAgreementId!==agreement.id || !Array.isArray(doc.quoteIds) || !doc.quoteIds.includes(quote.id))continue;
    const policyIds=[...new Set([...(Array.isArray(doc.policyIds)?doc.policyIds.map(String):[]),policyId])];
    return [versionCheck(table(),agreement),{Update:{
      TableName:modelTable('Document'),Key:{id:doc.id},
      UpdateExpression:'SET policyIds = :ids, updatedAt = :now',
      ConditionExpression:'updatedAt = :old AND entityId = :account AND #category = :category AND brokerFeeAgreementId = :agreement',
      ExpressionAttributeNames:{'#category':'category'},
      ExpressionAttributeValues:{':ids':policyIds,':now':new Date().toISOString(),':old':doc.updatedAt,':account':accountId,':category':'BROKER_FEE_DISCLOSURE',':agreement':agreement.id},
    }}];
  }
  return[];
}

/** Bind and fee attribution share the policy/commission snapshot transaction. */
export async function brokerFeeBindWrites(quote:Record<string,unknown>,policyId:string,billType:string,expectedFeeVersion?:number):Promise<Write[]> {
  assertBrokerFeeAgencyBilling({brokerFee:quote.brokerFee as number|undefined,billType});
  if(brokerFeeCents(quote.brokerFee as number|undefined)>0 && quote.billType!==billType) throw new Error("The premium billing method must match the signed fee quote.");
  const signed=await assertBrokerFeeSigned(quote);
  if(!signed)return feeFreeDisclosureBindWrites(quote,policyId);
  const {fee,agreement,settings}=signed;
  if(expectedFeeVersion!==undefined&&fee.version!==expectedFeeVersion)throw new Error("The fee payment changed while binding. Refresh and retry.");
  jurisdictionRule(settings?.brokerFeeJurisdictions,agreement.jurisdiction,agreement.quotes,billType);
  if(fee.submittedCents<fee.amountCents || fee.refundedCents>0)throw new Error('The broker fee payment must be submitted before binding. A submitted ACH payment may still be clearing.');
  if(fee.policyId && fee.policyId!==policyId)throw new Error('This policy term fee already belongs to another bound policy.');
  const doc=await getModel<Record<string,unknown>>('Document',agreement.signedDocumentId!);
  if(!doc || doc.entityId!==quote.accountId || doc.category!=='BROKER_FEE_DISCLOSURE')throw new Error('The signed broker fee disclosure could not be verified.');
  const policyIds=[...new Set([...(Array.isArray(doc.policyIds)?doc.policyIds.map(String):[]),policyId])];
  return [feePut({...fee,policyId},fee),versionCheck(table(),agreement),
    ...(settings?[versionCheck(modelTable('AgencySettings'),settings as {id:string;updatedAt:string})]:[]),
    {Update:{TableName:modelTable('Document'),Key:{id:doc.id},UpdateExpression:'SET policyIds = :ids, updatedAt = :now',ConditionExpression:'updatedAt = :old AND entityId = :account',ExpressionAttributeValues:{':ids':policyIds,':now':new Date().toISOString(),':old':doc.updatedAt,':account':quote.accountId}}}];
}
