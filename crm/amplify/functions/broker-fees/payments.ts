import { createHash } from 'node:crypto';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { brokerFeeCents, feeAllocations, type BrokerFeeAllocation, type BrokerFeeRecord } from '../../../../shared/brokerFees';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import { appendEntry, type CommissionPolicy, type CommissionStatement, type StatementLine } from '../../../../shared/commissions';
import * as commissions from '../commissions/store';
import { db, table, getRow, getFee, getModel, feePut, transact, versionCheck, type Write, modelTable } from './store';

export interface BrokerFeePaymentInput {
  sourceId: string; accountId: string; allocations: BrokerFeeAllocation[];
  status: 'PROCESSING' | 'PAID' | 'FAILED' | 'REFUNDED';
  receivedOn?: string; refundedCents?: number; confirmedBy?: string;
}
interface Payment extends BrokerFeePaymentInput {
  id: string; kind: 'PAYMENT'; version: number; receivedOn?: string; refundedOn?: string;
  /** A source receipt is allocated to each frozen policy exactly once. */
  posted?: Record<string, { refundedCents: number }>;
  pending?: 'PENDING';
}
const applyStatementLine = (policy:CommissionPolicy, statement:CommissionStatement, line:StatementLine, id:string) => appendEntry(policy,line,statement,id);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const retryable = (error: unknown) => ['TransactionCanceledException','ConditionalCheckFailedException'].includes((error as {name?:string})?.name ?? '');
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
const paymentId = (sourceId: string) => `payment:${digest(sourceId)}`;

/** Pin the accepted fee before creating any external collection link. */
export async function reserveFeeInvoice(source:Record<string,unknown>|string,invoiceId:string) {
  const quoteId=typeof source==='string'?source:String(source.id);
  for(let attempt=0;attempt<5;attempt++) {
    const quote=await getModel<Record<string,unknown>>('Quote',quoteId);
    const invoice=await getModel<Record<string,unknown>>('Invoice',invoiceId);
    if(!quote||!invoice||quote.accountId!==invoice.accountId||!['DRAFT','SENT'].includes(String(invoice.status)))throw new Error('The fee invoice or quote changed before payment was prepared.');
    const policy=invoice.policyId?await getModel<Record<string,unknown>>('Policy',String(invoice.policyId)):undefined;
    if(invoice.quoteId!==quoteId&&policy?.quoteId!==quoteId)throw new Error('The fee invoice must belong to its quoted policy term.');
    const amount=brokerFeeCents(quote.brokerFee as number|undefined);
    if(!amount)return;
    if(typeof source!=='string'&&authorizedQuoteTerms(source)!==authorizedQuoteTerms(quote))throw new Error('The fee quote changed. Refresh the invoice before sending.');
    const old=await getFee(quoteId);
    if(old&&(old.amountCents!==amount||old.terms!==authorizedQuoteTerms(quote))&&(old.submittedCents>0||old.collectedCents>0||old.policyId))throw new Error('The existing fee payment must be reviewed before changing its terms.');
    const unchanged=old?.terms===authorizedQuoteTerms(quote)&&old.amountCents===amount;
    const base:BrokerFeeRecord=unchanged?old!:{id:`fee:${quoteId}`,kind:'FEE',accountId:String(quote.accountId),quoteId,amountCents:amount,terms:authorizedQuoteTerms(quote),version:0,submittedCents:0,collectedCents:0,refundedCents:0};
    const ids=[...new Set([...(base.issuedInvoiceIds??[]),invoiceId])];
    if(ids.length>100)throw new Error('This fee invoice history needs review before another payment is prepared.');
    try {await transact([feePut({...base,issuedInvoiceIds:ids},old),versionCheck(modelTable('Quote'),quote as {id:string;updatedAt:string}),versionCheck(modelTable('Invoice'),invoice as {id:string;updatedAt:string})]);return;}
    catch(error){if(!retryable(error)||attempt===4)throw error;}
  }
}

/** Keep financing checkout reservations visible even after its invoice is voided. */
export async function reserveFeeLoan(quoteId:string,loanId:string) {
  for(let attempt=0;attempt<5;attempt++) {
    const fee=await getFee(quoteId),loan=await getModel<Record<string,unknown>>('PfLoan',loanId);
    if(!fee||!loan||loan.accountId!==fee.accountId||!feeAllocations(loan.brokerFeeAllocations).some(a=>a.quoteId===quoteId&&a.amountCents===fee.amountCents))throw new Error('The finance offer fee does not match its accepted policy term.');
    const ids=[...new Set([...(fee.issuedLoanIds??[]),loanId])];
    if(ids.length>100)throw new Error('The fee financing history needs review.');
    try {await transact([feePut({...fee,issuedLoanIds:ids},fee),versionCheck(modelTable('PfLoan'),loan as {id:string;updatedAt:string})]);return;}
    catch(error){if(!retryable(error)||attempt===4)throw error;}
  }
}

