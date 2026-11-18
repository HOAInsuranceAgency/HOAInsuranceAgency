import type { IntakeWorkspace } from '../../../shared/commissionIntake';
import { payrollApprovalIssues,payrollCutoffIssue,type PayrollWorkspace } from '../../../shared/commissionPayroll';
import { batchPaidCents,type CommissionOverview } from '../../../shared/commissions';
import { allWithAuthorizationPriority } from '../lib/allWithAuthorizationPriority';
import { isAuthorizationError } from '../../../shared/authorizationError';
import { commissionWorkflowAction as commissionAction } from '../lib/commissions';
import { useCommissionWorkflow,type CommissionDestination } from '../lib/commissionWorkflow';
import { useAsyncResource } from '../lib/useAsyncResource';
import type { CommissionExceptionWorkspace } from './CommissionExceptions';
import { Button } from './ui/Button';

export default function CommissionWorkQueue({ data, onAccessDenied }: { data: CommissionOverview; onAccessDenied: (error: unknown) => void }) {
  const { navigate } = useCommissionWorkflow();
  const resource = useAsyncResource(async () => {
    try {
      const [inbox, payroll, reviews] = await allWithAuthorizationPriority([
        commissionAction<IntakeWorkspace>('intakeWorkspace', {}),
        commissionAction<PayrollWorkspace>('payrollWorkspace', {}),
        commissionAction<CommissionExceptionWorkspace>('commissionExceptions', {}),
      ]);
      if (![inbox.intakes,inbox.settlements,payroll.cycles,reviews.departures,reviews.adjustments,reviews.earnings].every(Array.isArray)) throw new Error('Commission work is unavailable. Refresh to load the complete queue.');
      return { inbox, payroll, reviews };
    } catch (error) { if (isAuthorizationError(error)) onAccessDenied(error); throw error; }
  }, [], { clearDataOnError: () => true });
  if (!resource.data) return <section className="card"><h2>Work queue</h2><p role={resource.error ? 'alert' : 'status'}>{resource.error || 'Loading current work…'}</p>{resource.error && <Button onClick={() => void resource.refetch()}>Retry work queue</Button>}</section>;
  const { inbox, payroll, reviews } = resource.data;
  const cycles = payroll.cycles.filter(c => c.status === 'OPEN').sort((a,b) => a.cutoff.localeCompare(b.cutoff));
  type Work = { id: string; priority: number; due: string; title: string; detail: string; action: string; target: CommissionDestination };
  const items: Work[] = inbox.intakes.filter(s => s.status === 'OPEN' && (s.completedRows !== s.rowCount || !s.rowCount || inbox.settlements.some(p => p.intakeId === s.id && ['RECORDED','POSTING'].includes(p.status)))).map(s => {
    const pending = inbox.settlements.filter(p => p.intakeId === s.id && ['RECORDED','POSTING'].includes(p.status)).sort((a,b) => a.receivedOn.localeCompare(b.receivedOn));
    const affected = pending.length ? cycles.find(c => pending[0].receivedOn <= c.cutoff) : undefined;
    const review = !s.rowCount || s.needsReview || s.unmatched || s.totalCents === undefined || s.totalCents !== s.rowTotalCents;
    return { id: 'statement:' + s.id, priority: affected ? 0 : pending.length ? 1 : review ? 3 : 4, due: affected?.cutoff ?? s.documentReceivedOn, title: s.reference,
      detail: pending.length ? 'Received money needs allocation or posting' + (affected ? ' · payroll cutoff ' + affected.cutoff : '') : review ? 'Review source and policy matches' : 'Awaiting carrier payment',
      action: pending.length ? 'Review settlement' : 'Open statement', target: { tab: 'statements', intakeId: s.id } };
  });
  for (const d of inbox.deposits ?? []) if (d.status === 'AWAITING_REMITTANCE') {
    const affected = cycles.find(c => d.receivedOn <= c.cutoff);
    items.push({id:'deposit:'+d.id,priority:affected?0:1,due:affected?.cutoff??d.receivedOn,title:d.payor+' · '+new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(d.totalCents/100),detail:'Awaiting remittance · '+d.reference+(affected?' · payroll cutoff '+affected.cutoff:''),action:'Match deposit',target:{tab:'statements',depositId:d.id,intakeId:''}});
  }
  for (const s of data.statements.filter(s => s.status === 'DRAFT')) {
    const affected = cycles.find(c => s.receivedOn <= c.cutoff);
    items.push({id:'legacy:'+s.id,priority:affected?0:1,due:affected?.cutoff??s.receivedOn,title:s.reference,detail:'Earlier received statement needs reconciliation'+(affected?' · payroll cutoff '+affected.cutoff:''),action:'Review reconciliation',target:{tab:'statements',statementId:s.id}});
  }
  for (const c of payroll.cycles.filter(c => c.status === 'APPROVED')) {
    const issue=(payroll.deliveries??[]).some(d=>d.cycleId===c.id&&d.cycleRevision===c.revision&&(d.status==='FAILED'||d.status==='UNKNOWN'||!!d.failureState));
    const paid=(payroll.batches??[]).filter(b=>c.batchIds.includes(b.id)).reduce((n,b)=>n+batchPaidCents(b),0);
    items.push({id:'approved:'+c.id,priority:2,due:c.payDate,title:'Approved payroll · '+c.id,detail:issue?'Review report delivery evidence':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((c.totalCents-paid)/100)+' employee payment remaining',action:issue?'Review delivery':'Review approved payroll',target:{tab:'payroll',cycleId:c.id}});
  }
  for (const c of cycles) {
    const cutoffWait = payrollCutoffIssue(c);
    const reviewCount = payrollApprovalIssues(c).filter(issue => issue !== cutoffWait).length;
    const detail = reviewCount ? reviewCount + ' review item' + (reviewCount === 1 ? '' : 's') + ' to resolve' : cutoffWait ? 'Waiting for the ' + c.cutoff + ' receipt cutoff to end' : 'Ready for your approval';
    items.push({ id:'cycle:'+c.id, priority:2, due:c.cutoff, title:'Payroll · '+c.id, detail, action:!reviewCount && cutoffWait ? 'Review payroll schedule' : 'Review cycle',target:{tab:'payroll',cycleId:c.id}});
  }
  for (const c of reviews.departures.filter(c => c.status !== 'CLOSED')) items.push({ id:'departure:'+c.id,priority:2,due:c.reviewOn,title:c.producerName+' · departure review',detail:'Review terms, held earnings and payment decisions',action:'Resolve departure',target:{tab:'exceptions',departureId:c.id}});
  for (const a of reviews.adjustments.filter(a => a.status === 'DRAFT')) items.push({id:'adjustment:'+a.id,priority:2,due:a.effectiveOn,title:'Compensation adjustment',detail:a.reason,action:'Review adjustment',target:{tab:'exceptions',adjustmentId:a.id}});
  for (const p of data.policies) for (const hold of p.reviewHolds ?? []) if (hold.status === 'OPEN') items.push({id:'hold:'+p.id+':'+hold.id,priority:2,due:hold.dueOn,title:p.policyNumber+' · '+hold.category.toLowerCase(),detail:hold.note,action:'Resolve policy review',target:{tab:'ledger',policyId:p.id}});
  for (const e of reviews.earnings.filter(e => e.status === 'REVIEW')) items.push({id:'earning:'+e.id,priority:2,due:e.receivedOn,title:e.producerName+' · '+e.policyNumber,detail:'Review carrier adjustment or recovery evidence',action:'Resolve earnings review',target:{tab:'exceptions',earningId:e.id}});
  items.sort((a,b) => a.priority-b.priority || a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  return <section className="commission-work-queue">
    <div className="commission-section-heading"><div><h2>Work queue</h2><p>Start with received money affecting payroll, then the nearest cutoff and review decisions.</p></div><Button variant="secondary" onClick={() => void resource.refetch()}>Refresh work queue</Button></div>
    <div className="commission-action-bar"><Button variant="primary" onClick={() => navigate({tab:'statements'})}>Log or review a statement</Button><Button variant="secondary" onClick={() => navigate({tab:"statements",depositId:"new",intakeId:""})}>Log carrier deposit</Button><Button variant="secondary" onClick={() => navigate({tab:'exceptions'})}>Shared commissions, departures & adjustments</Button></div>
    {!items.length && <p>No unfinished commission work.</p>}
    {items.map(item => <div className="commission-work-item" key={item.id}><div><strong>{item.title}</strong><p>{item.detail}</p><small>{item.priority === 4 ? 'Arrived ' : 'Date / cutoff '}{item.due}</small></div><Button variant="secondary" onClick={() => navigate(item.target)}>{item.action}</Button></div>)}
  </section>;
}
