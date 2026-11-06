import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import Commissions from '../../src/pages/Commissions';
import { previewQuery, useIsOwner } from './fixtures';
import SampleReports from './SampleReports';
import { ReportContext } from '../../src/components/ReportDownload';

function selectPreview(key: 'scenario' | 'role', value: string) {
  const next = new URLSearchParams(previewQuery);
  next.set(key, value);
  if (location.protocol === 'file:') {
    location.hash = next.toString();
    location.reload();
  } else {
    location.search = next.toString();
  }
}
createRoot(document.getElementById('root')!).render(
  <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <img src="/logo.png" alt="HOA Insurance Agency" />
      </div>
      <nav>
        <a href="#">Dashboard</a>
        <a href="#">Profitability</a>
        <a className="active" href="#">Commissions</a>
        <a href="#">Leads</a>
        <a href="#">Clients</a>
        <a href="#">Carriers</a>
      </nav>
      <div className="spacer" />
      <div className="user">
        {useIsOwner() ? 'Owner preview' : 'Avery Brooks'}
        <div className="muted small">Fictional preview</div>
      </div>
    </aside>
    <main className="main">
      <section className="card" aria-label="Preview controls">
        <strong>Read-only preview · Fictional records</strong>
        <p className="small muted">Choose a sample below, then open Payroll or Shared &amp; exceptions. Changes to records and email delivery are disabled.</p>
        <div style={{display:'flex',flexWrap:'wrap',gap:16}}>
          <label className="field" style={{minWidth:200,flex:1}}>
            Sample scenario
            <select value={previewQuery.get('scenario') || 'basic'} onChange={e=>selectPreview('scenario',e.target.value)}>
              <option value="shared">Shared commissions</option>
              <option value="exceptions">Payment &amp; report history</option>
              <option value="basic">Basic ledger</option>
            </select>
          </label>
          <label className="field" style={{minWidth:200,flex:1}}>
            Sample view
            <select value={useIsOwner() ? 'owner' : 'producer'} onChange={e=>selectPreview('role',e.target.value)}>
              <option value="owner">Owner</option>
              <option value="producer">Employee · Avery Brooks</option>
            </select>
          </label>
        </div>
        <SampleReports owner={useIsOwner()} />
      </section>
      <ReportContext.Provider value={{disabled:false,asOf:null,isTest:true}}><Commissions /></ReportContext.Provider>
    </main>
  </div>,
);
