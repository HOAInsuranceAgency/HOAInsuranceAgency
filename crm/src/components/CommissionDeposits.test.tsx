import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import CommissionDeposits from './CommissionDeposits';
import { CommissionWorkflowContext } from '../lib/commissionWorkflow';
import type { IntakeWorkspace, StatementIntake } from '../../../shared/commissionIntake';
import type { CommissionDeposit } from '../../../shared/commissionDeposits';
const h=vi.hoisted(()=>({action:vi.fn(),clean:vi.fn()}));
vi.mock('../lib/commissions',()=>({commissionWorkflowAction:h.action}));
vi.mock('../lib/editProtection',()=>({useEditProtection:()=>({requestLeave:(fn:()=>void)=>fn()}),useUnsavedChanges:()=>({markClean:h.clean})}));
const d:CommissionDeposit={id:'d',version:1,payor:'TEST Carrier',reference:'BANK-01',receivedOn:'2026-10-21',totalCents:150000,evidence:'TEST bank trace',status:'AWAITING_REMITTANCE',createdAt:'2026-10-21T12:00:00Z',createdBy:'owner'};
const s={id:'s',version:3,reference:'TEST-STMT',carrierId:'c',carrierName:'TEST Carrier',status:'OPEN',documentReceivedOn:'2026-10-23',totalCents:150000} as StatementIntake;
const props=()=>({workspace:{deposits:[d],intakes:[s],settlements:[],templates:[]} as IntakeWorkspace,carriers:[],refresh:vi.fn().mockResolvedValue(undefined),onError:vi.fn(),openStatement:vi.fn()});
beforeEach(()=>vi.resetAllMocks());
it('keeps matching as a suggestion until the Owner selects and confirms',async()=>{
 const p=props();h.action.mockResolvedValue({ok:true});render(<CommissionDeposits {...p}/>);
 fireEvent.click(screen.getByRole('button',{name:'Review deposit'}));
 expect(screen.getByLabelText('Statement to match')).toHaveValue('');expect(h.action).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Statement to match'),{target:{value:'s'}});
 const confirm=screen.getByRole('button',{name:'Confirm match & continue'});expect(confirm).toBeDisabled();
 fireEvent.click(screen.getByLabelText(/I checked the remittance/));fireEvent.click(confirm);
 await waitFor(()=>expect(p.openStatement).toHaveBeenCalledWith('s'));
 expect(h.action).toHaveBeenCalledWith('recordIntakeSettlement',{id:'s',version:3,depositId:'d',depositVersion:1,confirmed:true});
 expect(screen.getByText(/Saved evidence: TEST bank trace/)).toBeInTheDocument();
});
it('resets match confirmation after the selected statement changes',()=>{
 const p=props();p.workspace.intakes.push({...s,id:'s2',reference:'TEST-STMT-2'});render(<CommissionDeposits {...p}/>);
 fireEvent.click(screen.getByRole('button',{name:'Review deposit'}));fireEvent.change(screen.getByLabelText('Statement to match'),{target:{value:'s'}});fireEvent.click(screen.getByLabelText(/I checked the remittance/));
 fireEvent.change(screen.getByLabelText('Statement to match'),{target:{value:'s2'}});expect(screen.getByRole('button',{name:'Confirm match & continue'})).toBeDisabled();
});
it('opens a new deposit directly, formats currency, and resets confirmation on edits',async()=>{
 const p=props();h.action.mockResolvedValue({depositId:'saved'});render(<CommissionWorkflowContext.Provider value={{target:{tab:'statements',depositId:'new'},navigate:vi.fn()}}><CommissionDeposits {...p}/></CommissionWorkflowContext.Provider>);
 for(const [label,value] of [['Payor shown by bank','TEST Payor'],['Unique bank reference','TEST-NEW'],['Actual deposit date','2026-10-21'],['Deposit amount','1234.50'],['Bank receipt evidence','TEST trace']])fireEvent.change(screen.getByLabelText(label),{target:{value}});
 fireEvent.blur(screen.getByLabelText('Deposit amount'));expect(screen.getByLabelText('Deposit amount')).toHaveValue('$1,234.50');
 fireEvent.click(screen.getByLabelText(/I checked the actual bank/));fireEvent.change(screen.getByLabelText('Unique bank reference'),{target:{value:'TEST-NEW-2'}});expect(screen.getByRole('button',{name:'Save deposit for matching'})).toBeDisabled();
 fireEvent.click(screen.getByLabelText(/I checked the actual bank/));fireEvent.click(screen.getByRole('button',{name:'Save deposit for matching'}));
 await waitFor(()=>expect(h.action).toHaveBeenCalledWith('recordUnmatchedDeposit',expect.objectContaining({totalCents:123450,receivedOn:'2026-10-21',reference:'TEST-NEW-2',confirmed:true})));
});
it('requires a reason and fresh explicit confirmation to resolve without commission',async()=>{
 const p=props();h.action.mockResolvedValue({ok:true});render(<CommissionDeposits {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Review deposit'}));
 fireEvent.change(screen.getByLabelText('Resolution'),{target:{value:'NO_EMPLOYEE_COMMISSION'}});const button=screen.getByRole('button',{name:'Save deposit resolution'});expect(button).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Reason and supporting evidence'),{target:{value:'TEST reimbursement'}});fireEvent.click(screen.getByLabelText(/I confirm this resolution/));fireEvent.click(button);
 await waitFor(()=>expect(h.action).toHaveBeenCalledWith('resolveUnmatchedDeposit',expect.objectContaining({status:'NO_EMPLOYEE_COMMISSION',reason:'TEST reimbursement',confirmed:true})));
});
it('keeps an unmatched deposit visible when there are no valid statement candidates',()=>{
 const p=props();p.workspace.intakes=[];render(<CommissionDeposits {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Review deposit'}));
 expect(screen.getByText(/No statement currently fits/)).toBeInTheDocument();expect(h.action).not.toHaveBeenCalled();
});
