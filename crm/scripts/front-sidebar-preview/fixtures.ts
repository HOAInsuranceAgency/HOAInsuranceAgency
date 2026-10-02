/** Fictional component fixtures. No CRM connection or provider requests. */
import { type LeadWorkflow, type TeamEligibility, type WorkflowContext } from '../../../shared/leadWorkflow';
export type { WorkflowContext, TeamEligibility, Communication } from '../../../shared/leadWorkflow';
const params = new URLSearchParams(location.search);
export const role = params.get('role') || 'sales';
export const scenario = params.get('scenario') || 'lead';
export const previewNow = '2026-09-14T13:00:00.000Z';
export const team: TeamEligibility[] = [
  ['sales','Avery Brooks',true], ['owner','Jordan Ellis',false], ['specialist','Sam Patel',false],
].map(([userId,name,salesperson]) => ({ userId: String(userId), name: String(name), email: `${userId}@example.test`, frontId: `tea_${userId}`, enabled: true, salesperson: !!salesperson, available: true }));
const bound = ['renewal','service'].includes(scenario);
const wf: LeadWorkflow = { accountId:'example', name:'Willow Court Condominium', salespersonId:'sales',disposition:bound?'BOUND':'ACTIVE',conversationId:'cnv_example',version:1,updatedAt:previewNow };
const carrier = scenario === 'carrier';
const context: WorkflowContext = { workflow:wf,team,actorId:role,trackingHealthy:scenario!=='gap',frontContext:{conversationId:'cnv_example',assigneeId:'tea_sales',routing:'SALESPERSON',purpose:carrier?'CARRIER':'PROSPECT',context:bound?'SERVICE':'LEAD'}, tasks:[],issues:[],communications:[{id:'comm_example',accountId:'example',conversationId:'cnv_example',provider:'front',providerId:'msg_example',channel:'EMAIL',direction:'INBOUND',at:'2026-09-10T14:00:00.000Z',from:'jane@example.test',to:['sales@example.test'],subject:scenario==='service'?'Certificate request':'Insurance review',text:scenario==='service'?'Please send our certificate of insurance to the property manager.':'Could you call me about our upcoming insurance renewal?',status:'RECEIVED',classification:'SUBSTANTIVE',resolved:scenario==='healthy',version:1}] };
function notice(message:string) { window.dispatchEvent(new CustomEvent('preview-action',{detail:message})); }
export async function communicationRequest<T=Record<string,unknown>>(op:string,input?:Record<string,unknown>,_write?:boolean):Promise<T> {
  let result:unknown={notice:'Preview only. No real records changed.'};
  if(op==='context') result=structuredClone(context);
  else if(op==='team') result={team};
  else if(op==='accountSummary') result={summary:{name:wf.name,source:'Organic Website',incumbentExpirationDate:'2026-12-01',contacts:[{id:'jane',name:'Jane Smith',email:'jane@example.test',phone:'+16175550123'}],notes:'12-unit condominium. Property manager prefers afternoon calls.',quotes:scenario==='quote'?[{id:'quote_example',status:'QUOTED',carrierName:'Example Mutual',premium:12500,lines:['Property'],effectiveDate:'2026-12-01'}]:[],documents:[],url:'https://example.test/accounts/example',more:false}};
  else if(op==='work') result={items:[]};
  else if(op==='smsComposer') result={channelId:'cha_preview',sender:'+15085550123'};
  else if(op==='prepareBusinessDraft') result={draft:{channelId:'cha_preview',originalMessageId:'msg_example',recipient:'jane@example.test',subject:'Willow Court insurance',body:'Fictional test draft',attachments:[]}};
  else if(op==='setResponsibilities') {wf.salespersonId=String(input?.salespersonId);result={};notice('Lead team changed in this preview only.');}
  else notice(`Preview action: ${op}. No email was sent or real record changed.`);
  return result as T;
}
export const client={models:{Account:{list:async()=>({data:[{id:'example',name:wf.name}]})},Policy:{list:async()=>({data:[{id:'policy_example',policyNumber:'TEST-1001',lines:['Property'],expirationDate:'2026-12-01'}]})}}};
export const fmtDateTime=(value:string)=>new Date(value).toLocaleString('en-US',{timeZone:'America/New_York'});
export const fmtDate=(value:string)=>new Date(`${value.slice(0,10)}T12:00:00Z`).toLocaleDateString('en-US');
export const fmtProviderPhone=(value:string)=>value==='+16175550123'?'(617) 555-0123':value;
export const friendlyError=(error:unknown)=>String(error);
export default {contextUpdates:{subscribe:(fn:(value:unknown)=>void)=>{const timer=setTimeout(()=>fn({conversation:{id:'cnv_example'}}),0);return{unsubscribe:()=>clearTimeout(timer)};}},openUrl:(url:string)=>notice(`Preview destination: ${url}`),createDraft:async()=>{notice('Draft prepared. In Front you would review and send it; this preview sends nothing.');}};
