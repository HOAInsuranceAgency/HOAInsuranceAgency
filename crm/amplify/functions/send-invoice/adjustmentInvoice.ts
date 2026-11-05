import { isPaidOriginalPremium, type AdjustmentPolicy, type OriginalInvoice, type OriginalPremiumLine } from '../../../../shared/invoiceAdjustments';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { accountModels, db, getModel, modelTable, versionCheck, type Write } from '../broker-fees/store';
import { collectCompletePages } from '../storage/pages';
type Row = Record<string, unknown>;
type Reader = (model: string, id: string) => Promise<Row | undefined>;
const key = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : '';
async function premiumCandidateIds(invoiceId:string):Promise<string[]> {
  const index=(JSON.parse(process.env.ACCESS_INDEXES??'{}') as Record<string,string>)['InvoiceLine.invoiceId'];
  if(!index)throw new Error('Original invoice line access is not configured.');
  const ids = await collectCompletePages<string>(async cursor => {
    const result=await db.send(new QueryCommand({TableName:modelTable('InvoiceLine'),IndexName:index,KeyConditionExpression:'invoiceId = :invoice',ExpressionAttributeValues:{':invoice':invoiceId},ProjectionExpression:'id',ExclusiveStartKey:cursor,Limit:100}));
    const items = (result.Items ?? []).map(row => { const id = key(row.id); if (!id) throw new Error('An original invoice line could not be identified.'); return id; });
    return { items, next: result.LastEvaluatedKey };
  }, { maxPages: 20, maxRows: 500,
    sizeError: () => new Error('The original invoice has too many lines to verify safely.'),
    error: () => new Error('The original invoice line history could not be loaded completely.') });
  return [...new Set(ids)];
}
async function readBatches(model:string,ids:string[],reader:Reader):Promise<Row[]> {
  const rows:Row[]=[];
  for(let offset=0;offset<ids.length;offset+=5)rows.push(...(await Promise.all(ids.slice(offset,offset+5).map(id=>reader(model,id)))).filter((row):row is Row=>!!row));
  return rows;
}

/** Read all-status discovery first; only current headers and current original
 * premium lines can reject a repeated initial invoice. No GSI PAID filter. */
export async function assertInitialInvoiceAvailable(invoice:Row,options:{reader?:Reader;invoices?:(accountId:string)=>Promise<Row[]>;lineIds?:(invoiceId:string)=>Promise<string[]>}={}):Promise<void> {
  if(invoice.sourcePricingVersion!==1||['PAID','PROCESSING'].includes(String(invoice.status)))return;
  const reader=options.reader??getModel,policyId=key(invoice.policyId),quoteId=key(invoice.quoteId),accountId=key(invoice.accountId);
  const source=policyId?await reader('Policy',policyId):quoteId?await reader('Quote',quoteId):undefined;
  if(!source||source.accountId!==accountId)throw new Error('The initial invoice source could not be verified.');
  const sourceQuoteId=policyId?key(source.quoteId):quoteId;
  const candidates=await (options.invoices??(id=>accountModels<Row>('Invoice',id)))(accountId);
  const ids=[...new Set(candidates.filter(row=>row.id!==invoice.id&&(policyId&&row.policyId===policyId||sourceQuoteId&&row.quoteId===sourceQuoteId||policyId&&row.sourcePricingVersion==null&&!row.policyId&&!row.quoteId)).map(row=>key(row.id)))];
  if(ids.some(id=>!id)||ids.length>100)throw new Error('The source invoice history could not be verified completely.');
  for(const original of await readBatches('Invoice',ids,reader)) {
    if(original.accountId!==accountId||original.status!=='PAID'||original.sourcePricingVersion!=null&&original.sourcePricingVersion!==1)continue;
    const policy=policyId?source:{id:key(original.policyId)||`quote:${sourceQuoteId}`,accountId,quoteId:sourceQuoteId};
    if(policyId?original.policyId!==policyId&&original.quoteId!==sourceQuoteId&&!(original.sourcePricingVersion==null&&!original.policyId&&!original.quoteId):original.quoteId!==sourceQuoteId)continue;
    const lineIds=await (options.lineIds??premiumCandidateIds)(key(original.id));
    for(const line of await readBatches('InvoiceLine',lineIds,reader))if(isPaidOriginalPremium(policy as unknown as AdjustmentPolicy,original as unknown as OriginalInvoice,line as unknown as OriginalPremiumLine))throw new Error('This policy already has a paid original premium invoice. Create its endorsement or audit adjustment instead of billing the original premium again.');
  }
}

/** Only persisted invoice references and strongly read records establish proof. */
export async function assertAdjustmentInvoiceProof(invoice: Row, reader: Reader = getModel): Promise<{ policy: Row; guards: Write[] } | undefined> {
  if (invoice.sourcePricingVersion !== 2) return;
  const policyId = key(invoice.policyId), originalId = key(invoice.adjustsInvoiceId), lineId = key(invoice.adjustsPremiumLineId);
  if (!policyId || invoice.quoteId || !originalId || !lineId || originalId === invoice.id) throw new Error('An adjustment requires its policy and the paid original invoice premium line.');
  const [policy, original, line] = await Promise.all([reader('Policy', policyId), reader('Invoice', originalId), reader('InvoiceLine', lineId)]);
  if (!policy || policy.id !== policyId || policy.accountId !== invoice.accountId || !original || original.id !== originalId || !line || line.id !== lineId || !isPaidOriginalPremium(policy as unknown as AdjustmentPolicy, original as unknown as OriginalInvoice, line as unknown as OriginalPremiumLine)) throw new Error('The paid original policy invoice and premium line could not be verified for this adjustment.');
  return { policy, guards: [versionCheck(modelTable('Invoice'), original as {id:string;updatedAt:string}), versionCheck(modelTable('InvoiceLine'), line as {id:string;updatedAt:string})] };
}
