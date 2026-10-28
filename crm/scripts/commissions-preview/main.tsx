import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import Commissions from '../../src/pages/Commissions';
createRoot(document.getElementById('root')!).render(
  <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <img src="/logo.png" alt="HOA Insurance Agency" />
      </div>
      <nav>
        <a href="#">Dashboard</a>
        <a href="#">Profitability</a>
        <a className="active" href="#">
          Commissions
        </a>
        <a href="#">Leads</a>
        <a href="#">Clients</a>
        <a href="#">Carriers</a>
      </nav>
      <div className="spacer" />
      <div className="user">
        Avery Brooks<div className="muted small">Fictional preview</div>
      </div>
    </aside>
    <main className="main">
      <Commissions />
    </main>
  </div>,
);
