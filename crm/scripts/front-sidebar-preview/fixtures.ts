/** Fictional component fixtures. No CRM connection or provider requests. */
import { scheduleReminders, type LeadTask, type LeadWorkflow, type TeamEligibility, type TeamRouting, type WorkflowContext } from '../../../shared/leadWorkflow';
import { morningReport } from '../../../shared/morningReport';
export type { LeadTask, WorkflowContext, TeamEligibility, Communication } from '../../../shared/leadWorkflow';
const params = new URLSearchParams(location.search);
export const role = params.get('role') || 'sales';
export const scenario = params.get('scenario') || 'first';
export const previewNow = '2026-09-14T13:00:00.000Z';
export const team: TeamEligibility[] = [
  ['sales','Avery Brooks',true,false], ['champ','Casey Rivera',false,true], ['manager','Morgan Lee',false,false],
  ['marketing','Taylor Reed',false,false], ['owner','Jordan Ellis',false,false], ['specialist','Sam Patel',false,false],
].map(([userId,name,salesperson,champion]) => ({ userId: String(userId), name: String(name), email: `${userId}@example.test`, frontId: `tea_${userId}`, enabled: true, salesperson: !!salesperson, champion: !!champion }));
let routing: TeamRouting = { version: 1, ownerId: 'owner', marketingManagerId: 'marketing', intakeOwnerId: 'owner', integrationOwnerId: 'owner', reportChannelId: 'cha_preview', members: [{ userId:'sales',salesManagerId:'manager' },{ userId:'manager',salesManager:true },{ userId:'marketing',marketingManager:true }] };
const bound = ['renewal','service'].includes(scenario);
const wf: LeadWorkflow = { accountId:'example', name:'Willow Court Condominium', salespersonId:'sales',championId:'champ',disposition:bound?'BOUND':'ACTIVE',conversationId:'cnv_example',version:1,updatedAt:previewNow };
const kinds: Record<string, LeadTask['kind']> = {first:'FIRST_CONTACT',callback:'CALLBACK',quote:'QUOTE_PRESENTATION',carrier:'CARRIER',renewal:'QUOTE_TARGET',service:'SERVICE',annual:'ANNUAL_RETURN'};
const carrier = ['carrier','renewal'].includes(scenario);
const task: LeadTask = scheduleReminders({ id:'task_example',accountId:'example',conversationId:'cnv_example',title:scenario==='service'?'Send the requested certificate':'Follow up',kind:kinds[scenario]||'RESPONSE',role:bound||carrier?'CHAMPION':'SALESPERSON',domain:carrier?'CARRIER':'CLIENT',context:scenario==='renewal'?'RENEWAL':bound?'SERVICE':'LEAD',sourceAt:'2026-09-10T14:00:00.000Z',sourceIds:['comm_example'],dueAt:['manager','marketing','owner'].includes(role)?'2026-09-10T21:00:00.000Z':previewNow,escalationAt:'',version:1,status:'OPEN',...(scenario==='quote'?{quoteId:'quote_example'}:{}),...(scenario==='service'?{serviceType:'CERTIFICATE',milestone:true}:{}),...(scenario==='renewal'?{policyId:'policy_example',milestone:true}:{}) });
const context: WorkflowContext = { workflow:wf,team,actorId:role,frontContext:{conversationId:'cnv_example',assigneeId:`tea_${bound||carrier?'champ':'sales'}`,routing:bound||carrier?'CHAMPION':'SALESPERSON',purpose:carrier?'CARRIER':'PROSPECT',context:task.context,policyId:task.policyId}, tasks:scenario==='healthy'?[]:[task],issues:[],communications:[{id:'comm_example',accountId:'example',conversationId:'cnv_example',provider:'front',providerId:'msg_example',channel:'EMAIL',direction:'INBOUND',at:'2026-09-10T14:00:00.000Z',from:'jane@example.test',to:['sales@example.test'],subject:scenario==='service'?'Certificate request':'Insurance review',text:scenario==='service'?'Please send our certificate of insurance to the property manager.':'Could you call me about our upcoming insurance renewal?',status:'RECEIVED',classification:'SUBSTANTIVE',version:1}] };
export function previewReport() { const report=morningReport({recipientId:role,team,routing,workflows:[wf],tasks:context.tasks,now:previewNow,health:scenario==='gap'?['Email activity could not be verified. Jordan Ellis is reviewing the connection.']:[]}); report.items=scenario==='first'?report.items:report.items.map(i=>({...i,lastOutreach:'2026-09-10T15:30:00.000Z',lastOutreachKind:'human email'})); return report; }
function notice(message:string) { window.dispatchEvent(new CustomEvent('preview-action',{detail:message})); }
export async function communicationRequest<T=Record<string,unknown>>(op:string,input?:Record<string,unknown>,_write?:boolean):Promise<T> {
  let result:unknown={notice:'Preview only. No real records changed.'};
  if(op==='context') result=structuredClone(context);
  else if(op==='team') result={team};
  else if(op==='teamRouting') result={routing};
  else if(op==='saveTeamRouting') { routing=input as unknown as TeamRouting;result={routing};notice('Routing changed in this preview only. Reload to reset.'); }
  else if(op==='myReport') result={report:previewReport()};
  else if(op==='accountSummary') result={summary:{name:wf.name,source:'Organic Website',incumbentExpirationDate:'2026-12-01',contacts:[{id:'jane',name:'Jane Smith',email:'jane@example.test',phone:'+16175550123'}],notes:'12-unit condominium. Property manager prefers afternoon calls.',quotes:scenario==='quote'?[{id:'quote_example',status:'QUOTED',carrierName:'Example Mutual',premium:12500,lines:['Property'],effectiveDate:'2026-12-01'}]:[],documents:[],url:'https://example.test/accounts/example',more:false}};
  else if(op==='work') result={items:[]};
  else if(op==='deliveryOptions') result={options:scenario==='service'?[{id:'certificate_example',name:'Certificate for Willow Court',kind:'CERTIFICATE'}]:[]};
  else if(op==='smsComposer') result={channelId:'cha_preview',sender:'+15085550123'};
  else if(op==='prepareBusinessDraft') result={draft:{channelId:'cha_preview',originalMessageId:'msg_example',recipient:'jane@example.test',subject:'Willow Court insurance',body:'Fictional test draft',attachments:[]}};
  else if(op==='setResponsibilities') {wf.salespersonId=String(input?.salespersonId);wf.championId=String(input?.championId);result={};notice('Lead team changed in this preview only.');}
  else if(op==='nextYearPreview') result={current:'2026-12-01',next:'2027-12-01',returnAt:'2027-09-02T13:00:00.000Z'};
  else if(op==='nextYear') {wf.deferredUntil='2027-09-02T13:00:00.000Z';wf.deferredExpiration='2027-12-01';notice('Preview: returns September 2, 2027 at 9 a.m. Eastern. No real date changed.');}
  else notice(`Preview action: ${op}. No email was sent or real record changed.`);
  return result as T;
}
export const client={models:{Account:{list:async()=>({data:[{id:'example',name:wf.name}]})},Policy:{list:async()=>({data:[{id:'policy_example',policyNumber:'TEST-1001',lines:['Property'],expirationDate:'2026-12-01'}]})}}};
export const fmtDateTime=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/New_York'});
export const fmtDate=(value:string)=>new Date(`${value.slice(0,10)}T12:00:00Z`).toLocaleDateString('en-US');
export const fmtProviderPhone=(value:string)=>value==='+16175550123'?'(617) 555-0123':value;
export const friendlyError=(error:unknown)=>String(error);
export default {contextUpdates:{subscribe:(fn:(value:unknown)=>void)=>{const timer=setTimeout(()=>fn({conversation:{id:'cnv_example'}}),0);return{unsubscribe:()=>clearTimeout(timer)};}},openUrl:(url:string)=>notice(`Preview destination: ${url}`),createDraft:async()=>{notice('Draft prepared. In Front you would review and send it; this preview sends nothing.');}};
