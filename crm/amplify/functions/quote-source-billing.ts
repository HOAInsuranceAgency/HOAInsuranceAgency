import { assertHoaCollection } from './ipfs-invoice';
import { invoiceSendSettled, voidedInvoiceSendRetirementWrites } from "./send-invoice/sendOperation";
import { feeAllocations, type BrokerFeeRecord } from '../../../shared/brokerFees';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { isOpenQuoteStatus } from '../../../shared/quoteStatus';
import { loanWithoutCheckoutGuard } from './broker-fees/payments';
import { db, accountModels, getModel, modelTable, versionCheck, type Write } from './broker-fees/store';
type RecordData = Record<string, unknown>;
const SOURCE_INVOICE_POINTER = 'sourcePricingInvoiceId';
const SOURCE_LOAN_POINTER = 'sourcePricingLoanId';
const historyId = (value: unknown) => { if (typeof value !== 'string' || !value || value.length > 500) throw new Error('The saved quote billing source could not be verified.'); return value; };
/** Indexes discover candidates, never payment authority. Strong reads plus
 * private source pointers retain the current owner even during index lag. */
export async function quoteSourceBillingHistory(quote: RecordData, fee: BrokerFeeRecord | undefined) {
  const lists = await Promise.all((['Invoice','PfLoan'] as const).map(model => accountModels<RecordData>(model,String(quote.accountId))));
  const invoiceIds = new Set((fee?.issuedInvoiceIds ?? []).map(historyId)), loanIds = new Set((fee?.issuedLoanIds ?? []).map(historyId));
  if (quote[SOURCE_INVOICE_POINTER] != null) invoiceIds.add(historyId(quote[SOURCE_INVOICE_POINTER]));
  if (quote[SOURCE_LOAN_POINTER] != null) loanIds.add(historyId(quote[SOURCE_LOAN_POINTER]));
  for (const [index, rows] of lists.entries()) for (const row of rows) if (row.quoteId === quote.id && row.accountId === quote.accountId) (index ? loanIds : invoiceIds).add(historyId(row.id));
  if (invoiceIds.size + loanIds.size > 60) throw new Error('Too many quote billing records need review before changing these financial terms.');
  const readRows = async (model: string, ids: Set<string>) => {
    const output: RecordData[] = [], keys = [...ids];
    for (let offset=0; offset<keys.length; offset+=5) for (const row of await Promise.all(keys.slice(offset,offset+5).map(key=>getModel<RecordData>(model,key)))) {
      if (!row || row.accountId !== quote.accountId) throw new Error('A saved quote billing record could not be verified.');
      let matches = row.quoteId === quote.id;
      if (!matches && row.policyId) { const policy = await getModel<RecordData>('Policy',String(row.policyId)); matches = !!policy && policy.quoteId === quote.id && policy.accountId === quote.accountId; }
      // Private fee allocations also preserve source provenance through bind.
      if (!matches && model === 'PfLoan' && fee?.issuedLoanIds?.includes(String(row.id))) matches = feeAllocations(row.brokerFeeAllocations).some(part=>part.quoteId===quote.id);
      if (!matches) throw new Error('A saved quote billing record no longer matches its policy term.');
      output.push(row);
    }
    return output;
  };
  const [invoices,loans] = await Promise.all([readRows('Invoice',invoiceIds),readRows('PfLoan',loanIds)]);
  return {invoices,loans};
}

function publishInvoicePointer(quote: RecordData, key: string): Write {
  if (typeof quote.updatedAt !== 'string' || !Number.isFinite(Date.parse(quote.updatedAt))) throw new Error('The current quoted billing source version could not be verified.');
  const values: RecordData = { ':old':quote.updatedAt, ':now':new Date(Math.max(Date.now(),Date.parse(quote.updatedAt)+1)).toISOString(), ':id':historyId(key) };
  const names:Record<string,string>={'#pointer':SOURCE_INVOICE_POINTER},conditions=['updatedAt = :old', '(attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil)', '(attribute_not_exists(ipfsRegisteredPolicyId) OR ipfsRegisteredPolicyId = :nil)', 'NOT (#status = :bound)', 'NOT (clientBillingSelected = :selected AND billType = :direct)'];
  names['#status'] = 'status';
  values[':bound'] = 'BOUND';
  values[':selected'] = true;
  values[':direct'] = 'DIRECT';
  values[':nil'] = null;
  // Fence both owner slots: a native note save may repeat a timestamp after
  // a concurrent invoice or loan publication has changed the other pointer.
  for(const [index,field] of [SOURCE_INVOICE_POINTER,SOURCE_LOAN_POINTER].entries()){
    const name=`#source${index}`,value=`:source${index}`;names[name]=field;
    if(Object.hasOwn(quote,field)){conditions.push(`${name} = ${value}`);values[value]=historyId(quote[field]);}
    else conditions.push(`attribute_not_exists(${name})`);
  }
  return {Update:{TableName:modelTable('Quote'),Key:{id:quote.id},UpdateExpression:'SET #pointer = :id, updatedAt = :now',ConditionExpression:conditions.join(' AND '),ExpressionAttributeNames:names,ExpressionAttributeValues:values}};
}
async function pointerSource(quote:RecordData, model:'Invoice'|'PfLoan', pointer:string) {
  const key=quote[pointer];if(key==null)return;
  const row=await getModel<RecordData>(model,historyId(key));
  if(!row||row.accountId!==quote.accountId||row.quoteId!==quote.id)throw new Error('The saved quote billing source no longer matches its policy term.');
  return row;
}
/** V1 fee-free publication owns the source before its payment URL can escape.
 * A different invoice may take ownership only after the prior owner is VOID. */
export async function initialQuotePublicationWrites(invoice:RecordData, snapshot:RecordData, mode: 'send' | 'manual' = 'send'):Promise<Write[]> {
  if(invoice.sourcePricingVersion!==1||invoice.quoteId!==snapshot.id||invoice.accountId!==snapshot.accountId)throw new Error('The initial quote invoice source could not be verified.');
  const quote=await getModel<RecordData>('Quote',String(snapshot.id));
  if(!quote||quote.accountId!==invoice.accountId||!isOpenQuoteStatus(quote.status as string)||authorizedQuoteTerms(quote)!==authorizedQuoteTerms(snapshot)||(quote.billType??null)!==(snapshot.billType??null))throw new Error('The quote changed. Refresh its invoice before sending.');
  assertHoaCollection(quote);
  const writes:Write[]=[];
  const owner=await pointerSource(quote,'Invoice',SOURCE_INVOICE_POINTER);
  if(owner&&owner.id!==invoice.id){
    if(owner.sourcePricingVersion!==1||owner.status!=='VOID')throw new Error('Resolve the existing quote invoice before publishing another initial payment link.');
    if (mode === 'manual' && !invoiceSendSettled(owner)) throw new Error('Retire the previous invoice delivery before recording this payment.');
    const retirement=mode === 'manual' ? [] : await voidedInvoiceSendRetirementWrites(owner,{database:db,invoiceTable:modelTable('Invoice')});
    if(retirement.length)writes.push(...retirement);else writes.push(versionCheck(modelTable('Invoice'),owner as {id:string;updatedAt:string}));
  }
  const loan=await pointerSource(quote,'PfLoan',SOURCE_LOAN_POINTER);
  if(loan)writes.push(loanWithoutCheckoutGuard(loan));
  writes.push(publishInvoicePointer(quote,String(invoice.id)));
  return writes;
}
