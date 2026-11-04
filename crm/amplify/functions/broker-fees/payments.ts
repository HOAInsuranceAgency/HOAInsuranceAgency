import { createHash, randomUUID } from 'node:crypto';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { brokerFeeCents, feeAllocations, type BrokerFeeAllocation, type BrokerFeeRecord, type BrokerFeeInvoiceSendClaim } from '../../../../shared/brokerFees';
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

/** Pair fee-version checks on checkout claims with loan-version checks on a
 * competing invoice/manual receipt. A known checkout URL stays payable even
 * when its original invoice has been voided. */
export async function assertNoFeeLoanCheckout(fee: BrokerFeeRecord): Promise<Write[]> {
  const ids = [...new Set(fee.issuedLoanIds ?? [])];
  if (ids.length > 100 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('The financing payment history needs review.');
  const guards: Write[] = [];
  for (let offset = 0; offset < ids.length; offset += 10) {
    const loans = await Promise.all(ids.slice(offset, offset + 10).map(id => getModel<Record<string, unknown>>('PfLoan', id)));
    for (const loan of loans) {
      if (!loan) throw new Error('A referenced financing offer could not be verified. Review its payment session before collecting this fee another way.');
      if (loan.accountId !== fee.accountId) throw new Error('The financing payment source could not be verified.');
      if (!feeAllocations(loan.brokerFeeAllocations).some(part => part.quoteId === fee.quoteId && part.amountCents > 0)) throw new Error('The financing offer no longer matches its recorded broker fee source.');
      const expiry = Date.parse(String(loan.electionCheckoutExpiresAt ?? ''));
      const liveCheckout = !!loan.electionCheckoutUrl && (!Number.isFinite(expiry) || expiry > Date.now());
      if (loan.downPaymentIntentId || liveCheckout || ['ACCEPTED', 'ACTIVE', 'DEFAULTED', 'PAID'].includes(String(loan.status))) throw new Error('A financing payment is already open or submitted for this broker fee. Complete it or wait for the payment session to expire before collecting the fee another way.');
      if (loan.status === 'QUOTED') guards.push(versionCheck(modelTable('PfLoan'), loan as { id: string; updatedAt: string }));
      if (guards.length > 20) throw new Error('Too many financing offers need review before another fee payment can be prepared.');
    }
  }
  return guards;
}

/** Pin the accepted fee before creating any external collection link. */
export async function reserveFeeInvoice(source:Record<string,unknown>|string,invoiceId:string,totalCents?:number):Promise<BrokerFeeInvoiceSendClaim|undefined> {
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
    if(old&&(old.submittedCents>0||old.collectedCents>0||old.refundedCents>0))throw new Error('This broker fee already has a submitted or received payment. Review it before preparing another payment link.');
    if(old&&(old.amountCents!==amount||old.terms!==authorizedQuoteTerms(quote))&&(old.submittedCents>0||old.collectedCents>0||old.policyId))throw new Error('The existing fee payment must be reviewed before changing its terms.');
    const unchanged=old?.terms===authorizedQuoteTerms(quote)&&old.amountCents===amount;
    const base:BrokerFeeRecord=unchanged?old!:{id:`fee:${quoteId}`,kind:'FEE',accountId:String(quote.accountId),quoteId,amountCents:amount,terms:authorizedQuoteTerms(quote),version:0,submittedCents:0,collectedCents:0,refundedCents:0};
    const loanGuards = await assertNoFeeLoanCheckout(base);
    const previousClaim=old?.invoiceSendClaim;
    if(previousClaim&&previousClaim.invoiceId!==invoiceId){
      const priorInvoice=await getModel<Record<string,unknown>>('Invoice',previousClaim.invoiceId);
      if(!priorInvoice||priorInvoice.status!=='VOID'||previousClaim.phase==='PREPARING'&&!previousClaim.linkId)throw new Error('Finish or void the existing broker fee invoice before preparing another payment link.');
      loanGuards.push(versionCheck(modelTable('Invoice'),priorInvoice as {id:string;updatedAt:string}));
    }
    const wantedTotal=totalCents??Number(invoice.stripeLinkAmountCents??amount);
    if(!Number.isSafeInteger(wantedTotal)||wantedTotal<amount)throw new Error('The broker fee invoice total could not be verified.');
    const resume=previousClaim?.invoiceId===invoiceId&&previousClaim.phase==='PREPARING';
    if(resume&&previousClaim.totalCents!==wantedTotal)throw new Error('Payment setup already began with different invoice charges. Resume that send before voiding and reissuing it.');
    // Stripe retains idempotency keys for at least 24 hours. An uncertain old
    // creation must be reviewed, rather than minting another perpetual link.
    if(resume&&!previousClaim.linkId&&(!Number.isFinite(Date.parse(previousClaim.createdAt))||Date.now()-Date.parse(previousClaim.createdAt)>20*60*60*1000))throw new Error('This interrupted payment setup is too old to retry automatically. Review its processor link before issuing another invoice.');
    const claim:BrokerFeeInvoiceSendClaim=resume?previousClaim:{invoiceId,token:randomUUID(),createdAt:new Date().toISOString(),phase:'PREPARING',totalCents:wantedTotal,previousLinkId:typeof invoice.stripePaymentLinkId==='string'?invoice.stripePaymentLinkId:null};
    const ids=[...new Set([...(base.issuedInvoiceIds??[]),invoiceId])];
    if(ids.length>100)throw new Error('This fee invoice history needs review before another payment is prepared.');
    try {await transact([feePut({...base,issuedInvoiceIds:ids,invoiceSendClaim:claim},old),versionCheck(modelTable('Quote'),quote as {id:string;updatedAt:string}),versionCheck(modelTable('Invoice'),invoice as {id:string;updatedAt:string}),...loanGuards]);return claim;}
    catch(error){if(!retryable(error)||attempt===4)throw error;}
  }
}

