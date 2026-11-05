import { Tabs, TabPanel } from '../../src/components/ui/Tabs';
import { useState } from 'react';
import { mountPreview } from '../preview-support/mount';
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
      <Tabs id="commercial-preview" label="Review screens" value={screen} onChange={setScreen} items={[
        { value: 'leads', label: 'Leads table' },
        { value: 'clients', label: 'Clients table' },
        { value: 'dashboard', label: 'Dashboard' },
        { value: 'packages', label: 'Package options' },
      ]} />
      <TabPanel tabsId="commercial-preview" value={screen}>
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
      </TabPanel>
    </div>
  );
}
mountPreview(
  <MemoryRouter>
    <Preview />
  </MemoryRouter>,
);
