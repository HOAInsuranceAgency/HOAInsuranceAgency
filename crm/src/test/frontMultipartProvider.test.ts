import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn(),authorizationFailed:vi.fn(async()=>60),authorizationRestored:vi.fn(async()=>{})}));
vi.mock('../../amplify/functions/communications/config',()=>({credentials:async()=>({frontToken:'synthetic-unit-token'})}));
vi.mock('../../amplify/functions/communications/budget',()=>({remainingDelay:async()=>0,rememberBudget:async()=>{},authorizationDelay:async()=>0,authorizationFailed:h.authorizationFailed,authorizationRestored:h.authorizationRestored}));
import { providerRequest, front, FrontScopeError, ProviderError } from '../../amplify/functions/communications/providers';
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',h.fetch);h.fetch.mockResolvedValue(new Response('{"id":"msg_test"}',{status:200,headers:{'Content-Type':'application/json'}}));});
afterEach(()=>vi.unstubAllGlobals());
it('lets fetch set the multipart boundary while retaining the actual FormData bytes',async()=>{
  const form=new FormData();form.append('body','Synthetic draft');form.append('attachments[]',new Blob(['test'],{type:'text/plain'}),'test.txt');
  await providerRequest('front','/channels/cha_test/drafts','POST',form);
  const init=h.fetch.mock.calls[0][1];expect(init.body).toBe(form);expect(init.headers).not.toHaveProperty('Content-Type');expect(init.headers.Accept).toBe('application/json');expect(init.redirect).toBe('manual');
});
it('preserves JSON request encoding for all existing operations',async()=>{
  await providerRequest('front','/conversations/cnv_test/comments','POST',{body:'Synthetic note'});
  const init=h.fetch.mock.calls[0][1];expect(init.body).toBe('{"body":"Synthetic note"}');expect(init.headers['Content-Type']).toBe('application/json');
});
it.each(['/messages/msg_private','/conversations/cnv_private','/conversations/cnv_private/drafts','/conversations/cnv_private/messages?limit=100'])('keeps denied scoped GET %s out of the global authorization hold',async path=>{
  h.fetch.mockResolvedValue(new Response('{}',{status:403}));
  await expect(front(path,'GET',undefined,{resourceScoped:true})).rejects.toBeInstanceOf(FrontScopeError);
  expect(h.authorizationFailed).not.toHaveBeenCalled();expect(h.authorizationRestored).not.toHaveBeenCalled();expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('retains global credential failure handling for a scoped GET returning 401',async()=>{
  h.fetch.mockResolvedValue(new Response('{}',{status:401}));
  await expect(front('/messages/msg_private','GET',undefined,{resourceScoped:true})).rejects.toMatchObject({status:401});
  expect(h.authorizationFailed).toHaveBeenCalledWith('front',expect.any(String));expect(h.authorizationFailed).toHaveBeenCalledTimes(1);
});
it('preserves resource-local 403 handling when a known conversation redirects to its canonical ID',async()=>{
  h.fetch.mockResolvedValueOnce(new Response('',{status:301,headers:{location:'/conversations/cnv_canonical'}})).mockResolvedValueOnce(new Response('{}',{status:403}));
  await expect(front('/conversations/cnv_alias','GET',undefined,{resourceScoped:true})).rejects.toBeInstanceOf(FrontScopeError);expect(h.fetch).toHaveBeenCalledTimes(2);expect(h.authorizationFailed).not.toHaveBeenCalled();
});
it('retains ordinary global 403 handling when no resource scope is requested',async()=>{
  h.fetch.mockResolvedValue(new Response('{}',{status:403}));
  await expect(front('/messages/msg_private')).rejects.toBeInstanceOf(ProviderError);expect(h.authorizationFailed).toHaveBeenCalledTimes(1);
});
it.each(['https://untrusted.example/messages/msg_private','/conversations','/messages/search','/teammates/tea_private/channels','/conversations/cnv_private/inboxes'])('rejects a broader or untrusted scoped route %s before fetching',async path=>{
  await expect(front(path,'GET',undefined,{resourceScoped:true})).rejects.toThrow('Untrusted Front scoped');expect(h.fetch).not.toHaveBeenCalled();expect(h.authorizationFailed).not.toHaveBeenCalled();
});
it('never applies GET resource-denial semantics to a mutation',async()=>{
  await expect(front('/conversations/cnv_private/drafts','POST',{}, {resourceScoped:true})).rejects.toThrow('Untrusted Front scoped');expect(h.fetch).not.toHaveBeenCalled();
});
