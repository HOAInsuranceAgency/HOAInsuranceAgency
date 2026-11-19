import { formatUsdCents as money } from "../../../shared/money";
import { useEffect,useRef,useState,type FormEvent } from 'react';
import { depositSuggestions,type CommissionDeposit } from '../../../shared/commissionDeposits';
import { importedMoney } from '../../../shared/commissionImport';
import type { IntakeWorkspace } from '../../../shared/commissionIntake';
import type { CommissionOverview } from '../../../shared/commissions';
import { useEditProtection,useCommissionUnsavedChanges as useUnsavedChanges } from '../lib/commissionEditProtection';
import { commissionWorkflowAction as commissionAction } from '../lib/commissions';
import { displayCommissionAmount } from '../lib/commissionSourceGuidance';
import { useCommissionWorkflow } from '../lib/commissionWorkflow';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { Textarea } from './ui/Textarea';


const empty = {payor:'',carrierId:'',reference:'',receivedOn:'',amount:'',evidence:''};
export default function CommissionDeposits({workspace,carriers,refresh,onError,openStatement}:{workspace:IntakeWorkspace;carriers:CommissionOverview['carriers'];refresh:()=>Promise<void>;onError:(e:unknown)=>void;openStatement:(id:string)=>void}) {
  const {target,remember}=useCommissionWorkflow();
  const {requestLeave}=useEditProtection();
  const [selected,setSelected]=useState(target.depositId ?? '');
  const [form,setForm]=useState(empty), [confirmed,setConfirmed]=useState(false), [focused,setFocused]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const lock=useRef(false), panel=useRef<HTMLElement>(null);
  useEffect(()=>{ if(target.depositId) {setSelected(target.depositId);panel.current?.scrollIntoView?.({block:'start'});} },[target.depositId]);
  const choose=(id:string)=>requestLeave(()=>{setSelected(id);setError('');setConfirmed(false);remember?.({depositId:id});});
  const {markClean}=useUnsavedChanges(selected==='new' && Object.values(form).some(Boolean),{busy,onDiscard:()=>{setForm(empty);setConfirmed(false);}});
  const run=async(work:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Deposit action failed.');onError(e);}finally{lock.current=false;setBusy(false);}};
  const set=(key:keyof typeof empty,value:string)=>{setForm({...form,[key]:value});setConfirmed(false);};
  const save=(e:FormEvent)=>{e.preventDefault();void run(async()=>{
    const totalCents=importedMoney(form.amount); if(totalCents===undefined || totalCents<=0)throw new Error('Enter a positive deposit amount with at most two decimal places.');
    const result=await commissionAction<{depositId:string}>('recordUnmatchedDeposit',{...form,totalCents,confirmed});
    markClean();setForm(empty);setConfirmed(false);setSelected(result.depositId);remember?.({depositId:result.depositId});setMessage('Deposit saved. Next, match its remittance below. No employee earnings have been created.');await refresh();
  });};
  const deposits=workspace.deposits;
  if(!deposits) return <p role="status">Deposit records could not be loaded. Refresh commissions to try again.</p>;
  const pending=deposits.filter(d=>d.status==='AWAITING_REMITTANCE').sort((a,b)=>a.receivedOn.localeCompare(b.receivedOn));
  const active=deposits.find(d=>d.id===selected);
  return <section className="card commission-deposits" ref={panel} aria-label="Deposits awaiting remittance">
    <div className="commission-section-heading"><div><h3>Deposit arrived first?</h3><p>Save the bank receipt once. Match its statement when the remittance arrives.</p></div><Button variant="secondary" onClick={()=>choose('new')}>Log carrier deposit</Button></div>
    {error && <p role="alert" className="error-text">{error}</p>}{message && <p role="status">{message}</p>}
    {selected==='new' && <form onSubmit={save}><fieldset disabled={busy}><h4>Record the bank deposit</h4><div className="commission-form-grid">
      <label className="field">Payor shown by bank<Input required maxLength={200} value={form.payor} onChange={e=>set('payor',e.target.value)}/></label>
      <label className="field">Carrier, if known<Select value={form.carrierId} onChange={e=>set('carrierId',e.target.value)}><option value="">Unknown — review later</option>{carriers.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</Select></label>
      <label className="field">Unique bank reference<Input required maxLength={200} value={form.reference} onChange={e=>set('reference',e.target.value)}/></label>
      <label className="field">Actual deposit date<Input required type="date" value={form.receivedOn} onChange={e=>set('receivedOn',e.target.value)}/></label>
      <label className="field">Deposit amount<Input required inputMode="decimal" value={focused?form.amount:displayCommissionAmount(form.amount)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} onChange={e=>set('amount',e.target.value)}/></label>
      <label className="field">Bank receipt evidence<Textarea required maxLength={2000} value={form.evidence} onChange={e=>set('evidence',e.target.value)} placeholder="Bank entry, ACH trace or evidence reference"/></label>
    </div><p>No statement file or policy match is required yet. This saves received money for review; it does not approve employee commission.</p>
    <label className="commission-ack"><Input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I checked the actual bank deposit date, amount, reference and evidence.</label>
    <div className="form-actions"><Button variant="primary" disabled={busy||!confirmed}>{busy?'Saving…':'Save deposit for matching'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>choose('')}>Cancel</Button></div></fieldset></form>}
    {selected!=='new' && <><p><strong>{pending.length} deposit{pending.length===1?'':'s'} awaiting remittance</strong></p>{pending.map(d=><div className="intake-queue-item" key={d.id}><div><strong>{d.payor} · {money(d.totalCents)}</strong><span className="small muted">{d.receivedOn} · {d.reference} · Awaiting remittance</span></div><Button variant="secondary" onClick={()=>choose(d.id)}>Review deposit</Button></div>)}</>}
    {active && <DepositReview key={active.id+':'+active.version} deposit={active} workspace={workspace} busy={busy} run={run} refresh={refresh} openStatement={openStatement}/>}
    {!!deposits.some(d=>d.status!=='AWAITING_REMITTANCE') && <details><summary>Saved deposit history</summary>{deposits.filter(d=>d.status!=='AWAITING_REMITTANCE').map(d=><p key={d.id}>{d.payor} · {d.receivedOn} · {money(d.totalCents)} · {d.reference} · {d.status==='LINKED'?'Linked to statement':d.status==='VOID'?'Voided':'No employee commission'} {d.resolutionReason && <span>— {d.resolutionReason}</span>} {d.intakeId && <Button variant="secondary" onClick={()=>requestLeave(()=>openStatement(d.intakeId!))}>Open linked statement</Button>}</p>)}</details>}
  </section>;
}
function DepositReview({deposit:d,workspace,busy,run,refresh,openStatement}:{deposit:CommissionDeposit;workspace:IntakeWorkspace;busy:boolean;run:(work:()=>Promise<void>)=>Promise<void>;refresh:()=>Promise<void>;openStatement:(id:string)=>void}) {
  const [intakeId,setIntakeId]=useState(''),[confirmed,setConfirmed]=useState(false),[resolution,setResolution]=useState(''),[reason,setReason]=useState(''),[resolveConfirmed,setResolveConfirmed]=useState(false);
  const {markClean}=useUnsavedChanges(!!intakeId||!!reason||!!resolution,{busy,onDiscard:()=>{setIntakeId('');setConfirmed(false);setResolution('');setReason('');setResolveConfirmed(false);}});
  const suggestions=depositSuggestions(d,workspace.intakes,workspace.settlements,workspace.receiptTotals), chosen=suggestions.find(s=>s.intake.id===intakeId);
  if(d.status!=='AWAITING_REMITTANCE')return null;
  return <fieldset disabled={busy} className="deposit-review"><h4>Next: confirm the remittance match</h4><p><strong>{d.payor} · {money(d.totalCents)}</strong> · {d.receivedOn} · {d.reference}</p><p>Saved evidence: {d.evidence}</p>
    <p>The saved receipt details carry forward unchanged. A suggested amount match alone does not prove these records belong together.</p>
    {!suggestions.length ? <p>No statement currently fits this deposit. Log the remittance as a carrier statement below, then review this deposit again. Keep deposits spanning multiple statements unresolved until their breakdown is available.</p> : <>
      <label className="field">Statement to match<Select value={intakeId} onChange={e=>{setIntakeId(e.target.value);setConfirmed(false);}}><option value="">Choose after checking the remittance</option>{suggestions.map(s=><option key={s.intake.id} value={s.intake.id}>{s.intake.reference} · {s.intake.carrierName} · {money(s.balance!)} remaining · {s.exact?'Amount matches':'Partial payment'}</option>)}</Select></label>
      {chosen && <><p>{chosen.reason}. Statement date: {chosen.intake.statementDate||'Not supplied'}. Bank receipt date stays {d.receivedOn}.</p><label className="commission-ack"><Input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I checked the remittance and confirm this deposit belongs to this carrier and statement.</label>
      <Button variant="primary" disabled={busy||!confirmed} onClick={()=>void run(async()=>{await commissionAction('recordIntakeSettlement',{id:chosen.intake.id,version:chosen.intake.version,depositId:d.id,depositVersion:d.version,confirmed});markClean();await refresh();openStatement(chosen.intake.id);})}>Confirm match & continue</Button></>}
    </>}
    <details><summary>Resolve without employee commission or correct an entry</summary><label className="field">Resolution<Select value={resolution} onChange={e=>{setResolution(e.target.value);setResolveConfirmed(false);}}><option value="">Choose a resolution</option><option value="NO_EMPLOYEE_COMMISSION">Confirmed: no employee commission</option><option value="VOID">Void an incorrect deposit entry</option></Select></label>
      <label className="field">Reason and supporting evidence<Textarea maxLength={2000} value={reason} onChange={e=>{setReason(e.target.value);setResolveConfirmed(false);}}/></label>
      <label className="commission-ack"><Input type="checkbox" checked={resolveConfirmed} onChange={e=>setResolveConfirmed(e.target.checked)}/> I confirm this resolution and its supporting evidence.</label>
      <Button variant="secondary" disabled={busy||!resolveConfirmed||!resolution||!reason.trim()} onClick={()=>void run(async()=>{await commissionAction('resolveUnmatchedDeposit',{id:d.id,version:d.version,status:resolution,reason,confirmed:resolveConfirmed});markClean();await refresh();})}>Save deposit resolution</Button>
    </details></fieldset>;
}
