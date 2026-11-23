import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CommissionAccount, CommissionOverview } from '../../../shared/commissions';
import { commissionPolicy } from '../test/commissionFixtures';
const h = vi.hoisted(() => ({list:vi.fn(),action:vi.fn(),team:vi.fn()}));
vi.mock('../lib/client', () => ({client:{models:{Policy:{list:h.list}}},friendlyError:(e:Error)=>e.message}));
vi.mock('../lib/commissions', () => ({commissionWorkflowAction:h.action}));
vi.mock('../lib/communications', () => ({communicationRequest:h.team}));
vi.mock('../lib/commissionEditProtection', () => ({useCommissionUnsavedChanges:()=>({markClean:vi.fn()})}));
vi.mock('./CommissionPlanSettings', () => ({default:()=>null}));
import CommissionPolicyLink from './CommissionPolicyLink';
import { AccountClassificationResource } from '../features/commissions/AccountClassifications';
const data={policies:[{...commissionPolicy(),policyNumber:'BIP-A123456-26-42'}],plans:[],carriers:[],batches:[],statements:[]} as unknown as CommissionOverview;
beforeEach(()=>vi.resetAllMocks());
function mount() {
  const adopted=vi.fn(),denied=vi.fn();
  render(<CommissionPolicyLink policyNumber="A123456 BIP" carrierId="c" data={data}
    refresh={vi.fn().mockResolvedValue(undefined)} adopted={adopted} denied={denied} renderAccountSetup={()=>null}/>);
  return {adopted,denied};
}
it('finds a later matching policy and leaves its selection to the reviewer', async () => {
  h.list.mockResolvedValueOnce({data:[],nextToken:'later'})
    .mockResolvedValueOnce({data:[{id:'p',policyNumber:'BIP-A123456-26-42',effectiveDate:'2026-08-28',expirationDate:'2027-08-28'}]});
  const {adopted}=mount();
  await screen.findByText('BIP-A123456-26-42');
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(h.list).toHaveBeenLastCalledWith(expect.objectContaining({nextToken:'later',filter:{and:[
    {carrierId:{eq:'c'}},{or:[{policyNumber:{contains:'A123456 BIP'}},{policyNumber:{contains:'A123456'}}]}
  ]}}));
  expect(adopted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Use this policy'}));
  expect(adopted).toHaveBeenCalledWith('p');
  expect(h.action).not.toHaveBeenCalled();
});
it('invalidates private state when a later search page denies access', async () => {
  h.list.mockResolvedValueOnce({data:[],nextToken:'later'})
    .mockResolvedValueOnce({data:[],errors:[{message:'Access denied',errorType:'Unauthorized'}]});
  const {denied}=mount();
  await waitFor(()=>expect(denied).toHaveBeenCalled());
  expect(screen.queryByText(/No matching policy found/)).toBeNull();
  expect(screen.queryByRole('button',{name:'Use this policy'})).toBeNull();
});

const savedAccount = (): CommissionAccount => ({
  id: 'a', name: 'Cedar HOA', version: 2, firstBoundOn: '2026-01-01',
  bindingEvidence: 'Original agency binder',
  periods: [{ from: '2020-01-01', classification: 'GIM', evidence: 'Owner verified source' }],
});
async function mountTracking(classification = savedAccount()) {
  let account = classification;
  const adopted = vi.fn();
  h.list.mockResolvedValue({data:[{id:'old',policyNumber:'BIP-A123456-26-42',effectiveDate:'2026-08-28',expirationDate:'2027-08-28'}]});
  h.team.mockResolvedValue({team:[]});
  h.action.mockImplementation(async (operation, input) => {
    if (operation === 'policyIntakeContext') return {
      accountId:'a',accountName:'Cedar HOA',classification:account,suggestedProducerId:'producer',
      boundOn:'2026-08-26',effectiveDate:'2026-08-28',expirationDate:'2027-08-28',premium:10000,
      agencyRate:10,transaction:'NEW',updatedAt:'before',
    };
    if (operation === 'getAccountClassification') return {classification:account,accountName:account.name};
    if (operation === 'saveAccountClassification') {
      account = {...input,name:account.name,version:account.version + 1};
      return {ok:true};
    }
    if (operation === 'adoptPolicy') return {ok:true};
    throw new Error('Unexpected operation: ' + operation);
  });
  const trackingData = {...data,policies:[],plans:[{id:'producer',producerId:'producer',name:'Avery',version:1,terms:[]}]};
  render(<CommissionPolicyLink policyNumber="A123456 BIP" carrierId="c" data={trackingData}
    refresh={vi.fn().mockResolvedValue(undefined)} adopted={adopted} denied={vi.fn()}
    renderAccountSetup={(id,saved)=><AccountClassificationResource id={id} onSaved={saved}/>}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Complete commission tracking'}));
  await screen.findByText('Cedar HOA · commission classification');
  return {adopted};
}
const trackingConfirmation = () => screen.getByRole('checkbox',{name:/I verified the original producer/});
const trackingSave = () => screen.getByRole('button',{name:'Save tracking & use policy'});

it.each([
  {firstBoundOn:undefined,neverBound:true as const},
  {firstBoundOn:undefined},
  {firstBoundOn:'2026-09-01'},
])('opens account history for incomplete or conflicting historical setup: %j', async patch => {
  await mountTracking({...savedAccount(),...patch});
  expect(screen.getByText('Account eligibility & first bind history').closest('details')).toHaveAttribute('open');
  expect(screen.getByRole('combobox',{name:'Account classification 1'})).toHaveValue('GIM');
  fireEvent.click(trackingConfirmation());
  expect(trackingSave()).toBeDisabled();
  expect(h.action.mock.calls.some(([op])=>op==='adoptPolicy')).toBe(false);
});
it('saves original account history inline, preserves policy edits and requires a fresh confirmation', async () => {
  await mountTracking({...savedAccount(),firstBoundOn:undefined,neverBound:true});
  fireEvent.click(screen.getByRole('checkbox',{name:'Correct existing policy details'}));
  fireEvent.change(screen.getByLabelText('Policy premium ($)'),{target:{value:'11000'}});
  fireEvent.click(trackingConfirmation());
  fireEvent.change(screen.getByLabelText('Original account binding history'),{target:{value:'BOUND'}});
  expect(screen.getByLabelText('Account’s original first bind date')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Account’s original first bind date'),{target:{value:'2025-06-01'}});
  fireEvent.change(screen.getByLabelText('First-bind history reference'),{target:{value:'Original agency binder from 2025'}});
  fireEvent.click(screen.getByRole('button',{name:'Save classification'}));
  await screen.findByText('Saved first bind: 2025-06-01');
  expect(screen.getByLabelText('Policy premium ($)')).toHaveValue('11000');
  expect(trackingConfirmation()).not.toBeChecked();
  expect(trackingSave()).toBeDisabled();
  expect(h.action).toHaveBeenCalledWith('saveAccountClassification',expect.objectContaining({
    firstBoundOn:'2025-06-01',bindingEvidence:'Original agency binder from 2025',
    periods:savedAccount().periods,
  }));
  fireEvent.click(trackingConfirmation());
  fireEvent.click(trackingSave());
  await waitFor(()=>expect(h.action).toHaveBeenCalledWith('adoptPolicy',expect.objectContaining({premium:'11000',confirmed:true})));
});
it('keeps valid account history available and confirms receipt-only tracking for just the selected policy', async () => {
  const {adopted} = await mountTracking();
  expect(screen.getByText('Account eligibility & first bind history').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(trackingConfirmation());
  expect(trackingSave()).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox',{name:'Track this policy using actual receipts only'}));
  expect(trackingConfirmation()).not.toBeChecked();
  expect(trackingSave()).toBeDisabled();
  fireEvent.click(trackingConfirmation());
  fireEvent.click(trackingSave());
  await waitFor(()=>expect(adopted).toHaveBeenCalledWith('old'));
  expect(h.action).toHaveBeenCalledWith('adoptPolicy',expect.objectContaining({
    policyId:'old',actualReceiptsOnly:true,confirmed:true,policyUpdatedAt:'before',
  }));
  expect(h.action.mock.calls.some(([op])=>op==='saveCarrier')).toBe(false);
});
