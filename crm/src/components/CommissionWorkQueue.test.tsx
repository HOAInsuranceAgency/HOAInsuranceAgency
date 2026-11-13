import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { beforeEach,it,expect,vi } from 'vitest';
import type { CommissionOverview } from '../../../shared/commissions';
import CommissionWorkQueue from './CommissionWorkQueue';
import { CommissionWorkflowContext } from '../lib/commissionWorkflow';
const h=vi.hoisted(()=>({action:vi.fn()}));
vi.mock('../lib/commissions',()=>({commissionAction:h.action}));
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
