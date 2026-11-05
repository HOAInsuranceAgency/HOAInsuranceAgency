import { useState } from 'react';
import { LiveStatus } from "../../components/LiveStatus";
import { ReportContext } from '../../components/ReportDownload';
import { Tabs } from "../../components/ui/Tabs";
import { useIsOwner } from '../../lib/auth';
import { readCommissions } from '../../lib/commissions';
import { useAsyncResource } from '../../lib/useAsyncResource';
import { Ledger } from './CommissionLedger';
import { Settings } from './CommissionSettings';
import { FinancialStale } from './context';
import { BatchList, Payroll } from './Payroll';
import { Statements } from './StatementReconciliation';

export default function Commissions() {
  const owner = useIsOwner();
  // Unmount private data/forms immediately on role switch, including pending requests.
  return <CommissionView key={owner ? 'owner' : 'self'} owner={owner} />;
}

function CommissionView({ owner }: { owner: boolean }) {
  const resource = useAsyncResource(readCommissions, [], {
    errorMessage: 'Could not load commissions.',
    clearDataOnError: () => true,
    live: { topics: ['CRM', 'OWNER', 'PERSONAL'] }
  });
  const [tab, setTab] = useState('ledger');
  const snapshot = resource.data;
  return (
    <FinancialStale.Provider value={!!resource.refreshError || !!resource.error}>
      <ReportContext.Provider value={{ disabled: resource.loading || !!resource.refreshing || !!resource.refreshError || !!resource.error, asOf: resource.updatedAt ? new Date(resource.updatedAt) : null }}>
        <div className="commissions">
          <header>
            <p className="muted small">
              {owner ? 'Owner · private commission management' : 'Your commission statements'}
            </p>
            <h1>Commissions</h1>
            <p className="muted">
              Track expected revenue, carrier receipts, producer earnings, and confirmed payments.
            </p>
          </header>
          {owner && (
            <Tabs id="commissions" label="Commission views" value={tab} onChange={setTab} items={[
              { value: 'ledger', label: 'Ledger' },
              { value: 'statements', label: 'Reconciliation' },
              { value: 'payroll', label: 'Payroll' },
              { value: 'settings', label: 'Agreements & carriers' },
            ]} />
          )}

          <LiveStatus resource={resource} />
          {resource.error && (
            <p className="error-text" role="alert">
              {resource.error}
            </p>
          )}
          <div id={owner ? 'commissions-panel' : undefined} role={owner ? 'tabpanel' : undefined} aria-labelledby={owner ? `commissions-tab-${tab}` : undefined} tabIndex={owner ? 0 : undefined}>
            {!snapshot ? (
              !resource.error && <p>Loading commissions…</p>
            ) : (
              <>
                {tab === 'ledger' && <Ledger data={snapshot} owner={owner} refresh={resource.refetch} />}
                {owner && tab === 'settings' && <Settings data={snapshot} refresh={resource.refetch} />}
                {owner && tab === 'statements' && (
                  <Statements data={snapshot} refresh={resource.refetch} />
                )}
                {owner && tab === 'payroll' && <Payroll data={snapshot} refresh={resource.refetch} />}
                {!owner && <BatchList batches={snapshot.batches} />}
              </>
            )}
          </div>
        </div>
      </ReportContext.Provider>
    </FinancialStale.Provider>
  );
}