/** Bind a processor link to the durable owner before it can be delivered. */
export async function publishFeeInvoiceLink(invoiceId:string,allocations:BrokerFeeAllocation[],token:string,linkId:string,invoiceWrite:Write):Promise<boolean>{
  if(!allocations.length||allocations.length>25||!linkId)return false;
  for(let attempt=0;attempt<5;attempt++){
    const fees=await Promise.all(allocations.map(part=>getFee(part.quoteId)));
    if(fees.some(fee=>fee?.invoiceSendClaim?.invoiceId!==invoiceId||fee.invoiceSendClaim.token!==token))return false;
    const invoice=await getModel<Record<string,unknown>>('Invoice',invoiceId);
    if(invoice?.stripePaymentLinkId===linkId&&['DRAFT','SENT','PROCESSING','PAID'].includes(String(invoice.status))&&fees.every(fee=>fee!.invoiceSendClaim!.linkId===linkId))return true;
    if(fees.some(fee=>fee!.invoiceSendClaim!.phase!=='PREPARING'))return false;
    try{await transact([invoiceWrite,...fees.map(fee=>feePut({...fee!,invoiceSendClaim:{...fee!.invoiceSendClaim!,linkId}},fee))]);return true;}
    catch(error){if(!retryable(error))throw error;if(attempt===4)return false;}
  }
  return false;
}

/** Keep PREPARING through mail/status publication; no clock-based release. */
export async function completeFeeInvoiceSend(invoiceId:string,allocations:BrokerFeeAllocation[],token:string){
  if(!allocations.length||allocations.length>25)throw new Error('The broker fee payment allocation needs review.');
  for(let attempt=0;attempt<5;attempt++){
    const invoice=await getModel<Record<string,unknown>>('Invoice',invoiceId);
    if(!invoice||!invoice.stripePaymentLinkId||!['SENT','PROCESSING','PAID'].includes(String(invoice.status)))throw new Error('The invoice changed before its payment setup completed.');
    const fees=await Promise.all(allocations.map(part=>getFee(part.quoteId)));
    if(fees.some(fee=>fee?.invoiceSendClaim?.invoiceId!==invoiceId||fee.invoiceSendClaim.token!==token||fee.invoiceSendClaim.linkId!==invoice.stripePaymentLinkId))throw new Error('The broker fee payment setup changed. Review the existing invoice before sending again.');
    if(fees.every(fee=>fee!.invoiceSendClaim!.phase==='PUBLISHED'))return;
    try{await transact([...fees.map(fee=>feePut({...fee!,invoiceSendClaim:{...fee!.invoiceSendClaim!,phase:'PUBLISHED' as const}},fee)),versionCheck(modelTable('Invoice'),invoice as {id:string;updatedAt:string})]);return;}
    catch(error){if(!retryable(error)||attempt===4)throw error;}
  }
}

/** Void closes all known Stripe paths first, then atomically releases ownership. */
export async function feeInvoiceVoidWrites(invoice:Record<string,unknown>):Promise<Write[]>{
  const parts=feeAllocations(invoice.brokerFeeAllocations),ids=new Set(parts.map(part=>part.quoteId));
  if(typeof invoice.quoteId==='string')ids.add(invoice.quoteId);
  if(!ids.size&&invoice.policyId){const policy=await getModel<Record<string,unknown>>('Policy',String(invoice.policyId));if(policy?.quoteId)ids.add(String(policy.quoteId));}
  if(ids.size>25)throw new Error('The invoice fee history needs review.');
  const writes:Write[]=[];
  for(const id of ids){
    const fee=await getFee(id);if(!fee)continue;
    const claim=fee.invoiceSendClaim;
    if(claim&&claim.invoiceId===invoice.id){
      if(!claim.linkId||claim.linkId!==invoice.stripePaymentLinkId)throw new Error('Payment setup has not finished. Retry Send to recover its payment link before voiding this invoice.');
      const {invoiceSendClaim:_claim,...next}=fee;writes.push(feePut(next,fee));
    }else writes.push(versionCheck(table(),fee));
  }
  return writes;
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
export async function syncBrokerFeePayment(input: BrokerFeePaymentInput, extraWrites: Write[] = [], expectedFeeVersions: Record<string, number> = {}) {
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
      if (Object.hasOwn(expectedFeeVersions, allocation.quoteId) && old?.version !== expectedFeeVersions[allocation.quoteId]) throw new Error('The fee payment source changed. Refresh and review its financing offers before confirming payment.');
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
