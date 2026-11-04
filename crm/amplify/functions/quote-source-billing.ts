import { voidedInvoiceSendRetirementWrites } from "./send-invoice/sendOperation";
import { brokerFeeCents, feeAllocations, type BrokerFeeRecord } from '../../../shared/brokerFees';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';
import { isOpenQuoteStatus } from '../../src/lib/quoteStatus';
import { loanWithoutCheckoutGuard } from './broker-fees/payments';
import { db, accountModels, getFee, getModel, modelTable, table, versionCheck, type Write } from './broker-fees/store';
type RecordData = Record<string, unknown>;
const SOURCE_INVOICE_POINTER = 'sourcePricingInvoiceId';
const SOURCE_LOAN_POINTER = 'sourcePricingLoanId';
const historyId = (value: unknown) => { if (typeof value !== 'string' || !value || value.length > 500) throw new Error('The saved quote billing source could not be verified.'); return value; };
/** Indexes discover candidates, never payment authority. Strong reads plus
 * private source pointers retain the current owner even during index lag. */
export async function quoteSourceBillingHistory(quote: RecordData, fee: BrokerFeeRecord | undefined) {
  const lists = await Promise.all(['Invoice','PfLoan'].map(model => accountModels<RecordData>(model,String(quote.accountId))));
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

export function sourceQuoteTouch(quote: RecordData, pointer: typeof SOURCE_INVOICE_POINTER | typeof SOURCE_LOAN_POINTER, key: string): Write {
  if (typeof quote.updatedAt !== 'string' || !Number.isFinite(Date.parse(quote.updatedAt))) throw new Error('The current quoted billing source version could not be verified.');
  const values: RecordData = { ':old':quote.updatedAt, ':now':new Date(Math.max(Date.now(),Date.parse(quote.updatedAt)+1)).toISOString(), ':id':historyId(key) };
  const names:Record<string,string>={'#pointer':pointer},conditions=['updatedAt = :old'];
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
export async function initialQuotePublicationWrites(invoice:RecordData, snapshot:RecordData):Promise<Write[]> {
  if(invoice.sourcePricingVersion!==1||invoice.quoteId!==snapshot.id||invoice.accountId!==snapshot.accountId)throw new Error('The initial quote invoice source could not be verified.');
  const quote=await getModel<RecordData>('Quote',String(snapshot.id));
  if(!quote||quote.accountId!==invoice.accountId||!isOpenQuoteStatus(quote.status as string)||authorizedQuoteTerms(quote)!==authorizedQuoteTerms(snapshot)||(quote.billType??null)!==(snapshot.billType??null))throw new Error('The quote changed. Refresh its invoice before sending.');
  const writes:Write[]=[];
  const owner=await pointerSource(quote,'Invoice',SOURCE_INVOICE_POINTER);
  if(owner&&owner.id!==invoice.id){
    if(owner.sourcePricingVersion!==1||owner.status!=='VOID')throw new Error('Resolve the existing quote invoice before publishing another initial payment link.');
    const retirement=await voidedInvoiceSendRetirementWrites(owner,{database:db,invoiceTable:modelTable('Invoice')});
    if(retirement.length)writes.push(...retirement);else writes.push(versionCheck(modelTable('Invoice'),owner as {id:string;updatedAt:string}));
  }
  const loan=await pointerSource(quote,'PfLoan',SOURCE_LOAN_POINTER);
  if(loan)writes.push(loanWithoutCheckoutGuard(loan));
  writes.push(sourceQuoteTouch(quote,SOURCE_INVOICE_POINTER,String(invoice.id)));
  return writes;
}
/** Runs immediately before the actual public Checkout slot claim, after any
 * pay-in-full invoice was voided. A stale fee-free finance URL cannot collect
 * after an agent adds an unpaid fee or withdraws/reparents the quote. */
export async function zeroFeeQuoteClaimWrites(loan:RecordData):Promise<Write[]> {
  if(loan.policyId||!loan.quoteId||Number(loan.brokerFeeCents??0)!==0||feeAllocations(loan.brokerFeeAllocations).length)return [];
  const quote=await getModel<RecordData>('Quote',historyId(loan.quoteId));
  if(!quote||quote.accountId!==loan.accountId||!isOpenQuoteStatus(quote.status as string)||quote.billType!=null&&quote.billType!=='AGENCY')throw new Error('The quoted billing source changed. Use the updated invoice from your agent.');
  const writes:Write[]=[];
  const amount=brokerFeeCents(quote.brokerFee as number|undefined);
  if(amount){
    if(quote.billType!=='AGENCY')throw new Error('Broker fees require agency billing.');
    const fee=await getFee(String(quote.id));
    if(!fee?.signedAt||fee.accountId!==quote.accountId||fee.amountCents!==amount||fee.terms!==authorizedQuoteTerms(quote)||Math.max(fee.submittedCents,fee.collectedCents)-fee.refundedCents<amount)throw new Error('The broker fee changed or is still due. Use the updated invoice from your agent.');
    writes.push(versionCheck(table(),fee));
  }
  const prior=await pointerSource(quote,'PfLoan',SOURCE_LOAN_POINTER);
  if(prior&&prior.id!==loan.id)writes.push(loanWithoutCheckoutGuard(prior));
  const invoice=await pointerSource(quote,'Invoice',SOURCE_INVOICE_POINTER);
  if(invoice){if(invoice.status!=='VOID')throw new Error('Resolve the existing quote invoice before opening financing.');const retirement=await voidedInvoiceSendRetirementWrites(invoice,{database:db,invoiceTable:modelTable('Invoice')});if(retirement.length)writes.push(...retirement);else writes.push(versionCheck(modelTable('Invoice'),invoice as {id:string;updatedAt:string}));}
  writes.push(sourceQuoteTouch(quote,SOURCE_LOAN_POINTER,String(loan.id)));
  return writes;
}
