import { brokerFeeCents, type BrokerFeeAllocation } from '../../../../shared/brokerFees';
interface Source { accountId: string; brokerFee?: number | null; billType?: string | null }
interface FeeLine { kind?: string | null; accountId?: string | null; policyId?: string | null; brokerFeeQuoteId?: string | null; retailAmount?: number | null; costAmount?: number | null }
/** Invoice fees must represent the existing term's exact charge, never free-form invoice markup. */
export function invoiceBrokerFeeAllocations(input: {
  invoice: { accountId: string; status?: string | null }; source: Source | null;
  quoteId?: string | null; policyId?: string | null; lines: readonly FeeLine[]; alreadySubmitted: boolean;
}): BrokerFeeAllocation[] {
  const { invoice, source, quoteId, policyId, lines, alreadySubmitted } = input;
  const expected = brokerFeeCents(source?.brokerFee);
  const fees = lines.filter(line => line.kind === 'BROKER_FEE');
  if (expected > 0 && !['AGENCY', 'DIRECT'].includes(source?.billType ?? '')) throw new Error('Choose the billing method on the quote before invoicing its broker fee.');
  if (expected > 0 && source?.billType === 'DIRECT' && lines.some(line => ['PREMIUM','ENDORSEMENT'].includes(line.kind ?? ''))) throw new Error('This policy is direct bill. Its broker fee invoice cannot collect carrier premium.');
  if (fees.length && source?.accountId !== invoice.accountId) throw new Error('This broker fee belongs to a different account.');
  if (fees.length > 1 || fees.some(line => !quoteId || line.brokerFeeQuoteId !== quoteId || line.accountId !== invoice.accountId || brokerFeeCents(line.retailAmount) !== expected || line.costAmount !== 0 || (line.policyId && line.policyId !== policyId)) || (!expected && fees.length)) throw new Error("The broker fee must match this policy term's quote, with zero carrier cost. Update the quote and refresh its invoice.");
  if (expected > 0 && !fees.length && !alreadySubmitted) throw new Error("This policy term's broker fee is missing from the invoice. Refresh the invoice before sending.");
  if (alreadySubmitted && fees.length && invoice.status !== 'PAID') throw new Error("This term's broker fee was already submitted or collected. The existing fee payment must be resolved before sending another invoice.");
  return fees.length && quoteId ? [{quoteId,amountCents:expected,...(policyId?{policyId}:{})}] : [];
}

/** Refresh generated charges from the quote before sending an unpaid invoice. */
export function brokerFeeInvoiceRefresh(input: {
  invoice: {id:string;accountId:string;status?:string|null}; source:Source|null;
  quoteId?:string|null;policyId?:string|null;lines:readonly (FeeLine&{id:string})[];alreadySubmitted:boolean;
}) {
  const {invoice,source,quoteId,policyId,lines,alreadySubmitted}=input;
  const unchanged={remove:[] as string[],upsert:undefined as undefined|{id:string;kind:'BROKER_FEE';description:string;accountId:string;invoiceId:string;brokerFeeQuoteId:string;policyId?:string;retailAmount:number;costAmount:number;sortOrder:number}};
  if(alreadySubmitted || !source || source.accountId!==invoice.accountId || !['DRAFT','SENT'].includes(invoice.status??''))return unchanged;
  const fees=lines.filter(line=>line.kind==='BROKER_FEE'),amount=brokerFeeCents(source?.brokerFee);
  if(fees.length>1 || fees.some(line=>line.brokerFeeQuoteId!==quoteId || line.accountId!==invoice.accountId || line.policyId && line.policyId!==policyId))return unchanged;
  const remove=amount===0?fees.map(line=>line.id):[];
  if(amount>0 && source?.billType==='DIRECT')remove.push(...lines.filter(line=>['PREMIUM','ENDORSEMENT'].includes(line.kind??'')).map(line=>line.id));
  if(!amount || !quoteId || source?.accountId!==invoice.accountId || !['AGENCY','DIRECT'].includes(source.billType??''))return {...unchanged,remove};
  const current=fees[0];
  if(current && brokerFeeCents(current.retailAmount)===amount && current.costAmount===0)return {...unchanged,remove};
  return {remove,upsert:{id:current?.id??`broker-fee-${invoice.id}`,kind:'BROKER_FEE' as const,description:'Broker fee',accountId:invoice.accountId,invoiceId:invoice.id,brokerFeeQuoteId:quoteId,...(policyId?{policyId}:{}),retailAmount:amount/100,costAmount:0,sortOrder:lines.length}};
}