/** Only trusted payment handlers call this; browsers cannot submit processor states. */
export async function syncBrokerFeePayment(input: BrokerFeePaymentInput, extraWrites: Write[] = []) {
  const allocations = feeAllocations(input.allocations);
  if (!allocations.length) { if(extraWrites.length) await transact(extraWrites); return; }
  if (!input.sourceId || input.sourceId.length > 200 || !input.accountId || !['PROCESSING','PAID','FAILED','REFUNDED'].includes(input.status)) throw new Error('Invalid broker fee payment source.');
  const total = allocations.reduce((n,a) => n+a.amountCents,0);
  const refunded = input.status === 'REFUNDED' ? input.refundedCents ?? total : 0;
  if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > total) throw new Error('A fee refund exceeds the collected fee.');
  if (allocations.length>1 && refunded>0 && refunded<total) throw new Error("Identify each policy fee refund separately for a partial multi-policy refund.");
  const id = paymentId(input.sourceId);
  for (let attempt=0;attempt<5;attempt++) {
    const previous = await getRow<Payment>(id);
    if (previous && (previous.accountId !== input.accountId || JSON.stringify(previous.allocations) !== JSON.stringify(allocations))) throw new Error('The fee payment allocation changed after collection.');
    // Delayed processing cannot revive a failed attempt. A real later success still records settlement.
    if(previous?.status==='FAILED'&&input.status==='PROCESSING')return;
    // Processors can redeliver old pending/failure notifications after success.
    const status = previous?.status === 'REFUNDED' || previous?.status === 'PAID' && ['PROCESSING','FAILED'].includes(input.status) ? previous.status : input.status;
    const refundTotal = Math.max(previous?.refundedCents ?? 0, refunded);
    const next: Payment = { ...previous, ...input, id, kind:'PAYMENT', version:(previous?.version ?? 0)+1, allocations, status,
      refundedCents:refundTotal, pending:status==='FAILED'?undefined:'PENDING',
      receivedOn:previous?.receivedOn ?? (input.status==='PAID' ? input.receivedOn ?? day() : undefined),
      refundedOn:refundTotal>(previous?.refundedCents??0)?input.receivedOn??day():previous?.refundedOn };
    const writes: Write[] = [feePut(next,previous),...extraWrites];
    let allocatedRefund=0;
    for (let i=0;i<allocations.length;i++) {
      const allocation=allocations[i], old=await getFee(allocation.quoteId);
      const quote=await getModel<Record<string,unknown>>('Quote',allocation.quoteId);
      if (old ? old.accountId!==input.accountId||old.amountCents!==allocation.amountCents : !quote||quote.accountId!==input.accountId||brokerFeeCents(quote.brokerFee as number|undefined)!==allocation.amountCents) throw new Error('The collected broker fee differs from its frozen payment allocation.');
      const expected=old?.amountCents??brokerFeeCents(quote!.brokerFee as number|undefined);
      const base:BrokerFeeRecord=old ?? {id:`fee:${allocation.quoteId}`,kind:'FEE',accountId:input.accountId,quoteId:allocation.quoteId,amountCents:expected,terms:authorizedQuoteTerms(quote!),version:0,submittedCents:0,collectedCents:0,refundedCents:0};
      // Only distribute an explicitly identified fee refund, never a gross
      // premium refund. Allocation is deterministic within that fee component.
      const end=i===allocations.length-1?refundTotal:Math.floor(refundTotal*allocations.slice(0,i+1).reduce((s,a)=>s+a.amountCents,0)/total);
      const sourceRefund=end-allocatedRefund; allocatedRefund=end;
      const paymentSources={...base.paymentSources,[id]:{status,amountCents:allocation.amountCents,refundedCents:sourceRefund}};
      if (Object.keys(paymentSources).length>100) throw new Error('This fee payment history needs review before another receipt is recorded.');
      const sources=Object.values(paymentSources);
      const collectedCents=sources.filter(s=>['PAID','REFUNDED'].includes(s.status)).reduce((n,s)=>n+s.amountCents,0);
      const submittedCents=sources.filter(s=>s.status!=='FAILED').reduce((n,s)=>n+s.amountCents,0);
      if (collectedCents>expected || submittedCents>expected) throw new Error('Duplicate broker fee collection requires payment review; it cannot create additional producer earnings.');
      writes.push(feePut({...base,paymentSources,collectedCents,submittedCents,refundedCents:sources.reduce((n,s)=>n+s.refundedCents,0)},old));
    }
    try { await transact(writes); await allocatePayment(id); return; }
    catch(error) { if (!retryable(error)||attempt===4) throw error; }
  }
}

