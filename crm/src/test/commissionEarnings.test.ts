import { beforeEach, expect, it, vi } from 'vitest';
import { commissionPolicy } from './commissionFixtures';
import { receiptEarningId, type CommissionAllocation } from '../../../shared/commissionExceptions';
const h=vi.hoisted(()=>({getMany:vi.fn(),list:vi.fn()}));
vi.mock('../../amplify/functions/commissions/store',()=>({getMany:h.getMany,list:h.list}));
import { policyReceiptEarnings, workspaceEarnings } from '../../amplify/functions/commissions/earnings';
beforeEach(()=>vi.resetAllMocks());
it('does not read any earnings for a policy without shared receipts',async()=>{
  expect(await policyReceiptEarnings([commissionPolicy()])).toEqual([]);
  expect(h.getMany).not.toHaveBeenCalled();
});
it('uses exact policy, receipt and employee identities and refuses missing history',async()=>{
  const p=commissionPolicy();p.allocations=[{id:'split',participants:[{producerId:'employee'}]} as CommissionAllocation];
  p.entries=[{id:'receipt',allocationId:'split'} as typeof p.entries[number]];
  const id=receiptEarningId(p.id,'receipt','employee');
  h.getMany.mockResolvedValue([{id,policyId:p.id}]);
  expect(await policyReceiptEarnings([p,p])).toEqual([{id,policyId:p.id}]);
  expect(h.getMany).toHaveBeenCalledExactlyOnceWith([{kind:'EARNING',id}]);
  h.getMany.mockResolvedValue([]);
  await expect(policyReceiptEarnings([p])).rejects.toThrow(/history is incomplete/);
});

it('keeps complete policy-scoped snapshots above 5000 agency earnings without scanning the partition',async()=>{
  const policies=Array.from({length:2},(_,i)=>{
    const p=commissionPolicy();p.id='policy-'+i;
    p.allocations=[{id:'split',participants:[{producerId:'employee'}]} as CommissionAllocation];
    p.entries=Array.from({length:2501},(_,j)=>({id:'r'+j,allocationId:'split'} as typeof p.entries[number]));return p;
  });
  h.getMany.mockImplementation(async refs=>refs.map((r:{id:string})=>({id:r.id})));
  expect(await workspaceEarnings(policies,[])).toHaveLength(5002);
  expect(h.getMany.mock.calls.map(([refs])=>refs.length)).toEqual([5000,2]);
  expect(h.list).not.toHaveBeenCalled();
});
it('does not return partial totals when a referenced adjustment is missing or a policy read fails',async()=>{
  h.getMany.mockResolvedValue([]);
  await expect(workspaceEarnings([], [{id:'a',status:'APPROVED'} as any])).rejects.toThrow(/incomplete/);
  const p=commissionPolicy();p.allocations=[{id:'split',participants:[{producerId:'employee'}]} as CommissionAllocation];p.entries=[{id:'r',allocationId:'split'} as typeof p.entries[number]];
  h.getMany.mockRejectedValue(new Error('Throttled incomplete read'));
  await expect(workspaceEarnings([p],[])).rejects.toThrow(/incomplete read/);
});

it('fills existing batch reads across many small policy histories',async()=>{
  const policies=Array.from({length:1000},(_,i)=>{
    const p=commissionPolicy();p.id='policy-'+i;
    p.allocations=[{id:'split',participants:[{producerId:'employee'}]} as CommissionAllocation];
    p.entries=[{id:'r',allocationId:'split'} as typeof p.entries[number]];return p;
  });
  h.getMany.mockImplementation(async refs=>refs.map((r:{id:string})=>({id:r.id})));
  expect(await policyReceiptEarnings(policies)).toHaveLength(1000);
  expect(h.getMany).toHaveBeenCalledTimes(1);
  expect(h.getMany.mock.calls[0][0]).toHaveLength(1000);
});
