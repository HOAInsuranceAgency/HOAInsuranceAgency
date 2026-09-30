import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../../src/styles.css';
import { OverviewTab } from '../../src/pages/account/OverviewTab';
import ContactsCard from '../../src/components/ContactsCard';
import PropertyPanel from '../../src/components/PropertyPanel';
import { account as initialAccount, isClient, fmtDate } from './fixtures';

window.open = () => null;
const tabs = ['Overview', 'Property & coverage', ...(!isClient ? ['Prior coverage'] : []), 'Losses', 'Submissions', 'Quotes', ...(isClient ? ['Policies'] : []), 'Invoices', 'Financing', 'Documents', 'Certificates', 'Activity'];
function Preview() {
  const [account, setAccount] = useState(initialAccount);
  return <div className="shell">
    <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><img src="/logo.png" alt="HOA Insurance Agency" /></div></div>
      <nav aria-label="Main navigation">{['Leads', 'Clients', 'Carriers', 'Financing', 'Settings'].map(name =>
        <a key={name} href="#" className={name === (isClient ? 'Clients' : 'Leads') ? 'active' : undefined} onClick={event => event.preventDefault()}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h4" /></svg>{name}</a>)}</nav>
      <div className="spacer" /><div className="user">Avery Brooks<div className="small">SALESPERSON</div><div className="small" style={{ marginTop: 8 }}>Fictional preview</div></div>
    </aside>
    <main className="main">
      <div className="topbar"><div className="usearch"><input aria-label="Preview search" placeholder="Search accounts, contacts, policies, invoices, documents…" disabled /></div></div>
      <h1>{account.name} <span className="badge blue">{isClient ? 'Client' : 'Lead'}</span></h1>
      <p className="sub">ASSOCIATION · {account.city || 'Boston'}, {account.state || 'MA'} · {isClient ? `client since ${fmtDate(account.convertedAt)}` : `entered ${fmtDate(account.createdAt)}`}</p>
      <div className="tabs">{tabs.map(name => <button key={name} className={name === 'Overview' ? 'active' : ''}>{name}</button>)}</div>
      <div className="account-overview">
        <OverviewTab account={account} onChange={setAccount} />
        <ContactsCard accountId={account.id} />
        <PropertyPanel account={account} onChange={setAccount} />
      </div>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Preview /></MemoryRouter>);
