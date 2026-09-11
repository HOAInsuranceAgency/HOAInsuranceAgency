import { useEffect,useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import FrontSidebar from '../../src/pages/FrontSidebar';
import MorningWorkReport from '../../src/components/MorningWorkReport';
import TeamWorkflowSettings from '../../src/components/TeamWorkflowSettings';
import { renderMorningReport } from '../../../shared/morningReport';
import { role,scenario,previewReport,team } from './fixtures';
import '../../src/styles.css';
function Preview(){
 const [tab,setTab]=useState('workspace'),[width,setWidth]=useState(360),[notice,setNotice]=useState('');
 useEffect(()=>{const receive=(e:Event)=>setNotice((e as CustomEvent<string>).detail);window.addEventListener('preview-action',receive);return()=>window.removeEventListener('preview-action',receive);},[]);
 function choose(key:string,value:string){const p=new URLSearchParams(location.search);p.set(key,value);location.search=p.toString();}
 return <div onClickCapture={e=>{const a=(e.target as HTMLElement).closest("a");if(a){e.preventDefault();setNotice(`Preview destination: ${a.getAttribute("href")}. No external page opened.`);}}} style={{maxWidth:1200,margin:'auto',padding:'24px 16px'}}><header><p className="muted small">DESIGN REVIEW · FICTIONAL DATA</p><h1 style={{fontSize:28}}>A workday in the CRM</h1><p>Explore each role and situation. This workspace cannot send messages or change client records. Report examples use September 14, 2026 at 9 a.m. Eastern.</p>
 <div className="form-grid"><label className="field">View as<select value={role} onChange={e=>choose('role',e.target.value)}>{team.filter(p=>p.userId!=='specialist').map(p=><option key={p.userId} value={p.userId}>{p.name} · {({sales:'Salesperson',champ:'Deal champion',manager:'Sales manager',marketing:'Marketing manager',owner:'Agency owner'} as Record<string,string>)[p.userId]}</option>)}</select></label><label className="field">Situation<select value={scenario} onChange={e=>choose('scenario',e.target.value)}>{Object.entries({first:'First contact due',callback:'Missed call',quote:'Quote ready to present',carrier:'Carrier needs information',renewal:'Renewal needs usable quotes',service:'Client needs a certificate',annual:'Next-year prospect returns',gap:'Connection needs attention',healthy:'Everything is up to date'}).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></div>
 <nav className="toolbar" aria-label="Preview screens" style={{margin:'20px 0'}}>{[['workspace','Front workspace'],['report','Daily report'],['email','Reminder email'],...(role==='owner'?[['settings','Team settings']]:[])].map(([id,label])=><button key={id} className={tab===id?'primary':'secondary'} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</nav></header>
 {notice&&<p className="card" role="status">{notice}</p>}
 {tab==='workspace'?<><label className="field" style={{maxWidth:240}}>Panel width<select value={width} onChange={e=>setWidth(Number(e.target.value))}>{[260,340,360,440,768].map(w=><option key={w} value={w}>{w} pixels</option>)}</select></label><div style={{width,maxWidth:'100%',border:'1px solid #dce3ed',borderRadius:12,overflow:'hidden',marginTop:16}}><FrontSidebar/></div></>:tab==='report'?<MorningWorkReport/>:tab==='settings'?<TeamWorkflowSettings/>:<iframe title="Morning reminder email" srcDoc={renderMorningReport(previewReport(),'https://example.test').html} style={{width:'100%',height:900,border:0}}/>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Preview/></BrowserRouter>);
