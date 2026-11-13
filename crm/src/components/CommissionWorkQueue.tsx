import { allWithAuthorizationPriority } from '../lib/allWithAuthorizationPriority';
import { commissionAction } from '../lib/commissions';
import { useAsyncResource } from '../lib/useAsyncResource';
import { isAuthorizationError } from '../lib/authorizationError';
import { useCommissionWorkflow, type CommissionDestination } from '../lib/commissionWorkflow';
import { batchPaidCents, type CommissionOverview } from '../../../shared/commissions';
import type { IntakeWorkspace } from '../../../shared/commissionIntake';
import { payrollApprovalIssues, type PayrollWorkspace } from '../../../shared/commissionPayroll';
import type { CommissionExceptionWorkspace } from './CommissionExceptions';

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
  if (!resource.data) return <section className="card"><h2>Work queue</h2><p role={resource.error ? 'alert' : 'status'}>{resource.error || 'Loading current work…'}</p>{resource.error && <button onClick={() => void resource.refetch()}>Retry work queue</button>}</section>;
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
  for (const s of data.statements.filter(s => s.status === 'DRAFT')) {
    const affected = cycles.find(c => s.receivedOn <= c.cutoff);
    items.push({id:'legacy:'+s.id,priority:affected?0:1,due:affected?.cutoff??s.receivedOn,title:s.reference,detail:'Earlier received statement needs reconciliation'+(affected?' · payroll cutoff '+affected.cutoff:''),action:'Review reconciliation',target:{tab:'statements',statementId:s.id}});
  }
  for (const c of payroll.cycles.filter(c => c.status === 'APPROVED')) {
    const issue=(payroll.deliveries??[]).some(d=>d.cycleId===c.id&&d.cycleRevision===c.revision&&(d.status==='FAILED'||d.status==='UNKNOWN'||!!d.failureState));
    const paid=(payroll.batches??[]).filter(b=>c.batchIds.includes(b.id)).reduce((n,b)=>n+batchPaidCents(b),0);
    items.push({id:'approved:'+c.id,priority:2,due:c.payDate,title:'Approved payroll · '+c.id,detail:issue?'Review report delivery evidence':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((c.totalCents-paid)/100)+' employee payment remaining',action:issue?'Review delivery':'Review approved payroll',target:{tab:'payroll',cycleId:c.id}});
  }
  for (const c of cycles) items.push({ id:'cycle:'+c.id, priority:2, due:c.cutoff, title:'Payroll · '+c.id, detail:'Cutoff '+c.cutoff+' · '+payrollApprovalIssues(c).length+' approval issues', action:'Review cycle',target:{tab:'payroll',cycleId:c.id}});
  for (const c of reviews.departures.filter(c => c.status !== 'CLOSED')) items.push({ id:'departure:'+c.id,priority:2,due:c.reviewOn,title:c.producerName+' · departure review',detail:'Review terms, held earnings and payment decisions',action:'Resolve departure',target:{tab:'exceptions',departureId:c.id}});
  for (const a of reviews.adjustments.filter(a => a.status === 'DRAFT')) items.push({id:'adjustment:'+a.id,priority:2,due:a.effectiveOn,title:'Compensation adjustment',detail:a.reason,action:'Review adjustment',target:{tab:'exceptions',adjustmentId:a.id}});
  for (const p of data.policies) for (const hold of p.reviewHolds ?? []) if (hold.status === 'OPEN') items.push({id:'hold:'+p.id+':'+hold.id,priority:2,due:hold.dueOn,title:p.policyNumber+' · '+hold.category.toLowerCase(),detail:hold.note,action:'Resolve policy review',target:{tab:'ledger',policyId:p.id}});
  for (const e of reviews.earnings.filter(e => e.status === 'REVIEW')) items.push({id:'earning:'+e.id,priority:2,due:e.receivedOn,title:e.producerName+' · '+e.policyNumber,detail:'Review carrier adjustment or recovery evidence',action:'Resolve earnings review',target:{tab:'exceptions',earningId:e.id}});
  items.sort((a,b) => a.priority-b.priority || a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  return <section className="commission-work-queue">
    <div className="commission-section-heading"><div><h2>Work queue</h2><p>Start with received money affecting payroll, then the nearest cutoff and review decisions.</p></div><button className="secondary" onClick={() => void resource.refetch()}>Refresh work queue</button></div>
    <div className="commission-action-bar"><button className="primary" onClick={() => navigate({tab:'statements'})}>Log or review a statement</button><button className="secondary" onClick={() => navigate({tab:'exceptions'})}>Shared commissions, departures & adjustments</button></div>
    {!items.length && <p>No unfinished commission work.</p>}
    {items.map(item => <div className="commission-work-item" key={item.id}><div><strong>{item.title}</strong><p>{item.detail}</p><small>{item.priority === 4 ? 'Arrived ' : 'Date / cutoff '}{item.due}</small></div><button className="secondary" onClick={() => navigate(item.target)}>{item.action}</button></div>)}
  </section>;
}
