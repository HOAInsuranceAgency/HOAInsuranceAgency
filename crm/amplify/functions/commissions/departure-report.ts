import { reportReference } from './reports';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CommissionDeparture, departureWorklist } from '../../../../shared/commissionExceptions';
import { CommissionPdf, reportDate, reportTimestamp, reportMoney, statusTone, type ReportRenderOptions } from './report-layout';

function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export async function departureStatement(c: CommissionDeparture, worklist: ReturnType<typeof departureWorklist>, at: string, options: ReportRenderOptions = {}) {
  const snapshot={case:c,worklist};
  const snapshotHash=createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
  const pdf=await CommissionPdf.create(c.producerName+' departure commission review',at,'Confidential HR record',{...options,isTest:options.isTest??(process.env.COMMISSION_PAYROLL_ENV!==undefined&&process.env.COMMISSION_PAYROLL_ENV!=='main')});
  const employment=reportDate(c.employmentEndOn),due=reportDate(c.paymentDueOn),approved=reportTimestamp(c.approvedAt),created=reportTimestamp(at);
  pdf.start('DEPARTURE REVIEW · CASE VERSION '+c.version,'Departure commission review statement',c.producerName,
    [{label:c.status,tone:statusTone(c.status)}]);
  pdf.callout('Review record only — payment requires a separately approved payroll report.');
  const longTerms=c.agreement.length>140||c.evidence.length>140;
  pdf.facts([
    {label:'Employment end',value:employment.date,detail:employment.weekday},
    {label:'HR payment due',value:due.date,detail:due.weekday},
    {label:'Terms approved · Owner',value:approved.date,detail:approved.time},
    {label:'Snapshot',value:created.date,detail:created.time},
    {label:'Agreement',value:longTerms?'See supporting terms below':c.agreement,strong:false},
    {label:'Evidence',value:longTerms?'See supporting terms below':c.evidence,strong:false},
    {label:'Later receipts',value:c.laterReceipts,tone:statusTone(c.laterReceipts)},
    {label:'Renewals',value:c.renewals,tone:statusTone(c.renewals)},
  ]);
  if(longTerms){pdf.paragraph('Agreement: '+c.agreement);pdf.paragraph('Evidence: '+c.evidence);}
  pdf.section('01','Earnings and payment status');
  const total=worklist.rows.reduce((sum,row)=>sum+row.amountCents,0);
  pdf.table(['Policy','Date','Amount','Status','Payment'],[115,98,91,96,124],
    worklist.rows.map(row=>[
      {text:row.policyNumber,bold:true},{text:reportDate(row.receivedOn).date},
      {text:reportMoney(row.amountCents),bold:true,align:'right'},
      {text:row.decision,tone:statusTone(row.decision)},
      {text:row.paymentStatus,tone:statusTone(row.paymentStatus)},
    ]),
    [{text:'Total listed earnings',bold:true},{text:''},{text:reportMoney(total),bold:true,align:'right'},{text:''},{text:''}]);
  for(const row of worklist.rows)if(row.batchPaidCents!==undefined)
    pdf.paragraph(row.policyNumber+': Employee batch paid '+reportMoney(row.batchPaidCents)+' of '+reportMoney(row.batchTotalCents!)+'. A partial batch payment is not attributed to individual receipts.',8);
  const reviewTotal=worklist.rows.filter(row=>row.decision==='REVIEW').reduce((sum,row)=>sum+row.amountCents,0);
  pdf.paragraph('Awaiting eligibility decision: '+reportMoney(reviewTotal)+'. Approved earnings still require separate payroll approval.',8);
  pdf.section('02','Pending carrier receipts and reconciliation');
  pdf.table(['Policy','Expected agency','Received agency','Outstanding','Received to date'],[112,102,102,102,106],
    worklist.pending.map(p=>[
      {text:p.policyNumber,bold:true},
      {text:reportMoney(p.expectedAgencyCents),bold:true,align:'right'},
      {text:reportMoney(p.receivedAgencyCents),bold:true,align:'right'},
      {text:reportMoney(p.expectedAgencyCents-p.receivedAgencyCents),align:'right'},
      {text:p.expectedAgencyCents>0?((p.receivedAgencyCents/p.expectedAgencyCents)*100).toFixed(1)+'%':'—',align:'right',progress:p.expectedAgencyCents>0?p.receivedAgencyCents/p.expectedAgencyCents:0},
    ]));
  if(!worklist.pending.length)pdf.paragraph('No pending carrier balances in this snapshot.');
  pdf.section('03','Eligibility decisions',worklist.adjustments.length+' Proposed adjustments awaiting separate review');
  if(!c.decisions.length)pdf.paragraph('No individual eligibility decisions recorded.');
  for(const decision of c.decisions){
    const row=worklist.rows.find(row=>row.entryId===decision.entryId && (!decision.earningId || row.earningId===decision.earningId));
    pdf.paragraph((row?.policyNumber??'Policy record')+' | '+reportReference(decision.entryId)+' | '+decision.outcome+' | '+decision.reason,9,true);
    pdf.paragraph('Decision '+decision.at+' | '+decision.by+(decision.earningId?' | Earnings allocation '+decision.earningId:''),7);
  }
  for(const resolution of c.pendingResolutions??[]){
    pdf.paragraph('Carrier balance resolution: '+resolution.policyId+' | '+resolution.reason,9,true);
    pdf.paragraph(resolution.at+' | '+resolution.by,7);
  }
  pdf.audit('Case version '+c.version+'    Snapshot '+at+'    Terms approved '+(c.approvedAt??'Not recorded')+'    Record '+snapshotHash.slice(0,10));
  const bytes=Buffer.from(await pdf.finish('Review record only. Payment requires a separately approved payroll report.'));
  return {snapshot,snapshotHash,sha256:createHash('sha256').update(bytes).digest('hex'),content:gzipSync(bytes).toString('base64'),
    filename:'Departure_'+c.producerName.replace(/[^a-zA-Z0-9]+/g,'_')+'_v'+c.version+'_'+snapshotHash.slice(0,10)+'.pdf',createdAt:at};
}
export function departureReportFile(report:{content:string;sha256:string;filename:string}){
  const bytes=gunzipSync(Buffer.from(report.content,'base64'),{maxOutputLength:5_000_000});
  if(createHash('sha256').update(bytes).digest('hex')!==report.sha256)throw new Error('Departure report integrity check failed.');
  return {filename:report.filename,contentType:'application/pdf',content:bytes.toString('base64')};
}
