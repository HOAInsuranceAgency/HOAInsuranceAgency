import { cycleBatches, type PayrollCycle } from '../../../../shared/commissionPayroll';
import type { CommissionBatch } from '../../../../shared/commissions';
import { CommissionPdf, reportDate, reportMoney, reportTimestamp, type ReportRenderOptions, type Tone } from './report-layout';

export function reportReference(id: string) {
  const receipt = id.match(/^[a-f0-9]{64}:(.+)$/i);
  if (receipt) return receipt[1];
  if (/^[a-f0-9-]{32,}$/i.test(id) || id.startsWith('adjustment:')) return 'Record '+id.replace(/^adjustment:/,'').slice(0,10);
  return id;
}

/** Separate, deterministic approved records. An employee document never includes another employee. */
export async function commissionReportFiles(cycle: PayrollCycle, batches: CommissionBatch[], documentId?: string, options: ReportRenderOptions = {}) {
  if (!['APPROVED', 'PAID'].includes(cycle.status) || cycle.reviewRequired) throw new Error('Review and approve the cycle before generating earnings records.');
  const selected = cycleBatches(cycle, batches);
  const renderOptions = { ...options, isTest: options.isTest ?? (process.env.COMMISSION_PAYROLL_ENV !== undefined && process.env.COMMISSION_PAYROLL_ENV !== 'main') };
  if (documentId && documentId !== 'summary' && !selected.some(b => b.id === documentId)) throw new Error('Employee report is not part of this cycle.');
  const files: { filename: string; contentType: string; content: Uint8Array }[] = [];
  const approved = reportTimestamp(cycle.approvedAt ?? cycle.id.slice(0,7) + '-01T00:00:00Z');
  const payday=reportDate(cycle.payDate),processing=reportDate(cycle.processingOn),cutoff=reportDate(cycle.cutoff);
  for (const [index, employee] of [undefined, ...selected].entries()) {
    if (documentId && (employee?.id ?? 'summary') !== documentId) continue;
    const copy=employee?'Confidential employee copy':'Confidential HR copy';
    const pdf=await CommissionPdf.create(cycle.id+' Commission earnings - '+(employee?.producerName??'HR summary'),approved.iso,copy,renderOptions);
    const offCycle=cycle.cycleType==='OFF_CYCLE';
    const adjustment=(employee?[employee]:selected).some(b=>b.lines.some(l=>l.source==='ADJUSTMENT'));
    const badges:{label:string;tone:Tone}[]=[];
    if(cycle.replacesRevision)badges.push({label:'REPLACEMENT',tone:'uncovered'});
    if(offCycle)badges.push({label:'OFF-CYCLE PAYMENT',tone:'notice'});
    if(adjustment)badges.push({label:'ADJUSTMENT',tone:'attention'});
    badges.push({label:'REVISION '+cycle.revision,tone:'notice'});
    pdf.start('CYCLE '+cycle.id+' · REVISION '+cycle.revision,
      employee?'Employee commission earnings':offCycle?'Off-cycle commission payroll summary':'Commission payroll summary',
      employee?employee.producerName:'Approved commission amounts for entry in payroll.',badges);
    if(cycle.replacesRevision)pdf.callout('Replaces revision '+cycle.replacesRevision+' — do not pay both versions.',
      'Process only the amounts on this revision. Revision '+cycle.replacesRevision+' of cycle '+cycle.id+' is superseded.','uncovered');
    if(offCycle)pdf.callout('Off-cycle payment','This payment falls outside the regular monthly commission cycle. Reference: '+cycle.id+'.');
    pdf.facts([
      {label:'Scheduled payday',value:payday.date,detail:payday.weekday},
      {label:'Processing',value:processing.date,detail:processing.weekday},
      {label:'Carrier receipts',value:cutoff.date,detail:'Through end of day Eastern'},
      {label:'Approved',value:approved.date,detail:approved.time},
    ]);
    pdf.amount(employee?.totalCents??cycle.totalCents,
      employee?employee.producerName:selected.length+' '+(selected.length===1?'employee':'employees'),
      'Cycle '+cycle.id+' · Revision '+cycle.revision);
    if(employee) {
      pdf.section('01','Approved earnings detail','Only the earnings included in this report.');
      pdf.table(['Account / policy','Receipt / reference','Calculation','Earnings'],[172,106,146,100],
        employee.lines.map(row => [
          {text:row.accountName+' · '+row.policyNumber+' · '+(row.transaction==='NEW'?'New business':row.transaction==='RENEWAL'?'Renewal':'Commission'),bold:true},
          {text:(row.receivedOn?reportDate(row.receivedOn).date:'See source ledger')+' · '+reportReference(row.entryId)},
          {text:row.source==='ADJUSTMENT'?'Approved compensation adjustment':reportMoney(row.agencyCents)+(row.shareBps===undefined?'':' × '+(row.shareBps/100).toFixed(2)+'% share')+' × '+(row.producerBps/100).toFixed(2)+'% rate'},
          {text:reportMoney(row.amountCents),bold:true,align:'right'},
        ]),
        [{text:'Approved commission total',bold:true},{text:''},{text:''},{text:reportMoney(employee.totalCents),bold:true,align:'right'}]);
    } else {
      pdf.section('01','Payroll entries','Enter one approved commission amount per employee.');
      pdf.table(['Employee','Earnings included','Commission amount'],[260,110,154],
        selected.map(batch=>[{text:batch.producerName,bold:true},{text:String(batch.lines.length)+' '+(batch.lines.length===1?'item':'items')},{text:reportMoney(batch.totalCents),bold:true,align:'right'}]),
        [{text:'Total for payroll',bold:true},{text:''},{text:reportMoney(cycle.totalCents),bold:true,align:'right'}]);
      if(!selected.length)pdf.paragraph('No payable employee commissions in this approved cycle.');
    }
    pdf.audit('Source record  Cycle '+cycle.id+'    Approved '+approved.iso+'    Cycle revision '+cycle.revision+'    Copy '+copy);
    const name=employee?.producerName.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'_').slice(0,60)||'Employee';
    files.push({filename:employee?`Commission_${cycle.id}_v${cycle.revision}_${index}_${name}.pdf`:`Commission_Summary_${cycle.id}_v${cycle.revision}.pdf`,
      contentType:'application/pdf',content:await pdf.finish('Confidential pay record. Approval/report delivery does not confirm payment.')});
  }
  return files;
}
