import { useState } from 'react';
import { communicationRequest as request } from '../lib/communications';
import { useAsyncResource } from '../lib/useAsyncResource';
type Edition = { id:string;recipient:string;day:string;state:string;error?:string };
export default function ReportDeliveryReview(){
 const rows=useAsyncResource(()=>request<{items:Edition[];nextToken?:string}>('reportDelivery'),[],{initialData:{items:[]},errorMessage:'Could not load report delivery'});
 const [selected,setSelected]=useState(''),[link,setLink]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 return <section aria-label="Morning report delivery"><h3>Morning report delivery</h3><p className="muted small">Uncertain sends stay here until verified. Linking the original sent message records delivery without sending another email.</p>{(error||rows.error)&&<p role="alert" className="error-text">{error||rows.error}</p>}
 <button className="secondary" onClick={()=>void rows.refetch()}>Refresh reports</button>{!rows.loading&&!rows.data.items.length&&<p>No report deliveries need review.</p>}
 {rows.data.items.map(r=><article className="workflow-task" key={r.id}><strong>{r.recipient} · {r.day}</strong><p>{r.error||r.state.toLowerCase()}</p>{r.state!=='READY'&&<button className="secondary" onClick={()=>{setSelected(r.id);setLink('');}}>Link sent report</button>}</article>)}
 {rows.data.nextToken&&<button className="secondary" onClick={async()=>{try{const page=await request<{items:Edition[];nextToken?:string}>('reportDelivery',{nextToken:rows.data.nextToken});rows.setData(p=>({...page,items:[...p.items,...page.items]}));}catch(e){setError(String(e));}}}>More reports</button>}
 {selected&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const messageId=link.match(/msg_[a-z0-9]+/)?.[0];if(!messageId)throw new Error('Paste the link to the sent Front message.');await request('recoverReport',{editionId:selected,messageId},true);setSelected('');await rows.refetch();}catch(e){setError(e instanceof Error?e.message:'Could not verify the report');}finally{setBusy(false);}}}><label className="field">Sent message link<input value={link} onChange={e=>setLink(e.target.value)} placeholder="Paste the Front message link" required/></label><div className="form-actions"><button className="primary" disabled={busy}>Verify original delivery</button><button type="button" className="secondary" onClick={()=>setSelected('')}>Cancel</button></div></form>}
 </section>;
}
