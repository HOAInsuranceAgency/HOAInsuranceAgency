import { createRoot } from 'react-dom/client';
import Financing from '../../src/pages/Financing';
import { useIsAdmin } from './fixtures';
import '../../src/styles.css';

// From crm/: npx vite --config scripts/financing-preview/vite.config.ts
// ?role=admin opens admin controls; ?scenario=current approves conditional
// states in memory; ?scenario=error previews unavailable opinion reads.
function Preview() {
  const isAdmin = useIsAdmin();
  return <div className="shell">
    <aside className="sidebar">
      <div className="sidebar-top"><div className="brand"><img src="/logo.png" alt="HOA Insurance Agency" /></div></div>
      <nav aria-label="Main navigation">
        {(isAdmin ? ['Dashboard', 'Leads', 'Clients', 'Carriers', 'Financing', 'Settings'] : ['Leads', 'Clients', 'Carriers', 'Financing', 'Settings']).map(name =>
          <a key={name} href="#" className={name === 'Financing' ? 'active' : undefined} aria-current={name === 'Financing' ? 'page' : undefined} onClick={event => event.preventDefault()}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h4" /></svg>{name}
          </a>)}
      </nav>
      <div className="spacer" />
      <div className="user">Avery Brooks<div className="small">{isAdmin ? 'ADMIN' : 'SALESPERSON'}</div><div className="small" style={{ marginTop: 8 }}>Fictional preview</div></div>
    </aside>
    <main className="main">
      <div className="topbar"><div className="usearch"><input aria-label="Preview search" placeholder="Search accounts, contacts, policies, invoices, documents…" disabled /></div></div>
      <Financing />
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
