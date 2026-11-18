/** Offline integration checks: real commission/payroll modules, in-memory storage
 * and mail boundaries. No AWS credentials, network, email, or payroll writes.
 * Node >=22.15 (registerHooks); run with `npm run test:commission-payroll`. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, after, test } from 'node:test';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const state = { records: new Map(), roster: new Map(), receipts: new Map(), owners: [], disabledOwners: new Set(), sent: [], sendError: undefined, beforeCommit: undefined, disabled: false, staleRefs: undefined };
const pdfModulePath = createRequire(import.meta.url).resolve('pdf-lib', { paths: process.env.COMMISSION_TEST_NODE_MODULES ? [join(process.env.COMMISSION_TEST_NODE_MODULES, '..')] : [fileURLToPath(new URL('..', import.meta.url))] });
globalThis[Symbol.for('commission-payroll-test')] = state;
const mockSources = {
  // Interop wrapper around the real installed PDF library, not a PDF mock.
  pdf: `import {createRequire} from 'node:module';const lib=createRequire(${JSON.stringify(import.meta.url)})(${JSON.stringify(pdfModulePath)});export const {PDFDocument,StandardFonts,rgb,degrees}=lib;`,
  store: `const s=globalThis[Symbol.for('commission-payroll-test')];
    export const db={send:async c=>({Item:structuredClone(s.receipts.get(c.input.Key.pk))})};
    export const auditPage=async()=>({entries:[]});
    export const table=()=> 'private-ledger';
    export const get=async(k,id)=>structuredClone(s.records.get(k+':'+id));
    export const getMany=async(refs)=>refs.map(r=>structuredClone(s.records.get(r.kind+':'+r.id))).filter(Boolean);
    export const list=async(k,producer=false,recordKind)=>producer&&s.staleRefs?s.staleRefs:[...s.records].filter(([key,r])=>producer?r.producerId===k&&(!recordKind||key.startsWith(recordKind+':')):key.startsWith(k+':')).map(([key,r])=>structuredClone({...r,kind:key.split(':')[0]}));
    export async function commit(changes,actor,conditions=[]){
      if(s.beforeCommit){const f=s.beforeCommit;s.beforeCommit=undefined;await f();}
      const fail=()=>{const e=new Error('Transaction conflict');e.name='TransactionCanceledException';throw e;};
      for(const c of conditions){const q=c.ConditionCheck;if(q.Key.userId){if(s.disabledOwners.has(q.Key.userId))fail();continue;} const old=s.records.get(q.Key.kind+':'+q.Key.id);if(q.ConditionExpression==='attribute_not_exists(id)'?!!old:old?.version!==q.ExpressionAttributeValues[':v'])fail();}
      for(const c of changes){const old=s.records.get(c.kind+':'+c.value.id);if(c.previous?old?.version!==c.previous.version:!!old)fail();}
      for(const c of changes)s.records.set(c.kind+':'+c.value.id,structuredClone({...c.value,kind:c.kind,version:(c.previous?.version??0)+1}));
    }`,
  access: `export const tableName=m=>m;export class AccountAccess {async get(model,id){return structuredClone(globalThis[Symbol.for('commission-payroll-test')].roster.get(model+':'+id));}}`,
  policy: `export const object=v=>typeof v==='string'?JSON.parse(v):v??{};export class AccessDenied extends Error {constructor(){super('Not authorized');this.name='Unauthorized';}}`,
  status: `export async function assertUserSession(){if(globalThis[Symbol.for('commission-payroll-test')].disabled)throw new Error('Inactive session');} export const teamUserDisabled=async id=>globalThis[Symbol.for('commission-payroll-test')].disabledOwners.has(id);export const activeTeamUserCheck=id=>({ConditionCheck:{Key:{userId:id}}});`,
  bind: `export async function bindPolicy(){throw new Error('Binding is not used by payroll tests');}`,
  signing: `export const downloadContentDisposition=()=>'';export const fileSigningOptions={};export const fileClient=()=>({send:async()=>({})});`,
  sdk: `export class GetCommand{constructor(input){this.input=input;}};export class QueryCommand{};export class PutObjectCommand{};export class GetObjectCommand{};export class HeadObjectCommand{};export const getSignedUrl=async()=>{throw new Error('Signing is not used by payroll tests');};`,
  cognito: `export class ListUsersInGroupCommand{constructor(input){this.input=input;}};export class CognitoIdentityProviderClient{async send(c){const s=globalThis[Symbol.for('commission-payroll-test')];if(c.input.GroupName!=='OWNER')throw new Error('Wrong group');return {Users:structuredClone(s.owners)};}}`,
  ses: `export class SendEmailCommand {constructor(input){this.input=input;}}`,
  mail: `export class TransactionalMailClient {async send(command,details){const s=globalThis[Symbol.for('commission-payroll-test')];s.sent.push({command:command.input,details});if(typeof s.sendError==='function'){const e=s.sendError(command.input);if(e)throw e;}else if(s.sendError)throw s.sendError;return {MessageId:'test-message-'+s.sent.length};}}`,
  contract: `export class MailDeliveryError extends Error {constructor(state,key){super(state);this.state=state;this.operationKey=key;}}`,
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/node_modules/')) return next(specifier, context);
    if (specifier === 'pdf-lib') return { url: 'mock:pdf', shortCircuit: true };
    if (specifier === '@aws-sdk/client-sesv2') return { url: 'mock:ses', shortCircuit: true };
    if (specifier === '@aws-sdk/client-cognito-identity-provider') return { url: 'mock:cognito', shortCircuit: true };
    if (['@aws-sdk/lib-dynamodb','@aws-sdk/client-s3','@aws-sdk/s3-request-presigner'].includes(specifier)) return { url: 'mock:sdk', shortCircuit: true };
    if (specifier.startsWith('.')) {
      let url = new URL(specifier, context.parentURL);
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname) && existsSync(fileURLToPath(url) + '.ts')) url = new URL(url.href + '.ts');
      const substitutions = { '/commissions/store.ts': 'store', '/commissions/bind.ts': 'bind', '/crm-access/access.ts': 'access', '/crm-access/policy.ts': 'policy', '/crm-access/user-status.ts': 'status', '/crm-access/file-signing.ts': 'signing', '/transactional-mail/client.ts': 'mail', '/transactional-mail/contract.ts': 'contract' };
      for (const [suffix,name] of Object.entries(substitutions)) if (url.pathname.endsWith(suffix)) return { url: `mock:${name}`, shortCircuit: true };
      return next(url.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('mock:')) return { format: 'module', source: mockSources[url.slice(5)], shortCircuit: true };
    if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    return next(url, context);
  },
});
const { appendEntry, policyTotals, selectCommissionTerms, batchPaidCents, recoveryBalances } = await import('../../shared/commissions.ts');
const { parseStatementCsv, prepareStatementImport, importedMoney } = await import('../../shared/commissionImport.ts');
const { buildPayrollApproval, defaultPayrollSettings, payrollDay, payrollPreview, suggestPayrollDates, validatePayrollCycle, validatePayrollSettings } = await import('../../shared/commissionPayroll.ts');
const { commissionPolicy, commissionAccount, line, statement } = await import('../src/test/commissionFixtures.ts');
const { commissionReportFiles } = await import('../amplify/functions/commissions/reports.ts');
const { PDFDocument } = await import('pdf-lib');
const { payrollAction } = await import('../amplify/functions/commissions/payroll.ts');
const { handler: runWorker, verifyPayrollSchedule } = await import('../amplify/functions/commissions/payroll-worker.ts');
const { handler: commissionHandler } = await import('../amplify/functions/commissions/handler.ts');
const { MailDeliveryError } = await import('mock:contract');
const NativeDate = Date;
let clock = NativeDate.parse('2026-11-20T15:00:00.000Z');
globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
const originalEnvironment = { ...process.env };
const cycle = () => ({ ...validatePayrollCycle({ id: '2026-11', version: 0, cutoff: '2026-11-16', reviewOn: '2026-11-17', hrDueOn: '2026-11-20', processingOn: '2026-11-23', payDate: '2026-11-27' }), version: 1 });
const settings = () => ({ ...defaultPayrollSettings(), version: 1, enabled: true, hrRecipient: 'hr@example.com', reviewRecipient: 'owner@example.com', employees: [{ producerId: 'producer', employeeId: '00123', earningsCode: 'COM' }] });
const earned = () => appendEntry(commissionPolicy(), line(), { ...statement(), receivedOn: '2026-11-16' }, 'receipt');
const ownerAction = (operation,input={}) => payrollAction({},'owner',true,operation,input);
const scheduleEvent = () => ({ trigger: 'scheduled', scheduleArn: 'test-schedule', scheduledAt: new Date().toISOString() });
function seed() { state.records.set('PAYROLL_SETTINGS:payroll', settings()); state.records.set('PAYROLL_CYCLE:2026-11', cycle()); state.records.set('POLICY:p', earned()); }
async function approve() { const w=await ownerAction('payrollWorkspace'); await ownerAction('approvePayrollCycle',{id:'2026-11',version:1,previewToken:w.cycles[0].preview.token,confirmed:true}); return state.records.get('PAYROLL_CYCLE:2026-11'); }
beforeEach(() => {
  state.records.clear();state.roster.clear();state.sent=[];state.sendError=undefined;state.beforeCommit=undefined;state.disabled=false;state.staleRefs=undefined;
  state.receipts.clear();state.owners=[];state.disabledOwners.clear();
  process.env.HOA_TRANSACTIONAL_MAIL_TABLE='mail-ledger';process.env.USER_POOL_ID='owner-directory';
  clock=NativeDate.parse('2026-11-20T15:00:00.000Z');
  Object.assign(process.env,{COMMISSION_PAYROLL_ENV:'main',COMMISSION_PAYROLL_SCHEDULE_ARN:'test-schedule',COMMISSION_PAYROLL_FROM:'insurance@protectmyhoa.com',COMMISSION_PAYROLL_URL:'https://example.com',HOA_TRANSACTIONAL_MAIL_PROVIDER:'ses',HOA_MIGRATION_PREVIEW:'false',HOA_MIGRATION_BUSINESS_HELD:'false'});
});
after(() => { hook.deregister();globalThis.Date=NativeDate; for(const k of Object.keys(process.env))if(!(k in originalEnvironment))delete process.env[k];Object.assign(process.env,originalEnvironment);delete globalThis[Symbol.for('commission-payroll-test')]; });

test('both attached plan examples match and installments preserve pennies',()=>{
  for(const [rates,total] of [[[2000,2000,1000,1000],288550],[[1600,1600,800,800],230840]]) assert.equal([350000,528000,465000,664500].reduce((n,c,i)=>n+appendEntry({...commissionPolicy(),producerBps:rates[i]},line({agencyCents:c}),statement(),String(i)).entries[0].producerCents,0),total);
  let p={...commissionPolicy(),producerBps:3333};for(let i=0;i<12;i++)p=appendEntry(p,line({agencyCents:1}),statement(),String(i));assert.equal(policyTotals(p).earned,4);
});
test('payroll calendar validates order, real dates, and month',()=>{
  for(const patch of [{reviewOn:'2026-11-16'},{hrDueOn:'2026-11-24'},{payDate:'2026-12-04'},{cutoff:'2026-02-30'}])assert.throws(()=>validatePayrollCycle({...cycle(),...patch}));
  assert.equal(payrollDay(new NativeDate('2026-11-01T03:59:00Z')),'2026-10-31');
});
test('monthly suggestions use Friday EOD cutoff and Monday morning report and processing',()=>{
  assert.deepEqual(suggestPayrollDates('2026-11'),{id:'2026-11',payDate:'2026-11-27',cutoff:'2026-11-20',processingOn:'2026-11-23',hrDueOn:'2026-11-23',reviewOn:'2026-11-21'});
  for(const [month,lastFriday] of [['2024-02','2024-02-23'],['2026-02','2026-02-27'],['2026-03','2026-03-27'],['2026-07','2026-07-31'],['2027-01','2027-01-29']]){
    const dates=suggestPayrollDates(month);assert.equal(dates.payDate,lastFriday);assert.equal(new NativeDate(dates.processingOn).getUTCDay(),1);assert.equal(new NativeDate(dates.hrDueOn).getUTCDay(),1);assert.equal(new NativeDate(dates.reviewOn).getUTCDay(),6);assert.equal(dates.hrDueOn,dates.processingOn);assert.equal(new NativeDate(dates.cutoff).getUTCDay(),5);
  }
  for(const invalid of ['2026-13','2026-1','2026-02-01',''])assert.throws(()=>suggestPayrollDates(invalid));
});
test('suggested dates remain editable for actual payroll exceptions',()=>{
  const dates=suggestPayrollDates('2026-12');
  const adjusted=validatePayrollCycle({...cycle(),...dates,cutoff:'2026-12-14',payDate:'2026-12-24'});
  assert.equal(adjusted.payDate,'2026-12-24');assert.equal(adjusted.processingOn,'2026-12-21');
});
test('new payroll setup prefills the confirmed HR inbox and existing Jake mailbox without activating sends',async()=>{
  const w=await ownerAction('payrollWorkspace');assert.equal(w.settings.hrRecipient,'hr@cobaltemployment.com');assert.equal(w.settings.reviewRecipient,'jake@protectmyhoa.com');assert.equal(w.settings.enabled,false);assert.equal(state.records.size,0);
  await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
});
test('saved recipients are not silently replaced by setup defaults',async()=>{
  seed();const w=await ownerAction('payrollWorkspace');assert.equal(w.settings.hrRecipient,'hr@example.com');assert.equal(w.settings.reviewRecipient,'owner@example.com');
});
test('report settings need valid recipients but no payroll identifiers',()=>{
  assert.equal(defaultPayrollSettings().enabled,false);
  assert.throws(()=>validatePayrollSettings({...settings(),hrRecipient:'a@example.com,b@example.com'}));
  const validated=validatePayrollSettings({...settings(),employees:undefined});assert.equal(validated.employees,undefined);
});
test('cutoff includes that date, excludes late receipts and never nets recovery against wages',()=>{
  let p=earned();p=appendEntry(p,line({kind:'REVERSAL',agencyCents:-50000,originalId:'receipt'}),{...statement(),receivedOn:'2026-11-16'},'reversal');
  p=appendEntry(p,line(),{...statement(),receivedOn:'2026-11-17'},'late');
  assert.equal(payrollPreview([p],cycle().cutoff).length,1);assert.equal(payrollPreview([p],cycle().cutoff)[0].amountCents,16000);
});
test('approval produces balanced employee PDFs without payroll IDs',async()=>{
  const a=buildPayrollApproval(cycle(),[earned()],[],{...settings(),employees:undefined},'owner',new Date().toISOString());
  assert.equal(a.cycle.totalCents,16000);assert.equal(a.policies[0].entries[0].batchId,a.batches[0].id);
  const files=await commissionReportFiles(a.cycle,a.batches);assert.equal(files.length,2);assert.ok(files.every(f=>f.contentType==='application/pdf'&&Buffer.from(f.content).subarray(0,5).toString()==='%PDF-'));
  assert.equal((await PDFDocument.load(files[1].content)).getPageCount(),1);await assert.rejects(commissionReportFiles(a.cycle,[]));
});
test('approval blocks unfinished cutoff and mixed ledger snapshots',()=>{
  assert.throws(()=>buildPayrollApproval(cycle(),[earned()],[],settings(),'owner','2026-11-16T23:00:00Z'),/cutoff/);
  const p=earned();p.entries[0].batchId='missing';assert.throws(()=>buildPayrollApproval(cycle(),[p],[],settings(),'owner',new Date().toISOString()),/changed while loading/);
});
test('employee PDFs are deterministic across delivery retries and contain no active script',async()=>{
  const p=earned();p.producerName='=HYPERLINK("bad")';p.accountName='<script>alert(1)</script>';const a=buildPayrollApproval(cycle(),[p],[],settings(),'owner',new Date().toISOString());
  const first=await commissionReportFiles(a.cycle,a.batches);clock+=10000;const next=await commissionReportFiles(a.cycle,a.batches);assert.deepEqual(first,next);
  for(const f of first)assert.doesNotMatch(Buffer.from(f.content).toString(),/\/JavaScript|\/OpenAction/);
});
test('payroll operations retain existing Owner access',async()=>{
  seed();
  for(const op of ['payrollWorkspace','downloadPayrollCycle','confirmPayrollCycle','savePayrollSettings','savePayrollCycle','approvePayrollCycle','cancelPayrollCycle','retryPayrollDelivery'])await assert.rejects(payrollAction({},'other',false,op,{}),/active Owner/);
});
test('an HR inbox can be configured without a CRM teammate or new permission',async()=>{
  seed();state.roster.set('Communication:eligibility:producer',{data:{userId:'producer'}});
  await ownerAction('savePayrollSettings',{...settings(),hrRecipient:'payroll-inbox@example.com'});
  const w=await ownerAction('payrollWorkspace');assert.equal(w.settings.hrRecipient,'payroll-inbox@example.com');assert.equal(w.settings.hrUserId,undefined);
});
test('changed preview amounts cannot be silently approved',async()=>{
  seed();const w=await ownerAction('payrollWorkspace');state.records.set('POLICY:p',appendEntry(earned(),line(),{...statement(),receivedOn:'2026-11-16'},'additional'));
  await assert.rejects(ownerAction('approvePayrollCycle',{id:'2026-11',version:1,previewToken:w.cycles[0].preview.token,confirmed:true}),/amounts.*changed/);assert.equal([...state.records.keys()].filter(k=>k.startsWith('BATCH:')).length,0);
});
test('approval locks entries and prevents a duplicate approval',async()=>{
  seed();const c=await approve();assert.equal(c.status,'APPROVED');assert.equal(state.records.get('POLICY:p').entries[0].batchId,c.batchIds[0]);
  await assert.rejects(ownerAction('approvePayrollCycle',{id:c.id,version:1,confirmed:true}),/changed/);
});
test('email delivery is distinct from confirmed payment and needs no acknowledgement',async()=>{
  seed();const c=await approve();await runWorker(scheduleEvent());assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'APPROVED');
  await assert.rejects(ownerAction('confirmPayrollCycle',{id:c.id,version:c.version,paidOn:'2026-11-27',paymentReference:'ADP-123',confirmed:true}),/after it occurs/);
  await ownerAction('confirmPayrollCycle',{id:c.id,version:c.version,paidOn:'2026-11-20',paymentReference:'ADP-123',confirmed:true});assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'PAID');assert.equal(state.records.get('BATCH:'+c.batchIds[0]).status,'PAID');
  assert.ok((await ownerAction('downloadPayrollCycle',{id:c.id,historicalConfirmed:true})).files.length);
});
test('approved reports wait for the HR delivery date, ahead of payroll processing',async()=>{
  seed();await approve();clock=NativeDate.parse('2026-11-19T15:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
  clock=NativeDate.parse('2026-11-20T15:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.match(state.sent[0].details.text,/processing: 2026-11-23/);assert.match(state.sent[0].details.text,/No CRM acknowledgement is required/);
});
test('cancelling before delivery releases earnings and permits a replacement generation',async()=>{
  seed();let c=await approve();await ownerAction('cancelPayrollCycle',{id:c.id,version:c.version,reason:'Payroll rejected'});assert.equal(state.records.get('POLICY:p').entries[0].batchId,undefined);
  c=state.records.get('PAYROLL_CYCLE:2026-11');await ownerAction('savePayrollCycle',{...c});assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').revision,2);
  const w=await ownerAction('payrollWorkspace');await ownerAction('approvePayrollCycle',{id:c.id,version:w.cycles[0].version,previewToken:w.cycles[0].preview.token,confirmed:true});assert.match(state.records.get('PAYROLL_CYCLE:2026-11').batchIds[0],/:2:/);
});
test('disabled automation and nonproduction never send',async()=>{
  seed();await approve();state.records.get('PAYROLL_SETTINGS:payroll').enabled=false;await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
  state.records.get('PAYROLL_SETTINGS:payroll').enabled=true;process.env.COMMISSION_PAYROLL_ENV='staging';await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
});
test('schedule verifies identity, age and Eastern time across daylight saving',()=>{
  assert.throws(()=>verifyPayrollSchedule({...scheduleEvent(),scheduleArn:'forged'}));assert.throws(()=>verifyPayrollSchedule({...scheduleEvent(),scheduledAt:'invalid'}));
  assert.throws(()=>verifyPayrollSchedule({...scheduleEvent(),scheduledAt:'2026-11-19T15:00:00Z'}));
  verifyPayrollSchedule({...scheduleEvent(),scheduledAt:'2026-07-01T12:00:00Z'},NativeDate.parse('2026-07-01T12:00:00Z'));
  verifyPayrollSchedule({...scheduleEvent(),scheduledAt:'2026-11-20T13:00:00Z'},NativeDate.parse('2026-11-20T13:00:00Z'));
});
test('unapproved cycles send only Owner review notices',async()=>{
  seed();await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['owner@example.com']);assert.equal(state.sent[0].details.attachments.length,0);
});
test('approved HR report includes two attachments and sends only once',async()=>{
  seed();const c=await approve();await runWorker(scheduleEvent());await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.equal(state.sent[0].details.attachments.length,2);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['hr@example.com']);assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'APPROVED');
  await assert.rejects(ownerAction('cancelPayrollCycle',{id:c.id,version:c.version,reason:'Too late'}),/conflict/);
});
test('concurrent settings changes prevent a report reservation',async()=>{
  seed();await approve();state.beforeCommit=()=>state.records.set('PAYROLL_SETTINGS:payroll',{...settings(),version:2,enabled:false});await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
});
test('uncertain delivery is held without automatic or manual retry',async()=>{
  seed();await approve();state.sendError=new Error('lost network response');await assert.rejects(runWorker(scheduleEvent()));const d=state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL');assert.equal(d.status,'UNKNOWN');await runWorker(scheduleEvent());assert.equal(state.sent.length,1);await assert.rejects(ownerAction('retryPayrollDelivery',{id:d.id,version:d.version}),/definitely unsent/);
});
test('definite failures retry only when requested and reuse the same envelope',async()=>{
  seed();await approve();state.sendError=new MailDeliveryError('DEFERRED','test');await assert.rejects(runWorker(scheduleEvent()));await runWorker(scheduleEvent());assert.equal(state.sent.length,1);
  const d=state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL');await ownerAction('retryPayrollDelivery',{id:d.id,version:d.version});state.sendError=undefined;await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.equal(state.sent[0].details.idempotencyKey,state.sent[1].details.idempotencyKey);assert.equal(state.sent[0].details.text,state.sent[1].details.text);
});
test('missing batch records block partial reports',async()=>{
  seed();const c=await approve();state.records.delete('BATCH:'+c.batchIds[0]);await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,0);
});
test('overdue reminders do not duplicate on repeated hourly checks',async()=>{
  seed();clock=NativeDate.parse('2026-11-21T15:00:00Z');await runWorker(scheduleEvent());await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.match(state.sent[1].details.subject,/overdue/);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['owner@example.com']);
});
test('accepted reports need no HR acknowledgement to stop delivery reminders',async()=>{
  seed();await approve();await runWorker(scheduleEvent());clock=NativeDate.parse('2026-11-21T15:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,1);
});
test('an unsent report prompts the Owner even when the send itself fails',async()=>{
  seed();await approve();clock=NativeDate.parse('2026-11-21T15:00:00Z');state.sendError=new MailDeliveryError('DEFERRED','test');await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,2);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['owner@example.com']);assert.match(state.sent[1].details.subject,/overdue/);
});
test('payment reminders start after payday and stop when payment is confirmed',async()=>{
  seed();const c=await approve();await runWorker(scheduleEvent());clock=NativeDate.parse('2026-11-28T15:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.match(state.sent[1].details.subject,/overdue/);
  await ownerAction('confirmPayrollCycle',{id:c.id,version:c.version,paidOn:'2026-11-27',paymentReference:'ADP-123',confirmed:true});clock=NativeDate.parse('2026-11-29T15:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,2);
});
test('a stalled delivery is marked uncertain and never sent again',async()=>{
  seed();await approve();state.records.set('PAYROLL_DELIVERY:2026-11:1:PAYROLL',{id:'2026-11:1:PAYROLL',version:1,cycleId:'2026-11',cycleRevision:1,reportType:'PAYROLL',status:'SENDING',recipient:'hr@example.com',subject:'Payroll',text:'Payroll',createdAt:'2026-11-20T13:00:00Z',updatedAt:'2026-11-20T13:00:00Z'});
  await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL').status,'UNKNOWN');assert.equal(state.sent.length,0);
});
test('cancellation racing delivery reservation cannot release sent payroll allocations',async()=>{
  seed();const c=await approve();state.beforeCommit=()=>state.records.set('PAYROLL_DELIVERY:2026-11:1:PAYROLL',{id:'2026-11:1:PAYROLL',version:1,status:'SENDING'});
  await assert.rejects(ownerAction('cancelPayrollCycle',{id:c.id,version:c.version,reason:'Race'}),/conflict/);assert.equal(state.records.get('POLICY:p').entries[0].batchId,c.batchIds[0]);
});
test('a cancelled cycle racing delivery cannot send a stale report',async()=>{
  seed();const c=await approve();state.beforeCommit=()=>state.records.set('PAYROLL_CYCLE:2026-11',{...c,version:c.version+1,status:'CANCELLED'});await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
});
test('lost approval and payment responses can be retried without duplicate writes',async()=>{
  seed();const w=await ownerAction('payrollWorkspace'),request={id:'2026-11',version:1,previewToken:w.cycles[0].preview.token,confirmed:true};await ownerAction('approvePayrollCycle',request);await ownerAction('approvePayrollCycle',request);let c=state.records.get('PAYROLL_CYCLE:2026-11');assert.equal(c.version,2);
  const payment={id:c.id,version:c.version,paidOn:'2026-11-20',paymentReference:'ADP-confirmed',confirmed:true};await ownerAction('confirmPayrollCycle',payment);await ownerAction('confirmPayrollCycle',payment);c=state.records.get('PAYROLL_CYCLE:2026-11');assert.equal(c.version,3);
});
test('multiple producers receive separate earnings records',async()=>{
  const one=earned(),two={...earned(),id:'p2',producerId:'second',producerName:'Second Employee'};
  const a=buildPayrollApproval(cycle(),[one,two],[],{...settings(),employees:[...settings().employees,{producerId:'second',employeeId:'00456',earningsCode:'COM'}]},'owner',new Date().toISOString());assert.equal(a.batches.length,2);assert.equal(a.cycle.totalCents,32000);assert.notEqual(a.batches[0].id,a.batches[1].id);const files=await commissionReportFiles(a.cycle,a.batches);assert.equal(files.length,3);assert.notEqual(files[1].filename,files[2].filename);const oneFile=await commissionReportFiles(a.cycle,a.batches,a.batches[1].id);assert.equal(oneFile.length,1);assert.deepEqual(oneFile[0],files[2]);
});
test('unbatched receipts after the cutoff roll into a later month',()=>{
  let p=earned();p=appendEntry(p,line(),{...statement(),receivedOn:'2026-11-17'},'late');const first=buildPayrollApproval(cycle(),[p],[],settings(),'owner',new Date().toISOString());
  const next={...cycle(),id:'2026-12',cutoff:'2026-12-14',payDate:'2026-12-25'};
  const second=buildPayrollApproval(next,first.policies,first.batches,settings(),'owner','2026-12-15T15:00:00Z');assert.equal(second.cycle.totalCents,16000);assert.equal(second.batches[0].lines[0].entryId,'late');
});
test('approved dates are immutable and a new review is required after delivery setting changes',async()=>{
  seed();const w=await ownerAction('payrollWorkspace');state.records.set('PAYROLL_SETTINGS:payroll',{...settings(),version:2});await assert.rejects(ownerAction('approvePayrollCycle',{id:'2026-11',version:1,previewToken:w.cycles[0].preview.token,confirmed:true}),/settings changed/);
  const c=await approve();await assert.rejects(ownerAction('savePayrollCycle',{...c,payDate:'2026-11-26'}),/frozen/);
});
const apiEvent=(fieldName,operation,role='STAFF',groups=[role])=>({fieldName,identity:{sub:'hr',groups},request:{headers:{'x-crm-role':role}},arguments:{operation,input:{}}});
const ownerApi = (operation,input) => commissionHandler({...apiEvent('commissionAction',operation,'OWNER'),arguments:{operation,input}});
test('every non-Owner view and export contains only that employee and excludes private batch fields',async()=>{
  seed();const c=await approve();const own=state.records.get('POLICY:p');own.agreement='PRIVATE_AGREEMENT';own.carrierTerms.evidence='PRIVATE_CONTRACT';own.reviewHolds=[{note:'PRIVATE_HR_NOTE'}];
  const b=state.records.get('BATCH:'+c.batchIds[0]);b.reference='PRIVATE_PAYROLL_REFERENCE';b.internal='PRIVATE_FUTURE_FIELD';b.lines[0].internal='PRIVATE_LINE_FIELD';
  state.records.set('POLICY:other',{...earned(),id:'other',producerId:'other',producerName:'OTHER_EMPLOYEE',accountName:'OTHER_ACCOUNT'});
  for(const role of ['PRODUCER','STAFF','ADMIN']){
    const event=apiEvent('commissionOverview','',role);event.identity.sub='producer';event.arguments={producerId:'other',input:{producerId:'other'}};
    const result=await commissionHandler(event);assert.equal(result.ok,true);assert.equal(result.policies.length,1);assert.equal(result.batches.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|OTHER_/);
    assert.equal(result.plans,undefined);assert.equal(result.settings,undefined);assert.equal(result.statements,undefined);assert.equal(result.policies[0].reviewHolds,undefined);assert.equal(result.batches[0].reference,undefined);
  }
});
test('stale producer index references cannot expose a newly reassigned record',async()=>{
  seed();state.records.set('POLICY:other',{...earned(),id:'other',producerId:'someone-else',producerName:'PRIVATE_OTHER'});state.staleRefs=[{kind:'POLICY',id:'p'},{kind:'POLICY',id:'other'}];
  const event=apiEvent('commissionOverview','');event.identity.sub='producer';const result=await commissionHandler(event);assert.equal(result.ok,true);assert.equal(result.policies.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OTHER/);
});
test('cancelled batches cannot smuggle another employee policy into an export',async()=>{
  seed();const c=await approve();const b=state.records.get('BATCH:'+c.batchIds[0]);b.status='CANCELLED';state.records.get('POLICY:p').entries[0].batchId=undefined;b.lines[0].policyId='other';b.lines[0].accountName='PRIVATE_OTHER';
  const event=apiEvent('commissionOverview','');event.identity.sub='producer';const result=await commissionHandler(event);assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OTHER/);
});
test('all employee roles are denied private files, reports, and review mutations',async()=>{
  seed();for(const role of ['PRODUCER','STAFF','ADMIN'])for(const op of ['file','downloadPayrollCycle','confirmPayrollEmployee','addCommissionReview','resolveCommissionReview','saveStatement'])assert.equal((await commissionHandler(apiEvent('commissionAction',op,role))).ok,false);
});
test('pending eligibility can be saved as a draft but cannot be posted or paid',async()=>{
  seed();state.records.set('CARRIER:c',commissionPolicy().carrierTerms);
  const input={...statement(),version:0,source:'statements/12345678-1234-1234-1234-123456789abc',lines:[line({reviewStatus:'PENDING',eligible:false})]};
  assert.equal((await ownerApi('saveStatement',input)).ok,true);
  const draft=[...state.records.values()].find(r=>r.status==='DRAFT');assert.equal((await ownerApi('postStatement',{id:draft.id,version:draft.version,confirmed:true})).ok,false);
  const w=await ownerAction('payrollWorkspace');assert.match(w.cycles[0].preview.blockers.join(' '),/Reconcile draft/);
  await assert.rejects(approve(),/Reconcile draft/);
});
test('eligibility decisions must agree with the earnings treatment',()=>{
  assert.throws(()=>appendEntry(commissionPolicy(),line({reviewStatus:'INELIGIBLE',eligible:true}),statement(),'bad'),/disagree/);
  assert.throws(()=>appendEntry(commissionPolicy(),line({reviewStatus:'PENDING'}),statement(),'bad'),/pending eligibility/);
});
test('review items block approval until an Owner resolves them with evidence',async()=>{
  seed();assert.equal((await ownerApi('addCommissionReview',{id:'p',version:1,category:'SEPARATION',note:'Check signed agreement and final-pay timing',dueOn:'2026-11-19'})).ok,true);
  await assert.rejects(approve(),/separation review/);
  let p=state.records.get('POLICY:p');const holdId=p.reviewHolds[0].id;
  assert.equal((await ownerApi('resolveCommissionReview',{id:'p',version:p.version,holdId,resolution:''})).ok,false);
  assert.equal((await ownerApi('resolveCommissionReview',{id:'p',version:p.version,holdId,resolution:'Agreement verified; original bind remains eligible'})).ok,true);
  p=state.records.get('POLICY:p');assert.equal(p.reviewHolds[0].status,'RESOLVED');assert.ok(p.reviewHolds[0].resolvedBy);await approve();
});
test('a new review item invalidates an already reviewed approval preview',async()=>{
  seed();const w=await ownerAction('payrollWorkspace');await ownerApi('addCommissionReview',{id:'p',version:1,category:'DISPUTE',note:'Review original attribution',dueOn:'2026-11-19'});
  await assert.rejects(ownerAction('approvePayrollCycle',{id:'2026-11',version:1,previewToken:w.cycles[0].preview.token,confirmed:true}),/review due/);assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'OPEN');
});
test('a review after approval holds HR delivery until the cycle is replaced and approved again',async()=>{
  seed();await approve();let p=state.records.get('POLICY:p');
  assert.equal((await ownerApi('addCommissionReview',{id:'p',version:p.version,category:'DISPUTE',note:'Check attribution evidence',dueOn:'2026-11-19'})).ok,true);
  await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['owner@example.com']);assert.match(state.sent[0].details.subject,/needs review/);
  p=state.records.get('POLICY:p');await ownerApi('resolveCommissionReview',{id:p.id,version:p.version,holdId:p.reviewHolds[0].id,resolution:'Original attribution confirmed'});
  await runWorker(scheduleEvent());assert.equal(state.sent.length,1);await assert.rejects(ownerAction('downloadPayrollCycle',{id:'2026-11'}),/policy review/);
  let c=state.records.get('PAYROLL_CYCLE:2026-11');await ownerAction('cancelPayrollCycle',{id:c.id,version:c.version,reason:'Fresh review after dispute'});
  c=state.records.get('PAYROLL_CYCLE:2026-11');await ownerAction('savePayrollCycle',{...cycle(),version:c.version});
  const w=await ownerAction('payrollWorkspace');c=w.cycles[0];await ownerAction('approvePayrollCycle',{id:c.id,version:c.version,previewToken:c.preview.token,confirmed:true});
  await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['hr@example.com']);
});
test('a new review racing HR delivery prevents reserving the obsolete report',async()=>{
  seed();await approve();const p=state.records.get('POLICY:p');state.beforeCommit=async()=>assert.equal((await ownerApi('addCommissionReview',{id:p.id,version:p.version,category:'LICENSING',note:'Verify licensing',dueOn:'2026-11-19'})).ok,true);
  await runWorker(scheduleEvent());assert.equal(state.sent.length,0);assert.equal(state.records.has('PAYROLL_DELIVERY:2026-11:1:PAYROLL'),false);
  await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['owner@example.com']);
});
test('a review after HR delivery preserves the sent report and alerts only the Owner',async()=>{
  seed();await approve();await runWorker(scheduleEvent());const p=state.records.get('POLICY:p');await ownerApi('addCommissionReview',{id:p.id,version:p.version,category:'DISPUTE',note:'Coordinate correction with HR',dueOn:'2026-11-19'});
  await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['owner@example.com']);assert.match(state.sent[1].details.text,/cannot be recalled/);
  const c=state.records.get('PAYROLL_CYCLE:2026-11');await assert.rejects(ownerAction('cancelPayrollCycle',{id:c.id,version:c.version,reason:'Already sent'}),/conflict/);assert.equal(state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL').status,'SENT');
});
test('a new review cannot miss a zero-cycle approval committed during its save',async()=>{
  seed();state.records.set('POLICY:p',commissionPolicy());state.beforeCommit=async()=>{await approve();};
  const input={id:'p',version:1,category:'SEPARATION',note:'Verify obligations',dueOn:'2026-11-19'};
  assert.equal((await ownerApi('addCommissionReview',input)).ok,false);assert.equal(state.records.get('POLICY:p').reviewHolds,undefined);
  assert.equal((await ownerApi('addCommissionReview',input)).ok,true);assert.ok(state.records.get('PAYROLL_CYCLE:2026-11').reviewRequired);
});
test('a reviewed zero-commission month produces a report without inventing employee amounts',async()=>{
  seed();state.records.delete('POLICY:p');const c=await approve();assert.equal(c.totalCents,0);assert.deepEqual(c.batchIds,[]);await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.match(state.sent[0].details.text,/\$0\.00/);assert.equal(state.sent[0].details.attachments.length,1);
});
test('approval cannot race a newly saved or posted reconciliation, including a zero report',async()=>{
  for(const zero of [false,true]){
    state.records.clear();seed();if(zero)state.records.delete('POLICY:p');const w=await ownerAction('payrollWorkspace');
    state.beforeCommit=()=>state.records.set('PAYROLL_STATE:reconciliation',{id:'reconciliation',version:1});
    await assert.rejects(ownerAction('approvePayrollCycle',{id:'2026-11',version:1,previewToken:w.cycles[0].preview.token,confirmed:true}),/conflict/);assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'OPEN');
  }
});
test('due review items prevent a zero report from concealing an unresolved obligation',async()=>{
  seed();state.records.set('POLICY:p',commissionPolicy());await ownerApi('addCommissionReview',{id:'p',version:1,category:'SEPARATION',note:'Verify unpaid receipts',dueOn:'2026-11-18'});await assert.rejects(approve(),/separation review/);
});
test('import, review, receipt posting, approval, HR report and payment run together',async()=>{
  seed();state.records.set('POLICY:p',commissionPolicy());state.records.set('CARRIER:c',commissionPolicy().carrierTerms);
  const rows=parseStatementCsv('Policy,Ref,Amount,Effective\nPOL-1,IMPORT-1,"1,234.56",2026-01-01');const imported=prepareStatementImport(rows,importMapping,[commissionPolicy()],'c');
  const input={...statement(),version:0,reference:'IMPORT-NOV',receivedOn:'2026-11-16',source:'statements/12345678-1234-1234-1234-123456789abc',totalCents:123456,lines:imported.lines.map(l=>({...l,reviewStatus:'ELIGIBLE',eligible:true,eligibilityNote:'Signed agreement, licensing, transaction and settlement verified'}))};
  assert.equal((await ownerApi('saveStatement',input)).ok,true);const draft=[...state.records.values()].find(r=>r.status==='DRAFT');assert.equal((await ownerApi('postStatement',{id:draft.id,version:draft.version,confirmed:true})).ok,true);
  const c=await approve();assert.equal(c.totalCents,19753);await runWorker(scheduleEvent());assert.match(Buffer.from(state.sent[0].details.attachments[0].content).toString(),/^%PDF/);
  await ownerAction('confirmPayrollCycle',{id:c.id,version:c.version,paidOn:'2026-11-20',paymentReference:'TEST-PAID',confirmed:true});assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'PAID');assert.equal(state.records.get('PAYROLL_STATE:reconciliation').version,3);
});
test('missing calendars notify only the Owner and stop once a cycle is configured',async()=>{
  clock=NativeDate.parse('2026-11-21T15:00:00Z');seed();state.records.delete('PAYROLL_CYCLE:2026-11');await runWorker(scheduleEvent());await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['owner@example.com']);assert.match(state.sent[0].details.subject,/calendar missing/);assert.equal(state.sent[0].details.attachments.length,0);
  state.records.set('PAYROLL_CYCLE:2026-11',cycle());await approve();await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['hr@example.com']);
});
test('calendar reminders cannot race a newly configured calendar',async()=>{
  clock=NativeDate.parse('2026-11-21T15:00:00Z');seed();state.records.delete('PAYROLL_CYCLE:2026-11');state.beforeCommit=()=>state.records.set('PAYROLL_CYCLE:2026-11',cycle());await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
});
test('failed reminder retries from an earlier day retain their original identity',async()=>{
  clock=NativeDate.parse('2026-11-21T15:00:00Z');seed();state.records.delete('PAYROLL_CYCLE:2026-11');state.sendError=new MailDeliveryError('DEFERRED','test');await assert.rejects(runWorker(scheduleEvent()));
  const d=state.records.get('PAYROLL_DELIVERY:2026-11:0:CALENDAR:2026-11-21');await ownerAction('retryPayrollDelivery',{id:d.id,version:d.version});state.sendError=undefined;clock=NativeDate.parse('2026-11-22T15:00:00Z');await runWorker(scheduleEvent());assert.equal(state.records.get('PAYROLL_DELIVERY:'+d.id).status,'SENT');assert.equal(state.sent[1].details.idempotencyKey,state.sent[0].details.idempotencyKey);
});
test('individual employee payment records do not mark other employees paid',async()=>{
  seed();state.records.set('POLICY:p2',{...earned(),id:'p2',producerId:'second',producerName:'Second'});state.records.get('PAYROLL_SETTINGS:payroll').employees.push({producerId:'second',employeeId:'002',earningsCode:'COM'});let c=await approve();await runWorker(scheduleEvent());
  const first={id:c.id,version:c.version,batchId:c.batchIds[0],paidOn:'2026-11-20',paymentReference:'PAY-A',confirmed:true};await ownerAction('confirmPayrollEmployee',first);await ownerAction('confirmPayrollEmployee',first);c=state.records.get('PAYROLL_CYCLE:2026-11');assert.equal(c.status,'APPROVED');assert.equal(state.records.get('BATCH:'+c.batchIds[1]).status,'APPROVED');
  await ownerAction('confirmPayrollCycle',{id:c.id,version:c.version,paidOn:'2026-11-20',paymentReference:'PAY-B',confirmed:true});assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').status,'PAID');assert.equal(state.records.get('BATCH:'+c.batchIds[0]).reference,'PAY-A');assert.equal(state.records.get('BATCH:'+c.batchIds[1]).reference,'PAY-B');
});
test('full-cycle payment retry preserves different employee payment dates and references',async()=>{
  seed();state.records.set('POLICY:p2',{...earned(),id:'p2',producerId:'second',producerName:'Second'});state.records.get('PAYROLL_SETTINGS:payroll').employees.push({producerId:'second',employeeId:'002',earningsCode:'COM'});let c=await approve();
  await ownerAction('confirmPayrollEmployee',{id:c.id,version:c.version,batchId:c.batchIds[0],paidOn:'2026-11-20',paymentReference:'PAY-A',confirmed:true});c=state.records.get('PAYROLL_CYCLE:2026-11');
  const input={id:c.id,version:c.version,paidOn:'2026-11-19',paymentReference:'PAY-B',confirmed:true};await ownerAction('confirmPayrollCycle',input);await ownerAction('confirmPayrollCycle',input);
  assert.equal(state.records.get('PAYROLL_CYCLE:2026-11').paidOn,'2026-11-20');assert.equal(state.records.get('BATCH:'+c.batchIds[1]).actualPaidOn,'2026-11-19');assert.equal(state.records.get('BATCH:'+c.batchIds[0]).reference,'PAY-A');
});
test('CSV import preserves quoted fields, embedded newlines, BOM and cents',()=>{
  const rows=parseStatementCsv('\uFEFFPolicy,Ref,Amount,Note\r\nPOL-1,NEW-1,"$1,234.56","quoted ""note""\nsecond line"\r\n');assert.equal(rows[1][3],'quoted "note"\nsecond line');assert.equal(importedMoney(rows[1][2]),123456);assert.equal(importedMoney('($1,234.56)'),-123456);
  for(const value of ['1,23','1e4','=1+2','1.234','--1'])assert.throws(()=>importedMoney(value));assert.throws(()=>parseStatementCsv('a,b\n"unclosed'));assert.throws(()=>parseStatementCsv('a,b\n"x"oops,y'));
});
const importMapping={policy:0,reference:1,amount:2,effective:3,transaction:-1};
test('statement imports match only exact carrier policy terms and always require eligibility review',()=>{
  const p=commissionPolicy(),rows=parseStatementCsv('Policy,Ref,Amount,Effective\nPOL-1,NEW-1,100.25,2026-01-01');const result=prepareStatementImport(rows,importMapping,[p,{...p,id:'other',carrierId:'other'}],'c');assert.deepEqual(result.errors,[]);assert.equal(result.lines[0].policyId,'p');assert.equal(result.lines[0].agencyCents,10025);assert.equal(result.lines[0].reviewStatus,'PENDING');assert.equal(result.lines[0].sourceRow,2);
  const ambiguous=prepareStatementImport(rows,{...importMapping,effective:-1},[p,{...p,id:'renewal',effectiveDate:'2027-01-01'}],'c');assert.equal(ambiguous.lines[0].policyId,'');assert.equal(ambiguous.warnings.length,1);
});
test('imports detect duplicates in the whole file and previously posted carrier transactions',()=>{
  const duplicate=parseStatementCsv('Policy,Ref,Amount,Effective\nPOL-1,TX-2,10,2026-01-01\nPOL-1,tx-2,10,2026-01-01');assert.match(prepareStatementImport(duplicate,importMapping,[earned()],'c',1,1).errors.join(' '),/duplicated/);
  const posted=parseStatementCsv('Policy,Ref,Amount,Effective\nPOL-1,TX-1,10,2026-01-01');assert.match(prepareStatementImport(posted,importMapping,[earned()],'c').errors.join(' '),/already posted/);
});
test('imports reject unsupported transactions and invalid dates rather than assigning earnings',()=>{
  const rows=parseStatementCsv('Policy,Ref,Amount,Effective,Type\nPOL-1,T-1,10,2026-01-01,ENDORSEMENT\nPOL-1,T-2,10,2026-02-30,RECEIPT');const result=prepareStatementImport(rows,{...importMapping,transaction:4},[commissionPolicy()],'c');assert.equal(result.lines.length,0);assert.equal(result.errors.length,2);
});
const definition = (patch={}) => ({id:'standard',version:0,name:'Standard plan',newBps:2000,renewalBps:1000,agreement:'Approved plan document',archived:false,gim:{newBps:1000,renewalBps:500,agreement:'GIM document'},...patch});
const assignment = (patch={}) => ({id:'assignment-one',planId:'standard',planVersion:1,from:'2026-10-01',agreement:'Individual signed agreement',accountBoundFrom:'2026-10-01',receiptsFrom:'2026-10-01',...patch});
async function setupPlan(){state.roster.set('Communication:eligibility:producer',{data:{userId:'producer',name:'Avery'}});assert.equal((await ownerApi('saveCommissionPlan',definition())).ok,true);}
const assign=(rows,version=0)=>ownerApi('savePlanAssignments',{producerId:'producer',name:'Avery',version,assignments:rows});
test('plans are reusable and employee dates and eligibility are stored on assignments',async()=>{
  await setupPlan();assert.equal((await assign([assignment()])).ok,true);
  state.roster.set('Communication:eligibility:other',{data:{userId:'other',name:'Other'}});
  assert.equal((await ownerApi('savePlanAssignments',{producerId:'other',version:0,assignments:[assignment({id:'other-assignment',from:'2026-11-01',accountBoundFrom:'',receiptsFrom:''})]})).ok,true);
  assert.equal(state.records.get('PLAN_DEFINITION:standard').from,undefined);assert.equal(state.records.get('PLAN:producer').terms[0].newBps,2000);assert.equal(state.records.get('PLAN:other').terms[0].accountBoundFrom,undefined);
});
test('a producer cannot have overlapping or duplicate assignments, including the same endpoint date',async()=>{
  await setupPlan();
  for(const rows of [[assignment(),assignment({id:'two',from:'2026-11-01'})],[assignment({to:'2026-11-01'}),assignment({id:'two',from:'2026-11-01'})],[assignment({to:'2026-10-31'}),assignment({from:'2026-11-01'})]])assert.equal((await assign(rows)).ok,false);
  assert.equal(state.records.has('PLAN:producer'),false);
  assert.equal((await assign([assignment({to:'2026-10-31'}),assignment({id:'two',from:'2026-11-01'})])).ok,true);
});
test('plan edits do not rewrite an assigned rate and a dated new version applies only in its period',async()=>{
  await setupPlan();await assign([assignment({accountBoundFrom:'',receiptsFrom:''})]);
  await ownerApi('saveCommissionPlan',definition({version:1,newBps:2500}));const old=state.records.get('PLAN:producer');assert.equal(old.terms[0].newBps,2000);
  assert.equal((await assign([assignment({to:'2026-11-30',accountBoundFrom:'',receiptsFrom:''}),assignment({id:'second',planVersion:2,from:'2026-12-01',accountBoundFrom:'',receiptsFrom:''})],1)).ok,true);
  const p=state.records.get('PLAN:producer');assert.equal(selectCommissionTerms(p,commissionAccount(),'2026-11-30','NEW').producerBps,2000);assert.equal(selectCommissionTerms(p,commissionAccount(),'2026-12-01','NEW').producerBps,2500);assert.equal(selectCommissionTerms(p,commissionAccount(),'2026-12-01','RENEWAL').producerBps,1000);
  assert.equal(selectCommissionTerms(p,commissionAccount(),'2026-12-01','NEW').assignment.planVersion,2);
  assert.throws(()=>selectCommissionTerms(p,commissionAccount(),'2026-09-30','NEW'),/assign a commission plan/);
});
test('assignment-level first-bind and receipt cutoffs retain the historical exclusion',async()=>{
  await setupPlan();await assign([assignment()]);const p=state.records.get('PLAN:producer');
  const excluded=selectCommissionTerms(p,commissionAccount(),'2026-09-01','NEW','2026-09-01');assert.equal(excluded.producerBps,0);assert.equal(excluded.eligibility.eligible,false);
  const included=selectCommissionTerms(p,commissionAccount(),'2026-10-01','RENEWAL','2026-10-01');assert.equal(included.producerBps,1000);assert.equal(included.receiptsFrom,'2026-10-01');assert.throws(()=>selectCommissionTerms(p,commissionAccount(),'2026-10-01','NEW'),/first bind history/);
});
test('archiving a reusable plan stops new assignments without cancelling existing ones',async()=>{
  await setupPlan();await assign([assignment()]);await ownerApi('saveCommissionPlan',definition({version:1,archived:true}));
  assert.equal((await assign([assignment({to:'2026-12-31'})],1)).ok,true);
  assert.equal((await assign([assignment(),assignment({id:'new',planVersion:2,from:'2027-01-01'})],2)).ok,false);
});
test('assignment save guards against concurrent definition and employee edits',async()=>{
  await setupPlan();state.beforeCommit=()=>state.records.set('PLAN_DEFINITION:standard',{...definition(),version:2,newBps:3000});
  assert.equal((await assign([assignment()])).ok,false);assert.equal(state.records.has('PLAN:producer'),false);
  assert.equal((await assign([assignment({planVersion:2})])).ok,true);assert.equal((await assign([assignment({planVersion:2})],0)).ok,false);
});
test('legacy agreements can transition to a reusable plan without losing old rates or eligibility',async()=>{
  await setupPlan();state.records.set('PLAN:producer',{id:'producer',producerId:'producer',name:'Avery',version:1,accountBoundFrom:'2026-10-01',receiptsFrom:'2026-10-01',terms:[{from:'2026-10-01',newBps:1600,renewalBps:800,agreement:'Legacy signed agreement',gim:{newBps:500,renewalBps:250,agreement:'Legacy GIM addendum'}}]});
  assert.equal((await assign([assignment({id:'legacy:0',planId:'',planVersion:0,to:'2026-11-30'}),assignment({id:'new',from:'2026-12-01',accountBoundFrom:'',receiptsFrom:''})],1)).ok,true);
  const p=state.records.get('PLAN:producer');assert.equal(p.accountBoundFrom,undefined);assert.equal(p.terms[0].newBps,1600);assert.equal(p.terms[0].gim.agreement,'Legacy GIM addendum');assert.equal(p.terms[0].accountBoundFrom,'2026-10-01');assert.equal(p.terms[1].accountBoundFrom,undefined);
  assert.equal((await ownerApi('savePlan',{...p,version:2})).ok,false);
});
test('reusable plan setup and assignments remain Owner-only',async()=>{
  for(const role of ['PRODUCER','STAFF','ADMIN'])for(const operation of ['saveCommissionPlan','savePlanAssignments','initializePayrollCalendar'])assert.equal((await commissionHandler({...apiEvent('commissionAction',operation,role),arguments:{operation,input:definition()}})).ok,false);
  seed();await setupPlan();const event=apiEvent('commissionOverview','','PRODUCER');event.identity.sub='producer';const view=await commissionHandler(event);assert.equal(view.planDefinitions,undefined);assert.doesNotMatch(JSON.stringify(view),/Approved plan document/);
});
test('calendar initialization starts in October and preserves saved dates and disabled delivery',async()=>{
  await ownerAction('initializePayrollCalendar');const october=state.records.get('PAYROLL_CYCLE:2026-10');assert.equal(october.cutoff,'2026-10-23');assert.equal(october.processingOn,'2026-10-26');assert.equal(october.hrDueOn,'2026-10-26');assert.equal(october.payDate,'2026-10-30');assert.equal(state.records.has('PAYROLL_CYCLE:2026-09'),false);assert.equal(state.records.get('PAYROLL_SETTINGS:payroll').enabled,false);
  state.records.get('PAYROLL_CYCLE:2026-12').payDate='2026-12-24';await ownerAction('initializePayrollCalendar');assert.equal(state.records.get('PAYROLL_CYCLE:2026-12').payDate,'2026-12-24');assert.equal(state.records.get('PAYROLL_CYCLE:2026-10').version,1);
});
test('Friday EOD cutoff includes Friday receipts and excludes Saturday, with HR delivery Monday at 8 AM',async()=>{
  seed();const c=validatePayrollCycle({...suggestPayrollDates('2026-11'),version:1});state.records.set('PAYROLL_CYCLE:2026-11',c);
  let p=appendEntry(commissionPolicy(),line(),{...statement(),receivedOn:'2026-11-20'},'friday');p=appendEntry(p,line(),{...statement(),receivedOn:'2026-11-21'},'saturday');state.records.set('POLICY:p',p);
  clock=NativeDate.parse('2026-11-21T04:59:00Z');await assert.rejects(approve(),/cutoff/);
  clock=NativeDate.parse('2026-11-21T05:00:00Z');const approved=await approve();assert.equal(approved.totalCents,16000);assert.equal(state.records.get('POLICY:p').entries[1].batchId,undefined);
  clock=NativeDate.parse('2026-11-22T13:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,0);
  clock=NativeDate.parse('2026-11-23T13:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['hr@example.com']);
});
test('missing approval on processing morning alerts Jake without sending unapproved earnings to HR',async()=>{
  seed();state.records.set('PAYROLL_CYCLE:2026-11',validatePayrollCycle({...suggestPayrollDates('2026-11'),version:1}));clock=NativeDate.parse('2026-11-23T13:00:00Z');await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].command.Destination.ToAddresses,['owner@example.com']);assert.match(state.sent[0].details.subject,/overdue/);
});
function pdfText(bytes) {
  return [...Buffer.from(bytes).toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap(m=>{
    let data;try{data=inflateSync(Buffer.from(m[1],'latin1')).toString('latin1');}catch{return [];}
    return [...data.matchAll(/<([A-Fa-f0-9]+)>\s*Tj/g)].map(t=>Buffer.from(t[1],'hex').toString('latin1'));
  }).join('\n');
}
test('separate pay-file PDFs never include another employee, amounts or internal payment references',async()=>{
  const a=buildPayrollApproval(cycle(),[earned(),{...earned(),id:'p2',producerId:'other',producerName:'OTHER_PRIVATE_EMPLOYEE',accountName:'OTHER_PRIVATE_ACCOUNT'}],[],settings(),'owner',new Date().toISOString());a.batches[0].reference='PRIVATE_PAYROLL_RUN';
  const files=await commissionReportFiles(a.cycle,a.batches);const own=pdfText(files.find(f=>f.filename.includes('Avery')).content);assert.match(own,/Avery/);assert.match(own,/\$160\.00/);assert.doesNotMatch(own,/OTHER_PRIVATE|PRIVATE_PAYROLL_RUN|\$320\.00/);assert.match(pdfText(files[0].content),/\$320\.00/);
  const large={...a.batches[0],lines:Array.from({length:75},(_,i)=>({...a.batches[0].lines[0],entryId:'receipt-'+i})),totalCents:75*16000};const largeCycle={...a.cycle,batchIds:[large.id],totalCents:large.totalCents};const pages=await commissionReportFiles(largeCycle,[large]);assert.ok((await PDFDocument.load(pages[1].content)).getPageCount()>1);assert.match(pdfText(pages[1].content),/receipt-74/);
  if(process.env.COMMISSION_REPORT_PREVIEW_DIR){mkdirSync(process.env.COMMISSION_REPORT_PREVIEW_DIR,{recursive:true});for(const f of files)writeFileSync(join(process.env.COMMISSION_REPORT_PREVIEW_DIR,f.filename),f.content);for(const f of pages)writeFileSync(join(process.env.COMMISSION_REPORT_PREVIEW_DIR,'Long_'+f.filename),f.content);}
});
test('payroll remains on the existing Owner endpoint',async()=>{
  seed();for(const op of ['payrollWorkspace','downloadPayrollCycle','confirmPayrollCycle','savePlan','saveStatement','postStatement','savePayrollSettings','approvePayrollCycle','cancelPayrollCycle'])assert.equal((await commissionHandler(apiEvent('commissionAction',op))).ok,false);
  assert.equal((await commissionHandler(apiEvent('commissionAction','payrollWorkspace','OWNER'))).ok,true);
});
test('no separate HR payroll endpoint is exposed',async()=>{
  seed();assert.equal((await commissionHandler(apiEvent('commissionPayroll','payrollWorkspace','OWNER'))).ok,false);
});
test('forged Owner headers and an Owner in Admin view cannot approve payroll',async()=>{
  seed();assert.equal((await commissionHandler(apiEvent('commissionAction','approvePayrollCycle','OWNER',['STAFF']))).ok,false);
  assert.equal((await commissionHandler(apiEvent('commissionAction','approvePayrollCycle','ADMIN',['OWNER','ADMIN']))).ok,false);
});
test('disabled Owner sessions are rejected before payroll reads',async()=>{
  seed();state.disabled=true;const result=await commissionHandler(apiEvent('commissionAction','payrollWorkspace','OWNER'));assert.equal(result.ok,false);assert.match(result.error,/Inactive session/);
});
test('preview allows only Owner workspace reads and cannot bypass mutation hold',async()=>{
  seed();process.env.HOA_MIGRATION_PREVIEW='true';assert.equal((await commissionHandler(apiEvent('commissionAction','payrollWorkspace','OWNER'))).ok,true);
  await assert.rejects(commissionHandler(apiEvent('commissionAction','confirmPayrollCycle','OWNER')),/disabled/);
  await assert.rejects(commissionHandler(apiEvent('bindCommissionPolicy','payrollWorkspace')),/disabled/);
});

const currentCycle = () => state.records.get('PAYROLL_CYCLE:2026-11');
const currentBatch = () => state.records.get('BATCH:'+currentCycle().batchIds[0]);
const partial = (amountCents=6000, paymentId='part-1') => ownerAction('confirmPayrollEmployee',{id:'2026-11',version:currentCycle().version,batchId:currentBatch().id,paidOn:'2026-11-20',paymentReference:'PAY-1',amountCents,paymentId,confirmed:true});
const ownerUser = (id,email=`${id}@example.com`) => ({Enabled:true,Attributes:[{Name:'sub',Value:id},{Name:'email',Value:email}]});
const digest = v => createHash('sha256').update(v).digest('hex');
function feedback(delivery, types=['Bounce']) {
  const key=`OP#hoa/main/report/${digest(`commission-payroll:${delivery.id}`)}`;
  state.receipts.set(`RECEIPT#ses#${delivery.messageId}`,{kind:'RECEIPT',provider:'ses',environment:'main',mailKind:'report',providerId:delivery.messageId,operationKey:key,operationHash:digest(key),recipientHashes:[digest(delivery.recipient)],feedbackEventTypes:new Set(types),lastFeedbackObservedAt:new Date().toISOString()});
}
test('partial payments retain the balance, reject excess and duplicate IDs, and complete only the remainder',async()=>{
  seed();await approve();await partial();assert.equal(batchPaidCents(currentBatch()),6000);assert.equal(currentBatch().status,'APPROVED');assert.equal(currentCycle().status,'APPROVED');
  await partial();assert.equal(currentBatch().payments.length,1);
  await assert.rejects(partial(7000),/already used/);await assert.rejects(partial(10001,'part-2'),/payment amount/);await assert.rejects(partial(0,'part-2'));
  await partial(10000,'part-2');assert.equal(currentBatch().status,'PAID');assert.equal(currentCycle().status,'PAID');assert.equal(currentBatch().payments.length,2);assert.equal(batchPaidCents(currentBatch()),16000);
});
test('full-cycle confirmation preserves earlier partial payment records',async()=>{
  seed();await approve();await partial();const first=structuredClone(currentBatch().payments[0]);
  await ownerAction('confirmPayrollCycle',{id:'2026-11',version:currentCycle().version,paidOn:'2026-11-20',paymentReference:'FINAL',confirmed:true});
  assert.deepEqual(currentBatch().payments[0],first);assert.equal(currentBatch().payments[1].amountCents,10000);assert.equal(batchPaidCents(currentBatch()),16000);
});
test('paid amounts prevent cancellation and report replacement, including partial payments',async()=>{
  seed();await approve();await partial();
  for(const operation of ['cancelPayrollCycle','reopenPayrollCycle'])await assert.rejects(ownerAction(operation,{id:'2026-11',version:currentCycle().version,reason:'Correction',hrHeld:true}),/unpaid/);
});
test('partial payments are visible to their employee without internal payment references',async()=>{
  seed();await approve();await partial();const event=apiEvent('commissionOverview','','PRODUCER');event.identity.sub='producer';
  const result=await commissionHandler(event);assert.equal(result.ok,true);assert.equal(result.batches[0].paidCents,6000);assert.deepEqual(result.batches[0].payments,[{id:'1',amountCents:6000,paidOn:'2026-11-20'}]);assert.doesNotMatch(JSON.stringify(result),/PAY-1/);
});
test('partially paid reversals require allocation review instead of assuming all or no wages were paid',async()=>{
  seed();await approve();await partial();const policy=appendEntry(state.records.get('POLICY:p'),line({kind:'REVERSAL',agencyCents:-50000,originalId:'receipt'}),{...statement(),receivedOn:'2026-11-20'},'reversal');
  assert.deepEqual(recoveryBalances(policy,[currentBatch()]),{paidRecovery:0,unpaidAdjustment:0,partialAdjustment:8000});
});
test('approval archives exact PDFs, and payment changes cannot rewrite approved documents',async()=>{
  seed();await approve();const before=await ownerAction('downloadPayrollCycle',{id:'2026-11'});await partial();const after=await ownerAction('downloadPayrollCycle',{id:'2026-11'});
  assert.deepEqual(before.files,after.files);assert.equal(before.files.length,2);assert.match(before.files[0].filename,/_v1\.pdf$/);
  assert.equal([...state.records.keys()].filter(k=>k.startsWith('PAYROLL_ACCESS:')).length,2);
});
test('tampered archived PDF bytes and snapshot totals are rejected',async()=>{
  seed();await approve();const report=state.records.get('PAYROLL_REPORT:2026-11:1');const file=state.records.get('PAYROLL_REPORT_FILE:'+report.documents[0].id);file.content='bad';
  await assert.rejects(ownerAction('downloadPayrollCycle',{id:'2026-11'}));report.cycle.totalCents++;
  await assert.rejects(ownerAction('downloadPayrollCycle',{id:'2026-11'}),/integrity/);
});
test('sent report correction requires HR hold and retains old PDFs through a new approval',async()=>{
  seed();await approve();await runWorker(scheduleEvent());const old=(await ownerAction('downloadPayrollCycle',{id:'2026-11'})).files;
  const input={id:'2026-11',version:currentCycle().version,reason:'Late receipt correction'};
  await assert.rejects(ownerAction('reopenPayrollCycle',input),/HR has held/);
  await ownerAction('reopenPayrollCycle',{...input,hrHeld:true});assert.equal(currentCycle().revision,2);assert.equal(currentCycle().status,'OPEN');assert.equal(currentCycle().hrHeldBy,'owner');assert.equal(state.records.get('POLICY:p').entries[0].batchId,undefined);
  await assert.rejects(ownerAction('downloadPayrollCycle',{id:'2026-11',revision:1}),/historical/);
  const historical=await ownerAction('downloadPayrollCycle',{id:'2026-11',revision:1,historicalConfirmed:true});assert.deepEqual(historical.files.map(f=>f.content),old.map(f=>f.content));
  const w=await ownerAction('payrollWorkspace');await ownerAction('approvePayrollCycle',{id:'2026-11',version:currentCycle().version,previewToken:w.cycles[0].preview.token,confirmed:true});
  await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.match(state.sent[1].details.text,/REPLACES revision 1/);assert.match(state.sent[1].details.attachments[0].filename,/_v2\.pdf$/);
});
test('unknown or in-flight originals cannot be replaced even with an HR confirmation',async()=>{
  seed();await approve();for(const status of ['UNKNOWN','SENDING']){state.records.set('PAYROLL_DELIVERY:2026-11:1:PAYROLL',{id:'2026-11:1:PAYROLL',version:1,status});await assert.rejects(ownerAction('reopenPayrollCycle',{id:'2026-11',version:currentCycle().version,reason:'Correction',hrHeld:true}),/uncertain/);}
});
test('an off-cycle run includes only selected employees and reserves earnings against monthly duplication',async()=>{
  seed();state.records.set('POLICY:other',{...earned(),id:'other',producerId:'other'});
  const id='2026-11-OFF-12345678';await ownerAction('savePayrollCycle',{...cycle(),id,version:0,producerIds:['producer'],reason:'Supplemental payroll'});
  let w=await ownerAction('payrollWorkspace');let c=w.cycles.find(c=>c.id===id);assert.equal(c.preview.totalCents,16000);assert.equal(c.preview.employees.length,1);
  await ownerAction('approvePayrollCycle',{id,version:c.version,confirmed:true,previewToken:c.preview.token});
  w=await ownerAction('payrollWorkspace');assert.equal(w.cycles.find(c=>c.id==='2026-11').preview.totalCents,16000);await runWorker(scheduleEvent());
  assert.equal(state.sent.filter(s=>s.details.attachments.length).length,1);assert.match(state.sent.find(s=>s.details.attachments.length).details.attachments[0].filename,/OFF-12345678/);
});
test('off-cycle validation requires a reason, selected employees, and dates in its month',()=>{
  const c={...cycle(),id:'2026-11-OFF-12345678',reason:'Correction',producerIds:['producer']};
  for(const patch of [{reason:''},{producerIds:[]},{payDate:'2026-12-01'}])assert.throws(()=>validatePayrollCycle({...c,...patch}));
});
test('legacy direct batch creation and payment cannot bypass the approved HR report',async()=>{
  seed();assert.equal((await ownerApi('preparePayroll',{producerId:'producer',requestId:'old',cutoff:'2026-11-16',payDate:'2026-11-20'})).ok,false);
  state.records.set('BATCH:old',{id:'old',version:1,status:'APPROVED',totalCents:16000,lines:[]});assert.equal((await ownerApi('payPayroll',{id:'old',version:1,reference:'PAY',payDate:'2026-11-20'})).ok,false);
});
test('HR bounce sends each active Owner exactly one copy with the original PDFs',async()=>{
  seed();await approve();await runWorker(scheduleEvent());const source=state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL');feedback(source);
  state.owners=[ownerUser('one'),ownerUser('two'),ownerUser('three'),ownerUser('disabled'),{...ownerUser('off'),Enabled:false}];state.disabledOwners.add('disabled');
  await runWorker(scheduleEvent());assert.equal(state.sent.length,4);assert.deepEqual(state.sent.slice(1).map(s=>s.command.Destination.ToAddresses),[['one@example.com'],['two@example.com'],['three@example.com']]);
  for(const send of state.sent.slice(1)){assert.deepEqual(send.details.attachments,state.sent[0].details.attachments);assert.match(send.details.text,/not an additional payment/);}
  await runWorker(scheduleEvent());assert.equal(state.sent.length,4);assert.deepEqual(state.records.get('PAYROLL_DELIVERY:'+source.id).feedback,['Bounce']);
});
test('one failed Owner copy does not prevent other copies and only explicitly requested retries send again',async()=>{
  seed();await approve();await runWorker(scheduleEvent());feedback(state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL'));state.owners=[ownerUser('one'),ownerUser('two')];
  state.sendError=command=>command.Destination.ToAddresses[0]==='one@example.com'?new MailDeliveryError('DEFERRED','op'):undefined;
  await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,3);
  const failed=[...state.records.values()].find(r=>r.reportType==='OWNER_COPY'&&r.status==='FAILED');state.sendError=undefined;
  await runWorker(scheduleEvent());assert.equal(state.sent.length,3);await ownerAction('retryPayrollDelivery',{id:failed.id,version:failed.version});await runWorker(scheduleEvent());assert.equal(state.sent.length,4);
});
test('feedback from another message or recipient cannot trigger Owner copies',async()=>{
  seed();await approve();await runWorker(scheduleEvent());const source=state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL');feedback(source);state.owners=[ownerUser('one')];
  state.receipts.get('RECEIPT#ses#'+source.messageId).recipientHashes=[digest('someone-else@example.com')];await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,1);
});
test('Owner-copy bounces are visible and never recursively forwarded',async()=>{
  seed();await approve();await runWorker(scheduleEvent());feedback(state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL'));state.owners=[ownerUser('one')];await runWorker(scheduleEvent());
  const copy=[...state.records.values()].find(r=>r.reportType==='OWNER_COPY');feedback(copy);await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,2);
});
test('late bounce feedback on a paid cycle still produces Owner copies without reopening payment',async()=>{
  seed();await approve();await runWorker(scheduleEvent());feedback(state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL'));await partial(16000);state.owners=[ownerUser('one')];
  await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.equal(currentCycle().status,'PAID');assert.match(state.sent[1].details.text,/Current status when copied: PAID/);
});
test('review-notice bounces also reach Owners without inventing payroll attachments',async()=>{
  seed();clock=NativeDate.parse('2026-11-18T15:00:00Z');await runWorker(scheduleEvent());feedback(state.records.get('PAYROLL_DELIVERY:2026-11:1:REVIEW'));state.owners=[ownerUser('one')];
  await runWorker(scheduleEvent());assert.equal(state.sent.length,2);assert.equal(state.sent[1].details.attachments.length,0);
});
test('a missing Owner email raises review while reachable Owners still receive their copies',async()=>{
  seed();await approve();await runWorker(scheduleEvent());feedback(state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL'));state.owners=[ownerUser('one'),ownerUser('bad','')];
  await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,2);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['one@example.com']);
});
test('new payroll history, corrections and partial-payment actions remain Owner-only',async()=>{
  for(const operation of ['payrollAudit','reopenPayrollCycle','confirmPayrollEmployee','downloadPayrollCycle'])await assert.rejects(payrollAction({},'other',false,operation,{}),/active Owner/);
});
test('interrupted delivery acceptance is reconciled from the durable operation without resending',async()=>{
  seed();await approve();state.sendError=new MailDeliveryError('UNKNOWN','op');await assert.rejects(runWorker(scheduleEvent()));state.sendError=undefined;
  const d=state.records.get('PAYROLL_DELIVERY:2026-11:1:PAYROLL'),key=`OP#hoa/main/report/${digest(`commission-payroll:${d.id}`)}`;
  state.receipts.set(key,{pk:key,kind:'OPERATION',state:'ACCEPTED',provider:'ses',environment:'main',mailKind:'report',providerId:'confirmed-original'});
  await runWorker(scheduleEvent());assert.equal(state.sent.length,1);assert.equal(state.records.get('PAYROLL_DELIVERY:'+d.id).status,'SENT');assert.equal(state.records.get('PAYROLL_DELIVERY:'+d.id).messageId,'confirmed-original');
});
test('suppressed HR recipient escalates to Owners without retrying the original',async()=>{
  seed();await approve();state.owners=[ownerUser('one')];state.sendError=command=>command.Destination.ToAddresses[0]==='hr@example.com'?new MailDeliveryError('SUPPRESSED','op'):undefined;
  await assert.rejects(runWorker(scheduleEvent()));assert.equal(state.sent.length,2);assert.deepEqual(state.sent[1].command.Destination.ToAddresses,['one@example.com']);
  await runWorker(scheduleEvent());assert.equal(state.sent.length,2);
});
test('completed payroll downloads require historical acknowledgement and keep their original bytes',async()=>{
  seed();await approve();const original=await ownerAction('downloadPayrollCycle',{id:'2026-11'});await partial(16000);
  await assert.rejects(ownerAction('downloadPayrollCycle',{id:'2026-11'}),/historical/);
  const archive=await ownerAction('downloadPayrollCycle',{id:'2026-11',historicalConfirmed:true});assert.match(archive.files[0].filename,/^HISTORICAL_/);assert.equal(archive.files[0].content,original.files[0].content);
});
test('off-cycle selection cannot name an employee with no CRM commission record',async()=>{
  seed();await assert.rejects(ownerAction('savePayrollCycle',{...cycle(),id:'2026-11-OFF-12345678',version:0,reason:'Correction',producerIds:['unknown']}),/existing commission/);
});

const {receiptEarnings,validateAllocation,departureWorklist}=await import('../../shared/commissionExceptions.ts');
function exceptionSeed(withReceipt=false) {
  seed();state.records.set('POLICY:p',withReceipt?earned():commissionPolicy());
  state.records.set('ACCOUNT:a',commissionAccount());
  for(const [id,name,rate] of [['producer','Avery',2000],['jordan','Jordan',1600]])state.records.set('PLAN:'+id,{id,producerId:id,name,version:1,terms:[{from:'2020-01-01',newBps:rate,renewalBps:rate,agreement:'PRIVATE_'+name+'_AGREEMENT'}]});
}
async function sharedPolicy() {
  exceptionSeed();
  const approved=await ownerApi('approvePolicyAllocation',{id:'p',version:1,from:'2026-10-01',houseBps:0,agreement:'PRIVATE_SHARED_AGREEMENT',participants:[{producerId:'producer',shareBps:6000},{producerId:'jordan',shareBps:4000}],confirmed:true});
  assert.equal(approved.ok,true,approved.error);
  state.records.set('STATEMENT:s',{...statement(),lines:[line()]});
  const posted=await ownerApi('postStatement',{id:'s',version:1,confirmed:true});assert.equal(posted.ok,true,posted.error);
  return state.records.get('POLICY:p');
}
function departureInput(patch={}) {return {producerId:'producer',version:0,employmentEndOn:'2026-11-01',agreement:'Departure agreement',evidence:'Owner reviewed signed terms',reviewOn:'2026-11-02',paymentDueOn:'2026-11-20',laterReceipts:'REVIEW',renewals:'REVIEW',...patch};}
async function departureCase(patch={}) {
  assert.equal((await ownerApi('saveCommissionDeparture',departureInput(patch))).ok,true);
  assert.equal((await ownerApi('approveCommissionDeparture',{id:'producer',version:1,confirmed:true})).ok,true);
  return state.records.get('DEPARTURE:producer');
}
test('confirmed split posts one cash receipt and two earnings using frozen individual plan rates',async()=>{
  const p=await sharedPolicy(),earnings=[...state.records.values()].filter(e=>e.kind==='EARNING');
  assert.equal(p.entries.length,1);assert.equal(p.entries[0].producerCents,0);assert.equal(policyTotals(p).receivedAgency,100000);
  assert.deepEqual(earnings.map(e=>e.amountCents),[12000,6400]);assert.deepEqual(earnings.map(e=>e.shareBps),[6000,4000]);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,18400);
});
test('allocation rejects duplicate participants, missing plans, and shares not totaling 100 percent',async()=>{
  exceptionSeed();
  for(const participants of [[{producerId:'producer',shareBps:6000}],[{producerId:'producer',shareBps:5000},{producerId:'producer',shareBps:5000}],[{producerId:'missing',shareBps:10000}]]){
    const result=await ownerApi('approvePolicyAllocation',{id:'p',version:1,from:'2026-10-01',houseBps:0,agreement:'Agreement',participants,confirmed:true});assert.equal(result.ok,false);
  }
  assert.equal(state.records.get('POLICY:p').allocations,undefined);
});
test('historical cash and earnings cannot be retroactively split',async()=>{
  exceptionSeed(true);const result=await ownerApi('approvePolicyAllocation',{id:'p',version:1,from:'2026-10-01',houseBps:0,agreement:'Agreement',participants:[{producerId:'producer',shareBps:10000}],confirmed:true});
  assert.equal(result.ok,false);assert.match(result.error,/after all posted receipt/);assert.equal(state.records.get('POLICY:p').entries[0].producerCents,16000);
});
test('shared installments reconcile cumulative pennies with differing rates and an explicit house share',()=>{
  const allocation={id:'a',from:'2026-01-01',method:'INDIVIDUAL_PLAN_RATE',houseBps:1000,agreement:'Signed',approvedBy:'owner',approvedAt:new Date().toISOString(),participants:[{producerId:'a',producerName:'A',shareBps:3333,producerBps:2000,planVersion:1,agreement:'A',eligible:true},{producerId:'b',producerName:'B',shareBps:5667,producerBps:1600,planVersion:1,agreement:'B',eligible:true}]};
  validateAllocation(allocation);let p={...commissionPolicy(),allocations:[allocation]},all=[];
  for(let i=0;i<101;i++){p=appendEntry(p,line({agencyCents:1,lineRef:String(i)}),statement(),String(i));all.push(...receiptEarnings(p,p.entries.at(-1),all));}
  assert.equal(all.filter(e=>e.producerId==='a').reduce((n,e)=>n+e.amountCents,0),7);
  assert.equal(all.filter(e=>e.producerId==='b').reduce((n,e)=>n+e.amountCents,0),9);
  assert.equal(policyTotals(p).receivedAgency,101);assert.equal(policyTotals(p).earned,0);
});
test('shared reversals keep original allocation and never enter payable payroll',async()=>{
  await sharedPolicy();state.records.set('STATEMENT:reverse',{...statement(),id:'reverse',settlementRef:'REV-DEP',totalCents:-50000,receivedOn:'2026-11-01',lines:[line({lineRef:'REV-TX',kind:'REVERSAL',agencyCents:-50000,originalId:'s:TX-1'})]});
  const r=await ownerApi('postStatement',{id:'reverse',version:1,confirmed:true});assert.equal(r.ok,true,r.error);
  assert.deepEqual([...state.records.values()].filter(e=>e.kind==='EARNING'&&e.status==='REVIEW').map(e=>e.amountCents),[-6000,-3200]);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,18400);
});
test('shared earnings reserve once and release atomically when an unpaid report is revised',async()=>{
  await sharedPolicy();const c=await approve();assert.equal(c.totalCents,18400);
  const records=[...state.records.values()].filter(e=>e.kind==='EARNING');assert.ok(records.every(e=>e.batchId));
  const result=await ownerAction('reopenPayrollCycle',{id:c.id,version:c.version,reason:'Review split evidence'});assert.equal(result.ok,true);
  assert.ok([...state.records.values()].filter(e=>e.kind==='EARNING').every(e=>!e.batchId));
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,18400);
});
test('shared participant employee view contains only their own earnings and report lines',async()=>{
  await sharedPolicy();await approve();const event=apiEvent('commissionOverview','');event.identity.sub='jordan';const r=await commissionHandler(event);
  assert.equal(r.ok,true,r.error);assert.equal(r.policies.length,0);assert.equal(r.earnings.length,1);assert.equal(r.earnings[0].amountCents,6400);assert.equal(r.batches.length,1);assert.doesNotMatch(JSON.stringify(r),/Avery|PRIVATE_|approvedBy|paymentReference/);
});
test('shared-only employees can be selected for supplemental payroll without a duplicate cash policy',async()=>{
  await sharedPolicy();const dates=suggestPayrollDates('2026-11');
  const r=await ownerAction('savePayrollCycle',{...dates,id:'2026-11-OFF-12345678',version:0,reason:'Supplemental',producerIds:['jordan']});assert.equal(r.ok,true);
  const c=(await ownerAction('payrollWorkspace')).cycles.find(c=>c.cycleType==='OFF_CYCLE');assert.equal(c.preview.totalCents,6400);
});
test('additional compensation creates its own earning and cannot fabricate agency cash',async()=>{
  exceptionSeed(true);const r=await ownerApi('saveCommissionAdjustment',{id:'extra',version:0,policyId:'p',producerId:'producer',kind:'ADDITIONAL',correctedCents:2500,effectiveOn:'2026-11-15',reason:'Approved additional earning',evidence:'Signed addendum'});assert.equal(r.ok,true,r.error);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,16000);
  const a=await ownerApi('approveCommissionAdjustment',{id:'extra',version:1,confirmed:true});assert.equal(a.ok,true,a.error);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,18500);assert.equal(policyTotals(state.records.get('POLICY:p')).receivedAgency,100000);
  assert.equal(state.records.get('EARNING:adjustment:extra').agencyCents,0);
});
test('unpaid correction preserves original source amount and replaces its payable allocation',async()=>{
  exceptionSeed(true);assert.equal((await ownerApi('saveCommissionAdjustment',{id:'fix',version:0,policyId:'p',producerId:'producer',kind:'UNPAID_CORRECTION',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Correct unpaid amount',evidence:'Signed correction'})).ok,true);
  const r=await ownerApi('approveCommissionAdjustment',{id:'fix',version:1,confirmed:true});assert.equal(r.ok,true,r.error);
  const p=state.records.get('POLICY:p');assert.equal(p.entries[0].producerCents,16000);assert.equal(p.entries[0].supersededBy,'adjustment:fix');assert.equal(policyTotals(p).earned,0);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,10000);
  await approve();assert.equal((await ownerAction('payrollWorkspace')).batches[0].totalCents,10000);
});
test('an allocated earning must be reopened before an unpaid correction can be approved',async()=>{
  exceptionSeed(true);await approve();await ownerApi('saveCommissionAdjustment',{id:'fix',version:0,policyId:'p',producerId:'producer',kind:'UNPAID_CORRECTION',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Correction',evidence:'Agreement'});
  const r=await ownerApi('approveCommissionAdjustment',{id:'fix',version:1,confirmed:true});assert.equal(r.ok,false);assert.match(r.error,/Reopen/);assert.equal(state.records.get('EARNING:adjustment:fix'),undefined);
});
test('paid recovery remains nonpayable and retains links to the original payment',async()=>{
  exceptionSeed(true);let c=await approve();const b=state.records.get('BATCH:'+c.batchIds[0]);
  await ownerAction('confirmPayrollEmployee',{id:c.id,version:c.version,batchId:b.id,paymentId:'partial',amountCents:6000,paidOn:'2026-11-20',paymentReference:'PRIVATE_PAY',confirmed:true});
  const saved=await ownerApi('saveCommissionAdjustment',{id:'recovery',version:0,policyId:'p',producerId:'producer',kind:'PAID_RECOVERY',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Proposed recovery',evidence:'Owner review'});assert.equal(saved.ok,true,saved.error);
  const r=await ownerApi('approveCommissionAdjustment',{id:'recovery',version:1,confirmed:true});assert.equal(r.ok,true,r.error);
  assert.equal(state.records.get('EARNING:adjustment:recovery').status,'REVIEW');assert.equal(state.records.get('EARNING:adjustment:recovery').amountCents,-6000);
  assert.deepEqual(state.records.get('ADJUSTMENT:recovery').paymentIds,['partial']);assert.equal(batchPaidCents(state.records.get('BATCH:'+b.id)),6000);assert.equal(state.records.get('BATCH:'+b.id).totalCents,16000);
});
test('departure approval does not infer entitlement from disabled access and holds later receipts for review',async()=>{
  exceptionSeed(true);await departureCase({accessDisabledOn:'2026-11-02'});
  let w=await ownerAction('payrollWorkspace');assert.ok(w.cycles[0].preview.blockers.some(b=>b.includes('departure eligibility')));
  const c=state.records.get('DEPARTURE:producer');const r=await ownerApi('decideDepartureEarning',{id:c.id,version:c.version,policyId:'p',entryId:'receipt',outcome:'PAY',reason:'Agreement retains pre-departure earned commission',confirmed:true});assert.equal(r.ok,true,r.error);
  w=await ownerAction('payrollWorkspace');assert.deepEqual(w.cycles[0].preview.blockers,[]);assert.equal(w.cycles[0].preview.totalCents,16000);
});
test('explicit departure exclusion is audited and never rewrites carrier cash or original calculated earnings',async()=>{
  exceptionSeed(true);const c=await departureCase();
  const r=await ownerApi('decideDepartureEarning',{id:c.id,version:c.version,policyId:'p',entryId:'receipt',outcome:'EXCLUDE',reason:'Specific signed agreement exclusion',confirmed:true});assert.equal(r.ok,true,r.error);
  const p=state.records.get('POLICY:p');assert.equal(p.entries[0].agencyCents,100000);assert.equal(p.entries[0].producerCents,16000);assert.equal(policyTotals(p).earned,0);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,0);
});
test('continued departure eligibility respects the frozen policy plan and requires approval',async()=>{
  exceptionSeed(true);await ownerApi('saveCommissionDeparture',departureInput({laterReceipts:'CONTINUE',renewals:'CONTINUE'}));
  assert.ok((await ownerAction('payrollWorkspace')).cycles[0].preview.blockers.length);
  await ownerApi('approveCommissionDeparture',{id:'producer',version:1,confirmed:true});
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.totalCents,16000);assert.deepEqual((await ownerAction('payrollWorkspace')).cycles[0].preview.blockers,[]);
});
test('departure statements archive a review snapshot and cannot be used as payment instructions',async()=>{
  exceptionSeed(true);await departureCase();
  const r=await ownerApi('downloadDepartureStatement',{id:'producer'});assert.equal(r.ok,true,r.error);assert.ok(Buffer.from(r.files[0].content,'base64').subarray(0,4).equals(Buffer.from('%PDF')));
  const archive=[...state.records.values()].find(v=>v.kind==='DEPARTURE_REPORT');assert.ok(archive.snapshotHash);assert.equal(archive.snapshot.case.producerId,'producer');assert.equal(state.records.get('POLICY:p').entries[0].batchId,undefined);
});
test('carrier balance resolutions require evidence and later receipts reopen the departure worklist',async()=>{
  exceptionSeed(true);let c=await departureCase();
  assert.equal((await ownerApi('closeCommissionDeparture',{id:c.id,version:c.version,confirmed:true})).ok,false);
  assert.equal((await ownerApi('settleDeparturePolicy',{id:c.id,version:c.version,policyId:'p',reason:'Carrier confirmed final settlement',confirmed:true})).ok,true);
  c=state.records.get('DEPARTURE:producer');assert.equal(departureWorklist(c,[state.records.get('POLICY:p')],[],[]).pending.length,0);
  const p=appendEntry(state.records.get('POLICY:p'),line({agencyCents:100,lineRef:'late'}),{...statement(),receivedOn:'2026-11-19'},'late');
  assert.equal(departureWorklist(c,[p],[],[]).pending.length,1);
});
test('new exception writes and departure statements remain restricted to active Owners',async()=>{
  for(const role of ['PRODUCER','ADMIN','STAFF'])for(const op of ['commissionExceptions','approvePolicyAllocation','saveCommissionDeparture','approveCommissionDeparture','decideDepartureEarning','closeCommissionDeparture','settleDeparturePolicy','downloadDepartureStatement','saveCommissionAdjustment','approveCommissionAdjustment'])assert.equal((await commissionHandler(apiEvent('commissionAction',op,role))).ok,false);
});
test('a concurrent source change prevents an adjustment from replacing stale earnings',async()=>{
  exceptionSeed(true);await ownerApi('saveCommissionAdjustment',{id:'race',version:0,policyId:'p',producerId:'producer',kind:'UNPAID_CORRECTION',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Correction',evidence:'Agreement'});
  state.beforeCommit=async()=>{const p=state.records.get('POLICY:p');state.records.set('POLICY:p',{...p,version:p.version+1});};
  const result=await ownerApi('approveCommissionAdjustment',{id:'race',version:1,confirmed:true});assert.equal(result.ok,false);assert.equal(state.records.get('EARNING:adjustment:race'),undefined);assert.equal(state.records.get('ADJUSTMENT:race').status,'DRAFT');
});

test('a pending unpaid correction blocks payroll until an evidenced draft cancellation',async()=>{
  exceptionSeed(true);
  const input={id:'hold',version:0,policyId:'p',producerId:'producer',kind:'UNPAID_CORRECTION',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Review original amount',evidence:'Signed terms'};
  assert.equal((await ownerApi('saveCommissionAdjustment',input)).ok,true);
  await assert.rejects(approve(),/Resolve unpaid compensation correction/);
  assert.equal((await ownerApi('cancelCommissionAdjustment',{id:'hold',version:1,reason:''})).ok,false);
  assert.equal((await ownerApi('cancelCommissionAdjustment',{id:'hold',version:1,reason:'Original amount independently confirmed'})).ok,true);
  assert.equal((await approve()).totalCents,16000);
  assert.equal(state.records.get('EARNING:adjustment:hold'),undefined);
});
test('exclusion after a correction draft prevents approval from restoring ineligible earnings',async()=>{
  exceptionSeed(true);
  assert.equal((await ownerApi('saveCommissionAdjustment',{id:'excluded',version:0,policyId:'p',producerId:'producer',kind:'UNPAID_CORRECTION',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Correction',evidence:'Terms'})).ok,true);
  const c=await departureCase();
  assert.equal((await ownerApi('decideDepartureEarning',{id:c.id,version:c.version,policyId:'p',entryId:'receipt',outcome:'EXCLUDE',reason:'Confirmed agreement exclusion',confirmed:true})).ok,true);
  const result=await ownerApi('approveCommissionAdjustment',{id:'excluded',version:1,confirmed:true});
  assert.equal(result.ok,false);assert.match(result.error,/Original earnings changed/);
  assert.equal(state.records.get('EARNING:adjustment:excluded'),undefined);
  assert.equal((await ownerApi('saveCommissionAdjustment',{id:'excluded-new',version:0,policyId:'p',producerId:'producer',kind:'UNPAID_CORRECTION',targetEntryId:'receipt',correctedCents:10000,effectiveOn:'2026-11-15',reason:'Correction',evidence:'Terms'})).ok,false);
});
test('a resolved restoration review does not create phantom departure earnings',()=>{
  const c={...departureInput({laterReceipts:'CONTINUE',renewals:'CONTINUE'}),id:'producer',producerName:'Avery',status:'APPROVED',decisions:[]};
  const earning={id:'restoration',producerId:'producer',policyId:'p',policyNumber:'POL-1',entryId:'restore',receivedOn:'2026-11-10',transaction:'NEW',amountCents:1000,status:'REVIEW'};
  const pending=departureWorklist(c,[],[earning],[]);assert.equal(pending.rows.length,0);assert.equal(pending.adjustments.length,1);
  const resolved=departureWorklist(c,[],[{...earning,status:'RESOLVED'}],[]);assert.equal(resolved.rows.length,0);assert.equal(resolved.adjustments.length,0);
});
test('approved recovery proposals cannot cumulatively exceed the original earnings',async()=>{
  exceptionSeed(true);await approve();await partial(16000);
  for(const id of ['first','second'])assert.equal((await ownerApi('saveCommissionAdjustment',{id,version:0,policyId:'p',producerId:'producer',kind:'PAID_RECOVERY',targetEntryId:'receipt',correctedCents:6000,effectiveOn:'2026-11-15',reason:'Proposed recovery',evidence:'Terms review'})).ok,true);
  assert.equal((await ownerApi('approveCommissionAdjustment',{id:'first',version:1,confirmed:true})).ok,true);
  const result=await ownerApi('approveCommissionAdjustment',{id:'second',version:1,confirmed:true});assert.equal(result.ok,false);assert.match(result.error,/exceed the original/);
});
test('shared new business selects terms by the Eastern bind day',async()=>{
  exceptionSeed();const p=state.records.get('POLICY:p');state.records.set('POLICY:p',{...p,boundAt:'2026-01-01T02:00:00Z'});
  const plan=state.records.get('PLAN:producer');state.records.set('PLAN:producer',{...plan,terms:[...plan.terms,{from:'2026-01-01',newBps:5000,renewalBps:5000,agreement:'Later terms'}]});
  const result=await ownerApi('approvePolicyAllocation',{id:'p',version:1,from:'2026-10-01',houseBps:0,agreement:'Shared terms',participants:[{producerId:'producer',shareBps:10000}],confirmed:true});
  assert.equal(result.ok,true,result.error);assert.equal(state.records.get('POLICY:p').allocations[0].participants[0].producerBps,2000);
});
test('unchanged departure statements reuse their archive despite database field order',async()=>{
  exceptionSeed(true);await departureCase();const first=await ownerApi('downloadDepartureStatement',{id:'producer'});assert.equal(first.ok,true,first.error);
  const c=state.records.get('DEPARTURE:producer');state.records.set('DEPARTURE:producer',Object.fromEntries(Object.entries(c).reverse()));
  const second=await ownerApi('downloadDepartureStatement',{id:'producer'});assert.equal(second.ok,true,second.error);
  assert.equal(second.files[0].content,first.files[0].content);assert.equal([...state.records.values()].filter(r=>r.kind==='DEPARTURE_REPORT').length,1);
});

test('report dates retain calendar days and show Eastern timestamps across daylight-saving changes',async()=>{
  const {reportDate,reportTimestamp}=await import('../amplify/functions/commissions/report-layout.ts');
  assert.deepEqual(reportDate('2026-11-01'),{date:'Nov 1, 2026',weekday:'Sunday'});
  assert.equal(reportTimestamp('2026-11-01T03:30:00Z').date,'Oct 31, 2026');
  assert.equal(reportTimestamp('2026-11-01T05:30:00Z').time,'1:30 AM ET');
  assert.equal(reportTimestamp('2026-11-01T06:30:00Z').time,'1:30 AM ET');
  assert.equal(reportTimestamp('2026-11-01T06:30:00Z').iso,'2026-11-01T06:30:00.000Z');
});
test('test watermark is explicit and never changes approved amounts or production report bytes',async()=>{
  const a=buildPayrollApproval(cycle(),[earned()],[],settings(),'owner','2026-11-21T15:00:00Z');
  const live=await commissionReportFiles(a.cycle,a.batches);
  const sample=await commissionReportFiles(a.cycle,a.batches,undefined,{isTest:true});
  assert.doesNotMatch(pdfText(live[0].content),/TEST DATA/);
  assert.match(pdfText(sample[0].content),/TEST DATA/);
  assert.match(pdfText(sample[0].content),/\$160\.00/);
  assert.match(pdfText(sample[0].content),/10:00 AM ET/);
  const again=await commissionReportFiles(a.cycle,a.batches);
  assert.deepEqual(live.map(f=>Buffer.from(f.content)),again.map(f=>Buffer.from(f.content)));
});
test('departure PDF keeps totals, carrier balances, decisions and long evidence across pages',async()=>{
  const {departureStatement,departureReportFile}=await import('../amplify/functions/commissions/departure-report.ts');
  const c={id:'p',version:1,producerId:'producer',producerName:'Avery',employmentEndOn:'2026-09-30',reviewOn:'2026-11-05',paymentDueOn:'2026-11-06',
    agreement:'Evidence '.repeat(100)+'AGREEMENT_END',evidence:'Owner review '.repeat(100)+'EVIDENCE_END',
    laterReceipts:'REVIEW',renewals:'REVIEW',status:'APPROVED',approvedAt:'2026-11-05T12:00:00Z',approvedBy:'Example Owner',
    decisions:Array.from({length:50},(_,i)=>({policyId:'p',entryId:'entry-'+i,outcome:'PAY',reason:'Reviewed signed terms',at:'2026-11-05T12:00:00Z',by:'Owner'}))};
  const rows=[{policyId:'p',policyNumber:'POL-1',entryId:'r1',receivedOn:'2026-10-01',transaction:'NEW',amountCents:32000,decision:'REVIEW',paymentStatus:'UNALLOCATED'},
    {policyId:'s',policyNumber:'SHARED',entryId:'r2',receivedOn:'2026-10-01',transaction:'NEW',amountCents:12000,decision:'REVIEW',paymentStatus:'UNALLOCATED'}];
  const w={rows,pending:[{policyId:'p',policyNumber:'POL-1',receiptCount:1,expectedAgencyCents:1200000,receivedAgencyCents:150000}],adjustments:[]};
  const report=await departureStatement(c,w,'2026-11-06T16:00:00Z');
  const bytes=Buffer.from(departureReportFile(report).content,'base64'),text=pdfText(bytes);
  for(const token of ['$440.00','$10,500.00','12.5%','AGREEMENT_END','EVIDENCE_END','entry-49'])assert.ok(text.includes(token),token);
  assert.doesNotMatch(text,/TEST DATA/);
  assert.ok((await PDFDocument.load(bytes)).getPageCount()>1);
});

test('voiding a duplicate draft clears its blocker without changing receipts and preserves the immutable record',async()=>{
  seed();
  const draft={...statement(),id:createHash('sha256').update('c|test-void').digest('hex'),reference:'TEST-VOID',lines:[line()]};
  state.records.set('STATEMENT:'+draft.id,draft);
  const before=JSON.stringify(state.records.get('POLICY:p'));
  assert.match((await ownerAction('payrollWorkspace')).cycles[0].preview.blockers.join(' '),/TEST-VOID/);
  const input={id:draft.id,version:1,reason:'TEST duplicate; original retained',confirmed:true};
  assert.equal((await ownerApi('voidStatement',input)).ok,true);
  assert.equal((await ownerApi('voidStatement',input)).ok,true);
  const closed=state.records.get('STATEMENT:'+draft.id);
  assert.equal(closed.status,'VOID');assert.equal(closed.version,2);assert.deepEqual(closed.lines,draft.lines);
  assert.equal(JSON.stringify(state.records.get('POLICY:p')),before);
  assert.equal((await ownerAction('payrollWorkspace')).cycles[0].preview.blockers.length,0);
  assert.equal((await ownerApi('postStatement',{id:draft.id,version:2,confirmed:true})).ok,false);
  assert.equal((await ownerApi('saveStatement',{...draft,version:2})).ok,false);
});
test('a concurrent post wins safely over a stale void without partial reconciliation writes',async()=>{
  seed();state.records.set('STATEMENT:s',{...statement(),lines:[line()]});
  state.beforeCommit=()=>state.records.set('STATEMENT:s',{...statement(),version:2,status:'POSTED',lines:[line()]});
  const result=await ownerApi('voidStatement',{id:'s',version:1,reason:'TEST stale draft',confirmed:true});
  assert.equal(result.ok,false);assert.equal(state.records.get('STATEMENT:s').status,'POSTED');
  assert.equal(state.records.get('PAYROLL_STATE:reconciliation'),undefined);
});
test('selected off-cycle adjustment survives save, reserves once, pays in parts and never enters monthly payroll',async()=>{
  seed();
  const e={id:'extra',kind:'EARNING',version:1,producerId:'producer',producerName:'Avery',policyId:'p',policyNumber:'POL-1',accountName:'Cedar HOA',transaction:'NEW',entryId:'adjustment:extra',receivedOn:'2026-11-16',agencyCents:0,producerBps:1600,amountCents:5000,source:'ADJUSTMENT',status:'PAYABLE'};
  state.records.set('EARNING:extra',e);
  const id='2026-11-OFF-abcdef12',selectedEarningKeys=[JSON.stringify(['earning','extra'])];
  await ownerAction('savePayrollCycle',{...cycle(),id,version:0,producerIds:['producer'],reason:'TEST adjustment only',selectedEarningKeys});
  let c=(await ownerAction('payrollWorkspace')).cycles.find(c=>c.id===id);
  assert.equal(c.preview.totalCents,5000);
  await ownerAction('approvePayrollCycle',{id,version:c.version,previewToken:c.preview.token,confirmed:true});
  c=state.records.get('PAYROLL_CYCLE:'+id);
  const original=await ownerAction('downloadPayrollCycle',{id});
  assert.equal(original.files.length,2);
  assert.equal((await ownerAction('payrollWorkspace')).cycles.find(c=>c.id==='2026-11').preview.totalCents,16000);
  await ownerAction('confirmPayrollEmployee',{id,version:c.version,batchId:c.batchIds[0],amountCents:2500,paymentId:'part-a',paymentReference:'TEST-PAY-A',paidOn:'2026-11-20',confirmed:true});
  c=state.records.get('PAYROLL_CYCLE:'+id);
  await ownerAction('confirmPayrollEmployee',{id,version:c.version,batchId:c.batchIds[0],amountCents:2500,paymentId:'part-b',paymentReference:'TEST-PAY-B',paidOn:'2026-11-20',confirmed:true});
  c=state.records.get('PAYROLL_CYCLE:'+id);
  assert.equal(c.status,'PAID');assert.deepEqual(c.selectedEarningKeys,selectedEarningKeys);
  const history=await ownerAction('downloadPayrollCycle',{id,historicalConfirmed:true});
  assert.deepEqual(history.files.map(f=>f.content),original.files.map(f=>f.content));
  assert.equal((await ownerAction('payrollWorkspace')).cycles.find(c=>c.id==='2026-11').preview.totalCents,16000);
  assert.equal(state.records.get('BATCH:'+c.batchIds[0]).payments.length,2);
});
