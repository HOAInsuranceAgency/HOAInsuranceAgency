import { listAllPages } from '../../../../shared/pagination';
import { useContext,useState } from 'react';
import {
COMMISSION_BASES,
type CommissionOverview
} from '../../../../shared/commissions';
import CommissionPlanSettings from '../../components/CommissionPlanSettings';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { client } from '../../lib/client';
import { communicationRequest } from '../../lib/communications';
import { useAsyncResource } from '../../lib/useAsyncResource';

import { AccountClassifications } from './AccountClassifications';
import { CarrierEditor } from './CarrierTermsEditor';
import { ActionForm,Field } from './CommissionForm';
import { CommissionAccessContext } from './context';
import { LegacyPolicies } from './LegacyPolicyImport';

export function Settings({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const references = useAsyncResource(
    async () => {
      const [team, carriers] = await Promise.all([
        communicationRequest('team', {}),
        listAllPages(async (nextToken) => {
          const page = await client.models.Carrier.list({ nextToken });
          if (page.errors?.length) throw new Error(page.errors[0].message ?? 'Could not load the carrier directory.');
          return page;
        }),
      ]);
      return { team: team.team, carriers };
    },
    [],
    { clearDataOnError: () => true },
  );
  const invalidate = useContext(CommissionAccessContext);
  const [carrier, setCarrier] = useState('');
  const [addingCarrier, setAddingCarrier] = useState(false);
  const [newCarrierName, setNewCarrierName] = useState('');
  const [newCarrierStatus, setNewCarrierStatus] = useState('');
  const [newCarrierId, setNewCarrierId] = useState(() => crypto.randomUUID());
  const [manageCarrier, setManageCarrier] = useState(false), [carrierDirty, setCarrierDirty] = useState(false), [addPolicy, setAddPolicy] = useState(false);
  const selectCarrier = (id: string) => { if (id === carrier) { setManageCarrier(true); return; } if (!carrierDirty || window.confirm('Discard unsaved carrier changes?')) { setCarrierDirty(false); setCarrier(id); setManageCarrier(true); } };
  if (!references.data) return <div className="card"><p role={references.error ? 'alert' : undefined}>{references.error || 'Loading teammates and carriers…'}</p>{references.error && <Button variant="secondary" onClick={() => void references.refetch()}>Retry team & carriers</Button>}</div>;
  return <section className="commission-settings commission-settings-compact">
    <section className="card commission-setup-intro">
      <div className="commission-section-heading"><div><h2>Agreements & carriers</h2><p>Review what is saved, then edit only what your policies need.</p></div><Button variant="secondary" disabled={references.loading} onClick={() => void references.refetch()}>Refresh team & carriers</Button></div>
      <div className="commission-setup-totals"><span><strong>{(data.planDefinitions ?? []).length}</strong> plans</span><span><strong>{data.plans.length}</strong> assigned employees</span><span><strong>{data.carriers.length}</strong> configured carriers</span></div>
      <p className="commission-setup-essential"><strong>Needed to process a receipt:</strong> an employee plan, account eligibility, a tracked policy, and proof of money received. Carrier forecasts are optional.</p>
      <nav className="commission-setup-nav" aria-label="Setup sections"><a href="#commission-plan-assignments">Employees</a><a href="#commission-carrier-terms">Carriers</a><a href="#commission-account-eligibility">Accounts</a><a href="#commission-existing-policies">Policies</a></nav>
    </section>
    <CommissionPlanSettings definitions={data.planDefinitions ?? []} plans={data.plans} team={references.data.team} refresh={refresh} denied={invalidate} />
    <section className="card commission-setting-section" id="commission-carrier-terms">
      <div className="commission-section-heading"><div><h2>Carriers</h2><p>Use actual receipts to calculate earnings. Add a forecast only when you know the carrier’s schedule.</p></div><div className="commission-inline-actions"><Button variant="secondary" type="button" onClick={() => { if (!manageCarrier || !carrierDirty || window.confirm('Discard unsaved carrier changes?')) { if (manageCarrier) { setCarrierDirty(false); setCarrier(''); } setManageCarrier(v => !v); } }}>{manageCarrier ? 'Close carrier editor' : 'Configure carrier'}</Button><Button variant="secondary" type="button" onClick={() => { setAddingCarrier(v => !v); setManageCarrier(true); }}>Add a carrier</Button></div></div>
      {data.carriers.length ? <div className="commission-scroll"><Table aria-label="Saved carrier settings"><thead><tr><th>Carrier</th><th>Tracking / payment schedule</th><th>Applies to</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{data.carriers.map(c => <tr key={c.id}><td><strong>{c.name}</strong></td><td>{c.receiptOnly ? <><span>Actual receipts only</span><span className="commission-row-note">Payment timing not configured</span></> : c.arrangements?.length ? c.arrangements.map(a => <div className="commission-summary-period" key={a.id}><span>{COMMISSION_BASES[a.basis]} · {a.cadence === 'ONCE' ? 'Once per trigger' : a.cadence === 'MONTHLY' ? 'Monthly' : 'Quarterly'}</span><span className="commission-row-note">Paid by {a.payor} · {a.trigger === 'BIND' ? 'After binding' : a.trigger === 'EFFECTIVE' ? 'From effective date' : a.trigger === 'COLLECTION' ? 'After premium collection' : 'As coverage is earned'} · {a.lagDays} day lag{a.cutoffDay ? ' · Cutoff day ' + a.cutoffDay : ''}{a.paymentDay ? ' · Payment day ' + a.paymentDay : ''}</span></div>) : <><span>{COMMISSION_BASES[c.basis]} · {c.schedule}</span><span className="commission-row-note">Legacy terms · forecast not configured</span></>}</td><td>{c.arrangements?.map(a => <div className="commission-summary-period" key={a.id}><span>{a.from}{a.to ? ' – ' + a.to : ' onward'}</span><span className="commission-row-note">{a.lines?.join(', ') || 'All coverage lines'} · {a.transaction ? a.transaction === 'NEW' ? 'New business' : 'Renewals' : 'New & renewal'} · {a.billType ? a.billType === 'DIRECT' ? 'Direct bill' : 'Agency bill' : 'All billing types'}</span><span className="commission-row-note">Reference: {a.evidence}</span></div>) ?? 'All policy dates'}</td><td><Button variant="secondary" type="button" aria-label={'Edit carrier ' + c.name} onClick={() => selectCarrier(c.id)}>Edit</Button></td></tr>)}</tbody></Table></div> : <p className="commission-compact-empty">No carriers configured. Choose Configure carrier, then Use actual receipts only to begin.</p>}
      {manageCarrier && <div className="commission-inline-editor">
        <div className="commission-section-heading"><h3>Carrier setup</h3><a className="commission-management-link" href="/carriers">Carrier directory</a></div>
      {addingCarrier && <div id="commission-new-carrier">
        <ActionForm title="Add a carrier to the CRM" button="Create carrier" disabled={!newCarrierName.trim() || !newCarrierStatus}
          onDone={async () => { await references.refetch(); setAddingCarrier(false); setNewCarrierName(''); setNewCarrierStatus(''); setNewCarrierId(crypto.randomUUID()); }}
          submit={async () => {
            const name = newCarrierName.trim();
            if (!name || !['APPOINTED', 'PROSPECTIVE'].includes(newCarrierStatus)) throw new Error('Enter the carrier name and confirm its appointment status.');
            const existing = references.data!.carriers.find(c => c.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
            if (existing) throw new Error('This carrier is already in the directory. Choose it from the Carrier list below.');
            const result = await client.models.Carrier.create({ id: newCarrierId, name, appointed: newCarrierStatus === 'APPOINTED' });
            if (result.errors?.length || !result.data) throw new Error(result.errors?.[0]?.message ?? 'Could not create the carrier. Refresh the directory before retrying.');
            setCarrier(result.data.id);
            return result.data;
          }}>
          <p className="small muted">Create the directory record first. Its payment terms and policy commission rates are configured separately.</p>
          <div className="form-grid">
            <Field label="New carrier name" value={newCarrierName} change={setNewCarrierName} />
            <label className="field">New carrier appointment status<Select required value={newCarrierStatus} onChange={e => setNewCarrierStatus(e.target.value)}><option value="">Confirm appointment status…</option><option value="APPOINTED">Appointed</option><option value="PROSPECTIVE">Prospective</option></Select></label>
          </div>
        </ActionForm>
      </div>}
        <label className="field">Carrier<Select value={carrier} onChange={event => selectCarrier(event.target.value)}><option value="">Choose a carrier…</option>{references.data.carriers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        {carrier && <CarrierEditor key={carrier + ':' + (data.carriers.find(c => c.id === carrier)?.version ?? 0)} id={carrier} terms={data.carriers.find(c => c.id === carrier)} refresh={refresh} dirty={setCarrierDirty} />}
      </div>}
    </section>
    <AccountClassifications accounts={data.accounts ?? []} refresh={refresh} />
    <section className="card commission-setting-section" id="commission-existing-policies">
      <div className="commission-section-heading"><div><h2>Tracked policies</h2><p>Only add policies that appear on the statement you are testing.</p></div><Button type="button" variant="secondary" onClick={() => setAddPolicy(v => !v)}>{addPolicy ? 'Close policy form' : 'Add existing policy'}</Button></div>
      {data.policies.length ? <div className="commission-scroll"><Table aria-label="Tracked commission policies"><thead><tr><th>Policy / account</th><th>Producer</th><th>Agency / producer rate</th><th>Policy dates</th></tr></thead><tbody>{data.policies.map(p => <tr key={p.id}><td><strong>{p.policyNumber}</strong><span className="commission-row-note">{p.accountName}</span></td><td>{p.producerName}</td><td>{p.agencyRateUnits / 10000}% / {p.producerBps / 100}%<span className="commission-row-note">{p.transaction === 'NEW' ? 'New business' : 'Renewal'}</span></td><td>{p.effectiveDate} – {p.expirationDate}</td></tr>)}</tbody></Table></div> : <p className="commission-compact-empty">No policies tracked yet.</p>}
      <div hidden={!addPolicy} className="commission-inline-editor"><LegacyPolicies data={data} refresh={refresh} /></div>
    </section>
  </section>;
}
