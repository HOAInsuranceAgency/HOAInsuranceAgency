import { useEffect, useState } from 'react';
import { client, US_STATES } from '../lib/client';
import { useAsyncResource } from '../lib/useAsyncResource';
import { useSaveStatus, SaveStatus } from './SaveStatus';
import { brokerFeeCents } from '../../../shared/brokerFees';
import type { BrokerFeeJurisdictionRule } from '../../amplify/functions/broker-fees/agreements';

export default function BrokerFeeSettings() {
  const [state,setState]=useState('MA');
  const [saving,setSaving]=useState(false);
  const data=useAsyncResource(async()=>{
    const result=await client.models.AgencySettings.get({id:'AGENCY'});
    if(result.errors?.length)throw new Error(result.errors[0].message);
    const raw=result.data?.brokerFeeJurisdictions;
    return {version:result.data?.brokerFeeJurisdictionsVersion??0,rules:(typeof raw==='string'?JSON.parse(raw):raw??{}) as Record<string,BrokerFeeJurisdictionRule>};
  },[]);
  return <div className="card"><h2>Broker fee disclosures</h2><p className="muted small">Configure the fee eligibility and disclosure wording reviewed for each state. Quotes use these rules automatically. A state without configured rules cannot charge a broker fee.</p>
    {data.error?<p className="error-text">{data.error} <button className="link" onClick={()=>void data.refetch()}>Retry</button></p>:!data.loaded?<p>Loading disclosure settings…</p>:<>
      <label className="field">State<select disabled={saving} value={state} onChange={e=>setState(e.target.value)}>{US_STATES.map(s=><option key={s}>{s}</option>)}</select></label>
      <JurisdictionForm key={`${state}:${data.data?.version}`} state={state} existing={data.data?.rules[state]} version={data.data?.version??0} onSaved={()=>void data.refetch()} onBusy={setSaving}/>
      <button className="link" disabled={saving||data.loading} onClick={()=>void data.refetch()}>Reload current disclosure rules</button>
    </>}
  </div>;
}
function JurisdictionForm({state,existing,version,onSaved,onBusy}:{state:string;existing?:BrokerFeeJurisdictionRule;version:number;onSaved:()=>void;onBusy:(busy:boolean)=>void}) {
  const [rule,setRule]=useState({version:existing?.version??'',reviewedBy:existing?.reviewedBy??'',reviewedAt:existing?.reviewedAt?.slice(0,10)??'',evidenceUrl:existing?.evidenceUrl??'',lines:existing?.allowedLines.join(', ')??'',maxFee:existing?.maxFeeCents==null?'':String(existing.maxFeeCents/100),agency:existing?.allowedBillTypes.includes('AGENCY')??true,direct:existing?.allowedBillTypes.includes('DIRECT')??true,approved:!!existing,discloseCarrierCommission:existing?.discloseCarrierCommission??false,requiresBrokerSignature:existing?.requiresBrokerSignature??false,signerName:existing?.agencySigner?.name??'',signerTitle:existing?.agencySigner?.title??'',signerLicense:existing?.agencySigner?.licenseNumber??'',signerAuthorized:existing?.agencySigner?.authorized??false,forms:existing?.forms??[]});
  const status=useSaveStatus();
  useEffect(()=>{onBusy(status.busy);},[status.busy,onBusy]);
  function edit<T extends keyof typeof rule>(key:T,value:typeof rule[T]) {setRule(old=>({...old,[key]:value,...(['signerName','signerTitle','signerLicense'].includes(key)||key==='requiresBrokerSignature'&&value?{signerAuthorized:false}:{})}));status.markDirty();}
  async function save() {await status.run(async()=>{
    const maxFeeCents=rule.maxFee.trim()===''?null:brokerFeeCents(Number(rule.maxFee));
    if(rule.approved&&(!rule.version.trim()||!rule.reviewedBy.trim()||!rule.reviewedAt||!rule.evidenceUrl.startsWith('https://')||!rule.lines.trim()||maxFeeCents!==null&&(!Number.isSafeInteger(maxFeeCents)||maxFeeCents<0)))throw new Error('Complete the reviewed fee rules and source reference.');
    const next:BrokerFeeJurisdictionRule={approved:true,version:rule.version.trim(),reviewedBy:rule.reviewedBy.trim(),reviewedAt:`${rule.reviewedAt}T12:00:00Z`,evidenceUrl:rule.evidenceUrl.trim(),allowedLines:rule.lines.split(',').map(s=>s.trim()).filter(Boolean),allowedBillTypes:[...(rule.agency?['AGENCY' as const]:[]),...(rule.direct?['DIRECT' as const]:[])],allowsCarrierCommission:true,maxFeeCents,forms:rule.forms,discloseCarrierCommission:rule.discloseCarrierCommission,requiresBrokerSignature:rule.requiresBrokerSignature,...(rule.requiresBrokerSignature?{agencySigner:{name:rule.signerName.trim(),title:rule.signerTitle.trim(),licenseNumber:rule.signerLicense.trim(),authorized:rule.signerAuthorized as true}}:{})};
    const result=await client.mutations.brokerFeeAction({input:JSON.stringify({op:'saveJurisdiction',state,version,rule:rule.approved?next:null})});
    if(result.errors?.length)throw new Error(result.errors[0].message);
    const answer=typeof result.data==='string'?JSON.parse(result.data):result.data;
    if(!answer?.ok)throw new Error(answer?.error??'Disclosure settings could not be saved.');
    onSaved();
  },{errorMessage:'Could not save disclosure settings.',savedMessage:'Disclosure settings saved.'});}
  return <fieldset disabled={status.busy} style={{border:0,padding:0,minWidth:0}}>
    <div className="form-grid">
      <label className="field">Review reference/version<input value={rule.version} onChange={e=>edit('version',e.target.value)}/></label>
      <label className="field">Reviewed by<input value={rule.reviewedBy} onChange={e=>edit('reviewedBy',e.target.value)}/></label>
      <label className="field">Review date<input type="date" value={rule.reviewedAt} onChange={e=>edit('reviewedAt',e.target.value)}/></label>
      <label className="field">Source/reference link<input type="url" value={rule.evidenceUrl} onChange={e=>edit('evidenceUrl',e.target.value)}/></label>
      <label className="field">Permitted coverage lines, separated by commas<input value={rule.lines} onChange={e=>edit('lines',e.target.value)}/><span className="muted small">Enter the coverage names used on quotes; use * only if the review permits every line.</span></label>
      <label className="field">Maximum fee ($), if applicable<input inputMode="decimal" value={rule.maxFee} onChange={e=>edit('maxFee',e.target.value)}/><span className="muted small">Leave blank only when the reviewed rules impose no maximum.</span></label>
    </div>
    <div className="chip-row"><label><input type="checkbox" checked={rule.agency} onChange={e=>edit('agency',e.target.checked)}/> Agency bill</label><label><input type="checkbox" checked={rule.direct} onChange={e=>edit('direct',e.target.checked)}/> Direct bill</label></div>
    <label style={{display:'block',marginTop:16}}><input type="checkbox" checked={rule.discloseCarrierCommission} onChange={e=>edit('discloseCarrierCommission',e.target.checked)}/> Disclose each policy’s insurer-paid agency commission.</label>
    <label style={{display:'block',marginTop:16}}><input type="checkbox" checked={rule.requiresBrokerSignature} onChange={e=>edit('requiresBrokerSignature',e.target.checked)}/> This state requires the agency to countersign.</label>
    {rule.requiresBrokerSignature&&<div className="form-grid">
      <label className="field">Authorized agency signer<input value={rule.signerName} onChange={e=>edit('signerName',e.target.value)}/></label>
      <label className="field">Signer title<input value={rule.signerTitle} onChange={e=>edit('signerTitle',e.target.value)}/></label>
      <label className="field">Agency/broker license number<input value={rule.signerLicense} onChange={e=>edit('signerLicense',e.target.value)}/></label>
      <label><input type="checkbox" checked={rule.signerAuthorized} onChange={e=>edit('signerAuthorized',e.target.checked)}/> I authorize this agency electronic countersignature on these fee agreements.</label>
    </div>}
    <h3>Required state forms</h3><p className="muted small">These appear after the combined one-page summary in the same signing session. Include the complete reviewed wording, including required acknowledgments and agency signature provisions.</p>
    {rule.forms.map((form,index)=><div key={index} className="card"><label className="field">Form title<input value={form.title} onChange={e=>edit('forms',rule.forms.map((f,i)=>i===index?{...f,title:e.target.value}:f))}/></label><label className="field">Disclosure wording<textarea rows={7} value={form.paragraphs.join('\n\n')} onChange={e=>edit('forms',rule.forms.map((f,i)=>i===index?{...f,paragraphs:e.target.value.split(/\n\s*\n/).filter(s=>s.trim())}:f))}/></label><button className="link" onClick={()=>edit('forms',rule.forms.filter((_,i)=>i!==index))}>Remove form</button></div>)}
    <button className="secondary" disabled={rule.forms.length>=10} onClick={()=>edit('forms',[...rule.forms,{title:'',paragraphs:[]}])}>Add state form</button>
    <label style={{display:'block',marginTop:16}}><input type="checkbox" checked={rule.approved} onChange={e=>edit('approved',e.target.checked)}/> Enable these reviewed rules for fees alongside carrier commission. Uncheck to stop new fee agreements in this state.</label>
    <div className="form-actions"><button className="primary" onClick={()=>void save()}>Save disclosure rules</button><SaveStatus {...status.status}/></div>
  </fieldset>;
}
