import { Tabs } from '../../components/ui/Tabs';
import { getCommissionStorageKey } from '../../lib/commissionSession';
import { useEffect,useRef,useState } from 'react';
import CommissionExceptions from '../../components/CommissionExceptions';
import CommissionIntake from '../../components/CommissionIntake';
import CommissionPanel from '../../components/CommissionPanel';
import CommissionPolicyLink from '../../components/CommissionPolicyLink';
import CommissionWorkQueue from '../../components/CommissionWorkQueue';
import { LiveStatus } from '../../components/LiveStatus';
import { ReportContext } from '../../components/ReportDownload';
import { Button } from '../../components/ui/Button';
import { useIsOwner } from '../../lib/auth';
import { useEditProtection } from '../../lib/commissionEditProtection';
import { readCommissions } from '../../lib/commissions';
import { CommissionWorkflowContext,type CommissionDestination } from '../../lib/commissionWorkflow';
import { useAsyncResource } from '../../lib/useAsyncResource';

import { AccountClassificationResource } from './AccountClassifications';
import { Ledger } from './CommissionLedger';
import { Settings } from './CommissionSettings';
import { CommissionAccessContext,FinancialStale } from './context';
import { BatchList,Payroll } from './Payroll';
import { Statements } from './StatementReconciliation';

export default function Commissions() {
  const owner = useIsOwner();
  // Unmount private data/forms immediately on role switch, including pending requests.
  return <CommissionView key={owner ? 'owner' : 'self'} owner={owner} />;
}

export function CommissionView({ owner }: { owner: boolean }) {
  const { requestLeave } = useEditProtection();
  const resource = useAsyncResource(readCommissions, [], {
    errorMessage: 'Could not load commissions.',
    clearDataOnError: () => true,
    live: { topics: ['CRM', 'OWNER', 'PERSONAL'] },
  });
  const [target, setTarget] = useState<CommissionDestination>(() => ({ tab: owner ? (new URLSearchParams(window.location.search).get('tab') === 'settings' ? 'settings' : 'queue') : 'ledger' }));
  const [storageKey, setStorageKey] = useState<string>();
  const tab = target.tab;
  const interacted = useRef(false);
  const navigate = (next: CommissionDestination) => requestLeave(() => {
    interacted.current = true;
    setTarget(next);
    if (storageKey) try { localStorage.setItem(storageKey + ':location', JSON.stringify(next)); } catch { /* Optional browser preferences. */ }
  });
  const remember = (patch: Partial<CommissionDestination>) => setTarget(previous => {
    interacted.current = true;
    const next={...previous,...patch};
    if(storageKey) try{localStorage.setItem(storageKey+':location',JSON.stringify(next));}catch{/* Optional preferences. */}
    return next;
  });
  useEffect(() => {
    if (!owner) return;
    let active = true;
    void getCommissionStorageKey().then(key => {
      if (!active) return;
      setStorageKey(key);
      try {
        const saved = JSON.parse(localStorage.getItem(key + ':location') ?? 'null') as CommissionDestination | null;
        if (!interacted.current && saved && ['queue','statements','payroll','ledger','exceptions','settings'].includes(saved.tab) && !window.location.search.includes('tab=settings')) setTarget(saved);
      } catch { /* Optional browser preferences. */ }
    }).catch(() => {});
    return () => { active = false; };
  }, [owner]);
  useEffect(() => {
    if (storageKey && interacted.current) try { localStorage.setItem(storageKey + ':location', JSON.stringify(target)); } catch { /* Optional browser preferences. */ }
  }, [storageKey, target]);
  const snapshot = resource.data;
  return (
    <FinancialStale.Provider value={!!resource.refreshError || !!resource.error}><ReportContext.Provider value={{ disabled: resource.loading || !!resource.refreshing || !!resource.refreshError || !!resource.error, asOf: resource.updatedAt ? new Date(resource.updatedAt) : null }}><CommissionAccessContext.Provider value={resource.invalidate}><CommissionWorkflowContext.Provider value={{ target, navigate, storageKey, remember }}><div className="commissions">
      <header>
        <p className="muted small">
          {owner ? 'Owner · private commission management' : 'Your commission statements'}
        </p>
        <div className="commission-page-heading"><h1>Commissions</h1>
        </div>
        <p className="muted">
          Track expected revenue, carrier receipts, producer earnings, and confirmed payments.
        </p>
      </header>
      {owner && (
        <Tabs id="commissions" label="Commission views" value={tab === 'payroll' ? 'statements' : tab}
          onChange={id => navigate(id === 'statements' && ['statements', 'payroll'].includes(tab) ? target : {tab:id})}
          items={[{value:'queue',label:'Work queue'},{value:'statements',label:'Guided workflow'},{value:'ledger',label:'Ledger'},{value:'exceptions',label:'Reviews & exceptions'},{value:'settings',label:'Setup'}]} />
      )}
      <LiveStatus resource={resource} />
      {resource.error && (
        <p className="error-text" role="alert">
          {resource.error}
        </p>
      )}
      <fieldset id={owner ? "commissions-panel" : undefined} role={owner ? "tabpanel" : undefined} aria-labelledby={owner ? `commissions-tab-${tab === 'payroll' ? 'statements' : tab}` : undefined} className="commission-workspace" disabled={!!resource.refreshError || !!resource.error}>
      {!snapshot ? (
        !resource.error && <p>Loading commissions…</p>
      ) : (
        <>
          {owner && tab === 'queue' && <CommissionWorkQueue data={snapshot} onAccessDenied={resource.invalidate} />}
          {tab === 'ledger' && <Ledger data={snapshot} owner={owner} refresh={resource.refetch} />}
          {owner && tab === 'settings' && <Settings data={snapshot} refresh={resource.refetch} />}
          {owner && ['statements', 'payroll'].includes(tab) && <div className="commission-action-bar"><Button variant="secondary" onClick={() => navigate({tab:'statements',intakeId:''})}>Statement inbox</Button><Button variant="secondary" onClick={() => navigate({tab:'payroll'})}>All payroll cycles & history</Button></div>}
          {owner && tab === 'statements' && (
            <><CommissionIntake data={snapshot} refreshLedger={resource.refetch} onAccessDenied={resource.invalidate}
              renderPolicySetup={(policyNumber, carrierId, adopted) => <CommissionPolicyLink policyNumber={policyNumber} carrierId={carrierId} data={snapshot} refresh={resource.refetch} adopted={adopted} denied={resource.invalidate} renderAccountSetup={(id, saved) => <AccountClassificationResource id={id} onSaved={saved} />} />} />
            <CommissionPanel open={!!target.statementId} title="Earlier reconciliation records" hint="Review existing drafts and posted statement history"><Statements data={snapshot} refresh={resource.refetch} /></CommissionPanel></>
          )}
          {owner && tab === 'exceptions' && <CommissionExceptions refreshLedger={resource.refetch} onAccessDenied={resource.invalidate} />}
          {owner && tab === 'payroll' && <Payroll data={snapshot} refresh={resource.refetch} reviewStatements={() => navigate({ tab: 'statements' })} />}
          {!owner && <BatchList batches={snapshot.batches} />}
        </>
      )}
    </fieldset></div></CommissionWorkflowContext.Provider></CommissionAccessContext.Provider></ReportContext.Provider></FinancialStale.Provider>
  );
}
