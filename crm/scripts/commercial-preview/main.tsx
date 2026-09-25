import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AccountsList from '../../src/pages/AccountsList';
import LeadsTab from '../../src/pages/dashboard/LeadsTab';
import QuotePackages from '../../src/components/QuotePackages';
import { quotes, carriers } from './fixtures';
import '../../src/styles.css';
function Preview() {
  const [screen, setScreen] = useState('leads');
  return (
    <div style={{ padding: 24, maxWidth: 1600, margin: 'auto' }}>
      <p className="muted small">
        DESIGN REVIEW · FICTIONAL DATA · NO MESSAGES OR REAL RECORD CHANGES
      </p>
      <nav className="toolbar" aria-label="Review screens">
        {[
          ['leads', 'Leads table'],
          ['clients', 'Clients table'],
          ['dashboard', 'Dashboard'],
          ['packages', 'Package options'],
        ].map(([id, name]) => (
          <button
            key={id}
            className={screen === id ? 'primary' : 'secondary'}
            onClick={() => setScreen(id)}
          >
            {name}
          </button>
        ))}
      </nav>
      <div
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('a')) e.preventDefault();
        }}
      >
        {screen === 'packages' ? (
          <QuotePackages
            accountId="willow"
            quotes={quotes.filter((q) => q.accountId === 'willow')}
            carriers={carriers}
          />
        ) : screen === 'dashboard' ? (
          <LeadsTab />
        ) : (
          <AccountsList
            key={screen}
            stage={screen === 'clients' ? 'CLIENT' : 'LEAD'}
          />
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Preview />
  </MemoryRouter>,
);
