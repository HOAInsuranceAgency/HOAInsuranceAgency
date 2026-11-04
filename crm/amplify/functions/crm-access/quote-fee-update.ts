import { brokerFeeCents, type BrokerFeeRecord } from '../../../../shared/brokerFees';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import { feeIssuedHistory, invalidateUnclaimedLoan } from '../broker-fees/payments';
import { feePut, getAgreement, getFee, modelTable, table, transact, versionCheck, type Write } from '../broker-fees/store';
import { AccountAccess } from './access';
import { AccessDenied, id, object, type RecordData } from './policy';
import { quoteSourceBillingHistory } from '../quote-source-billing';
import { activeTeamUserCheck } from './user-status';

// This is a native updateQuote input whitelist, never a generic JSON update API.
// GraphQL validates field types and Amplify authorization runs before this stage.
const QUOTE_INPUT_FIELDS = new Set(['id','accountId','lastWriteBy','carrierId','status','renewalPolicyId','readyAt','presentedAt','bindAuthorizedAt','bindAuthorizedBy','bindAuthorizedTerms','offerExpiresAt','lines','premium','brokerFee','passThroughCharges','clientConditions','billType','commissionPct','glEachOccurrence','glDamageToRentedPremises','glMedicalExpense','glPersonalAdvInjury','glGeneralAggregate','glProductsCompletedOps','glClaimsMade','glAggregateAppliesTo','perOccurrenceDeductible','perUnitDeductible','blanketLimit','coinsurancePct','replacementCostType','effectiveDate','expirationDate','notes','producerOfRecord','isAuditable','minimumEarnedPremiumPct']);
export interface NativeQuoteUpdateContext { model?: string; field?: string; operation?: string; nativeConditions?: unknown; nativeAuthFilter?: unknown; arguments?: RecordData; }

/** The fixed AppSync pipeline invokes this after native authorization. Its
 * result is placed in a private stash; the native Dynamo stage skips ONLY that
 * server-written result. Browser arguments cannot populate the stash or mode. */
