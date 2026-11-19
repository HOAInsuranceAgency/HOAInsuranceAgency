import { act } from '@testing-library/react';
import { liveUpdates } from '../lib/liveUpdates';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { beforeEach,it,expect,vi } from 'vitest';
import type { CommissionOverview } from '../../../shared/commissions';
import CommissionWorkQueue from './CommissionWorkQueue';
import { CommissionWorkflowContext } from '../lib/commissionWorkflow';
const h=vi.hoisted(()=>({action:vi.fn()}));
vi.mock('../lib/commissions',()=>({commissionWorkflowAction:h.action}));
vi.mock('../lib/client',()=>({friendlyError:(e:Error)=>e.message}));
const data={policies:[],plans:[],carriers:[],batches:[],statements:[]} as CommissionOverview;
beforeEach(()=>vi.resetAllMocks());
it('puts received money affecting payroll ahead of older unpaid source review and opens the exact statement',async()=>{
 const old={id:'old',status:'OPEN',reference:'Older unpaid source',documentReceivedOn:'2026-10-01',rowCount:0,completedRows:0,needsReview:1};
 h.action.mockImplementation(async op=>op==='intakeWorkspace'?{intakes:[old,{...old,id:'paid',reference:'Received money',documentReceivedOn:'2026-11-10'}],settlements:[{id:'s',intakeId:'paid',status:'RECORDED',receivedOn:'2026-11-10'}]}:op==='payrollWorkspace'?{cycles:[{id:'2026-11',cutoff:'2026-11-12',status:'OPEN',preview:{blockers:[]}}]}:{departures:[],adjustments:[],earnings:[]});
 const navigate=vi.fn();
 render(<CommissionWorkflowContext.Provider value={{target:{tab:'queue'},navigate}}><CommissionWorkQueue data={data} onAccessDenied={vi.fn()}/></CommissionWorkflowContext.Provider>);
 const first=await screen.findByRole('button',{name:'Review settlement'});
 expect(screen.getByText('Received money').compareDocumentPosition(screen.getByText('Older unpaid source')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(first);
 expect(navigate).toHaveBeenCalledWith({tab:'statements',intakeId:'paid'});
});
it('does not let a transient read failure hide a concurrent access denial',async()=>{
 h.action.mockImplementation(async op=>{throw new Error(op==='payrollWorkspace'?'Not authorized':'Temporary failure');});
 const denied=vi.fn();
 render(<CommissionWorkQueue data={data} onAccessDenied={denied}/>);
 await waitFor(()=>expect(denied).toHaveBeenCalled());
 expect(await screen.findByRole('alert')).toHaveTextContent('Not authorized');
 expect(screen.queryByRole('button',{name:'Review settlement'})).toBeNull();
});

it('keeps earlier reconciliation and approved unpaid payroll in the queue with exact destinations', async () => {
 h.action.mockImplementation(async op=>op==='intakeWorkspace'?{intakes:[],settlements:[]}:op==='payrollWorkspace'?{cycles:[{id:'approved',status:'APPROVED',cutoff:'2026-10-10',payDate:'2026-10-15',totalCents:15000,batchIds:[]}],deliveries:[],batches:[]}:{departures:[],adjustments:[],earnings:[]});
 const navigate=vi.fn();
 render(<CommissionWorkflowContext.Provider value={{target:{tab:'queue'},navigate}}><CommissionWorkQueue data={{...data,statements:[{id:'legacy',status:'DRAFT',reference:'Earlier received payment',receivedOn:'2026-10-09'} as CommissionOverview['statements'][number]]}} onAccessDenied={vi.fn()}/></CommissionWorkflowContext.Provider>);
 fireEvent.click(await screen.findByRole('button',{name:'Review reconciliation'}));
 expect(navigate).toHaveBeenLastCalledWith({tab:'statements',statementId:'legacy'});
 expect(screen.getByText('$150.00 employee payment remaining')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Review approved payroll'}));
 expect(navigate).toHaveBeenLastCalledWith({tab:'payroll',cycleId:'approved'});
});

it('labels a future cutoff as a scheduled wait instead of a reconciliation issue', async () => {
 h.action.mockImplementation(async op=>op==='intakeWorkspace'?{intakes:[],settlements:[]}:op==='payrollWorkspace'?{cycles:[{id:'future',status:'OPEN',cutoff:'2099-11-20',preview:{blockers:[]}}]}:{departures:[],adjustments:[],earnings:[]});
 const navigate=vi.fn();
 render(<CommissionWorkflowContext.Provider value={{target:{tab:'queue'},navigate}}><CommissionWorkQueue data={data} onAccessDenied={vi.fn()}/></CommissionWorkflowContext.Provider>);
 fireEvent.click(await screen.findByRole('button',{name:'Review payroll schedule'}));
 expect(screen.getByText('Waiting for the 2099-11-20 receipt cutoff to end')).toBeInTheDocument();
 expect(screen.queryByText(/approval issues/)).toBeNull();
 expect(navigate).toHaveBeenCalledWith({tab:'payroll',cycleId:'future'});
});

it('refreshes remote work after an edit lock clears without replacing work during editing',async()=>{
 const stop=liveUpdates.start('review-test:OWNER');let release:(()=>void)|undefined;
 try {
  let reference='Original work';
  h.action.mockImplementation(async op=>op==='intakeWorkspace'?{intakes:[{id:'s',status:'OPEN',reference,documentReceivedOn:'2026-10-01',rowCount:0,completedRows:0,needsReview:1}],settlements:[]}:op==='payrollWorkspace'?{cycles:[]}:{departures:[],adjustments:[],earnings:[]});
  const view=render(<CommissionWorkQueue data={data} onAccessDenied={vi.fn()}/>);await screen.findByText('Original work');
  release=liveUpdates.acquireBlock('edit');reference='Updated by another Owner';
  act(()=>liveUpdates.invalidate(['OWNER']));
  await act(async()=>{await new Promise(r=>setTimeout(r,150));});
  expect(screen.queryByText('Updated by another Owner')).toBeNull();expect(screen.getByText('Original work')).toBeInTheDocument();
  act(()=>release!());release=undefined;await screen.findByText('Updated by another Owner');view.unmount();
 } finally {release?.();stop();}
});
