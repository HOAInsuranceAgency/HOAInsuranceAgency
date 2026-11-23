import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CommissionOverview } from '../../../shared/commissions';
import { commissionPolicy } from '../test/commissionFixtures';
const h = vi.hoisted(() => ({list:vi.fn(),action:vi.fn()}));
vi.mock('../lib/client', () => ({client:{models:{Policy:{list:h.list}}},friendlyError:(e:Error)=>e.message}));
vi.mock('../lib/commissions', () => ({commissionWorkflowAction:h.action}));
vi.mock('../lib/communications', () => ({communicationRequest:vi.fn()}));
vi.mock('./CommissionPlanSettings', () => ({default:()=>null}));
import CommissionPolicyLink from './CommissionPolicyLink';
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