/** Receipt + payroll earnings + allocation lock commit as one private transaction. */
async function allocatePayment(id: string) {
  for (let attempt=0;attempt<5;attempt++) {
    const payment=await getRow<Payment>(id);
    if (!payment || !payment.receivedOn || !['PAID','REFUNDED'].includes(payment.status)) return;
    const posted={...payment.posted};
    const changes:commissions.Change[]=[], extras:commissions.Transaction=[];
    let refundAllocated=0, changed=false;
    const total=payment.allocations.reduce((s,a)=>s+a.amountCents,0);
    for (let i=0;i<payment.allocations.length;i++) {
      const a=payment.allocations[i], fee=await getFee(a.quoteId);
      const refundEnd=i===payment.allocations.length-1?(payment.refundedCents??0):Math.floor((payment.refundedCents??0)*payment.allocations.slice(0,i+1).reduce((s,x)=>s+x.amountCents,0)/total);
      const refund=refundEnd-refundAllocated;refundAllocated=refundEnd;
      if (!fee?.policyId) continue; // Binding will attach the frozen producer.
      const policy=await commissions.get<CommissionPolicy>('POLICY',fee.policyId);
      if (!policy || policy.accountId!==payment.accountId || policy.quoteId!==a.quoteId) throw new Error('Broker fee producer attribution is incomplete.');
      const old=policy; let next=policy;
      const receiptId=`fee-receipt:${digest(`${payment.sourceId}:${a.quoteId}`)}`;
      const eligible=policy.eligibility?.eligible!==false && (!policy.receiptsFrom||payment.receivedOn>=policy.receiptsFrom);
      const statement={id:payment.id,receivedOn:payment.receivedOn} as CommissionStatement;
      if (!posted[a.quoteId]) {
        if (!next.entries.some(e=>e.id===receiptId)) next=applyStatementLine(next,statement,{policyId:policy.id,lineRef:payment.sourceId,kind:'RECEIPT',revenueKind:'BROKER_FEE',agencyCents:a.amountCents,eligible,eligibilityNote:'Verified broker fee settlement; policy producer terms apply.'} satisfies StatementLine,receiptId);
        posted[a.quoteId]={refundedCents:0}; changed=true;
      }
      const priorRefund=posted[a.quoteId].refundedCents;
      if (refund>priorRefund) {
        const reversalId=`fee-refund:${digest(`${payment.sourceId}:${a.quoteId}:${refund}`)}`;
        if(!next.entries.some(e=>e.id===reversalId)) next=applyStatementLine(next,{...statement,receivedOn:payment.refundedOn??day()}, {policyId:policy.id,lineRef:`${payment.sourceId}:refund:${refund}`,kind:'REVERSAL',revenueKind:'BROKER_FEE',agencyCents:-(refund-priorRefund),originalId:receiptId,eligible,eligibilityNote:'Actual broker fee refund; original producer allocation retained.'},reversalId);
        posted[a.quoteId]={refundedCents:refund}; changed=true;
      }
      if(next!==old) changes.push({kind:'POLICY',value:next as unknown as commissions.Data&{id:string},previous:old as unknown as commissions.Data});
      extras.push({ConditionCheck:{TableName:table(),Key:{id:fee.id},ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':fee.version}}});
      extras.push({Update:{TableName:modelTable('Policy'),Key:{id:policy.id},UpdateExpression:'SET brokerFeeCollected = :gross, brokerFeeRefunded = :refund, brokerFeeCollectedAt = :at',ConditionExpression:'accountId = :account AND quoteId = :quote',ExpressionAttributeValues:{':gross':fee.collectedCents/100,':refund':fee.refundedCents/100,':at':`${payment.receivedOn}T12:00:00Z`,':account':payment.accountId,':quote':a.quoteId}}});
    }
    if(!changed) {
      if(payment.pending && payment.allocations.every(a=>posted[a.quoteId]))await transact([feePut({...payment,pending:undefined},payment)]);
      return;
    }
    const complete=payment.allocations.every(a=>posted[a.quoteId]);
    extras.push(feePut({...payment,posted,pending:complete?undefined:'PENDING'},payment));
    try { await commissions.commit(changes,'broker-fee-payment',extras);return; }
    catch(error){if(!retryable(error)||attempt===4)throw error;}
  }
}

/** Durable recovery also covers a settled payment received before binding. */
export async function reconcilePendingPayments() {
  const recovery=await getRow<{id:string;cursor?:Record<string,unknown>}>('recovery-cursor');
  let cursor=recovery?.cursor, processed=0,failed=0;
  const deadline=Date.now()+20_000;
  do {
    const result=await db.send(new QueryCommand({TableName:table(),IndexName:'pending',KeyConditionExpression:'#pending = :pending',ExpressionAttributeNames:{'#pending':'pending'},ExpressionAttributeValues:{':pending':'PENDING'},ExclusiveStartKey:cursor,Limit:25}));
    for(const row of result.Items??[]) {
      try {await allocatePayment(String(row.id));processed++;}
      catch(error){failed++;console.error('Broker fee receipt remains pending for recovery',String(row.id),error);}
    }
    cursor=result.LastEvaluatedKey;
    await db.send(new PutCommand({TableName:table(),Item:{id:'recovery-cursor',cursor}}));
  } while(cursor && Date.now()<deadline);
  if(failed)throw new Error(`${failed} broker fee receipts remain queued for retry.`);
  return {processed};
}

export async function reconcileQuotePayments(quoteId:string) {
  const fee=await getFee(quoteId);
  for(const id of Object.keys(fee?.paymentSources??{}))await allocatePayment(id);
}
