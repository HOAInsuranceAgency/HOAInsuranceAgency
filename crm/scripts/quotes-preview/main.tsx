import { Tabs, TabPanel } from '../../src/components/ui/Tabs';
import { Input } from '../../src/components/ui/Input';
import '../../src/components/UniversalSearch.css';
import { useState } from 'react';
import { mountPreview } from '../preview-support/mount';
import { MemoryRouter } from 'react-router-dom';
import '../../src/styles.css';
import QuotesPanel from '../../src/components/QuotesPanel';
import HoneycombEstimates from '../../src/components/HoneycombEstimates';
import { account, fmtDate } from './fixtures';

// From crm/: npx vite --config scripts/quotes-preview/vite.config.ts
// ?scenario=empty (default), populated, selected, estimates, error, loading.
// Add &estimate=ready to show a fictional Honeycomb indication with any scenario.
function Preview() {
  const [currentAccount, setAccount] = useState(account);
  return <div className="shell">
    <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><img src="/logo.png" alt="HOA Insurance Agency" /></div></div>
      <nav aria-label="Main navigation">{['Dashboard', 'Leads', 'Clients', 'Carriers', 'Financing', 'Settings'].map(name =>
        <a key={name} href="#" className={name === 'Leads' ? 'active' : undefined} onClick={event => event.preventDefault()}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h4" /></svg>{name}</a>)}</nav>
      <div className="spacer" /><div className="user">Avery Brooks<div className="small">SALESPERSON</div><div className="small" style={{ marginTop: 8 }}>Fictional preview</div></div>
    </aside>
    <main className="main">
      <div className="topbar"><div className="usearch"><Input aria-label="Preview search" placeholder="Search accounts, contacts, policies, invoices, documents…" disabled /></div></div>
      <h1>{currentAccount.name} <span className="badge blue">{currentAccount.stage === 'LEAD' ? 'Lead' : 'Client'}</span></h1>
      <p className="sub">ASSOCIATION · Boston, MA · entered {fmtDate(currentAccount.createdAt)}</p>
      {/* Shell navigation stays inert in this single-view fixture. */}
      <Tabs id="quotes-preview" label="Account views" value="quotes" onChange={() => {}}
        items={['Overview', 'Property & coverage', 'Prior coverage', 'Losses', 'Submissions', 'Quotes', 'Invoices', 'Financing', 'Documents', 'Certificates', 'Activity'].map(label => ({ value: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label }))} />
      <TabPanel tabsId="quotes-preview" value="quotes">
      <div id="carrier-work"><HoneycombEstimates accountId={currentAccount.id} /><QuotesPanel account={currentAccount} onAccountChange={setAccount} /></div>
      </TabPanel>
    </main>
  </div>;
}
mountPreview(<MemoryRouter><Preview /></MemoryRouter>);
