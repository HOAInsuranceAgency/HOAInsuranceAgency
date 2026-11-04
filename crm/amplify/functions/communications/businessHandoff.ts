import { randomUUID, createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { BusinessDeliveryAttempt, BusinessDeliveryContext, BusinessDeliveryPreview, BusinessDeliverySelection, BusinessDeliverySender, PrepareBusinessDraftInput, ReconcileBusinessDraftInput } from '../../../../shared/frontBusinessDelivery';
import type { Communication, TeamEligibility, LeadWorkflow } from '../../../../shared/leadWorkflow';
import { packageAssessment, packageTerms, type CommercialPlan } from '../../../../shared/quotePackages';
import { agencyDay } from '../../../../shared/leadActionGuidance';
import { currentContacts } from '../../../src/lib/contacts';
import { currentMessage } from '../../../../shared/serviceEvidence';
import { contactProgress } from '../../../../shared/contactProgress';
import { dataClient } from './data';
import { enabledUser, accountRows } from './workflow';
import { resolveProducerEmail } from './producerEmail';
import { front, assertRecipient, permittedConversation, htmlEscape, messageConversation, ProviderError, type FrontMessage } from './providers';
import { get, row, save, commit, put, check, absent, hash, canonical, query, conflict, type Row, type Write } from './store';
import { activeTeamUserCheck } from '../crm-access/user-status';
import { downloadFrontAttachment } from './attachments';
import { allowedDocument, deliveryAccount, deliveryId, loadDeliverySource, deliverySourceChecks, businessValidation, type Quote, type Document } from './businessDeliverySources';
import { createBusinessProposalPdf } from './businessProposalPdf';

const s3 = new S3Client(), MAX = 25 * 1024 * 1024;
interface FrozenFile { id: string; name: string; key: string; contentType: string; size: number; sha256: string; sourceKey?: string; }
interface PreviewRecord { actor: string; preview: BusinessDeliveryPreview; sourceFingerprint: string; files: FrozenFile[]; reference: string; memberVersion: number; allowedRecipients: string[]; commercialVersion?:number; }
interface AttemptRecord extends BusinessDeliveryAttempt { actor: string; previewId: string; previewHash: string; requestHash: string; reference: string; facts: string[]; files: FrozenFile[]; quoteTerms: Record<string,string>; sender: BusinessDeliverySender; sourceFingerprint: string; frontMessageId?: string; lastCheckedBy?:string; lastCheckedAt?:string; }
interface TargetPointer { accountId:string; kind:string; recordId:string; attemptId:string; }
interface MessagePointer { accountId:string; attemptId:string; }
interface ServerAccess { admin: boolean; }
async function accountAccess(accountId:string,actor:string,access:ServerAccess) {
  const workflow=await get<LeadWorkflow>(`workflow:${accountId}`);
  if(!access.admin && workflow?.data.salespersonId!==actor)throw businessValidation('Account assignment changed. Refresh the account before preparing a draft');
  if(await get(`deleted-account:${accountId}`))throw businessValidation('This account is unavailable');
  return workflow;
}
const openUrl = (id: string) => /^cnv_[a-z0-9]+$/.test(id) ? `https://app.frontapp.com/open/${id}` : undefined;
const fileHash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const cleanName = (value: string) => value.replace(/[\\/\x00-\x1f]/g,'_').slice(0,180) || 'document.pdf';
const senderDto = (s: BusinessDeliverySender):BusinessDeliverySender => ({frontId:s.frontId,channelId:s.channelId,senderEmail:s.senderEmail,signatureId:s.signatureId});
// These exact IDs have already passed the account/attempt boundary. A denied
// private read must not start a token-wide authorization hold for shared mail.
const businessFrontRead=<T = Record<string,unknown>>(path:string)=>front<T>(path,'GET',undefined,{resourceScoped:true});
/** Front's documented Core response uses draft_mode; older receipts expose is_draft. */
function draftState(message:FrontMessage):boolean|undefined {
  const mode=message.draft_mode==='private' || message.draft_mode==='shared'?true:message.draft_mode===null?false:undefined;
  if(typeof message.is_draft==='boolean')return mode!==undefined && mode!==message.is_draft?undefined:message.is_draft;
  return mode;
}
// Front may report whole seconds even though the local intent records milliseconds.
function notBeforePreparation(preparedAt:string,sentSeconds:number):boolean {
  const preparedSeconds=Date.parse(preparedAt)/1000;
  return Number.isFinite(preparedSeconds) && Number.isFinite(sentSeconds) && Math.floor(sentSeconds)>=Math.floor(preparedSeconds);
}
/** Receipt time is business evidence, not the optimistic-lock version of a later edit. */
export function quoteProjectionTimestamp(updatedAt:string):string {
  const previous=Date.parse(updatedAt);
  if(!Number.isFinite(previous))throw new Error('The current quote update version could not be verified');
  return new Date(Math.max(Date.now(),previous+1)).toISOString();
}
async function sender(actor:string) {
  await enabledUser(actor);
  const member=await get<TeamEligibility>(`eligibility:${actor}`);
  if(!member || member.data.userId!==actor || !member.data.enabled)throw businessValidation('Connect your personal Front mailbox in Team settings before preparing a draft');
  return {member,sender:senderDto(await resolveProducerEmail(member.data))};
}
async function bytes(key:string,contentType='application/pdf') {
  if(!process.env.DOCUMENT_BUCKET)throw businessValidation('Document storage is not configured');
  const object=await s3.send(new GetObjectCommand({Bucket:process.env.DOCUMENT_BUCKET,Key:key}));
  if(!object.Body || !object.ContentLength || object.ContentLength>MAX)throw businessValidation('Choose attachments totalling no more than 25 MB');
  const result=await object.Body.transformToByteArray();
  const header=Buffer.from(result.subarray(0,16)),hex=header.toString('hex');
  const valid=contentType==='application/pdf'?header.subarray(0,5).toString()==='%PDF-':contentType==='image/jpeg'?hex.startsWith('ffd8ff'):contentType==='image/png'?hex.startsWith('89504e470d0a1a0a'):contentType==='image/gif'?/^GIF8[79]a/.test(header.toString()):contentType==='image/tiff'?hex.startsWith('49492a00') || hex.startsWith('4d4d002a'):contentType==='image/webp'?header.subarray(0,4).toString()==='RIFF' && header.subarray(8,12).toString()==='WEBP':contentType.includes('openxmlformats')?hex.startsWith('504b0304'):['text/plain','text/csv','application/csv'].includes(contentType)?!result.includes(0):false;
  if(!result.length || result.length>MAX || !valid)throw businessValidation('The selected attachment does not match its supported file type');
  return result;
}
async function thread(accountId:string,chosen?:string) {
  if(!chosen || chosen==='NEW')return {id:'NEW',label:'New conversation — no quoted history',allowedRecipients:[] as string[],link:undefined as Row<unknown>|undefined};
  const conversation=await permittedConversation(chosen),link=await get<{accountId:string;purpose?:string}>(`front-link:${conversation.id}`);
  if(!link || link.data.accountId!==accountId || link.data.purpose!=='PROSPECT')throw businessValidation('Choose a linked client conversation on this account');
  const handles=new Set<string>(),seen=new Set<string>();let cursor:string|undefined=`/conversations/${conversation.id}/messages?limit=100`;
  for(let page=0;cursor && page<20;page++) {
    const url=new URL(cursor,'https://api2.frontapp.com');
    if(url.pathname!==`/conversations/${conversation.id}/messages` || seen.has(cursor))throw businessValidation('Conversation history could not be verified');
    seen.add(cursor);
    const messages:{_results:FrontMessage[];_pagination?:{next?:string}}=await businessFrontRead(cursor);
    if(!Array.isArray(messages._results))throw businessValidation('Conversation recipients could not be verified');
    for(const message of messages._results)if(draftState(message)!==true)for(const r of message.recipients ?? [])if(['from','to','cc'].includes(r.role) && r.handle.includes('@'))handles.add(r.handle.trim().toLowerCase());
    cursor=messages._pagination?.next;
  }
  if(cursor)throw businessValidation('Conversation history is too large to verify; choose a new conversation');
  return {id:conversation.id,label:`Linked client conversation ${conversation.id}`,allowedRecipients:[...handles],link};
}
export function deliveryRecipients(to:unknown,cc:unknown) {
  if(!Array.isArray(to) || !Array.isArray(cc) || !to.length || to.length+cc.length>20)throw businessValidation('Choose at least one To recipient and no more than 20 To/CC recipients');
  const normalize=(items:unknown[])=>items.map(value=>{
    if(typeof value!=='string' || value!==value.trim() || value.length>254 || /[\x00-\x1f]/.test(value))throw businessValidation('Enter valid individual email addresses');
    const parts=value.split('@'),local=parts[0],domain=parts[1];
    if(parts.length!==2 || !local || local.length>64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !domain || !domain.includes('.') || domain.split('.').some(label=>!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))throw businessValidation('Enter valid individual email addresses');
    return value.toLowerCase();
  });
  const result={to:normalize(to),cc:normalize(cc)};
  if(new Set([...result.to,...result.cc]).size!==result.to.length+result.cc.length)throw businessValidation('Each recipient should appear only once');
  return result;
}
function attemptDto(d:AttemptRecord):BusinessDeliveryAttempt {
  return {id:d.id,requestId:d.requestId,accountId:d.accountId,kind:d.kind,recordId:d.recordId,state:d.state,from:d.from,to:d.to,cc:d.cc,conversationId:d.conversationId,frontDraftId:d.frontDraftId,frontUrl:d.frontUrl,messageUrl:d.messageUrl,preparedAt:d.preparedAt,sentAt:d.sentAt,failure:d.failure,sentWithChanges:d.sentWithChanges};
}
/** Missing personal mailbox setup must not hide available sources or account history. */
export async function businessDeliveryContext(input:{accountId:string},actor:string,access:ServerAccess={admin:false}):Promise<BusinessDeliveryContext> {
  await accountAccess(input.accountId,actor,access);
  const account=await deliveryAccount(input.accountId),client=await dataClient();
  const context:BusinessDeliveryContext={accountId:account.id,accountName:account.name,choices:[],documents:[],conversations:[{id:'NEW',label:'New conversation — no quoted history'}],recipientSuggestions:[]};
  try{context.sender=(await sender(actor)).sender;}catch(error){context.senderError=error instanceof Error?error.message:'Your Front mailbox needs setup';}
  const contacts=[];let token:string|null|undefined;
  do{const page=await account.contacts({nextToken:token,limit:100});if(page.errors?.length)throw businessValidation('Could not load current account contacts');contacts.push(...page.data);token=page.nextToken;}while(token);
  context.recipientSuggestions=currentContacts(contacts).filter(c=>!!c.email).map(c=>({email:c.email!,label:c.name || c.email!}));
  const plan=await get<CommercialPlan>(`commercial:${account.id}`),quotes:Quote[]=[];token=undefined;
  do{const page=await account.quotes({nextToken:token,limit:100});if(page.errors?.length)throw businessValidation('Could not load package quotes');quotes.push(...page.data);token=page.nextToken;}while(token);
  for(const option of plan?.data.options ?? []){
    const assessment=packageAssessment(plan!.data,option,quotes,agencyDay(new Date().toISOString()));
    context.choices.push({kind:'PACKAGE',recordId:option.id,label:option.name,...(!assessment.complete || option.quoteIds.some(id=>!quotes.some(q=>q.id===id && ['QUOTED','PRESENTED'].includes(q.status)))?{disabledReason:'Review the package and current open offers first'}:{})});
  }
  token=undefined;
  do{const page:{data:Document[];errors?:{message:string}[];nextToken?:string|null}=await client.models.Document.listDocumentByEntityId({entityId:account.id},{filter:{entityType:{eq:'ACCOUNT'}},nextToken:token,limit:100});if(page.errors?.length)throw businessValidation('Could not load account PDFs');
    for(const d of page.data)if(allowedDocument(d,account.id)){context.documents.push({id:d.id,name:d.name,contentType:d.contentType!,size:d.sizeBytes ?? undefined,category:d.category ?? undefined});context.choices.push({kind:'DOCUMENT',recordId:d.id,label:d.name});}token=page.nextToken;
  }while(token);
  token=undefined;
  do{const page=await account.certificates({nextToken:token,limit:100});if(page.errors?.length)throw businessValidation('Could not load certificates');for(const cert of page.data)if(cert.s3Key===`certificates/${account.id}/${cert.id}.pdf`)context.choices.push({kind:'CERTIFICATE',recordId:cert.id,label:`Certificate ${cert.certificateNumber ?? cert.id} — ${cert.holderName}`});token=page.nextToken;}while(token);
  for(const link of await accountRows<{conversationId:string;purpose?:string}>(account.id,'LINK'))if(link.data.purpose==='PROSPECT')context.conversations.push({id:link.data.conversationId,label:`Linked client conversation ${link.data.conversationId}`});
  return context;
}
/** Freeze the PDF and selected attachments once; prepare never regenerates them. */
export async function previewBusinessDelivery(input:BusinessDeliverySelection,actor:string,access:ServerAccess={admin:false}):Promise<BusinessDeliveryPreview> {
  const workflow=await accountAccess(input.accountId,actor,access);
  const source=await loadDeliverySource(input),identity=await sender(actor),selected=await thread(input.accountId,input.conversationId);
  const id=`bdp_${randomUUID().replace(/-/g,'')}`,reference=`HOA-${randomUUID().replace(/-/g,'').slice(0,12).toUpperCase()}`,files:FrozenFile[]=[];let total=0;
  const add=async(fileId:string,name:string,data:Uint8Array,sourceKey?:string,contentType='application/pdf')=>{
    total+=data.length;if(total>MAX)throw businessValidation('Choose attachments totalling no more than 25 MB');
    const key=`business-deliveries/${input.accountId}/${id}/${files.length}-${cleanName(name)}`;
    await s3.send(new PutObjectCommand({Bucket:process.env.DOCUMENT_BUCKET,Key:key,Body:data,ContentType:contentType}));
    files.push({id:fileId,name:cleanName(name),key,contentType,size:data.length,sha256:fileHash(data),...(sourceKey?{sourceKey}:{})});
  };
  if(input.kind==='PACKAGE'){const proposal=await createBusinessProposalPdf({account:source.account,packageName:source.packageName!,requiredLines:source.requiredLines,quotes:source.quotes,reference,preparedAt:new Date().toISOString()});await add(`proposal:${input.recordId}`,proposal.filename,proposal.bytes);}
  for(const file of source.files)await add(file.id,file.name,await bytes(file.key,file.contentType),file.key,file.contentType);
  const body=`<h2>${htmlEscape(source.title)}</h2><p>${htmlEscape(source.account.name)}</p>${source.facts.map(f=>`<p>${htmlEscape(f)}</p>`).join('')}<p>${input.kind==='PACKAGE'?'Please review the attached insurance proposal and selected documents. Coverage is subject to the carrier’s terms and confirmation of binding.':'Please review the attached document.'}</p><p>Reference: ${reference}</p>`;
  const preview:BusinessDeliveryPreview={id,previewId:id,previewHash:'',selection:{accountId:input.accountId,kind:input.kind,recordId:input.recordId,conversationId:selected.id,documentIds:input.documentIds ?? []},sender:identity.sender,conversationId:selected.id,conversationLabel:selected.label,subject:source.title,body,facts:source.facts,quotes:source.quotes,attachments:files.map(f=>({id:f.id,name:f.name,contentType:f.contentType,size:f.size,sha256:f.sha256})),warnings:['Nothing has been sent. Review every attachment and recipient in Front before sending.',...(input.kind==='PACKAGE' && source.files.length===0?['No carrier quotation PDFs are selected. The proposal contains recorded terms only; review the carrier quotations before sending.']:[])],expiresAt:new Date(Date.now()+600_000).toISOString()};
  preview.previewHash=hash(canonical({actor,preview,sourceFingerprint:source.fingerprint}));
  const stored=row('BUSINESS_PREVIEW',id,{actor,preview,sourceFingerprint:source.fingerprint,files,reference,memberVersion:identity.member.version,allowedRecipients:selected.allowedRecipients,commercialVersion:source.commercial?.version} satisfies PreviewRecord,{accountId:input.accountId});
  await commit([put(stored),...(workflow?[check(workflow)]:[]),check(identity.member),...deliverySourceChecks(source),absent(`deleted-account:${input.accountId}`),activeTeamUserCheck(actor)]);
  return preview;
}
async function freshPreview(input:PrepareBusinessDraftInput,actor:string) {
  const stored=await get<PreviewRecord>(deliveryId(input.previewId,'preview'));
  if(!stored || stored.accountId!==input.accountId || stored.data.actor!==actor || stored.data.preview.previewHash!==input.previewHash || Date.parse(stored.data.preview.expiresAt)<=Date.now())throw businessValidation('This preview expired or changed. Review a fresh preview before preparing a draft');
  return stored;
}
async function updateAttempt(old:Row<AttemptRecord>,patch:Partial<AttemptRecord>) {
  const next=row('BUSINESS_DELIVERY',old.id,{...old.data,...patch},{accountId:old.accountId,previous:old});await save(next,old);return next;
}
async function sentNeedsReview(id:string,failure:string) {
  const current=await get<AttemptRecord>(id);
  if(!current)throw new Error('This draft attempt is unavailable');
  if(['SENT','FAILED'].includes(current.data.state))return attemptDto(current.data);
  try{return attemptDto((await updateAttempt(current,{state:'UNKNOWN',failure})).data);}catch(error){
    if(conflict(error)){const latest=await get<AttemptRecord>(id);if(latest && ['SENT','FAILED'].includes(latest.data.state))return attemptDto(latest.data);}
    throw error;
  }
}
function originalSender(message:FrontMessage,d:AttemptRecord):boolean {
  const from=(message.recipients ?? []).filter(r=>r.role==='from');
  return message.author?.id===d.sender.frontId && from.length===1 && from[0].handle.toLowerCase()===d.from;
}
/** Resolve only the stored conversation and the returned message's conversation. */
async function knownSentConversation(message:FrontMessage,d:AttemptRecord) {
  const actualId=messageConversation(message);
  if(message.id!==d.frontDraftId || !actualId || !/^cnv_[a-z0-9]+$/.test(d.conversationId) || !originalSender(message,d) || message.is_inbound!==false || draftState(message)!==false || message.error_type || !notBeforePreparation(d.preparedAt,message.created_at))return;
  const preview=await get<PreviewRecord>(d.previewId);
  if(!preview || preview.accountId!==d.accountId || preview.data.actor!==d.actor || preview.data.preview.selection.accountId!==d.accountId)return;
  const known=await businessFrontRead<{id:string}>(`/conversations/${d.conversationId}`);
  const actual=actualId===d.conversationId?known:await businessFrontRead<{id:string}>(`/conversations/${actualId}`);
  if(!/^cnv_[a-z0-9]+$/.test(known.id) || known.id!==actual.id)return;
  const checks:Row<unknown>[]=[preview];
  for(const id of new Set([d.conversationId,actualId,known.id])) {
    const link=await get<{accountId:string;purpose?:string}>(`front-link:${id}`);
    if(link && (link.data.accountId!==d.accountId || link.data.purpose==='CARRIER'))return;
    if(link)checks.push(link);
  }
  if(preview.data.preview.conversationId!=='NEW') {
    const permitted=await permittedConversation(preview.data.preview.conversationId),link=await get<{accountId:string;purpose?:string}>(`front-link:${known.id}`);
    if(permitted.id!==known.id || !link || link.data.accountId!==d.accountId || link.data.purpose!=='PROSPECT')return;
    if(!checks.some(c=>c.id===link.id))checks.push(link);
  }
  return {id:known.id,checks};
}
async function messagePointer(d:AttemptRecord,messageId:string) {
  const id=`business-message:${messageId}`,previous=await get<MessagePointer>(id);
  if(previous && (previous.data.attemptId!==d.id || previous.data.accountId!==d.accountId))throw new Error('This Front message is already recorded for another draft attempt; review its history');
  return {previous,record:row('BUSINESS_MESSAGE',id,{accountId:d.accountId,attemptId:d.id} satisfies MessagePointer,{accountId:d.accountId,previous})};
}
async function recordChangedSend(attemptId:string,message:FrontMessage,originalKnownId:string|undefined,conversation:{id:string;checks:Row<unknown>[]}) {
  const current=await get<AttemptRecord>(attemptId);
  if(!current)throw new Error('This draft attempt is unavailable');
  if(['SENT','FAILED'].includes(current.data.state))return attemptDto(current.data);
  if(!originalKnownId || originalKnownId!==message.id || current.data.frontDraftId!==message.id)return sentNeedsReview(attemptId,'The sent message differs from the preview and was not a previously known draft. Verify the exact original draft before recording its outcome.');
  const pointer=await messagePointer(current.data,message.id),next=row('BUSINESS_DELIVERY',current.id,{...current.data,state:'SENT' as const,sentWithChanges:true,sentAt:new Date(message.created_at*1000).toISOString(),frontMessageId:message.id,conversationId:conversation.id,frontUrl:openUrl(conversation.id),messageUrl:openUrl(conversation.id),failure:'Sent with changes in Front. Recipients shown are the originally prepared To/CC; open Front for the actual recipients and content. Current quotes were not marked presented.'},{accountId:current.accountId,previous:current});
  try{await commit([put(next,current),put(pointer.record,pointer.previous),...conversation.checks.map(check)]);return attemptDto(next.data);}catch(error){
    if(conflict(error)){const latest=await get<AttemptRecord>(attemptId);if(latest && ['SENT','FAILED'].includes(latest.data.state))return attemptDto(latest.data);}
    throw error;
  }
}
function verifiedRecipients(message:FrontMessage,d:AttemptRecord) {
  const values=(role:string)=>(message.recipients ?? []).filter(r=>r.role===role).map(r=>r.handle.toLowerCase()).sort();
  return values('from').length===1 && values('from')[0]===d.from && canonical(values('to'))===canonical([...d.to].sort()) && canonical(values('cc'))===canonical([...d.cc].sort()) && values('bcc').length===0;
}
const plainBody=(message:FrontMessage)=>(message.text ?? message.body ?? '').replace(/<[^>]*>/g,'\n').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
async function verifiedFiles(message:FrontMessage,d:AttemptRecord) {
  if(message.attachments?.length!==d.files.length)return false;
  const remaining=[...(message.attachments ?? [])],digests=new Map<string,string>();
  if(new Set(remaining.map(a=>a.id)).size!==remaining.length)return false;
  for(const file of d.files){
    let matched=-1;
    for(let i=0;i<remaining.length;i++){
      const attachment=remaining[i];if(attachment.filename!==file.name || attachment.size!==file.size)continue;
      let digest=digests.get(attachment.id);if(!digest){digest=fileHash(await downloadFrontAttachment(attachment.id));digests.set(attachment.id,digest);}
      if(digest===file.sha256){matched=i;break;}
    }
    if(matched<0)return false;remaining.splice(matched,1);
  }
  return remaining.length===0;
}
async function captureDraft(old:Row<AttemptRecord>,message:FrontMessage) {
  const d=old.data,conversationId=messageConversation(message);
  if(d.state==='SENT' || d.state==='FAILED')return old;
  if(!/^msg_[a-z0-9]+$/.test(message.id) || !conversationId || draftState(message)!==true || message.author?.id!==d.sender.frontId)throw businessValidation('Front draft response could not be verified');
  if(d.conversationId!=='NEW' && conversationId!==d.conversationId)throw businessValidation('Front created the draft in a different conversation; review it before proceeding');
  const link=await get<{accountId:string}>(`front-link:${conversationId}`);
  if(link && link.data.accountId!==d.accountId)throw businessValidation('Front draft conversation is linked to another account');
  const text=plainBody(message),verified=verifiedRecipients(message,d) && text.includes(d.reference) && d.facts.every(f=>text.includes(f)) && await verifiedFiles(message,d);
  // A private NEW conversation is tracked only by this explicit attempt. It is
  // deliberately not added to general linked-inbox ingestion or shared routing.
  return updateAttempt(old,{state:verified?'DRAFT':'UNKNOWN',frontDraftId:message.id,conversationId,frontUrl:openUrl(conversationId),failure:verified?undefined:'Review this Front draft: its content, recipients or attachments differ from the prepared preview. Nothing has been sent by the CRM.'});
}
/** Claim one external POST before contacting Front. Replaying an ID never POSTs. */
export async function prepareBusinessDraft(input:PrepareBusinessDraftInput,actor:string,access:ServerAccess={admin:false}):Promise<BusinessDeliveryAttempt> {
  deliveryId(input.accountId,'account');deliveryId(input.requestId,'request');
  const workflow=await accountAccess(input.accountId,actor,access);
  const id=`business-delivery:${hash(`${actor}:${input.accountId}:${input.requestId}`)}`;
  let existing=await get<AttemptRecord>(id);
  let recipients:{to:string[];cc:string[]};
  try{recipients=deliveryRecipients(input.to,input.cc);}catch(error){if(existing)throw new Error('This draft request ID already has an attempt. Check its status before changing recipients');throw error;}
  const requestHash=hash(canonical({...input,...recipients}));
  if(existing){if(existing.data.requestHash!==requestHash)throw new Error('This draft request ID was already used for different content or recipients');return attemptDto(existing.data);}
  const stored=await freshPreview(input,actor),p=stored.data.preview,source=await loadDeliverySource(p.selection),identity=await sender(actor),selected=await thread(input.accountId,p.conversationId);
  const targetId=`business-target:${hash(canonical([input.accountId,p.selection.kind,p.selection.recordId]))}`,target=await get<TargetPointer>(targetId),prior=target?await get<AttemptRecord>(target.data.attemptId):undefined;
  if(target && (!prior || prior.accountId!==input.accountId || prior.data.kind!==p.selection.kind || prior.data.recordId!==p.selection.recordId))throw new Error('The previous draft attempt needs administrator review before preparing another');
  if(prior && ['PREPARING','UNKNOWN'].includes(prior.data.state))throw new Error('An earlier draft attempt for this item is still preparing or needs review. Check its history before creating another');
  if((input.conversationId && input.conversationId!==p.conversationId) || source.fingerprint!==stored.data.sourceFingerprint || canonical(identity.sender)!==canonical(p.sender) || identity.member.version!==stored.data.memberVersion || selected.id!==p.conversationId)throw businessValidation('The package, documents, thread or sending mailbox changed. Review a new preview');
  for(const address of [...recipients.to,...recipients.cc]){try{await assertRecipient(address);}catch(error){if(error instanceof ProviderError)throw error;throw businessValidation(error instanceof Error?error.message:'The recipient could not be verified');}if(selected.id!=='NEW' && !selected.allowedRecipients.includes(address))throw businessValidation('A new recipient needs a new conversation so client history is not forwarded');}
  const attachments=[];
  for(const file of stored.data.files){const frozen=await bytes(file.key,file.contentType);if(fileHash(frozen)!==file.sha256 || (file.sourceKey && fileHash(await bytes(file.sourceKey,file.contentType))!==file.sha256))throw businessValidation('An attachment changed after preview. Review a new preview');attachments.push({file,bytes:frozen});}
  const data:AttemptRecord={id,requestId:input.requestId,accountId:input.accountId,kind:p.selection.kind,recordId:p.selection.recordId,state:'PREPARING',from:p.sender.senderEmail,to:recipients.to,cc:recipients.cc,conversationId:selected.id,preparedAt:new Date().toISOString(),actor,previewId:stored.id,previewHash:p.previewHash,requestHash,reference:stored.data.reference,facts:p.facts,files:stored.data.files,quoteTerms:source.quoteTerms,sender:p.sender,sourceFingerprint:source.fingerprint};
  const intent=row('BUSINESS_DELIVERY',id,data,{accountId:input.accountId});
  const pointer=row('BUSINESS_TARGET',targetId,{accountId:input.accountId,kind:p.selection.kind,recordId:p.selection.recordId,attemptId:id} satisfies TargetPointer,{accountId:input.accountId,previous:target});
  try{await commit([put(intent),put(pointer,target),...(prior?[check(prior)]:[]),put(row('BUSINESS_REFERENCE',`business-reference:${data.reference}`,{attemptId:id,accountId:input.accountId},{accountId:input.accountId})),check(stored),check(identity.member),...(workflow?[check(workflow)]:[]),...(selected.link?[check(selected.link)]:[]),...deliverySourceChecks(source),absent(`deleted-account:${input.accountId}`),activeTeamUserCheck(actor)]);}catch(error){
    if(!conflict(error))throw error;existing=await get<AttemptRecord>(id);if(existing){if(existing.data.requestHash===requestHash)return attemptDto(existing.data);throw new Error('This request ID was claimed by another draft attempt. Check its status before changing it');}
    const claimed=await get<TargetPointer>(targetId);if(claimed?.data.attemptId!==target?.data.attemptId)throw new Error('Another draft attempt claimed this item. Check its history before creating another');
    throw businessValidation('The source changed while preparing the draft. Review it again');
  }
  try{
    const form=new FormData();
    for(const [key,value] of Object.entries({author_id:p.sender.frontId,signature_id:p.sender.signatureId,should_add_default_signature:'false',mode:'private',subject:p.subject,body:p.body,quote_body:''}))form.append(key,value);
    if(selected.id!=='NEW')form.append('channel_id',p.sender.channelId);
    for(const address of recipients.to)form.append('to[]',address);for(const address of recipients.cc)form.append('cc[]',address);
    for(const attachment of attachments)form.append('attachments[]',new Blob([Buffer.from(attachment.bytes)],{type:attachment.file.contentType}),attachment.file.name);
    const path=selected.id==='NEW'?`/channels/${p.sender.channelId}/drafts`:`/conversations/${selected.id}/drafts`;
    const result=await front<FrontMessage>(path,'POST',form);
    return attemptDto((await captureDraft(intent,result)).data);
  }catch(error){
    const current=await get<AttemptRecord>(id) ?? intent;
    if(['DRAFT','SENT','FAILED'].includes(current.data.state))return attemptDto(current.data);
    const uncertain=!(error instanceof ProviderError) || error.uncertain;
    return attemptDto((await updateAttempt(current,{state:uncertain?'UNKNOWN':'FAILED',failure:uncertain?'Front may have created this draft. Check Front and reconcile; this request will not create another draft.':error instanceof Error?error.message:'Front rejected this draft'})).data);
  }
}
export async function historyBusinessDeliveries(input:{accountId:string;kind?:string;recordId?:string;nextToken?:string},actor?:string,access:ServerAccess={admin:false}) {
  if(actor)await accountAccess(input.accountId,actor,access);else throw businessValidation('Sign in to review draft history');
  await deliveryAccount(input.accountId);
  const page=await query<AttemptRecord>('account',input.accountId,input.nextToken,50,'BUSINESS_DELIVERY#');
  return {items:page.items.filter(r=>r.data.id && (!input.kind || r.data.kind===input.kind) && (!input.recordId || r.data.recordId===input.recordId)).map(r=>attemptDto(r.data)),nextToken:page.nextToken};
}
/** Read/project the one allowed attempt. Never resend an uncertain draft POST. */
export async function reconcileBusinessDraft(input:ReconcileBusinessDraftInput,actor:string,access:ServerAccess={admin:false}):Promise<BusinessDeliveryAttempt> {
  await accountAccess(input.accountId,actor,access);
  await deliveryAccount(input.accountId);await enabledUser(actor);
  const attempt=await get<AttemptRecord>(input.attemptId);
  if(!attempt || attempt.accountId!==input.accountId || attempt.data.actor!==actor && !access.admin)throw businessValidation('This draft attempt is unavailable');
  const originalKnownId=attempt.data.frontDraftId;
  let current=attempt,d=current.data;
  if(access.admin && actor!==d.actor){
    // Verify the recorded original mailbox directly. An offboarded CRM user is
    // not re-enabled, and the administrator's mailbox is never substituted.
    const original=senderDto(await resolveProducerEmail({userId:d.actor,name:'Recorded preparer',email:d.from,enabled:false,salesperson:false,frontId:d.sender.frontId,frontChannelId:d.sender.channelId,frontSignatureId:d.sender.signatureId}));
    if(canonical(original)!==canonical(d.sender))throw businessValidation('The original personal Front mailbox could not be verified for recovery');
    current=await updateAttempt(current,{lastCheckedBy:actor,lastCheckedAt:new Date().toISOString()});d=current.data;
  }
  if(input.recoveryMessageId){
    if(!/^msg_[a-z0-9]{1,124}$/.test(input.recoveryMessageId))throw businessValidation('Enter the exact Front message or draft ID beginning msg_');
    if(['SENT','FAILED'].includes(d.state) && d.frontDraftId!==input.recoveryMessageId)throw new Error('A completed attempt cannot be replaced with another message');
    if(actor===d.actor){const identity=await sender(actor);if(canonical(identity.sender)!==canonical(d.sender))throw businessValidation('Your personal Front mailbox changed. Restore its verified connection before recovery');}
    const message=await businessFrontRead<FrontMessage>(`/messages/${input.recoveryMessageId}`),conversationId=messageConversation(message),text=plainBody(message);
    const link=conversationId?await get<{accountId:string;purpose?:string}>(`front-link:${conversationId}`):undefined;
    if(message.id!==input.recoveryMessageId || !conversationId || message.author?.id!==d.sender.frontId || message.is_inbound || draftState(message)===undefined || !notBeforePreparation(d.preparedAt,message.created_at) || !verifiedRecipients(message,d) || !text.includes(d.reference) || !d.facts.every(f=>text.includes(f)) || link && (link.data.accountId!==d.accountId || link.data.purpose==='CARRIER') || !await verifiedFiles(message,d))throw businessValidation('That Front message does not match this prepared attempt');
    const preview=await get<PreviewRecord>(d.previewId);
    if(!preview || preview.data.actor!==d.actor || preview.data.preview.conversationId!=='NEW' && (await thread(d.accountId,preview.data.preview.conversationId)).id!==conversationId)throw businessValidation('That Front conversation does not match this prepared attempt');
    current=await updateAttempt(current,{frontDraftId:message.id,conversationId,frontUrl:openUrl(conversationId)});d=current.data;
  }
  if(d.frontDraftId){
    let message:FrontMessage;
    try{message=await businessFrontRead(`/messages/${d.frontDraftId}`);}catch(error){if(error instanceof ProviderError && error.status===404){if(['SENT','FAILED'].includes(d.state))return attemptDto(d);return attemptDto((await updateAttempt(current,{state:'UNKNOWN',failure:'This Front draft is no longer available at its stored ID. It may have been sent or deleted; inspect the conversation before preparing another attempt.'})).data);}throw error;}
    if(message.error_type && originalSender(message,d) && (d.sentWithChanges && d.frontMessageId===message.id || d.frontDraftId===message.id && verifiedRecipients(message,d) && plainBody(message).includes(d.reference)))return attemptDto((await updateAttempt(current,{state:'FAILED',failure:'Front reported this message failed. Check recipients before preparing a new attempt.'})).data);
    if(draftState(message)===true)return attemptDto((await captureDraft(current,message)).data);
    if(draftState(message)===false && !message.is_inbound){
      // Once Front says the known draft was sent, it must no longer unlock a
      // replacement as a resolved DRAFT, including while receipt checks retry.
      await sentNeedsReview(attempt.id,'Front records this message as sent. Verification against the prepared preview is pending; check this attempt before preparing another draft.');
      const conversation=await knownSentConversation(message,d);
      if(!conversation)return sentNeedsReview(attempt.id,'Front records this message as sent, but its original sender or account conversation could not be verified. No current quote presentation was recorded. Review the linked Front message.');
      await applyBusinessAttempt({id:`comm:front:${message.id}`,provider:'front',providerId:message.id,accountId:d.accountId,conversationId:messageConversation(message),channel:'EMAIL',direction:'OUTBOUND',at:new Date(message.created_at*1000).toISOString(),from:message.recipients?.find(r=>r.role==='from')?.handle,to:message.recipients?.filter(r=>r.role==='to').map(r=>r.handle),actorId:message.author?.id,text:message.text ?? plainBody(message),attachments:message.attachments,frontDraft:false,status:'SENT',classification:'SUBSTANTIVE',version:1});
      return recordChangedSend(attempt.id,message,originalKnownId,conversation);
    }
  }
  if(d.conversationId!=='NEW'){
    // Only this known account-bound conversation is searched. No private inbox scan.
    const drafts=await businessFrontRead<{_results:FrontMessage[]}>(`/conversations/${d.conversationId}/drafts`);
    const matches=drafts._results?.filter(m=>draftState(m)===true && m.author?.id===d.sender.frontId && (m.text ?? m.body ?? '').includes(d.reference));
    if(matches?.length===1)return attemptDto((await captureDraft(current,matches[0])).data);
  }
  if(d.state==='PREPARING' && Date.now()-Date.parse(d.preparedAt)>30_000)return attemptDto((await updateAttempt(current,{state:'UNKNOWN',failure:'No verified Front draft receipt is available. Inspect Front before taking further action; nothing was resent.'})).data);
  return attemptDto(d);
}
export async function applyBusinessAttempt(comm:Communication) {
  if(!comm.accountId || comm.provider!=='front' || comm.direction!=='OUTBOUND' || comm.frontDraft!==false)return;
  const seen=new Set<string>(),pointer=await get<MessagePointer>(`business-message:${comm.providerId}`);
  if(pointer && pointer.data.accountId===comm.accountId){const candidate=await get<AttemptRecord>(pointer.data.attemptId);if(candidate && candidate.accountId===comm.accountId && candidate.data.frontMessageId===comm.providerId){await applyAttempt(candidate,comm,currentMessage(comm.text));seen.add(candidate.id);}}
  const text=currentMessage(comm.text),references=[...new Set(text.match(/HOA-[A-F0-9]{12}/g) ?? [])].slice(0,10);
  for(const reference of references){const index=await get<{attemptId:string}>(`business-reference:${reference}`);if(!index || seen.has(index.data.attemptId))continue;const candidate=await get<AttemptRecord>(index.data.attemptId);if(candidate && candidate.accountId===comm.accountId)await applyAttempt(candidate,comm,text);}
}
async function applyAttempt(candidate:Row<AttemptRecord>,comm:Communication,text:string) {
  const d=candidate.data;
  if(comm.status==='FAILED'){
    if(d.frontMessageId===comm.providerId && comm.actorId===d.sender.frontId && comm.from?.toLowerCase()===d.from)await updateAttempt(candidate,{state:'FAILED',failure:'Front reported this sent message failed. Check recipients before preparing a new attempt.'});return;
  }
  if(d.state==='SENT' || d.state==='FAILED' || contactProgress(comm)!=='CONTACT' || !notBeforePreparation(d.preparedAt,Date.parse(comm.at)/1000) || !d.facts.every(f=>text.includes(f)))return;
  const actual=await businessFrontRead<FrontMessage>(`/messages/${comm.providerId}`),cnv=messageConversation(actual);
  if(draftState(actual)!==false || actual.is_inbound || actual.author?.id!==d.sender.frontId || !cnv)return;
  if(!verifiedRecipients(actual,d) || !plainBody(actual).includes(d.reference) || !d.facts.every(f=>plainBody(actual).includes(f)) || !await verifiedFiles(actual,d))return;
  if(actual.error_type){await updateAttempt(candidate,{state:'FAILED',failure:'Front reported this message failed. Check recipients before preparing a new attempt.'});return;}
  const priorPreview=await get<PreviewRecord>(d.previewId);
  if(!priorPreview || priorPreview.data.actor!==d.actor)return;
  const selected=priorPreview.data.preview.conversationId;
  if(selected!=='NEW' ? (await thread(d.accountId,selected)).id!==cnv : d.conversationId!=='NEW' && d.conversationId!==cnv)return;
  const writes:Write[]=[],client=await dataClient();let changed=false;
  const commercial=d.kind==='PACKAGE'?await get<CommercialPlan>(`commercial:${d.accountId}`):undefined;
  if(d.kind==='PACKAGE' && commercial?.version!==priorPreview.data.commercialVersion)changed=true;
  if(d.kind==='PACKAGE')for(const [id,terms] of Object.entries(d.quoteTerms)){
    const result=await client.models.Quote.get({id}),q=result.data;
    if(result.errors?.length || !q || q.accountId!==d.accountId || packageTerms(q)!==terms || !['QUOTED','PRESENTED'].includes(q.status)){changed=true;continue;}
    writes.push({Update:{TableName:process.env.QUOTE_TABLE,Key:{id},UpdateExpression:'SET presentedAt = if_not_exists(presentedAt, :at), #status = :presented, updatedAt = :processed, lastWriteBy = :actor',ConditionExpression:'updatedAt = :old AND (#status = :quoted OR #status = :presented)',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':at':comm.at,':processed':quoteProjectionTimestamp(q.updatedAt),':old':q.updatedAt,':actor':'communication-delivery',':quoted':'QUOTED',':presented':'PRESENTED'}}});
  }
  if(changed)writes.length=0;
  // Individual send-attempt history is the evidence; legacy deliveredAt is not receipt.
  const pointer=await messagePointer(d,comm.providerId),next=row('BUSINESS_DELIVERY',candidate.id,{...d,state:'SENT' as const,sentWithChanges:false,sentAt:comm.at,frontMessageId:comm.providerId,conversationId:cnv,frontUrl:openUrl(cnv),messageUrl:openUrl(cnv),failure:changed?'Sent with frozen earlier terms; changed current quotes were not marked presented.':undefined},{accountId:d.accountId,previous:candidate});
  await commit([put(next,candidate),put(pointer.record,pointer.previous),...(writes.length && commercial?[check(commercial)]:[]),...writes]);
}