export async function updateFeeQuoteAtomically(access: AccountAccess, context: NativeQuoteUpdateContext): Promise<{ committed: false } | { committed: true; quote: RecordData }> {
  if (context.model !== 'Quote' || context.field !== 'updateQuote' || context.operation !== 'update') throw new AccessDenied();
  const args = object(context.arguments), input = object(args.input);
  // Repeat ownership and financial checks after native model authorization,
  // using fresh reads in this invocation instead of a previous guard snapshot.
  await access.write('Quote', 'update', input);
  const previous = await access.requireRecord('Quote', id(input.id));
  const reparent = Object.hasOwn(input,'accountId') && input.accountId !== previous.accountId;
  if (!brokerFeeCents(previous.brokerFee as number | undefined) && !brokerFeeCents(input.brokerFee as number | undefined) && !reparent) return { committed: false };
  const fee = await getFee(id(previous.id));
  const agreement = fee?.agreementId ? await getAgreement(fee.agreementId) : undefined;
  const disclosed = agreement?.quotes.find(quote => quote.id === previous.id)?.agencyCommissionPct !== undefined;
  const next = { ...previous, ...input };
  const changed = reparent || authorizedQuoteTerms(previous) !== authorizedQuoteTerms(next) || disclosed && next.commissionPct !== previous.commissionPct;
  const withdrawn = ['LOST','DECLINED'].includes(String(input.status)) && input.status !== previous.status;
  if (!changed && !withdrawn) return { committed: false };
  if (Object.keys(input).some(key => !QUOTE_INPUT_FIELDS.has(key)) || Object.keys(args).some(key => !['input','condition'].includes(key))) throw new Error('This quote update contains unsupported fields. Refresh the quote and try again.');
  // Do not commit and then discover that a caller-supplied/native condition
  // would have rejected the generated update. Conditional fee edits fail closed.
  if (args.condition != null || Array.isArray(context.nativeConditions) && context.nativeConditions.length || context.nativeConditions != null && !Array.isArray(context.nativeConditions) || context.nativeAuthFilter != null && Object.keys(object(context.nativeAuthFilter)).length) throw new Error('Conditional financial quote edits are not supported. Refresh the quote and save its current terms.');
  if (fee && (fee.accountId !== previous.accountId || fee.policyId || fee.submittedCents > 0 || fee.collectedCents > 0 || fee.refundedCents > 0)) throw new Error('Resolve the existing fee payment or bound policy before changing its accepted terms.');
  if (reparent && (fee || brokerFeeCents(previous.brokerFee as number|undefined) || brokerFeeCents(next.brokerFee as number|undefined))) throw new Error('A quote with fee history must retain its original account.');
  const now = new Date(Math.max(Date.now(), Date.parse(String(previous.updatedAt)) + 1)).toISOString();
  const writes: Write[] = [activeTeamUserCheck(access.actor)];
  // Couple assignment, account retention, and known invoice state to the same
  // commit. A revocation, fresh loan reservation, or checkout claim wins first
  // or cancels this entire financial edit.
  writes.push({ ConditionCheck: { TableName: modelTable('Communication'), Key: { id: `deleted-account:${previous.accountId}` }, ConditionExpression: 'attribute_not_exists(id)' } });
  if(reparent)writes.push({ConditionCheck:{TableName:modelTable('Communication'),Key:{id:`deleted-account:${next.accountId}`},ConditionExpression:'attribute_not_exists(id)'}});
  if (!access.admin) {
    const workflow = await access.get('Communication', `workflow:${previous.accountId}`);
    if (!workflow || object(workflow.data).salespersonId !== access.actor) throw new AccessDenied();
    writes.push({ ConditionCheck: { TableName: modelTable('Communication'), Key: { id: workflow.id ?? `workflow:${previous.accountId}` }, ConditionExpression: '#data = :data', ExpressionAttributeNames: { '#data': 'data' }, ExpressionAttributeValues: { ':data': workflow.data } } });
    if(reparent){const target=await access.get('Communication',`workflow:${next.accountId}`);if(!target||object(target.data).salespersonId!==access.actor)throw new AccessDenied();writes.push({ConditionCheck:{TableName:modelTable('Communication'),Key:{id:target.id??`workflow:${next.accountId}`},ConditionExpression:'#data = :data',ExpressionAttributeNames:{'#data':'data'},ExpressionAttributeValues:{':data':target.data}}});}
  }
  const history = await quoteSourceBillingHistory(previous,fee);
  if(reparent&&(history.invoices.length||history.loans.length))throw new Error('A quote with billing history must retain its original account.');
  for (const loan of history.loans) { const update = invalidateUnclaimedLoan(loan,now); if (update) writes.push(update); }
  for (const invoice of history.invoices) {
    if (invoice.status === 'VOID') {
      if (![1,2].includes(Number(invoice.sourcePricingVersion)) && (invoice.stripePaymentLinkId || invoice.paymentUrl)) throw new Error('The legacy invoice payment sessions need review before changing these quote terms.');
      if (invoice.invoiceSendOperation && !object(invoice.invoiceSendOperation).completed) throw new Error('Finish the existing invoice delivery before changing its quote terms.');
      writes.push(versionCheck(modelTable('Invoice'),invoice as {id:string;updatedAt:string}));
    } else if (invoice.status === 'DRAFT' && !invoice.stripePaymentLinkId && !invoice.paymentUrl && !invoice.invoiceSendOperation) {
      // Touch draft headers so a sender with an old source snapshot cannot
      // reserve delivery after this financial edit. A prior send reservation
      // also makes this update fail, including same-millisecond races.
      writes.push({Update:{TableName:modelTable('Invoice'),Key:{id:invoice.id},UpdateExpression:'SET updatedAt = :now',ConditionExpression:'#status = :draft AND updatedAt = :old AND attribute_not_exists(invoiceSendOperation) AND attribute_not_exists(stripePaymentLinkId) AND attribute_not_exists(paymentUrl)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':draft':'DRAFT',':old':invoice.updatedAt,':now':new Date(Math.max(Date.parse(now),Date.parse(String(invoice.updatedAt))+1)).toISOString()}}});
    } else throw new Error('Void the existing quote invoice or resolve its payment before changing accepted financial terms.');
  }
  if (fee) {
    const replacement: BrokerFeeRecord = { id: fee.id, kind: 'FEE', accountId: String(previous.accountId), quoteId: String(previous.id), amountCents: brokerFeeCents(next.brokerFee as number | undefined), terms: authorizedQuoteTerms(next), version: fee.version, submittedCents: 0, collectedCents: 0, refundedCents: 0, ...feeIssuedHistory(fee) };
    // An unknown in-flight external link cannot safely be made stale.
    if (fee.invoiceSendClaim?.phase === 'PREPARING' && !fee.invoiceSendClaim.linkId) throw new Error('Finish the existing invoice payment setup before changing its accepted quote terms.');
    writes.push(feePut(replacement, fee));
  } else writes.push({ ConditionCheck: { TableName: table(), Key: { id: `fee:${previous.id}` }, ConditionExpression: 'attribute_not_exists(id)' } });
  const names: Record<string,string> = { '#version': 'updatedAt' }, values: RecordData = { ':old': previous.updatedAt, ':now': now };
  const set = ['#version = :now'], remove: string[] = [];
  for (const [key,value] of Object.entries(input)) {
    if (key === 'id') continue;
    const attribute = `#f${set.length + remove.length}`, token = `:f${set.length + remove.length}`; names[attribute] = key;
    if (value == null) remove.push(attribute); else { values[token] = value; set.push(`${attribute} = ${token}`); }
  }
  const expression = `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`;
  const conditions = ['#version = :old'];
  // Native metadata writes use wall-clock timestamps. Preserve explicit
  // pointer fences even if another writer repeats an earlier millisecond.
  for(const [index,pointer] of ['sourcePricingInvoiceId','sourcePricingLoanId'].entries()) {
    const name=`#pointer${index}`, value=`:pointer${index}`; names[name]=pointer;
    if(Object.hasOwn(previous,pointer)){conditions.push(`${name} = ${value}`);values[value]=previous[pointer];}
    else conditions.push(`attribute_not_exists(${name})`);
  }
  writes.push({ Update: { TableName: modelTable('Quote'), Key: { id: previous.id }, UpdateExpression: expression, ConditionExpression: conditions.join(' AND '), ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
  await transact(writes);
  const result: RecordData = { ...next, updatedAt: now };
  for (const [key,value] of Object.entries(input)) if (value == null) delete result[key];
  return { committed: true, quote: result };
}
