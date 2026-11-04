import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Communication } from '../../../shared/leadWorkflow';
import type { BusinessDeliveryPreview, PrepareBusinessDraftInput } from '../../../shared/frontBusinessDelivery';
const h=vi.hoisted(()=>({rows:new Map<string,any>(),models:new Map<string,any>(),objects:new Map<string,Uint8Array>(),messages:new Map<string,any>(),front:vi.fn(),pdf:vi.fn(),identity:vi.fn(),enabled:vi.fn(),recipients:vi.fn(),attachment:vi.fn(),beforeCommit:undefined as undefined|(()=>void),posts:0}));
vi.mock('@aws-sdk/client-s3',()=>({S3Client:class{async send(command:any){const p=command.input;if(command.constructor.name==='PutObjectCommand'){h.objects.set(p.Key,new Uint8Array(p.Body));return{};}const body=h.objects.get(p.Key);if(!body)throw new Error('Missing object');return{ContentLength:body.length,Body:{transformToByteArray:async()=>body}};}},GetObjectCommand:class GetObjectCommand{constructor(public input:any){}},PutObjectCommand:class PutObjectCommand{constructor(public input:any){}}}));
vi.mock('../../amplify/functions/communications/config',()=>({config:async()=>({environment:'main'})}));
vi.mock('../../amplify/functions/communications/producerEmail',()=>({resolveProducerEmail:h.identity}));
vi.mock('../../amplify/functions/communications/workflow',()=>({enabledUser:h.enabled,accountRows:async(accountId:string,kind:string)=>[...h.rows.values()].filter(r=>r.accountId===accountId && r.kind===kind)}));
vi.mock('../../amplify/functions/crm-access/user-status',()=>({activeTeamUserCheck:(id:string)=>({ConditionCheck:{TableName:'UserAccess',Key:{userId:id}}})}));
vi.mock('../../amplify/functions/communications/businessProposalPdf',()=>({createBusinessProposalPdf:h.pdf}));
vi.mock('../../amplify/functions/communications/attachments',()=>({downloadFrontAttachment:h.attachment}));
vi.mock('../../amplify/functions/communications/providers',async original=>({...await original<typeof import('../../amplify/functions/communications/providers')>(),front:h.front,assertRecipient:h.recipients,permittedConversation:async(id:string)=>({id:id==='cnv_old'?'cnv_client':id})}));
vi.mock('../../amplify/functions/communications/data',()=>({dataClient:async()=>({models:Object.fromEntries(['Account','Quote','Carrier','Document','Certificate'].map(model=>[model,{get:async({id}:{id:string})=>({data:h.models.get(`${model}:${id}`)}),listDocumentByEntityId:async({entityId}:{entityId:string})=>({data:[...h.models.entries()].filter(([key,value])=>key.startsWith('Document:') && value.entityId===entityId).map(([,v])=>v)})}]))})}));
vi.mock('../../amplify/functions/communications/store',async original=>{
  const actual=await original<typeof import('../../amplify/functions/communications/store')>();
  const execute=async(writes:any[])=>{
    const callback=h.beforeCommit;h.beforeCommit=undefined;callback?.();
    for(const write of writes){const w=write.Put ?? write.ConditionCheck ?? write.Update;if(w.TableName==='UserAccess')continue;
      const old=w.TableName==='Communication'?h.rows.get(w.Item?.id ?? w.Key?.id):h.models.get(`${w.TableName}:${w.Key?.id}`);
      const failed=w.ConditionExpression==='attribute_not_exists(id)'?!!old:w.ExpressionAttributeValues?.[':v']!==undefined?old?.version!==w.ExpressionAttributeValues[':v']:w.ExpressionAttributeValues?.[':at']!==undefined && write.ConditionCheck?old?.updatedAt!==w.ExpressionAttributeValues[':at']:write.Update?old?.updatedAt!==w.ExpressionAttributeValues[':old']:false;
      if(failed)throw Object.assign(new Error('Conflict'),{name:'ConditionalCheckFailedException'});
    }
    for(const write of writes){if(write.Put)h.rows.set(write.Put.Item.id,structuredClone(write.Put.Item));if(write.Update){const u=write.Update,key=`${u.TableName}:${u.Key.id}`,old=h.models.get(key);h.models.set(key,{...old,presentedAt:old.presentedAt ?? u.ExpressionAttributeValues[':at'],updatedAt:u.ExpressionAttributeValues[':at'],status:'PRESENTED'});}}
  };
  return{...actual,get:async(id:string)=>h.rows.get(id),commit:execute,save:async(next:any,old?:any)=>{await execute([actual.put(next,old)]);return next;},query:async(_index:string,accountId:string)=>({items:[...h.rows.values()].filter(r=>r.kind==='BUSINESS_DELIVERY' && r.accountId===accountId)})};
});
import { row } from '../../amplify/functions/communications/store';
import { packageTerms } from '../../../shared/quotePackages';
import { allowedDocument } from '../../amplify/functions/communications/businessDeliverySources';
import { businessDeliveryContext, previewBusinessDelivery, prepareBusinessDraft, reconcileBusinessDraft, historyBusinessDeliveries, applyBusinessAttempt, deliveryRecipients } from '../../amplify/functions/communications/businessHandoff';
import { ProviderError } from '../../amplify/functions/communications/providers';
const NOW='2026-11-03T16:00:00.000Z',PDF=new TextEncoder().encode('%PDF-1.7 synthetic test artifact');
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const selection={accountId:'a1',kind:'PACKAGE' as const,recordId:'option',conversationId:'NEW'};
const readRows=(kind:string)=>[...h.rows.values()].filter(r=>r.kind===kind);
const prepareInput=(p:BusinessDeliveryPreview,requestId='request_1'):PrepareBusinessDraftInput=>({accountId:'a1',previewId:p.previewId,previewHash:p.previewHash,requestId,to:['client@example.com'],cc:[]});
function sent(commId='msg_draft',at='2026-11-03T17:00:00.000Z'):Communication {
  const m=h.messages.get(commId);m.is_draft=false;m.created_at=Date.parse(at)/1000;
  return{id:`comm:front:${commId}`,provider:'front',providerId:commId,accountId:'a1',conversationId:m.conversation.id,channel:'EMAIL',direction:'OUTBOUND',at,text:m.text,from:'actor@example.com',to:['client@example.com'],actorId:'tea_actor',status:'SENT',frontDraft:false,classification:'SUBSTANTIVE',version:1};
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(NOW));vi.clearAllMocks();h.rows.clear();h.models.clear();h.objects.clear();h.messages.clear();h.posts=0;h.beforeCommit=undefined;
  for(const model of ['ACCOUNT','QUOTE','CARRIER','CERTIFICATE','DOCUMENT'])process.env[`${model}_TABLE`]=model[0]+model.slice(1).toLowerCase();
  process.env.COMMUNICATION_TABLE='Communication';process.env.DOCUMENT_BUCKET='test';
  const account={id:'a1',name:'Willow HOA',updatedAt:NOW,contacts:async()=>({data:[{name:'Current manager',email:'client@example.com',isPrimary:true},{name:'Former manager',email:'former@example.com',validUntil:'2026-11-01'}]}),quotes:async()=>({data:[h.models.get('Quote:q1')]}),certificates:async()=>({data:[...h.models.entries()].filter(([k])=>k.startsWith('Certificate:')).map(([,v])=>v)})};
  h.models.set('Account:a1',account);h.models.set('Quote:q1',{id:'q1',accountId:'a1',carrierId:'c1',status:'QUOTED',premium:1200,commissionPct:15,notes:'PRIVATE NOTES',lines:['Property'],effectiveDate:'2026-12-01',expirationDate:'2027-12-01',updatedAt:NOW});h.models.set('Carrier:c1',{id:'c1',name:'Test Carrier',updatedAt:NOW});
  h.rows.set('workflow:a1',row('WORKFLOW','workflow:a1',{accountId:'a1',salespersonId:'actor'},{accountId:'a1'}));
  h.rows.set('eligibility:actor',row('ELIGIBILITY','eligibility:actor',{userId:'actor',enabled:true,salesperson:false,frontId:'tea_actor'}));
  h.rows.set('commercial:a1',row('COMMERCIAL_PLAN','commercial:a1',{accountId:'a1',version:1,estimatedCents:null,requiredLines:['Property'],options:[{id:'option',name:'Reviewed option',quoteIds:['q1'],reviewed:{at:NOW,by:'actor',terms:{q1:packageTerms(h.models.get('Quote:q1'))}}}],selectedOptionId:null},{accountId:'a1'}));
  h.rows.set('front-link:cnv_client',row('LINK','front-link:cnv_client',{accountId:'a1',purpose:'PROSPECT',conversationId:'cnv_client'},{accountId:'a1'}));
  h.enabled.mockResolvedValue({Enabled:true});h.identity.mockResolvedValue({frontId:'tea_actor',channelId:'cha_personal',senderEmail:'actor@example.com',signatureId:'sig_actor',signatureMode:'FRONT'});h.pdf.mockResolvedValue({bytes:PDF,filename:'Proposal.pdf',contentType:'application/pdf'});h.recipients.mockResolvedValue(undefined);h.attachment.mockResolvedValue(PDF);
  h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{
    if(method==='POST'){
      h.posts++;expect(readRows('BUSINESS_DELIVERY').some(r=>r.data.state==='PREPARING')).toBe(true);expect(body).toBeInstanceOf(FormData);
      const data=body!,messageId=h.posts===1?'msg_draft':`msg_draft${h.posts}`,message={id:messageId,conversation:{id:path.startsWith('/channels/')?'cnv_private':'cnv_client'},is_draft:true,is_inbound:false,type:'email',author:{id:data.get('author_id')},text:String(data.get('body')).replace(/<[^>]*>/g,'\n'),body:data.get('body'),created_at:Date.now()/1000,recipients:[{role:'from',handle:'actor@example.com'},...data.getAll('to[]').map(handle=>({role:'to',handle})),...data.getAll('cc[]').map(handle=>({role:'cc',handle}))],attachments:readRows('BUSINESS_PREVIEW').at(-1)!.data.files.map((f:any,i:number)=>({id:`fil_${i}`,filename:f.name,size:f.size}))};h.messages.set(messageId,message);return message;
    }
    if(path.startsWith('/messages/'))return h.messages.get(path.split('/').pop()!);
    if(path.endsWith('/drafts'))return{_results:[...h.messages.values()].filter(m=>m.is_draft)};
    if(path.includes('/messages'))return{_results:[{id:'msg_in',is_inbound:true,recipients:[{role:'from',handle:'client@example.com'},{role:'to',handle:'actor@example.com'}]}]};
    throw new Error(`Unexpected test Front read ${path}`);
  });
});
afterEach(()=>{vi.useRealTimers();});
describe('reviewed Front business handoff',()=>{
  it('offers current contacts and PDFs even when the preparing actor mailbox is unavailable',async()=>{
    h.identity.mockRejectedValue(new Error('Personal mailbox needs setup'));
    const result=await businessDeliveryContext({accountId:'a1'},'actor');
    expect(result.sender).toBeUndefined();expect(result.senderError).toContain('mailbox');expect(result.recipientSuggestions.map(r=>r.email)).toEqual(['client@example.com']);expect(result.choices[0]).toMatchObject({kind:'PACKAGE',recordId:'option'});expect(h.posts).toBe(0);
  });
  it('freezes one public PDF without leaking commission, notes or private storage paths',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');
    expect(p.attachments[0].sha256).toBe(sha(PDF));expect(p.sender.senderEmail).toBe('actor@example.com');expect(JSON.stringify(p)).not.toContain('PRIVATE NOTES');expect(JSON.stringify(p)).not.toContain('commission');expect(JSON.stringify(p)).not.toContain('business-deliveries/');expect(h.pdf.mock.calls[0][0].quotes[0]).not.toHaveProperty('notes');
    const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a.state).toBe('DRAFT');expect(h.pdf).toHaveBeenCalledTimes(1);expect(h.front.mock.calls.find(c=>c[1]==='POST')![0]).toBe('/channels/cha_personal/drafts');expect(h.rows.has('front-link:cnv_private')).toBe(false);expect(h.models.get('Quote:q1').status).toBe('QUOTED');
  });
  it('replays the exact request without another POST and rejects changed recipients for its ID',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),input=prepareInput(p);const first=await prepareBusinessDraft(input,'actor');expect(await prepareBusinessDraft(input,'actor')).toEqual(first);expect(h.posts).toBe(1);await expect(prepareBusinessDraft({...input,to:['other@example.com']},'actor')).rejects.toThrow('request ID');
  });
  it('accepts explicit CC, validates every recipient and never invents BCC',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');await prepareBusinessDraft({...prepareInput(p),cc:['board@example.com']},'actor');expect(h.recipients.mock.calls.map(c=>c[0])).toEqual(['client@example.com','board@example.com']);const form=h.front.mock.calls.find(c=>c[1]==='POST')![2] as FormData;expect(form.getAll('cc[]')).toEqual(['board@example.com']);expect(form.has('bcc[]')).toBe(false);expect(form.get('quote_body')).toBe('');
  });
  it('canonicalizes existing threads and refuses new recipients in a reply',async()=>{
    const p=await previewBusinessDelivery({...selection,conversationId:'cnv_old'},'actor');expect(p.conversationId).toBe('cnv_client');await expect(prepareBusinessDraft({...prepareInput(p),cc:['holder@example.com']},'actor')).rejects.toThrow('new conversation');expect(h.posts).toBe(0);await prepareBusinessDraft(prepareInput(p),'actor');expect(h.front.mock.calls.find(c=>c[1]==='POST')![0]).toBe('/conversations/cnv_client/drafts');
  });
  it('rejects carrier and cross-account client threads',async()=>{
    h.rows.get('front-link:cnv_client').data.purpose='CARRIER';await expect(previewBusinessDelivery({...selection,conversationId:'cnv_client'},'actor')).rejects.toThrow('linked client');h.rows.get('front-link:cnv_client').data={accountId:'a2',purpose:'PROSPECT'};await expect(previewBusinessDelivery({...selection,conversationId:'cnv_client'},'actor')).rejects.toThrow('linked client');
  });
  it('does not offer a bare quote or an unreviewed package',async()=>{
    await expect(previewBusinessDelivery({...selection,kind:'QUOTE' as any},'actor')).rejects.toThrow('reviewed package');delete h.rows.get('commercial:a1').data.options[0].reviewed;await expect(previewBusinessDelivery(selection,'actor')).rejects.toThrow('reviewed package');expect(h.posts).toBe(0);
  });
  it('rejects expired, foreign-actor, changed-term and changed-mailbox previews before POST',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');await expect(prepareBusinessDraft(prepareInput(p),'other',{admin:true})).rejects.toThrow('preview');vi.setSystemTime(new Date(Date.parse(NOW)+600_000));await expect(prepareBusinessDraft(prepareInput(p),'actor')).rejects.toThrow('expired');vi.setSystemTime(new Date(NOW));h.models.get('Quote:q1').premium=1300;await expect(prepareBusinessDraft(prepareInput(p),'actor')).rejects.toThrow('Review');h.models.get('Quote:q1').premium=1200;h.identity.mockResolvedValue({frontId:'tea_actor',channelId:'cha_other',senderEmail:'other@example.com',signatureId:'sig_actor'});await expect(prepareBusinessDraft(prepareInput(p),'actor')).rejects.toThrow('mailbox changed');expect(h.posts).toBe(0);
  });
  it('fences a concurrent source update before claiming the Front POST',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');h.beforeCommit=()=>{h.models.get('Quote:q1').updatedAt='2026-11-03T16:01:00Z';};await expect(prepareBusinessDraft(prepareInput(p),'actor')).rejects.toThrow('source changed');expect(h.posts).toBe(0);expect(readRows('BUSINESS_DELIVERY')).toHaveLength(0);
  });
  it('fences reassignment during preparation even when Account.updatedAt does not change',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');h.beforeCommit=()=>{const current=h.rows.get('workflow:a1');h.rows.set(current.id,{...current,version:current.version+1,data:{...current.data,salespersonId:'other'}});};
    await expect(prepareBusinessDraft(prepareInput(p),'actor')).rejects.toThrow('source changed');expect(h.models.get('Account:a1').updatedAt).toBe(NOW);expect(h.posts).toBe(0);
  });
  it('uses only server-derived admin access and never trusts an input admin flag',async()=>{
    h.rows.get('workflow:a1').data.salespersonId='other';await expect(previewBusinessDelivery({...selection,admin:true} as any,'actor')).rejects.toThrow('assignment changed');
    const p=await previewBusinessDelivery(selection,'actor',{admin:true});expect((await prepareBusinessDraft(prepareInput(p),'actor',{admin:true})).state).toBe('DRAFT');
  });
  it('holds a timed-out NEW draft UNKNOWN and never blindly retries it',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');h.front.mockImplementation(async()=>{throw new ProviderError('Front timeout',0,true);});const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a.state).toBe('UNKNOWN');expect(await prepareBusinessDraft(prepareInput(p),'actor')).toEqual(a);expect((await reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'actor')).state).toBe('UNKNOWN');expect(h.front).toHaveBeenCalledTimes(1);
  });
  it('records definite Front rejection as a failed attempt without a sent timestamp',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');h.front.mockRejectedValue(new ProviderError('Front returned 403',403,false));const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a).toMatchObject({state:'FAILED'});expect(a.sentAt).toBeUndefined();
  });
  it('requires actual actor, recipient and exact file evidence, then preserves first presentation on resend',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),a=await prepareBusinessDraft(prepareInput(p),'actor');const comm=sent();h.messages.get('msg_draft').recipients.push({role:'cc',handle:'unexpected@example.com'});await applyBusinessAttempt(comm);expect(h.models.get('Quote:q1').status).toBe('QUOTED');h.messages.get('msg_draft').recipients.pop();await applyBusinessAttempt(comm);expect(h.models.get('Quote:q1')).toMatchObject({status:'PRESENTED',presentedAt:comm.at});expect((await historyBusinessDeliveries({accountId:'a1'},'actor')).items[0]).toMatchObject({state:'SENT',sentAt:comm.at});
    vi.setSystemTime(new Date('2026-11-04T16:00:00Z'));const next=await previewBusinessDelivery(selection,'actor'),second=await prepareBusinessDraft(prepareInput(next,'request_2'),'actor');expect(second.state).toBe('DRAFT');const resend=sent(second.frontDraftId!,'2026-11-04T17:00:00Z');await applyBusinessAttempt(resend);expect(h.models.get('Quote:q1').presentedAt).toBe(comm.at);expect((await historyBusinessDeliveries({accountId:'a1'},'actor')).items.filter(a=>a.state==='SENT')).toHaveLength(2);expect(a.frontUrl).toBe('https://app.frontapp.com/open/cnv_private');
  });
  it('marks late failure per attempt while preserving the historical sent timestamp',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),a=await prepareBusinessDraft(prepareInput(p),'actor'),comm=sent();await applyBusinessAttempt(comm);await applyBusinessAttempt({...comm,status:'FAILED'});const result=(await historyBusinessDeliveries({accountId:'a1'},'actor')).items[0];expect(result).toMatchObject({id:a.id,state:'FAILED',sentAt:comm.at});expect(result.failure).toContain('failed');expect(h.models.get('Quote:q1').presentedAt).toBe(comm.at);
  });
  it('a changed package after drafting retains send history without marking current quotes presented',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');await prepareBusinessDraft(prepareInput(p),'actor');h.rows.get('commercial:a1').version++;await applyBusinessAttempt(sent());expect(h.models.get('Quote:q1').status).toBe('QUOTED');expect((await historyBusinessDeliveries({accountId:'a1'},'actor')).items[0]).toMatchObject({state:'SENT',failure:expect.stringContaining('changed')});
  });
  it('reconciles a known private draft without traversing or importing its private inbox',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),a=await prepareBusinessDraft(prepareInput(p),'actor');h.front.mockClear();expect((await reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'actor')).state).toBe('DRAFT');expect(h.front.mock.calls.map(c=>c[0])).toEqual(['/messages/msg_draft']);await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'other')).rejects.toThrow('assignment changed');sent();expect((await reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'actor')).state).toBe('SENT');
  });
  it('does not reuse one attachment to verify two equal-name/equal-size carrier files',async()=>{
    for(const id of ['d1','d2']){const key=`documents/ACCOUNT/a1/${id}/carrier.pdf`;h.models.set(`Document:${id}`,{id,entityType:'ACCOUNT',entityId:'a1',name:'Carrier.pdf',contentType:'application/pdf',s3Key:key,updatedAt:NOW});h.objects.set(key,PDF);}
    const p=await previewBusinessDelivery({...selection,documentIds:['d1','d2']},'actor');await prepareBusinessDraft(prepareInput(p),'actor');
    const comm=sent();h.attachment.mockImplementation(async(id:string)=>id==='fil_2'?new TextEncoder().encode('%PDF-1.7 replaced test artifact'):PDF);
    await applyBusinessAttempt(comm);expect(h.models.get('Quote:q1').status).toBe('QUOTED');expect((await historyBusinessDeliveries({accountId:'a1'},'actor')).items[0].state).toBe('DRAFT');
    h.attachment.mockResolvedValue(PDF);await applyBusinessAttempt(comm);expect(h.models.get('Quote:q1').status).toBe('PRESENTED');
  });
  it('reconciles an ambiguous reply using only the known conversation without creating another draft',async()=>{
    const p=await previewBusinessDelivery({...selection,conversationId:'cnv_client'},'actor'),implementation=h.front.getMockImplementation()!;
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST')throw new ProviderError('Lost response',0,true);return result;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a.state).toBe('UNKNOWN');expect((await reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'actor')).state).toBe('DRAFT');expect(h.posts).toBe(1);
  });
  it('keeps a verified draft ID for review when Front content differs from the preview',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),implementation=h.front.getMockImplementation()!;
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST')result.recipients.push({role:'cc',handle:'unexpected@example.com'});return result;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a).toMatchObject({state:'UNKNOWN',frontDraftId:'msg_draft',frontUrl:'https://app.frontapp.com/open/cnv_private'});expect(a.failure).toContain('recipients');expect(h.models.get('Quote:q1').status).toBe('QUOTED');
  });
  it('allows safe validation recovery but never unlocks an existing request conflict',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),input=prepareInput(p);await expect(prepareBusinessDraft({...input,to:[]},'actor')).rejects.toHaveProperty('code','BUSINESS_DRAFT_NOT_DISPATCHED');await prepareBusinessDraft(input,'actor');
    try{await prepareBusinessDraft({...input,to:[]},'actor');throw new Error('Expected conflict');}catch(error){expect(error).not.toHaveProperty('code');}
  });
  it('concurrent exact prepare calls claim only one Front draft',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),input=prepareInput(p);await Promise.all([prepareBusinessDraft(input,'actor'),prepareBusinessDraft(input,'actor')]);expect(h.posts).toBe(1);expect(readRows('BUSINESS_DELIVERY')).toHaveLength(1);
  });
  it('durably blocks a different request after an unresolved outcome, independent of paginated history',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');h.front.mockRejectedValue(new ProviderError('Timeout',0,true));await prepareBusinessDraft(prepareInput(p),'actor');h.front.mockClear();
    const p2=await previewBusinessDelivery(selection,'actor');await expect(prepareBusinessDraft(prepareInput(p2,'other_request'),'actor')).rejects.toThrow('earlier draft attempt');expect(h.front).not.toHaveBeenCalled();expect(readRows('BUSINESS_DELIVERY')).toHaveLength(1);
  });
  it('concurrent different request IDs/previews cannot both claim one target',async()=>{
    const p1=await previewBusinessDelivery(selection,'actor'),p2=await previewBusinessDelivery(selection,'actor');const results=await Promise.allSettled([prepareBusinessDraft(prepareInput(p1,'first'),'actor'),prepareBusinessDraft(prepareInput(p2,'second'),'actor')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(h.posts).toBe(1);expect(readRows('BUSINESS_TARGET')).toHaveLength(1);expect(readRows('BUSINESS_DELIVERY')).toHaveLength(1);
  });
  it('does not regress a concurrent SENT receipt when capture of the draft response conflicts',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');h.attachment.mockImplementation(async()=>{const current=readRows('BUSINESS_DELIVERY')[0];if(current?.data.state==='PREPARING')h.rows.set(current.id,{...current,version:current.version+1,data:{...current.data,state:'SENT',sentAt:NOW,frontMessageId:'msg_draft'}});return PDF;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a).toMatchObject({state:'SENT',sentAt:NOW});expect(h.posts).toBe(1);
  });
  it('retains known sent history if the old draft ID later returns 404',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),a=await prepareBusinessDraft(prepareInput(p),'actor'),comm=sent();await applyBusinessAttempt(comm);h.front.mockRejectedValue(new ProviderError('Not found',404,false));
    expect(await reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'actor')).toMatchObject({state:'SENT',sentAt:comm.at});
  });
  it('fences a concurrent package edit when projecting quote presentation, then retries as historical sending only',async()=>{
    const p=await previewBusinessDelivery(selection,'actor');await prepareBusinessDraft(prepareInput(p),'actor');const comm=sent();h.beforeCommit=()=>{h.rows.get('commercial:a1').version++;};
    await expect(applyBusinessAttempt(comm)).rejects.toThrow('Conflict');expect(h.models.get('Quote:q1').status).toBe('QUOTED');await applyBusinessAttempt(comm);expect((await historyBusinessDeliveries({accountId:'a1'},'actor')).items[0].state).toBe('SENT');expect(h.models.get('Quote:q1').status).toBe('QUOTED');
  });
  it('recovers an UNKNOWN NEW draft by exact user-supplied ID without another POST or inbox scan',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),implementation=h.front.getMockImplementation()!;
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST')throw new ProviderError('Lost response',0,true);return result;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a).toMatchObject({state:'UNKNOWN',conversationId:'NEW'});h.front.mockClear();
    const recovered=await reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor');expect(recovered).toMatchObject({state:'DRAFT',frontDraftId:'msg_draft',conversationId:'cnv_private'});expect(h.front.mock.calls.every(c=>c[0]==='/messages/msg_draft')).toBe(true);expect(h.posts).toBe(1);
  });
  it('refuses recovery IDs with wrong account, author, recipient or file bytes',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),a=await prepareBusinessDraft(prepareInput(p),'actor'),message=h.messages.get('msg_draft');message.author.id='tea_other';await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor')).rejects.toThrow('does not match');message.author.id='tea_actor';h.rows.set('front-link:cnv_private',row('LINK','front-link:cnv_private',{accountId:'foreign',purpose:'PROSPECT'}));await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor')).rejects.toThrow('does not match');h.rows.delete('front-link:cnv_private');message.recipients.push({role:'cc',handle:'other@example.com'});await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor')).rejects.toThrow('does not match');message.recipients.pop();h.attachment.mockResolvedValue(new TextEncoder().encode('%PDF-wrong'));await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor')).rejects.toThrow('does not match');
  });
  it('projects recovered failed Front draft using the freshly saved attempt version',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),implementation=h.front.getMockImplementation()!;
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST')throw new ProviderError('Lost response',0,true);return result;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');h.messages.get('msg_draft').error_type='send_failed';
    expect(await reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor')).toMatchObject({state:'FAILED',frontDraftId:'msg_draft'});expect(h.posts).toBe(1);
  });
  it('lets a trusted admin recover an offboarded preparer without changing sender or scanning their inbox',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),implementation=h.front.getMockImplementation()!;
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST')throw new ProviderError('Lost response',0,true);return result;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');h.rows.get('workflow:a1').data.salespersonId='other';h.enabled.mockImplementation(async(id:string)=>{if(id==='actor')throw new Error('Disabled old preparer');return{Enabled:true};});
    await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'actor')).rejects.toThrow('assignment changed');
    await expect(reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft',admin:true} as any,'other')).rejects.toThrow('unavailable');
    h.front.mockClear();const recovered=await reconcileBusinessDraft({accountId:'a1',attemptId:a.id,recoveryMessageId:'msg_draft'},'owner',{admin:true});expect(recovered).toMatchObject({state:'DRAFT',from:'actor@example.com'});expect(h.front.mock.calls.every(c=>c[0]==='/messages/msg_draft')).toBe(true);expect(h.identity.mock.calls.at(-1)![0]).toMatchObject({userId:'actor',frontId:'tea_actor',frontChannelId:'cha_personal'});expect(h.rows.get(a.id).data).toMatchObject({actor:'actor',lastCheckedBy:'owner'});
    h.rows.set('eligibility:other',row('ELIGIBILITY','eligibility:other',{userId:'other',enabled:true,frontId:'tea_other'}));h.identity.mockResolvedValue({frontId:'tea_other',channelId:'cha_other',senderEmail:'other@example.com',signatureId:'sig_other'});
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST')result.recipients[0].handle='other@example.com';return result;});
    const p2=await previewBusinessDelivery(selection,'other');expect((await prepareBusinessDraft(prepareInput(p2,'other_request'),'other')).state).toBe('DRAFT');expect(h.posts).toBe(2);
  });
  it('accepts documented draft_mode responses and a recovered sent message with HTML-only body',async()=>{
    const p=await previewBusinessDelivery(selection,'actor'),implementation=h.front.getMockImplementation()!;
    h.front.mockImplementation(async(path:string,method='GET',body?:FormData)=>{const result=await implementation(path,method,body);if(method==='POST'){delete result.is_draft;result.draft_mode='private';}return result;});
    const a=await prepareBusinessDraft(prepareInput(p),'actor');expect(a.state).toBe('DRAFT');const message=h.messages.get('msg_draft');message.draft_mode=null;delete message.text;message.created_at=Date.parse('2026-11-03T17:00:00Z')/1000;expect((await reconcileBusinessDraft({accountId:'a1',attemptId:a.id},'actor')).state).toBe('SENT');
  });
});
describe('PDF/recipient source boundaries',()=>{
  const doc={id:'d1',entityType:'ACCOUNT' as const,entityId:'a1',contentType:'application/pdf',category:'ACORD_FORM' as const};
  it.each(['generated/a2/123-acord125-file.pdf','generated/a1/not-acord.pdf','generated/pf/a1/premium-finance-agreement.pdf','generated/a1/../x.pdf','documents/ACCOUNT/a1/other/file.pdf'])('rejects non-owned generated path %s',s3Key=>{expect(allowedDocument({...doc,s3Key},'a1')).toBe(false);});
  it('accepts only linked account ACORD/PDF paths',()=>{expect(allowedDocument({...doc,s3Key:'generated/a1/123-acord125-file.pdf'},'a1')).toBe(true);expect(allowedDocument({...doc,s3Key:'documents/ACCOUNT/a1/d1/file.pdf'},'a1')).toBe(true);expect(allowedDocument({...doc,s3Key:'generated/a1/123-acord125-file.pdf',category:'OTHER'},'a1')).toBe(false);});
  it.each([[[],[]],[['x@example.com'],['X@example.com']],[['bad@bad..example'],[]],[['name@example.com\nBcc:other@example.com'],[]]])('rejects invalid or duplicate recipient arrays', (to,cc)=>{expect(()=>deliveryRecipients(to,cc)).toThrow();});
  it('rejects an attachment replaced in place after preview',async()=>{
    const key='documents/ACCOUNT/a1/d1/carrier.pdf';h.models.set('Document:d1',{...doc,s3Key:key,name:'Carrier.pdf',sizeBytes:PDF.length,updatedAt:NOW});h.objects.set(key,PDF);const p=await previewBusinessDelivery({...selection,documentIds:['d1']},'actor');h.objects.set(key,new TextEncoder().encode('%PDF-1.7 changed'));await expect(prepareBusinessDraft(prepareInput(p),'actor')).rejects.toThrow('attachment changed');expect(h.posts).toBe(0);
  });
  it('supports a selected ordinary account JPEG document while keeping package attachment choices PDF-only',async()=>{
    const image=new Uint8Array([0xff,0xd8,0xff,0xe0,1,2,3]),key='documents/ACCOUNT/a1/photo/photo.jpg';h.models.set('Document:photo',{...doc,id:'photo',category:'OTHER',s3Key:key,name:'photo.jpg',contentType:'image/jpeg',updatedAt:NOW});h.objects.set(key,image);h.attachment.mockResolvedValue(image);
    const p=await previewBusinessDelivery({accountId:'a1',kind:'DOCUMENT',recordId:'photo'},'actor');expect(p.attachments[0].contentType).toBe('image/jpeg');expect(p.quotes).toEqual([]);expect((await prepareBusinessDraft(prepareInput(p),'actor')).state).toBe('DRAFT');await expect(previewBusinessDelivery({...selection,documentIds:['photo']},'actor')).rejects.toThrow('must be PDFs');
  });
});
