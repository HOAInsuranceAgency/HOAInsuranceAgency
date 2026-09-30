import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import FrontSidebar from '../../src/pages/FrontSidebar';
import { role, scenario, team } from './fixtures';
import '../../src/styles.css';
function Preview() {
  const [width, setWidth] = useState(360), [notice, setNotice] = useState('');
  useEffect(() => { const receive = (e: Event) => setNotice((e as CustomEvent<string>).detail); window.addEventListener('preview-action', receive); return () => window.removeEventListener('preview-action', receive); }, []);
  function choose(key: string, value: string) { const p = new URLSearchParams(location.search); p.set(key, value); location.search = p.toString(); }
  return <div style={{ maxWidth: 1200, margin: 'auto', padding: '24px 16px' }}><header><p className="muted small">DESIGN REVIEW · FICTIONAL DATA</p><h1 style={{ fontSize: 28 }}>Account communications in Front</h1><p>This workspace cannot send messages or change client records.</p>
    <div className="form-grid"><label className="field">View as<select value={role} onChange={e => choose('role', e.target.value)}>{team.map(p => <option key={p.userId} value={p.userId}>{p.name}</option>)}</select></label><label className="field">Situation<select value={scenario} onChange={e => choose('scenario', e.target.value)}>{Object.entries({ lead: 'Lead conversation', quote: 'Quote recorded', carrier: 'Carrier conversation', service: 'Client conversation', gap: 'Connection issue' }).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div></header>
    {notice && <p className="card" role="status">{notice}</p>}
    <label className="field" style={{ maxWidth: 240 }}>Panel width<select value={width} onChange={e => setWidth(Number(e.target.value))}>{[260, 340, 360, 440, 768].map(w => <option key={w} value={w}>{w} pixels</option>)}</select></label><div style={{ width, maxWidth: '100%', border: '1px solid #dce3ed', borderRadius: 12, overflow: 'hidden', marginTop: 16 }}><FrontSidebar /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Preview /></BrowserRouter>);
