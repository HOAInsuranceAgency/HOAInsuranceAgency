import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../amplify/functions/communications/config',()=>({credentials:async()=>({frontToken:'synthetic-unit-token'})}));
vi.mock('../../amplify/functions/communications/budget',()=>({remainingDelay:async()=>0,rememberBudget:async()=>{},authorizationDelay:async()=>0,authorizationFailed:async()=>0,authorizationRestored:async()=>{}}));
import { providerRequest } from '../../amplify/functions/communications/providers';
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
