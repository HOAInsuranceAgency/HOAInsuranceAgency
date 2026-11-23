import { expect, it, vi } from 'vitest';
import { policySearchTerms, searchPolicyPages } from './commissionPolicySearch';

it('continues through empty filtered pages to a matching policy', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({data:[],nextToken:'second'})
    .mockResolvedValueOnce({data:[],nextToken:'third'})
    .mockResolvedValueOnce({data:[{id:'match',policyNumber:'BIP-A123456-26-42'}]});
  expect((await searchPolicyPages(fetch)).data).toEqual([{id:'match',policyNumber:'BIP-A123456-26-42'}]);
  expect(fetch.mock.calls).toEqual([[undefined],['second'],['third']]);
});
it('retains a bounded continuation without declaring the search exhausted', async () => {
  let page=0;
  const fetch = vi.fn(async () => ({data:[],nextToken:'page-'+(++page)}));
  expect(await searchPolicyPages(fetch)).toEqual({data:[],nextToken:'page-10'});
  expect(fetch).toHaveBeenCalledTimes(10);
});
it('rejects later-page errors and repeated cursors instead of returning no matches', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({data:[],nextToken:'second'})
    .mockResolvedValueOnce({data:[],errors:[{message:'Not authorized',errorType:'Unauthorized'}]});
  await expect(searchPolicyPages(fetch)).rejects.toThrow('Not authorized');
  await expect(searchPolicyPages(async () => ({data:[],nextToken:'repeat'}))).rejects.toThrow('repeated');
});
it('searches the core policy number without automatically choosing a policy or dropping leading zeroes', () => {
  expect(policySearchTerms('A123456 BIP')).toContain('A123456');
  expect(policySearchTerms('BIP-A123456-26-42')).toContain('A123456');
  expect(policySearchTerms('0123456789 LB')).toContain('0123456789');
  expect(policySearchTerms('POL-1')).toEqual(['POL-1']);
  expect(policySearchTerms('A123456 B987654')).toEqual(['A123456 B987654']);
});
