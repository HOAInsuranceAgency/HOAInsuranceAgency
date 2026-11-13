import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useIsOwner } from '../lib/auth';
import { useAsyncResource } from '../lib/useAsyncResource';
import { client, listAllPages } from '../lib/client';
import { communicationRequest, type TeamEligibility } from '../lib/communications';
import { commissionAction, readCommissions } from '../lib/commissions';
import { attachCommissionStatement } from '../lib/commissionStatementAttachment';
import AccountPicker from '../components/AccountPicker';
import CommissionPayroll from '../components/CommissionPayroll';
import CommissionExceptions from '../components/CommissionExceptions';
import CommissionPlanSettings from '../components/CommissionPlanSettings';
import CommissionStatementImport from '../components/CommissionStatementImport';
import CommissionPanel from '../components/CommissionPanel';
import { useEditProtection, useUnsavedChanges } from '../lib/editProtection';
import { isAuthorizationError } from '../lib/authorizationError';
import { ReportDownload } from '../components/ReportDownload';
import {
  COMMISSION_BASES,
  COMMISSION_REVIEW_CATEGORIES,
  ACCOUNT_COMMISSION_CLASSES,
  type CommissionAccount,
  type AccountCommissionClass,
  decimal,
  policyTotals,
  recoveryBalances,
  carrierReconciliationBalances,
  batchPaidCents,
  ratio,
  sum,
  type CommissionOverview,
  type CarrierCommissionTerms,
  type CarrierPaymentArrangement,
  type CommissionReconciliationBalances,
  type CommissionStatement,
  type CommissionBatch,
  type CommissionPolicy,
  type StatementLine,
} from '../../../shared/commissions';
import './Commissions.css';

const commissionCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => commissionCurrency.format(cents / 100);
const CommissionAccessContext = createContext<(error: unknown) => void>(() => {});
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export default function Commissions() {
  const owner = useIsOwner();
  // Unmount private data/forms immediately on role switch, including pending requests.
  return <CommissionView key={owner ? 'owner' : 'self'} owner={owner} />;
}
function CommissionView({ owner }: { owner: boolean }) {
  const { requestLeave } = useEditProtection();
  const resource = useAsyncResource(readCommissions, [], {
    errorMessage: 'Could not load commissions.',
    clearDataOnError: () => true,
  });
  const [tab, setTab] = useState(() => owner && new URLSearchParams(window.location.search).get('tab') === 'settings' ? 'settings' : 'ledger');
  const snapshot = resource.data;
  return (
    <CommissionAccessContext.Provider value={resource.invalidate}><div className="commissions">
      <header>
        <p className="muted small">
          {owner ? 'Owner · private commission management' : 'Your commission statements'}
        </p>
        <div className="commission-page-heading"><h1>Commissions</h1>
        {owner && <button className="primary" onClick={() => requestLeave(() => setTab('settings'))}>Commission setup</button>}</div>
        <p className="muted">
          Track expected revenue, carrier receipts, producer earnings, and confirmed payments.
        </p>
      </header>
      {owner && (
        <div className="commission-tabs" role="tablist" aria-label="Commission views">
          {[
            ['ledger', 'Ledger'],
            ['statements', 'Reconciliation'],
            ['payroll', 'Payroll'],
            ['exceptions', 'Shared & exceptions'],
            ['settings', 'Agreements & carriers'],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'primary' : 'secondary'}
              onClick={() => requestLeave(() => setTab(id))}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <button
        className="secondary"
        disabled={resource.loading}
        onClick={() => void resource.refetch()}
      >
        Refresh commissions
      </button>
      {resource.error && (
        <p className="error-text" role="alert">
          {resource.error}
        </p>
      )}
      {!snapshot ? (
        !resource.error && <p>Loading commissions…</p>
      ) : (
        <>
          {tab === 'ledger' && <Ledger data={snapshot} owner={owner} refresh={resource.refetch} />}
          {owner && tab === 'settings' && <Settings data={snapshot} refresh={resource.refetch} />}
          {owner && tab === 'statements' && (
            <Statements data={snapshot} refresh={resource.refetch} />
          )}
          {owner && tab === 'exceptions' && <CommissionExceptions refreshLedger={resource.refetch} onAccessDenied={resource.invalidate} />}
          {owner && tab === 'payroll' && <Payroll data={snapshot} refresh={resource.refetch} />}
          {!owner && <BatchList batches={snapshot.batches} />}
        </>
      )}
    </div></CommissionAccessContext.Provider>
  );
}
function Ledger({
  data,
  owner,
  refresh,
}: {
  data: CommissionOverview;
  owner: boolean;
  refresh: () => Promise<void>;
}) {
  const [asOf, setAsOf] = useState(today);
  const totals = data.policies.map(policyTotals),
    recoveries = data.policies.map((p) => recoveryBalances(p, data.batches)),
    paid = sum(data.batches.map(batchPaidCents));
  const earningRows = data.earnings ?? [];
  const earned = sum([...totals.map((t) => t.earned), ...earningRows.filter(e=>e.status==='PAYABLE').map(e=>e.amountCents)]);
  return (
    <>
      <div className="stat-row">
        {[
          ['Agency received', sum(totals.map((t) => t.receivedAgency))],
          ['Producer earned', earned],
          ['Paid', paid],
          ['Unpaid earnings', earned - paid],
          ['Proposed paid recoveries', sum([...recoveries.map((t) => t.paidRecovery),...earningRows.filter(e=>e.source==='ADJUSTMENT'&&e.status==='REVIEW'&&e.amountCents<0).map(e=>-e.amountCents)])],
          ['Unpaid adjustments to review', sum(recoveries.map((t) => t.unpaidAdjustment))],
          ['Partially paid adjustments to review', sum(recoveries.map(t => t.partialAdjustment ?? 0))],
        ].map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="l">{label}</span>
            <strong>{money(Number(value))}</strong>
          </div>
        ))}
      </div>
      <p className="muted small">
        Proposed adjustments are shown separately and do not reduce payroll.{' '}
        {owner
          ? 'Recovery collection is not enabled; review the agreement and permitted recovery method first.'
          : 'Contact the Owner to review or dispute a statement line.'}
      </p>
      <ReportDownload
        report={{
          title: 'Producer commission ledger',
          commissionLedger: {
            scope: owner ? 'All displayed employees' : 'Your displayed earnings',
            isTest: data.isTest,
            agencyReceivedCents: sum(totals.map(t => t.receivedAgency)),
            earnedCents: earned, paidCents: paid,
            proposedPaidRecoveryCents: sum([...recoveries.map(t => t.paidRecovery), ...earningRows.filter(e => e.source === 'ADJUSTMENT' && e.status === 'REVIEW' && e.amountCents < 0).map(e => -e.amountCents)]),
            unpaidAdjustmentCents: sum(recoveries.map(t => t.unpaidAdjustment)),
            partialAdjustmentCents: sum(recoveries.map(t => t.partialAdjustment ?? 0)),
          },
          filters:
            'USD · actual receipts and frozen producer rates · proposed recoveries excluded from payroll',
          sections: [
            {
              title: 'Transactions',
              columns: [
                'Producer',
                'Account',
                'Policy',
                'Receipt date',
                'Type',
                'Revenue source',
                'Agency revenue (USD)',
                'Producer rate (%)',
                'Producer amount (USD)',
                'Payment batch',
                'Carrier transaction reference',
              ],
              rows: data.policies.flatMap((p) =>
                p.entries.map((e) => [
                  p.producerName,
                  p.accountName,
                  p.policyNumber,
                  e.receivedOn,
                  e.kind + (e.allocationId ? ' · shared allocation' : '') + (e.supersededBy ? ' · corrected' : '') + (e.excludedByCase ? ' · excluded' : ''),
                  e.revenueKind === "BROKER_FEE" ? "Broker fee" : "Carrier commission",
                  e.agencyCents / 100,
                  e.allocationId ? '' : p.producerBps / 100,
                  e.allocationId ? '' : e.producerCents / 100,
                  e.batchId ?? '',
                  e.lineRef,
                ]),
              ),
            },
            {
              title: 'Employee earnings allocations (agency cash is recorded above)',
              columns: ['Employee', 'Account', 'Policy', 'Date', 'Source', 'Policy share (%)', 'Plan rate (%)', 'Employee amount (USD)', 'Status', 'Payment batch', 'Earning ID', 'Original receipt / adjustment ID'],
              rows: earningRows.map(e => [e.producerName, e.accountName, e.policyNumber, e.receivedOn, e.source, e.shareBps === undefined ? '' : e.shareBps / 100, e.source === 'ADJUSTMENT' ? '' : e.producerBps / 100, e.amountCents / 100, e.status, e.batchId ?? '', e.id, e.entryId]),
            },
            {
              title: 'Recorded payments',
              columns: ['Employee','Payroll cycle / batch','Payment date','Amount paid (USD)','Reference'],
              rows: data.batches.filter(b=>b.status!=='CANCELLED').flatMap(b=>(b.payments?.length ? b.payments.map(p=>[b.producerName,b.cycleId??b.id,p.paidOn,p.amountCents/100,owner?p.reference:'Recorded payment']) : b.status==='PAID' ? [[b.producerName,b.cycleId??b.id,b.actualPaidOn??b.payDate,batchPaidCents(b)/100,owner?(b.reference??'Recorded payment'):'Recorded payment']] : [])),
            },
          ],
        }}
      />
      {!!earningRows.length && <section className="card"><h2>Shared commission & adjustment earnings</h2><div className="commission-scroll"><table><thead><tr>{owner&&<th>Employee</th>}<th>Policy</th><th>Date</th><th>Source</th><th>Share / rate</th><th>Employee amount</th><th>Status</th></tr></thead><tbody>{earningRows.map(e=><tr key={e.id}>{owner&&<td>{e.producerName}</td>}<td>{e.accountName}<div className="small muted">{e.policyNumber}</div></td><td>{e.receivedOn}</td><td>{e.source==='ADJUSTMENT'?'Approved adjustment':'Shared receipt'}</td><td>{e.shareBps===undefined?'—':e.shareBps/100+'% share · '+e.producerBps/100+'% rate'}</td><td>{money(e.amountCents)}</td><td>{e.batchId?(data.batches.find(b=>b.id===e.batchId)?.status??'Allocated'):e.status}</td></tr>)}</tbody></table></div><p className="small muted">Shared earnings reference one carrier receipt. Compensation adjustments do not change agency cash received.</p></section>}
      {!data.policies.length && !earningRows.length && (
        <div className="card">
          No commission snapshots yet.{' '}
          {owner
            ? 'Configure producer agreements, account classifications, and carrier terms, then bind a policy.'
            : 'Your policy commission records will appear here after binding.'}
        </div>
      )}
      {owner && (
        <label className="field commission-asof">
          Receipt reconciliation as of
          <input
            type="date"
            required
            value={asOf}
            onChange={(e) => setAsOf(e.target.value || today())}
          />
        </label>
      )}
      {data.policies.map((p) => {
        const t = policyTotals(p);
        const allocatedEarnings = earningRows.filter(e => e.policyId === p.id && e.status === 'PAYABLE');
        const employeeEarned = t.earned + sum(allocatedEarnings.map(e => e.amountCents));
        const hasSharedReceipts = p.entries.some(e => e.allocationId);
        return (
          <section className="card" key={p.id}>
            <h2>
              {p.accountName} · {p.policyNumber}
            </h2>
            <p className="muted">
              {p.carrierName} · {p.effectiveDate} to {p.expirationDate} ·{' '}
              {p.transaction === 'NEW' ? 'New business' : 'Renewal'} · {p.producerName}
            </p>
            <p>
              Premium {money(p.premiumCents)} · Agency {p.agencyRateUnits / 10000}% · {hasSharedReceipts ? 'Original producer rate' : 'Producer'}{' '}
              {p.producerBps / 100}% of agency commission
              {hasSharedReceipts && ' · Shared receipts use the individual shares and rates shown above.'}
            </p>
            {p.eligibility && (
              <p className="small">
                {p.eligibility.eligible
                  ? 'Account passes first-bind cutoff'
                  : 'Noncommissionable account — includes later renewals'}
                {` · First bound ${p.eligibility.accountFirstBoundOn} · Cutoff ${p.eligibility.accountBoundFrom}`}
              </p>
            )}
            {owner && (
              <p className="small">
                {p.accountClassification
                  ? `${ACCOUNT_COMMISSION_CLASSES[p.accountClassification.classification]} · ${p.agreement} · Classification reference: ${p.accountClassification.evidence}`
                  : 'Legacy snapshot · original rate retained; account classification was not recorded.'}
              </p>
            )}
            <p className="small">
              Full-term agency estimate {money(t.expectedAgency)} · Agency received{' '}
              {money(t.receivedAgency)} · {owner ? 'Employee earnings' : 'Your earnings'} {money(employeeEarned)} · Proposed adjustments{' '}
              {money(t.proposedRecovery)}
            </p>
            {owner ? (
              <>
                <CarrierBalances balances={carrierReconciliationBalances(p, asOf)} />
                <CommissionPanel title="Manage expected receipts">
                  <ReceiptForecastEditor
                    key={`${p.id}:${p.version}`}
                    policy={p}
                    refresh={refresh}
                  />
                </CommissionPanel>
                <PolicyNumber key={`${p.id}:${p.version}`} policy={p} refresh={refresh} />
                <PolicyReview key={`review:${p.id}:${p.version}`} policy={p} refresh={refresh} />
              </>
            ) : p.reconciliationBalances ? (
              <CarrierBalances balances={p.reconciliationBalances} />
            ) : null}
            {p.entries.length ? (
              <div className="commission-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Agency</th>
                      <th>Producer</th>
                      <th>Payment</th>
                      {owner && <th>Review notes</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {p.entries.map((e) => (
                      <tr key={e.id}>
                        <td>{e.receivedOn}</td>
                        <td>
                          {e.kind}{e.allocationId ? ' · shared allocation' : ''}{e.supersededBy ? ' · corrected' : ''}{e.excludedByCase ? ' · excluded' : ''}
                          <div className="small">{e.revenueKind === "BROKER_FEE" ? "Broker fee" : "Carrier commission"}</div>
                          <div className="small muted">{e.lineRef}</div>
                        </td>
                        <td>{money(e.agencyCents)}</td>
                        <td>{e.allocationId ? 'See employee allocations' : money(e.producerCents)}</td>
                        <td>
                          {e.supersededBy ? 'Replaced by correction' : e.excludedByCase ? 'Excluded by approved review' : e.allocationId ? 'See employee allocations' : e.kind !== 'RECEIPT'
                            ? 'Proposed adjustment'
                            : e.batchId
                              ? (data.batches.find((b) => b.id === e.batchId)?.status ??
                                'Batch pending refresh')
                              : e.producerCents
                                ? 'Unpaid'
                                : 'Not commissionable'}
                        </td>
                        {owner && <td>{e.eligibilityNote}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                Awaiting carrier commission or broker fee receipts. Binding alone does not create payable earnings.
              </p>
            )}
          </section>
        );
      })}
    </>
  );
}
function PolicyReview({ policy, refresh }: { policy: CommissionPolicy; refresh: () => Promise<void> }) {
  const [category, setCategory] = useState<string>('DOCUMENTATION'), [note, setNote] = useState(''), [dueOn, setDueOn] = useState(today());
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const holds = policy.reviewHolds ?? [];
  return <CommissionPanel open={holds.some(h => h.status === 'OPEN')} title={<>Commission review items ({holds.filter(h => h.status === 'OPEN').length} open)</>}>
    <p>Open items require review before including this policy in new payroll. Record agreement evidence for licensing, documentation, splits, cancellation, separation, or disputes. A new item also holds affected approved cycles for fresh approval. Check delivery history and coordinate with HR if a report already started sending. Resolving an item does not change a rate or collect a recovery.</p>
    {holds.map(h => <section className="commission-review-item" key={h.id}>
      <p><strong>{h.category} / {h.status}</strong> — Due {h.dueOn}</p><p>{h.note}</p>
      {h.status === 'RESOLVED' ? <p>Resolution: {h.resolution}</p> : <ActionForm title="Resolve review item" button="Resolve with evidence" onDone={refresh} submit={() => commissionAction('resolveCommissionReview', { id: policy.id, version: policy.version, holdId: h.id, resolution: resolutions[h.id] ?? '' })}>
        <Field label={`Resolution for ${h.category}`} value={resolutions[h.id] ?? ''} change={value => setResolutions(r => ({ ...r, [h.id]: value }))} />
      </ActionForm>}
    </section>)}
    <ActionForm title="Add commission review item" onDone={refresh} submit={() => commissionAction('addCommissionReview', { id: policy.id, version: policy.version, category, note, dueOn })}>
      <label className="field">Review category<select value={category} onChange={e => setCategory(e.target.value)}>{COMMISSION_REVIEW_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
      <Field label="Issue and supporting evidence" value={note} change={setNote} /><Field label="Review due date" type="date" value={dueOn} change={setDueOn} />
    </ActionForm>
  </CommissionPanel>;
}
function ActionForm({
  title,
  submit,
  children,
  onDone,
  button = 'Save',
  disabled = false,
}: {
  title: string;
  submit: () => Promise<unknown>;
  children: ReactNode;
  onDone: () => Promise<void>;
  button?: string;
  disabled?: boolean;
}) {
  const invalidate = useContext(CommissionAccessContext);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const lock = useRef(false);
  async function run(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await submit();
      await onDone();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      if (isAuthorizationError(err)) invalidate(err);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="card commission-form" onSubmit={(e) => void run(e)}>
      <h2>{title}</h2>
      <fieldset disabled={busy}>
        <div className="commission-form-body">{children}</div>
        <div className="form-actions">
          <button className="primary" type="submit" disabled={disabled}>
            {busy ? 'Saving…' : button}
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {saved && <p className="commission-saved" role="status">Saved.</p>}
    </form>
  );
}
function Field({
  label,
  value,
  change,
  type = 'text',
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      {label}
      <input required type={type} value={value} onChange={(e) => change(e.target.value)} />
    </label>
  );
}
function Settings({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const references = useAsyncResource(
    async () => {
      const [team, carriers] = await Promise.all([
        communicationRequest<{ team: TeamEligibility[] }>('team', {}),
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
  if (!references.data) return <div className="card"><p role={references.error ? 'alert' : undefined}>{references.error || 'Loading teammates and carriers…'}</p>{references.error && <button className="secondary" onClick={() => void references.refetch()}>Retry team & carriers</button>}</div>;
  return <section className="commission-settings commission-settings-compact">
    <section className="card commission-setup-intro">
      <div className="commission-section-heading"><div><h2>Agreements & carriers</h2><p>Review what is saved, then edit only what your test policy needs.</p></div><button className="secondary" disabled={references.loading} onClick={() => void references.refetch()}>Refresh team & carriers</button></div>
      <div className="commission-setup-totals"><span><strong>{(data.planDefinitions ?? []).length}</strong> plans</span><span><strong>{data.plans.length}</strong> assigned employees</span><span><strong>{data.carriers.length}</strong> configured carriers</span></div>
      <p className="commission-setup-essential"><strong>Needed for a receipt test:</strong> an employee plan, account eligibility, a tracked policy, and proof of money received. Carrier forecasts are optional.</p>
      <nav className="commission-setup-nav" aria-label="Setup sections"><a href="#commission-plan-assignments">Employees</a><a href="#commission-carrier-terms">Carriers</a><a href="#commission-account-eligibility">Accounts</a><a href="#commission-existing-policies">Policies</a></nav>
    </section>
    <CommissionPlanSettings definitions={data.planDefinitions ?? []} plans={data.plans} team={references.data.team} refresh={refresh} denied={invalidate} />
    <section className="card commission-setting-section" id="commission-carrier-terms">
      <div className="commission-section-heading"><div><h2>Carriers</h2><p>Use actual receipts to calculate earnings. Add a forecast only when you know the carrier’s schedule.</p></div><div className="commission-inline-actions"><button className="secondary" type="button" onClick={() => { if (!manageCarrier || !carrierDirty || window.confirm('Discard unsaved carrier changes?')) { if (manageCarrier) { setCarrierDirty(false); setCarrier(''); } setManageCarrier(v => !v); } }}>{manageCarrier ? 'Close carrier editor' : 'Configure carrier'}</button><button className="secondary" type="button" onClick={() => { setAddingCarrier(v => !v); setManageCarrier(true); }}>Add a carrier</button></div></div>
      {data.carriers.length ? <div className="commission-scroll"><table aria-label="Saved carrier settings"><thead><tr><th>Carrier</th><th>Tracking / payment schedule</th><th>Applies to</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{data.carriers.map(c => <tr key={c.id}><td><strong>{c.name}</strong></td><td>{c.receiptOnly ? <><span>Actual receipts only</span><span className="commission-row-note">Payment timing not configured</span></> : c.arrangements?.length ? c.arrangements.map(a => <div className="commission-summary-period" key={a.id}><span>{COMMISSION_BASES[a.basis]} · {a.cadence === 'ONCE' ? 'Once per trigger' : a.cadence === 'MONTHLY' ? 'Monthly' : 'Quarterly'}</span><span className="commission-row-note">Paid by {a.payor} · {a.trigger === 'BIND' ? 'After binding' : a.trigger === 'EFFECTIVE' ? 'From effective date' : a.trigger === 'COLLECTION' ? 'After premium collection' : 'As coverage is earned'} · {a.lagDays} day lag{a.cutoffDay ? ' · Cutoff day ' + a.cutoffDay : ''}{a.paymentDay ? ' · Payment day ' + a.paymentDay : ''}</span></div>) : <><span>{COMMISSION_BASES[c.basis]} · {c.schedule}</span><span className="commission-row-note">Legacy terms · forecast not configured</span></>}</td><td>{c.arrangements?.map(a => <div className="commission-summary-period" key={a.id}><span>{a.from}{a.to ? ' – ' + a.to : ' onward'}</span><span className="commission-row-note">{a.lines?.join(', ') || 'All coverage lines'} · {a.transaction ? a.transaction === 'NEW' ? 'New business' : 'Renewals' : 'New & renewal'} · {a.billType ? a.billType === 'DIRECT' ? 'Direct bill' : 'Agency bill' : 'All billing types'}</span><span className="commission-row-note">Reference: {a.evidence}</span></div>) ?? 'All policy dates'}</td><td><button className="secondary" type="button" aria-label={'Edit carrier ' + c.name} onClick={() => selectCarrier(c.id)}>Edit</button></td></tr>)}</tbody></table></div> : <p className="commission-compact-empty">No carriers configured. Choose Configure carrier, then Use actual receipts only to begin.</p>}
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
            <label className="field">New carrier appointment status<select required value={newCarrierStatus} onChange={e => setNewCarrierStatus(e.target.value)}><option value="">Confirm appointment status…</option><option value="APPOINTED">Appointed</option><option value="PROSPECTIVE">Prospective</option></select></label>
          </div>
        </ActionForm>
      </div>}
        <label className="field">Carrier<select value={carrier} onChange={event => selectCarrier(event.target.value)}><option value="">Choose a carrier…</option>{references.data.carriers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {carrier && <CarrierEditor key={carrier + ':' + (data.carriers.find(c => c.id === carrier)?.version ?? 0)} id={carrier} terms={data.carriers.find(c => c.id === carrier)} refresh={refresh} dirty={setCarrierDirty} />}
      </div>}
    </section>
    <AccountClassifications accounts={data.accounts ?? []} refresh={refresh} />
    <section className="card commission-setting-section" id="commission-existing-policies">
      <div className="commission-section-heading"><div><h2>Tracked policies</h2><p>Only add policies that appear on the statement you are testing.</p></div><button type="button" className="secondary" onClick={() => setAddPolicy(v => !v)}>{addPolicy ? 'Close policy form' : 'Add existing policy'}</button></div>
      {data.policies.length ? <div className="commission-scroll"><table aria-label="Tracked commission policies"><thead><tr><th>Policy / account</th><th>Producer</th><th>Agency / producer rate</th><th>Policy dates</th></tr></thead><tbody>{data.policies.map(p => <tr key={p.id}><td><strong>{p.policyNumber}</strong><span className="commission-row-note">{p.accountName}</span></td><td>{p.producerName}</td><td>{p.agencyRateUnits / 10000}% / {p.producerBps / 100}%<span className="commission-row-note">{p.transaction === 'NEW' ? 'New business' : 'Renewal'}</span></td><td>{p.effectiveDate} – {p.expirationDate}</td></tr>)}</tbody></table></div> : <p className="commission-compact-empty">No policies tracked yet.</p>}
      <div hidden={!addPolicy} className="commission-inline-editor"><LegacyPolicies data={data} refresh={refresh} /></div>
    </section>
  </section>;
}
function AccountClassifications({ accounts, refresh }: { accounts: CommissionAccount[]; refresh: () => Promise<void> }) {
  const [accountId, setAccountId] = useState(''), [editing, setEditing] = useState(false);
  return <section className="card commission-setting-section" id="commission-account-eligibility">
    <div className="commission-section-heading"><div><h2>Account eligibility</h2><p>Confirm Standard or GIM and the original first-bind history for the accounts you are testing.</p></div><button className="secondary" type="button" onClick={() => setEditing(v => !v)}>{editing ? 'Close account form' : 'Add account classification'}</button></div>
    {accounts.length ? <div className="commission-scroll"><table aria-label="Saved account classifications"><thead><tr><th>Account</th><th>Classification / dates</th><th>First bind</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{accounts.map(a => <tr key={a.id}><td><strong>{a.name}</strong></td><td>{a.periods.map((p, i) => <div className="commission-summary-period" key={i}>{p.classification === 'GIM' ? 'GIM' : 'Standard'}<span className="commission-row-note">{p.from}{p.to ? ' – ' + p.to : ' onward'}</span></div>)}</td><td>{a.firstBoundOn || (a.neverBound ? 'Never bound' : 'Needs review')}</td><td><button type="button" className="secondary" aria-label={'Edit account ' + a.name} onClick={() => { setAccountId(a.id); setEditing(true); }}>Edit</button></td></tr>)}</tbody></table></div> : <p className="commission-compact-empty">No account classifications saved.</p>}
    <div hidden={!editing} className="commission-inline-editor"><AccountPicker value={accountId} onChange={setAccountId} disabled={false} />{accountId && <AccountClassificationResource key={accountId} id={accountId} onSaved={refresh} />}</div>
  </section>;
}
function AccountClassificationResource({ id, onSaved }: { id: string; onSaved: () => Promise<void> }) {
  const invalidate = useContext(CommissionAccessContext);
  const resource = useAsyncResource(
    async () => {
      try { return await commissionAction<{ classification: CommissionAccount | null; accountName: string }>('getAccountClassification', { id }); }
      catch (error) { if (isAuthorizationError(error)) invalidate(error); throw error; }
    },
    [id],
    { clearDataOnError: () => true },
  );
  if (resource.error)
    return (
      <div role="alert">
        <p>{resource.error}</p>
        <button type="button" className="secondary" onClick={() => void resource.refetch()}>
          Retry account classification
        </button>
      </div>
    );
  if (!resource.data || resource.loading) return <p>Loading account classification…</p>;
  return (
    <AccountClassificationEditor
      key={`${id}:${resource.data.classification?.version ?? 0}`}
      id={id}
      name={resource.data.accountName}
      account={resource.data.classification ?? undefined}
      refresh={async () => { await resource.refetch(); await onSaved(); }}
    />
  );
}
function AccountClassificationEditor({
  id,
  name,
  account,
  refresh,
}: {
  id: string;
  name: string;
  account?: CommissionAccount;
  refresh: () => Promise<void>;
}) {
  const [history, setHistory] = useState(
    account?.firstBoundOn ? 'BOUND' : account?.neverBound ? 'NEW' : '',
  );
  const [firstBoundOn, setFirstBoundOn] = useState(account?.firstBoundOn ?? '');
  const [bindingEvidence, setBindingEvidence] = useState(account?.bindingEvidence ?? '');
  const [periods, setPeriods] = useState(
    account?.periods.map((p) => ({ ...p, to: p.to ?? '' })) ?? [
      {
        from: '',
        to: '',
        classification: '' as AccountCommissionClass | '',
        evidence: '',
      },
    ],
  );
  return (
    <ActionForm
      title={`${name} · commission classification`}
      button="Save classification"
      onDone={refresh}
      submit={() =>
        commissionAction('saveAccountClassification', {
          id,
          version: account?.version ?? 0,
          ...(history === 'BOUND' ? { firstBoundOn } : { neverBound: true }),
          bindingEvidence,
          periods: periods.map((p) => ({
            from: p.from,
            ...(p.to ? { to: p.to } : {}),
            classification: p.classification,
            evidence: p.evidence,
          })),
        })
      }
    >
      <p className="small muted">
        Use the bind date for new business and the term effective date for renewals. Existing
        snapshots keep their original classification and rate. Through dates are inclusive.
      </p>
      <label className="field">
        Original account binding history
        <select required value={history} onChange={(e) => setHistory(e.target.value)}>
          <option value="">Confirm the account’s history…</option>
          <option value="NEW">Never bound with this agency</option>
          <option value="BOUND">Previously bound with this agency</option>
        </select>
      </label>
      {history === 'BOUND' && (
        <Field
          label="Account’s original first bind date"
          type="date"
          value={firstBoundOn}
          change={setFirstBoundOn}
        />
      )}
      <Field
        label="First-bind history reference"
        value={bindingEvidence}
        change={setBindingEvidence}
      />
      <p className="small muted">
        Include business that predates the CRM. For a genuinely new account, its first successful
        bind records this date automatically. An older account stays excluded on all later renewals
        when a producer’s cutoff applies.
      </p>
      {periods.map((p, i) => (
        <div key={i} className="commission-period">
          <div className="form-grid">
            <Field
              label={`Classification effective from ${i + 1}`}
              type="date"
              value={p.from}
              change={(v) => setPeriods(periods.map((r, j) => (i === j ? { ...r, from: v } : r)))}
            />
            <label className="field">
              {`Classification through ${i + 1} (optional)`}
              <input
                type="date"
                value={p.to}
                onChange={(e) =>
                  setPeriods(periods.map((r, j) => (i === j ? { ...r, to: e.target.value } : r)))
                }
              />
            </label>
            <label className="field">
              {`Account classification ${i + 1}`}
              <select
                required
                value={p.classification}
                onChange={(e) =>
                  setPeriods(
                    periods.map((r, j) =>
                      i === j
                        ? {
                            ...r,
                            classification: e.target.value as AccountCommissionClass,
                          }
                        : r,
                    ),
                  )
                }
              >
                <option value="">Choose Standard or GIM…</option>
                {Object.entries(ACCOUNT_COMMISSION_CLASSES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Field
            label={`Classification reference ${i + 1}`}
            value={p.evidence}
            change={(v) => setPeriods(periods.map((r, j) => (i === j ? { ...r, evidence: v } : r)))}
          />
          <button
            type="button"
            className="secondary"
            disabled={periods.length === 1}
            onClick={() => setPeriods(periods.filter((_, j) => i !== j))}
          >
            Remove classification period
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          setPeriods([...periods, { from: '', to: '', classification: '', evidence: '' }])
        }
      >
        Add classification period
      </button>
    </ActionForm>
  );
}
type ArrangementDraft = {
  id: string;
  from: string;
  to: string;
  lines: string;
  transaction: CarrierPaymentArrangement['transaction'] | '';
  billType: CarrierPaymentArrangement['billType'] | '';
  basis: CarrierPaymentArrangement['basis'] | '';
  payor: string;
  trigger: CarrierPaymentArrangement['trigger'] | '';
  cadence: CarrierPaymentArrangement['cadence'] | '';
  lagDays: string;
  cutoffDay: string;
  paymentDay: string;
  earningMethod: CarrierPaymentArrangement['earningMethod'] | '';
  evidence: string;
  notes: string;
};
const blankArrangement = (): ArrangementDraft => ({
  id: crypto.randomUUID(),
  from: '',
  to: '',
  lines: '',
  transaction: '',
  billType: '',
  basis: '',
  payor: '',
  trigger: '',
  cadence: '',
  lagDays: '',
  cutoffDay: '',
  paymentDay: '',
  earningMethod: '',
  evidence: '',
  notes: '',
});
function CarrierEditor({
  id,
  terms,
  refresh,
  dirty,
}: {
  id: string;
  terms?: CarrierCommissionTerms;
  refresh: () => Promise<void>;
  dirty?: (changed: boolean) => void;
}) {
  const [arrangements, setArrangements] = useState<ArrangementDraft[]>(
    () =>
      terms?.arrangements?.map((a) => ({
        ...a,
        to: a.to ?? '',
        lines: a.lines?.join(', ') ?? '',
        transaction: a.transaction ?? '',
        billType: a.billType ?? '',
        lagDays: String(a.lagDays),
        cutoffDay: a.cutoffDay == null ? '' : String(a.cutoffDay),
        paymentDay: a.paymentDay == null ? '' : String(a.paymentDay),
        earningMethod: a.earningMethod ?? '',
        notes: a.notes ?? '',
      })) ?? [],
  );
  const update = (index: number, change: Partial<ArrangementDraft>) =>
    setArrangements(arrangements.map((a, i) => (i === index ? { ...a, ...change } : a)));
  const [schedule, setSchedule] = useState(!!terms && !terms.receiptOnly);
  const initial = useRef(JSON.stringify(arrangements));
  const changed = initial.current !== JSON.stringify(arrangements);
  useUnsavedChanges(changed);
  useEffect(() => { dirty?.(changed); }, [changed, dirty]);
  return <div className="commission-carrier-editor">
    <div className="commission-receipt-choice">
      <div><strong>Actual receipts only</strong><p>Enough to reconcile statements and calculate employee earnings. Expected payment dates stay unknown.</p></div>
      {terms?.receiptOnly ? <span className="commission-status-label">Enabled</span> : <ActionForm title="Enable receipt tracking" button="Use actual receipts only" disabled={changed} onDone={refresh} submit={() => commissionAction('saveCarrier', { id, version: terms?.version ?? 0, receiptOnly: true })}>
        {terms && <p className="small muted">This replaces the schedule for future policy snapshots. Existing snapshots keep their saved terms.</p>}
      </ActionForm>}
    </div>
    <button type="button" className="secondary" aria-expanded={schedule} onClick={() => setSchedule(v => !v)}>{schedule ? 'Hide payment forecast' : 'Add payment forecast (optional)'}</button>
    {schedule && (
    <ActionForm
      title="Carrier commission payment terms"
      button="Save carrier payment terms"
      disabled={!arrangements.length}
      onDone={refresh}
      submit={() => {
        const first = arrangements[0];
        return commissionAction('saveCarrier', {
          id,
          version: terms?.version ?? 0,
          basis: first?.basis ?? terms?.basis,
          schedule:
            (terms?.schedule && !terms.receiptOnly) ? terms.schedule : `${first.cadence} · ${first.trigger} · ${first.lagDays} day lag`,
          evidence: first?.evidence ?? terms?.evidence,
          arrangements: arrangements.map((a) => ({
            id: a.id,
            from: a.from,
            ...(a.to ? { to: a.to } : {}),
            ...(a.lines.trim()
              ? {
                  lines: a.lines
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(a.transaction ? { transaction: a.transaction } : {}),
            ...(a.billType ? { billType: a.billType } : {}),
            basis: a.basis,
            payor: a.payor,
            trigger: a.trigger,
            cadence: a.cadence,
            lagDays: Number(a.lagDays),
            ...(a.cadence !== 'ONCE' && a.cutoffDay ? { cutoffDay: Number(a.cutoffDay) } : {}),
            ...(a.paymentDay ? { paymentDay: Number(a.paymentDay) } : {}),
            ...(a.basis === 'EARNED' && a.earningMethod ? { earningMethod: a.earningMethod } : {}),
            evidence: a.evidence,
            ...(a.notes ? { notes: a.notes } : {}),
          })),
        });
      }}
    >
      <p className="small muted">
        Optional forecasting only. Enter confirmed carrier rules below; actual receipts determine employee earnings.
        Effective dates select the agreement for each policy.
      </p>
      {terms && !terms.receiptOnly && !terms.arrangements?.length && (
        <div className="commission-notice">
          <strong>Legacy carrier terms need a structured payment arrangement.</strong>
          <p>
            {COMMISSION_BASES[terms.basis]} · {terms.schedule} · Reference: {terms.evidence}
          </p>
          <p>
            Review the carrier agreement before entering dates or payment rules. The legacy schedule
            has not been converted into a forecast.
          </p>
        </div>
      )}
      {arrangements.map((a, i) => (
        <div key={a.id} className="commission-period">
          <h3>Payment arrangement {i + 1}</h3>
          <div className="form-grid">
            <Field
              label={`Carrier terms effective from ${i + 1}`}
              type="date"
              value={a.from}
              change={(v) => update(i, { from: v })}
            />
          </div>
          <CommissionPanel title={`Coverage and end date ${i + 1} (optional)`} open={!!(a.to || a.lines || a.transaction || a.billType)}>
          <p className="small muted">Use only when this agreement applies to specific coverage, business types, or billing methods.</p>
          <div className="form-grid">
            <label className="field">
              {`Carrier terms through ${i + 1} (optional)`}
              <input type="date" value={a.to} onChange={(e) => update(i, { to: e.target.value })} />
            </label>
            <label className="field">
              {`Lines of business ${i + 1} (blank = all)`}
              <input
                value={a.lines}
                placeholder="Use the policy coverage line names"
                onChange={(e) => update(i, { lines: e.target.value })}
              />
            </label>
            <label className="field">
              {`Business type ${i + 1}`}
              <select
                value={a.transaction}
                onChange={(e) =>
                  update(i, {
                    transaction: e.target.value as ArrangementDraft['transaction'],
                  })
                }
              >
                <option value="">All business types</option>
                <option value="NEW">New business</option>
                <option value="RENEWAL">Renewal</option>
              </select>
            </label>
            <label className="field">
              {`Billing scope ${i + 1}`}
              <select
                value={a.billType}
                onChange={(e) =>
                  update(i, {
                    billType: e.target.value as ArrangementDraft['billType'],
                  })
                }
              >
                <option value="">Agency and direct bill</option>
                <option value="AGENCY">Agency bill</option>
                <option value="DIRECT">Direct bill</option>
              </select>
            </label>
          </div>
          </CommissionPanel>
          <div className="form-grid">
            <label className="field">
              {`Commission basis ${i + 1}`}
              <select
                required
                value={a.basis}
                onChange={(e) =>
                  update(i, {
                    basis: e.target.value as ArrangementDraft['basis'],
                    trigger: e.target.value === 'COLLECTED' ? 'COLLECTION' : e.target.value === 'EARNED' ? 'EARNED' : '',
                    earningMethod: '',
                  })
                }
              >
                <option value="">Confirm the premium basis…</option>
                {Object.entries(COMMISSION_BASES).filter(([value]) => value !== 'UNSPECIFIED').map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={`Commission payor ${i + 1}`}
              value={a.payor}
              change={(v) => update(i, { payor: v })}
            />
            <label className="field">
              {`Receipt trigger ${i + 1}`}
              <select
                required
                value={a.trigger}
                onChange={(e) =>
                  update(i, {
                    trigger: e.target.value as ArrangementDraft['trigger'],
                  })
                }
              >
                <option value="">Confirm the trigger…</option>
                {a.basis === 'WRITTEN' && (
                  <>
                    <option value="BIND">Policy bound</option>
                    <option value="EFFECTIVE">Policy effective</option>
                  </>
                )}
                {a.basis === 'COLLECTED' && <option value="COLLECTION">Premium collected</option>}
                {a.basis === 'EARNED' && <option value="EARNED">Coverage earned</option>}
              </select>
            </label>
            <label className="field">
              {`Remittance frequency ${i + 1}`}
              <select
                required
                value={a.cadence}
                onChange={(e) =>
                  update(i, {
                    cadence: e.target.value as ArrangementDraft['cadence'],
                    ...(e.target.value === 'ONCE' ? { cutoffDay: '' } : {}),
                  })
                }
              >
                <option value="">Confirm the frequency…</option>
                <option value="ONCE">Once per trigger</option>
                <option value="MONTHLY">Monthly statement cycle</option>
                <option value="QUARTERLY">Quarterly statement cycle</option>
              </select>
            </label>
            <label className="field">
              {`Additional lag days ${i + 1}`}
              <input
                required
                type="number"
                min="0"
                max="730"
                step="1"
                value={a.lagDays}
                onChange={(e) => update(i, { lagDays: e.target.value })}
              />
            </label>
            {a.basis === 'EARNED' && (
              <label className="field">
                {`Earned premium method ${i + 1}`}
                <select
                  required
                  value={a.earningMethod}
                  onChange={(e) =>
                    update(i, {
                      earningMethod: e.target.value as ArrangementDraft['earningMethod'],
                    })
                  }
                >
                  <option value="">Confirm the method…</option>
                  <option value="DAILY_PRORATA">Daily pro rata forecast</option>
                  <option value="MANUAL">Carrier schedule entered manually</option>
                </select>
              </label>
            )}
          </div>
          <CommissionPanel title={`Statement dates ${i + 1} (optional)`} open={!!(a.cutoffDay || a.paymentDay)}>
            <p className="small muted">Only enter documented calendar days. Blank cutoff uses month end; blank remittance day uses the cutoff date.</p>
            <div className="form-grid">
            <label className="field">
              {`Statement cutoff day ${i + 1} (optional)`}
              <input
                type="number"
                min="1"
                max="31"
                step="1"
                disabled={a.cadence === 'ONCE'}
                value={a.cutoffDay}
                onChange={(e) => update(i, { cutoffDay: e.target.value })}
              />
            </label>
            <label className="field">
              {`Remittance day ${i + 1} (optional)`}
              <input
                type="number"
                min="1"
                max="31"
                step="1"
                value={a.paymentDay}
                onChange={(e) => update(i, { paymentDay: e.target.value })}
              />
            </label>

            </div>
          </CommissionPanel>
          <Field
            label={`Carrier agreement reference ${i + 1}`}
            value={a.evidence}
            change={(v) => update(i, { evidence: v })}
          />
          <label className="field">
            {`Original carrier wording / notes ${i + 1} (optional)`}
            <textarea value={a.notes} onChange={(e) => update(i, { notes: e.target.value })} />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => setArrangements(arrangements.filter((_, j) => i !== j))}
          >
            Remove payment arrangement {i + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={arrangements.length >= 100}
        onClick={() => setArrangements([...arrangements, blankArrangement()])}
      >
        Add payment arrangement
      </button>
      <CommissionPanel title="How forecast dates work">
      <p className="small muted">
        Dates are inclusive. Separate lines of business with commas. Monthly cycles close each
        month; quarterly cycles close in March, June, September, and December. Triggers after the
        cutoff roll to the next cycle. A blank cutoff means month end. With a remittance day,
        payment falls in the month after the cutoff; without one, payment falls on the cutoff.
        Additional lag uses calendar days. Once per trigger uses the trigger date, or the next
        remittance day on or after it, plus lag. Days 29–31 are limited to the last day of shorter
        months.
      </p>
      <p className="small muted">
        Collected premium follows actual client payments; “as earned” in a carrier agreement may
        mean collected premium. Record the contract’s meaning explicitly. Forecasts never create
        receipts or producer earnings.
      </p>
      </CommissionPanel>
    </ActionForm>
    )}
  </div>;
}
function CarrierBalances({ balances: b }: { balances: CommissionReconciliationBalances }) {
  const value = (amount: number | null) => (amount == null ? 'Unknown' : money(amount));
  const gap = b.confirmed
    ? b.overdue
    : b.expectedToDate == null || b.adjustmentReview
      ? null
      : Math.max(0, b.expectedToDate - b.receivedToDate);
  const certainty = b.adjustmentReview
    ? 'Receipt schedule needs review'
    : b.expectedToDate == null
      ? 'Receipt timing unknown'
      : b.confirmed
        ? 'Confirmed receipt schedule'
        : 'Estimated receipt forecast';
  return (
    <div className="commission-balances" aria-label={`Carrier receipt balances as of ${b.asOf}`}>
      <p className="small">
        <strong>Carrier receipts as of {b.asOf}</strong> · {certainty}
      </p>
      <dl>
        <div>
          <dt>Full-term agency estimate</dt>
          <dd>{money(b.fullTermEstimate)}</dd>
        </div>
        <div>
          <dt>{b.confirmed ? 'Expected through date' : 'Estimated through date'}</dt>
          <dd>{value(b.expectedToDate)}</dd>
        </div>
        <div>
          <dt>Actual received through date</dt>
          <dd>{money(b.receivedToDate)}</dd>
        </div>
        <div>
          <dt>{b.confirmed ? 'Overdue before date' : 'Estimated gap through date'}</dt>
          <dd>{value(gap)}</dd>
        </div>
        <div>
          <dt>Future scheduled balance</dt>
          <dd>{value(b.futureForecast)}</dd>
        </div>
        <div>
          <dt>Full receipt forecast</dt>
          <dd>{value(b.forecastTotal)}</dd>
        </div>
        <div>
          <dt>Forecast not yet allocated to dates</dt>
          <dd>{value(b.unallocatedForecast)}</dd>
        </div>
      </dl>
      {b.expectedToDate == null && (
        <p className="small muted">
          Receipt timing is unknown. A supported receipt schedule is needed before assessing overdue
          commission.
        </p>
      )}
      {b.forecastTotal == null && b.expectedToDate != null && (
        <p className="small muted">
          Only entered receipt dates are included. The remaining schedule is unknown; the full-term
          estimate is not a current amount due.
        </p>
      )}
      {b.adjustmentReview && (
        <p className="small">
          Carrier adjustments need schedule review. Preserve the original estimate and update the
          forecast with supporting evidence.
        </p>
      )}
      <p className="small muted">
        Forecasts do not create payable producer commission. Earnings follow posted, reconciled
        agency receipts.
      </p>
    </div>
  );
}
function ReceiptForecastEditor({
  policy,
  refresh,
}: {
  policy: CommissionPolicy;
  refresh: () => Promise<void>;
}) {
  const forecast = policy.receiptForecast;
  const [items, setItems] = useState(
    () =>
      forecast?.items.map((item) => ({
        dueOn: item.dueOn,
        amount: String(item.agencyCents / 100),
      })) ?? [{ dueOn: '', amount: '' }],
  );
  const [evidence, setEvidence] = useState(forecast?.evidence ?? '');
  const [confirmed, setConfirmed] = useState(forecast ? String(forecast.confirmed) : '');
  const [complete, setComplete] = useState(forecast ? String(forecast.complete) : '');
  return (
    <ActionForm
      title="Expected carrier receipts"
      button="Save receipt forecast"
      onDone={refresh}
      submit={() =>
        commissionAction('saveReceiptForecast', {
          policyId: policy.id,
          version: policy.version,
          receiptForecast: {
            items: items.map((item) => ({
              dueOn: item.dueOn,
              agencyCents: decimal(item.amount),
            })),
            evidence,
            confirmed: confirmed === 'true',
            complete: complete === 'true',
          },
        })
      }
    >
      <p className="small muted">
        Enter carrier-supported receipt dates and agency commission amounts, including prior
        expected receipts for the policy term. Unequal installments are supported. A complete
        empty schedule forecasts zero total commission; posted receipts remain visible.
      </p>
      <div className="form-grid">
        <label className="field">
          Receipt forecast certainty
          <select required value={confirmed} onChange={(e) => setConfirmed(e.target.value)}>
            <option value="">Choose…</option>
            <option value="false">Estimate — timing or amounts not confirmed</option>
            <option value="true">Confirmed by carrier evidence</option>
          </select>
        </label>
        <label className="field">
          Receipt schedule coverage
          <select required value={complete} onChange={(e) => setComplete(e.target.value)}>
            <option value="">Choose…</option>
            <option value="false">Partial — remaining dates or amounts unknown</option>
            <option value="true">Complete — all expected receipts included</option>
          </select>
        </label>
      </div>
      {items.map((item, i) => (
        <div className="commission-forecast-row" key={i}>
          <Field
            label={`Expected receipt date ${i + 1}`}
            type="date"
            value={item.dueOn}
            change={(v) => setItems(items.map((r, j) => (i === j ? { ...r, dueOn: v } : r)))}
          />
          <Field
            label={`Expected agency commission ($) ${i + 1}`}
            value={item.amount}
            change={(v) => setItems(items.map((r, j) => (i === j ? { ...r, amount: v } : r)))}
          />
          <button
            type="button"
            className="secondary"
            onClick={() => setItems(items.filter((_, j) => i !== j))}
          >
            Remove expected receipt {i + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={items.length >= 100}
        onClick={() => setItems([...items, { dueOn: '', amount: '' }])}
      >
        Add expected receipt
      </button>
      <Field label="Receipt forecast evidence" value={evidence} change={setEvidence} />
    </ActionForm>
  );
}
function Statements({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<CommissionStatement | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const { requestLeave } = useEditProtection();
  const matches = data.statements.filter(s => [s.reference, s.settlementRef, ...s.lines.map(l => l.lineRef), ...s.lines.map(l => data.policies.find(p => p.id === l.policyId)?.policyNumber ?? '')].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const drafts = matches.filter(s => s.status === 'DRAFT');
  const history = matches.filter(s => s.status !== 'DRAFT').sort((a,b) => b.receivedOn.localeCompare(a.receivedOn));
  return (
    <>
      <div className="commission-workflow-strip" aria-label="Reconciliation steps">
        <span><b>1</b> Attach & match</span><span><b>2</b> Review eligibility</span><span><b>3</b> Post receipt</span>
      </div>
      <CommissionPanel title="Statement entry guide" hint="Amounts, settlement evidence, and supported files">
        <h2>Prepare a statement for reconciliation</h2>
        <p>Attach the original PDF as evidence and enter its commission rows manually. CSV and XLSX files also support column mapping. Use the agency commission paid for each row, not premium, full-term commission, or previously paid totals.</p>
        <p className="small muted">Record the actual settlement date. An invoice's due date is not proof of receipt; retained agency-bill commission needs collection and remittance evidence. Earlier receipts keep their original dates and remain subject to the employee's eligibility cutoffs.</p>
      </CommissionPanel>
      <div className="commission-section-heading">
        <div><h2>Reconciliation</h2><p>{data.statements.filter(s => s.status === 'DRAFT').length} drafts need review. Posted and voided records remain in history.</p></div>
        <button className="primary" onClick={() => requestLeave(() => setEditing(null))}>New reconciliation</button>
      </div>
      <label className="field">Find a statement<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Statement, settlement, transaction, or policy" /></label>
      {editing !== undefined && (
        <StatementEditor
          key={editing?.id ?? 'new'}
          data={data}
          statement={editing ?? undefined}
          done={async () => {
            setEditing(undefined);
            await refresh();
          }}
        />
      )}
      {data.statements.length === 0 && <div className="commission-empty">No statements yet.</div>}
      {drafts.map((s) => (
        <StatementCard
          key={`${s.id}:${s.version}`}
          statement={s}
          policies={data.policies}
          edit={() => requestLeave(() => setEditing(s))}
          refresh={refresh}
        />
      ))}
      {!!history.length && <CommissionPanel title="Reconciliation history" hint={history.length + ' posted or voided statements'}>
        {history.map(s => <StatementCard key={s.id + ':' + s.version} statement={s} policies={data.policies} edit={() => {}} refresh={refresh} />)}
      </CommissionPanel>}
      {!!query && !matches.length && <div className="commission-empty">No statements match this search.</div>}
    </>
  );
}
type LineDraft = Omit<StatementLine, 'agencyCents'> & {
  amount: string;
  reportedPremium?: string;
  reportedRate?: string;
};
const blankLine = (): LineDraft => ({
  policyId: '',
  lineRef: '',
  kind: 'RECEIPT',
  amount: '',
  eligible: false,
  reviewStatus: 'PENDING',
  eligibilityNote: '',
});
function StatementEditor({
  data,
  statement,
  done,
}: {
  data: CommissionOverview;
  statement?: CommissionStatement;
  done: () => Promise<void>;
}) {
  const invalidate = useContext(CommissionAccessContext);
  const [carrierId, setCarrier] = useState(statement?.carrierId ?? ''),
    [reference, setReference] = useState(statement?.reference ?? ''),
    [source, setSource] = useState(statement?.source ?? ''),
    [receivedOn, setDate] = useState(statement?.receivedOn ?? ''),
    [settlementRef, setSettlement] = useState(statement?.settlementRef ?? ''),
    [total, setTotal] = useState(statement ? String(statement.totalCents / 100) : ''),
    [settlementType, setType] = useState(statement?.settlementType ?? 'DEPOSIT');
  const [lines, setLines] = useState<LineDraft[]>(
    statement?.lines.map((l) => ({
      ...l,
      reviewStatus: l.reviewStatus ?? (l.eligible ? 'ELIGIBLE' : 'INELIGIBLE'),
      amount: String(l.agencyCents / 100),
      reportedPremium: l.reportedPremiumCents == null ? '' : String(l.reportedPremiumCents / 100),
      reportedRate: l.reportedRateUnits == null ? '' : String(l.reportedRateUnits / 10000),
    })) ?? [blankLine()],
  );
  const [uploading, setUploading] = useState(false),
    [importFile, setImportFile] = useState<File | null>(null),
    [fileError, setFileError] = useState(''),
    [fileName, setFileName] = useState(statement ? 'Previously attached statement' : '');
  const [saved, setSaved] = useState(false), [saving, setSaving] = useState(false);
  const serialized = JSON.stringify({ carrierId, reference, source, receivedOn, settlementRef, total, settlementType, lines });
  const initial = useRef(serialized);
  useUnsavedChanges(!saved && serialized !== initial.current, { busy: uploading || saving });
  const update = (index: number, change: Partial<LineDraft>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
  async function upload(file: File) {
    setUploading(true);
    setFileError('');
    setSource('');
    setImportFile(null);
    setFileName('');
    try {
      const result = await attachCommissionStatement(file);
      setSource(result.key);
      setFileName(result.uploaded ? file.name : file.name + ' · Local preview only — not uploaded or saved');
      setImportFile(file);
    } catch (e) {
      setFileError((e as Error).message);
      if (isAuthorizationError(e)) invalidate(e);
    } finally {
      setUploading(false);
    }
  }
  return (
    <ActionForm
      title="Match a carrier statement"
      button="Save draft for review"
      onDone={done}
      submit={async () => {
        if (uploading || !source) throw new Error('Attach the original statement before saving.');
        setSaving(true);
        try { const result = await commissionAction('saveStatement', {
          version: statement?.version ?? 0,
          carrierId,
          reference,
          source,
          receivedOn,
          settlementRef,
          settlementType,
          totalCents: decimal(total),
          lines: lines.map(
            ({
              amount,
              reportedPremium,
              reportedRate,
              reportedPremiumCents: _premium,
              reportedRateUnits: _rate,
              ...l
            }) => ({
              ...l,
              agencyCents: decimal(amount),
              ...(reportedPremium ? { reportedPremiumCents: decimal(reportedPremium) } : {}),
              ...(reportedRate ? { reportedRateUnits: decimal(reportedRate, 4) } : {}),
            }),
          ),
        }); setSaved(true); return result; } finally { setSaving(false); }
      }}
    >
      <p className="small muted">Save the draft before leaving. Drafts never create earnings; posting requires a separate review.</p>
      <div className="form-grid">
        <label className="field">
          Carrier
          <select
            required
            value={carrierId}
            disabled={!!statement}
            onChange={(e) => {
              setCarrier(e.target.value);
              setLines([blankLine()]);
            }}
          >
            <option value="">Choose…</option>
            {data.carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="Statement reference" value={reference} change={setReference} />
        <Field
          label="Actual receipt / settlement date"
          type="date"
          value={receivedOn}
          change={setDate}
        />
        <Field label="Verified settlement allocation ($)" value={total} change={setTotal} />
        <Field
          label="Unique deposit / settlement allocation reference"
          value={settlementRef}
          change={setSettlement}
        />
        <label className="field">
          Settlement type
          <select
            value={settlementType}
            onChange={(e) => setType(e.target.value as typeof settlementType)}
          >
            <option value="DEPOSIT">Carrier deposit</option>
            <option value="RETAINED">Agency-bill retained commission</option>
            <option value="NET_SETTLEMENT">Net settlement / offset</option>
          </select>
        </label>
      </div>
      <label className="field commission-file-field">
        Original carrier statement
        <input
          type="file"
          accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </label>
      <p className="commission-file-status small">{uploading ? 'Preparing statement…' : fileName}</p>
      <CommissionStatementImport key={`${source}:${carrierId}:${importFile?.name}:${importFile?.lastModified}`} file={importFile} carrierId={carrierId} policies={data.policies} disabled={uploading || !importFile} apply={imported => setLines(imported.map(l => ({ ...l, amount: (l.agencyCents / 100).toFixed(2) })))} />
      {fileError && (
        <p className="error-text" role="alert">
          {fileError}
        </p>
      )}
      <p className="muted small">
        Enter each carrier transaction below. Use a carrier transaction reference that is unique
        across statements. For a large statement, use separately identified settlement allocations,
        each with its own control total. Do not reuse a deposit amount.
      </p>
      {lines.map((l, i) => {
        const p = data.policies.find((p) => p.id === l.policyId);
        return (
          <div className="commission-period" key={i}>
            <h3>Statement line {i + 1}</h3>
            <div className="form-grid">
              <label className="field">
                Policy term
                <select
                  required
                  value={l.policyId}
                  onChange={(e) =>
                    update(i, {
                      policyId: e.target.value,
                      originalId: undefined,
                      reviewStatus: 'PENDING',
                      eligible: false,
                    })
                  }
                >
                  <option value="">Match a policy…</option>
                  {data.policies
                    .filter((p) => p.carrierId === carrierId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.accountName} · {p.policyNumber} · {p.effectiveDate}
                      </option>
                    ))}
                </select>
              </label>
              <Field
                label={`Carrier transaction reference ${i + 1}`}
                value={l.lineRef}
                change={(v) => update(i, { lineRef: v })}
              />
              <label className="field">
                Transaction
                <select
                  value={l.kind}
                  onChange={(e) =>
                    update(i, {
                      kind: e.target.value as LineDraft['kind'],
                      originalId: undefined,
                      reviewStatus: 'PENDING',
                      eligible: false,
                    })
                  }
                >
                  <option value="RECEIPT">Commission receipt</option>
                  <option value="REVERSAL">Carrier reversal (negative)</option>
                  <option value="RESTORATION">Restore reversed commission</option>
                </select>
              </label>
              <Field
                label={`Agency commission received / reversed ($) ${i + 1}`}
                value={l.amount}
                change={(v) => update(i, { amount: v })}
              />
            </div>
            {p && (
              <p className="small">
                CRM expectation: {money(policyTotals(p).expectedAgency)} for the full term · Premium{' '}
                {money(p.premiumCents)} at {p.agencyRateUnits / 10000}% · Received so far{' '}
                {money(policyTotals(p).receivedAgency)} ·{' '}
                {COMMISSION_BASES[p.carrierTerms.payment?.basis ?? p.carrierTerms.basis]} ·{' '}
                {p.carrierTerms.payment
                  ? `${p.carrierTerms.payment.payor} · ${p.carrierTerms.payment.cadence.toLowerCase()} remittance · ${p.carrierTerms.payment.lagDays} additional lag days`
                  : `Legacy timing: ${p.carrierTerms.schedule}`}
              </p>
            )}
            {p && (
              <CarrierBalances balances={carrierReconciliationBalances(p, receivedOn || today())} />
            )}
            <div className="form-grid">
              <label className="field">
                Carrier premium basis for this line ($, optional)
                <input
                  inputMode="decimal"
                  value={l.reportedPremium ?? ''}
                  onChange={(e) => update(i, { reportedPremium: e.target.value })}
                />
              </label>
              <label className="field">
                Carrier commission rate (%, optional)
                <input
                  inputMode="decimal"
                  value={l.reportedRate ?? ''}
                  onChange={(e) => update(i, { reportedRate: e.target.value })}
                />
              </label>
            </div>
            <p className="small muted">{carrierComparison(l, p)}</p>
            {l.kind !== 'RECEIPT' && (
              <label className="field">
                Original transaction
                <select
                  required
                  value={l.originalId ?? ''}
                  onChange={(e) => update(i, { originalId: e.target.value })}
                >
                  <option value="">Choose the original transaction…</option>
                  {p?.entries
                    .filter((e) =>
                      l.kind === 'REVERSAL'
                        ? ['RECEIPT', 'RESTORATION'].includes(e.kind)
                        : e.kind === 'REVERSAL',
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.receivedOn} · {e.lineRef} · {money(e.agencyCents)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="field">Eligibility decision {i + 1}
              <select value={l.reviewStatus ?? 'PENDING'} onChange={e => update(i, { reviewStatus: e.target.value as StatementLine['reviewStatus'], eligible: e.target.value === 'ELIGIBLE' })}>
                <option value="PENDING">Pending review - cannot post</option>
                {l.kind === 'RECEIPT' && <option value="ELIGIBLE">Eligible - agreement requirements verified</option>}
                <option value="INELIGIBLE">{l.kind === 'RECEIPT' ? 'Not eligible - explain in review notes' : 'Adjustment - original allocation verified'}</option>
              </select>
            </label>
            <label className="field">Eligibility and variance review notes {i + 1}
              <textarea required maxLength={2000} value={l.eligibilityNote} onChange={e => update(i, { eligibilityNote: e.target.value })} />
              <span className="small muted">{l.eligibilityNote.length}/2,000 characters · evidence, eligibility, and any differences</span>
            </label>
            <button
              className="secondary"
              type="button"
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              Remove line
            </button>
          </div>
        );
      })}
      <button
        className="secondary"
        type="button"
        disabled={lines.length >= 20}
        onClick={() => setLines([...lines, blankLine()])}
      >
        Add statement line
      </button>
    </ActionForm>
  );
}
function StatementCard({
  statement: s,
  policies,
  edit,
  refresh,
}: {
  statement: CommissionStatement;
  policies: CommissionPolicy[];
  edit: () => void;
  refresh: () => Promise<void>;
}) {
  const invalidate = useContext(CommissionAccessContext);
  const [confirmed, setConfirmed] = useState(false),
    [fileError, setFileError] = useState('');
  const [voidReason, setVoidReason] = useState(''), [voidConfirmed, setVoidConfirmed] = useState(false);
  const body = (
    <>
      <dl className="commission-facts">
        <div><dt>Receipt date</dt><dd>{s.receivedOn}</dd></div>
        <div><dt>Status</dt><dd><span className={'badge ' + (s.status === 'POSTED' ? 'green' : s.status === 'VOID' ? 'gray' : 'amber')}>{s.status}</span></dd></div>
        <div><dt>Settlement reference</dt><dd>{s.settlementRef}</dd></div>
        <div><dt>Agency amount</dt><dd>{money(s.totalCents)}</dd></div>
      </dl>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            const r = await commissionAction<{ url: string }>('file', {
              key: s.source,
            });
            window.location.assign(r.url);
          } catch (e) {
            setFileError((e as Error).message);
            if (isAuthorizationError(e)) invalidate(e);
          }
        }}
      >
        Download original statement
      </button>
      {fileError && <p role="alert">{fileError}</p>}
      <div className="commission-scroll">
        <table>
          <thead>
            <tr>
              <th>Policy</th>
              <th>Transaction</th>
              <th>Agency amount</th>
              <th>Eligibility / variance review</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.lineRef}>
                <td>{policies.find((p) => p.id === l.policyId)?.policyNumber ?? l.policyId}</td>
                <td>
                  {l.kind} · {l.lineRef}
                </td>
                <td>
                  {money(l.agencyCents)}
                  <div className="small muted">
                    {l.reportedPremiumCents != null
                      ? `Carrier basis ${money(l.reportedPremiumCents)}`
                      : ''}{' '}
                    {l.reportedRateUnits != null ? `at ${l.reportedRateUnits / 10000}%` : ''}
                  </div>
                </td>
                <td>
                  {l.reviewStatus === 'PENDING' ? 'Pending review' : l.eligible ? 'Eligible' : 'Not eligible / adjustment'} · {l.eligibilityNote}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
  if (s.status !== 'DRAFT')
    return (
      <CommissionPanel title={s.reference} hint={s.status + ' · ' + s.receivedOn + ' · ' + money(s.totalCents)}>
        {s.status === 'VOID' && <div className="commission-notice"><strong>Voided draft · excluded from payroll review</strong><p>{s.voidReason}</p><p className="small muted">Voided {s.voidedAt}. The original file, lines, and audit history are retained.</p></div>}
        {body}
      </CommissionPanel>
    );
  return (
    <><ActionForm
      title={s.reference}
      disabled={!confirmed || s.lines.some(l => l.reviewStatus === 'PENDING')}
      button="Post reconciled statement"
      onDone={refresh}
      submit={() =>
        commissionAction('postStatement', {
          id: s.id,
          version: s.version,
          confirmed,
        })
      }
    >
      {body}
      <button className="secondary" type="button" onClick={edit}>
        Edit draft
      </button>
      <label className="commission-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{' '}
        I verified settlement evidence, policy terms, eligibility, and any differences. The
        allocation total has not already been posted.
      </label>
    </ActionForm>
    <CommissionPanel title={'Void draft · ' + s.reference} hint="Close a duplicate or incorrect draft without posting it" danger>
      <ActionForm title="Void this draft" button="Void draft" disabled={!voidConfirmed || !voidReason.trim()} onDone={refresh}
        submit={() => commissionAction('voidStatement', { id: s.id, version: s.version, reason: voidReason, confirmed: voidConfirmed })}>
        <p>The original file and review history remain available. This draft will no longer block payroll. Posted receipts cannot be voided.</p>
        <label className="field">Reason for voiding<textarea required maxLength={1000} value={voidReason} onChange={e => setVoidReason(e.target.value)} /></label>
        <label className="commission-check"><input type="checkbox" checked={voidConfirmed} onChange={e => setVoidConfirmed(e.target.checked)} />This draft must not be posted.</label>
      </ActionForm>
    </CommissionPanel></>
  );
}
function Payroll({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const invalidate = useContext(CommissionAccessContext);
  return <>
    <CommissionPayroll owner refreshLedger={refresh} onAccessDenied={invalidate} />
    <CommissionPanel title="Legacy payroll batch history">
      <p>New payments use monthly or off-cycle payroll above. Cancel an unpaid legacy batch to release its receipts before preparing a new approved report.</p>
      <BatchList batches={data.batches.filter(b => !b.cycleId)} refresh={refresh} />
    </CommissionPanel>
  </>;
}
function BatchList({
  batches,
  refresh,
}: {
  batches: CommissionBatch[];
  refresh?: () => Promise<void>;
}) {
  return (
    <>
      {!batches.length && <div className="commission-empty">{refresh ? 'No legacy payroll batches.' : 'No payroll statements yet.'}</div>}
      {batches.map((b) => (
        <BatchCard key={`${b.id}:${b.version}`} batch={b} refresh={refresh} />
      ))}
    </>
  );
}
function BatchCard({
  batch: b,
  refresh,
}: {
  batch: CommissionBatch;
  refresh?: () => Promise<void>;
}) {
  const [reference, setReference] = useState(''),
    [date, setDate] = useState(today()),
    [action, setAction] = useState('cancelPayroll');
  const body = (
    <>
      <dl className="commission-facts">
        <div><dt>Employee</dt><dd>{b.producerName}</dd></div>
        <div><dt>Status</dt><dd><span className={'badge ' + (b.status === 'PAID' ? 'green' : b.status === 'APPROVED' ? 'blue' : 'gray')}>{b.status}</span></dd></div>
        <div><dt>Approved amount</dt><dd>{money(b.totalCents)}</dd></div>
        <div><dt>Pay date</dt><dd>{b.payDate}</dd></div>
        <div><dt>Receipt cutoff</dt><dd>{b.cutoff}</dd></div>
        <div><dt>Recorded paid / remaining</dt><dd>{money(batchPaidCents(b))} / {money(b.totalCents - batchPaidCents(b))}</dd></div>
      </dl>
      {b.reference && <p>Confirmation: {b.reference}</p>}
      <ReportDownload
        report={{
          title: `Commission payroll ${b.id}`,
          filters: `${b.producerName} · ${b.status} · USD · pay date ${b.payDate} · recoveries excluded`,
          sections: [
            {
              title: 'Producer statement',
              columns: [
                'Account',
                'Policy',
                'Agency received (USD)',
                'Producer rate (%)',
                'Producer commission (USD)',
              ],
              rows: b.lines.map((l) => [
                l.accountName,
                l.policyNumber,
                l.agencyCents / 100,
                l.producerBps / 100,
                l.amountCents / 100,
              ]),
            },
          ],
        }}
      />
    </>
  );
  if (!refresh || b.status !== 'APPROVED' || b.cycleId)
    return (
      <section className="card">
        <h2>Payroll statement</h2>
        {body}
      </section>
    );
  return (
    <ActionForm
      title="Approved payroll batch"
      onDone={refresh}
      button="Record payroll outcome"
      submit={() =>
        commissionAction(action, {
          id: b.id,
          version: b.version,
          reference,
          payDate: date,
        })
      }
    >
      {body}
      <label className="field">
        Outcome
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="cancelPayroll">Cancel an unpaid batch</option>
        </select>
      </label>
      <Field
        label="Payment confirmation reference / cancellation reason"
        value={reference}
        change={setReference}
      />
      {action === 'payPayroll' && (
        <Field label="Actual payment date" type="date" value={date} change={setDate} />
      )}
      <p className="small muted">
        Cancel only an unpaid legacy batch. Review and approve its released earnings in the payroll workspace.
      </p>
    </ActionForm>
  );
}

function LegacyPolicies({
  data,
  refresh,
}: {
  data: CommissionOverview;
  refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const resource = useAsyncResource(
    async () => {
      if (!query) return { data: [], nextToken: null };
      const page = await client.models.Policy.list({
        filter: {
          and: [
            { commissionSnapshotId: { attributeExists: false } },
            { policyNumber: { contains: query } },
          ],
        },
        limit: 25,
        nextToken: cursor,
      });
      if (page.errors?.length) throw new Error(page.errors[0].message);
      return page;
    },
    [query, cursor],
    { clearDataOnError: () => true },
  );
  const [premium, setPremium] = useState(''),
    [agencyRate, setAgencyRate] = useState(''),
    [effectiveDate, setEffectiveDate] = useState(''),
    [expirationDate, setExpirationDate] = useState('');
  const [policyId, setPolicy] = useState(''),
    [producerId, setProducer] = useState(''),
    [boundOn, setBound] = useState(''),
    [transaction, setTransaction] = useState(''),
    [evidence, setEvidence] = useState('');
  const options = resource.data?.data ?? [],
    selected = options.find((p) => p.id === policyId);
  return (
    <ActionForm
      title="Add an existing policy to commission tracking"
      onDone={async () => {
        setPolicy('');
        await refresh();
        await resource.refetch();
      }}
      submit={() =>
        commissionAction('adoptPolicy', {
          policyId,
          producerId,
          boundOn,
          transaction,
          evidence,
          premium,
          agencyRate,
          effectiveDate,
          expirationDate,
        })
      }
    >
      <p className="small muted">
        Use documented original ownership and agreement terms. Current account assignment is not
        evidence of historical commission ownership. Import receipts and prior payments separately
        so opening balances reconcile.
      </p>
      <label className="field">
        Find historical policy number
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={resource.loading || search.trim().length < 2}
        onClick={() => {
          setPolicy('');
          if (query === search.trim() && cursor === undefined) void resource.refetch();
          else {
            setCursor(undefined);
            setQuery(search.trim());
          }
        }}
      >
        Search historical policies
      </button>
      {resource.error && <p role="alert">{resource.error}</p>}
      {resource.loading && <p>Loading matching policies…</p>}
      {query && !resource.loading && !resource.error && !options.length && (
        <p>
          No matching policies on this page.
          {resource.data?.nextToken ? ' Continue to the next page to search more records.' : ''}
        </p>
      )}
      {resource.data?.nextToken && (
        <button
          type="button"
          className="secondary"
          disabled={resource.loading}
          onClick={() => {
            setPolicy('');
            setCursor(resource.data?.nextToken ?? undefined);
          }}
        >
          Next policies
        </button>
      )}
      <p className="small muted">
        Search by policy number (at least two characters). Results are paged; only policies without
        commission tracking are returned. Add a missing policy number in the policy editor first.
      </p>
      <label className="field">
        Existing policy
        <select
          required
          value={policyId}
          onChange={(e) => {
            setPolicy(e.target.value);
            const selected = options.find((p) => p.id === e.target.value);
            setPremium(selected?.premium == null ? '' : String(selected.premium));
            setAgencyRate(selected?.commissionPct == null ? '' : String(selected.commissionPct));
            setEffectiveDate(selected?.effectiveDate ?? '');
            setExpirationDate(selected?.expirationDate ?? '');
            setBound(
              options.find((p) => p.id === e.target.value)?.datePolicyBound?.slice(0, 10) ?? '',
            );
          }}
        >
          <option value="">Choose…</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.policyNumber || p.id} · {p.effectiveDate}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p>
          Recorded premium {selected.premium == null ? 'Missing' : commissionCurrency.format(selected.premium)} ·
          Agency rate {selected.commissionPct ?? 'Missing'}%
        </p>
      )}
      <div className="form-grid">
        <label className="field">
          Original producer
          <select required value={producerId} onChange={(e) => setProducer(e.target.value)}>
            <option value="">Choose…</option>
            {data.plans.map((p) => (
              <option key={p.id} value={p.producerId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="Original bind date" type="date" value={boundOn} change={setBound} />
        <label className="field">
          Original transaction
          <select required value={transaction} onChange={(e) => setTransaction(e.target.value)}>
            <option value="">Choose…</option>
            <option value="NEW">New business</option>
            <option value="RENEWAL">Renewal</option>
          </select>
        </label>
      </div>
      <div className="form-grid">
        <Field label="Confirmed policy premium ($)" value={premium} change={setPremium} />
        <Field label="Confirmed agency commission (%)" value={agencyRate} change={setAgencyRate} />
        <Field
          label="Confirmed effective date"
          type="date"
          value={effectiveDate}
          change={setEffectiveDate}
        />
        <Field
          label="Confirmed expiration date"
          type="date"
          value={expirationDate}
          change={setExpirationDate}
        />
      </div>
      <Field
        label="Historical attribution and policy evidence"
        value={evidence}
        change={setEvidence}
      />
    </ActionForm>
  );
}

function PolicyNumber({
  policy,
  refresh,
}: {
  policy: CommissionPolicy;
  refresh: () => Promise<void>;
}) {
  const [number, setNumber] = useState(
    policy.policyNumber === policy.id ? '' : policy.policyNumber,
  );
  return (
    <CommissionPanel title="Update carrier policy number">
      <ActionForm
        title="Carrier policy number"
        onDone={refresh}
        submit={() =>
          commissionAction('updatePolicyNumber', {
            id: policy.id,
            version: policy.version,
            policyNumber: number,
          })
        }
      >
        <Field label="Carrier policy number" value={number} change={setNumber} />
      </ActionForm>
    </CommissionPanel>
  );
}

function carrierComparison(line: LineDraft, policy?: CommissionPolicy) {
  try {
    const rate = line.reportedRate ? decimal(line.reportedRate, 4) : null;
    const mismatch =
      rate != null && policy && rate !== policy.agencyRateUnits
        ? `Carrier rate differs from the recorded agency rate by ${(rate - policy.agencyRateUnits) / 10000} percentage points. `
        : '';
    if (!line.reportedPremium || rate == null || !line.amount)
      return `${mismatch}Enter the carrier's premium basis and rate when provided. Missing statement values remain unknown.`;
    const premium = decimal(line.reportedPremium),
      expected = ratio(Math.abs(premium), rate, 1_000_000) * (premium < 0 ? -1 : 1),
      difference = decimal(line.amount) - expected;
    return `${mismatch}Carrier basis × carrier rate = ${money(expected)}; difference from this line's commission: ${money(difference)}. Explain differences in the review notes. An installment basis can differ from the full-term premium.`;
  } catch {
    return 'Enter valid decimal amounts to compare the carrier figures.';
  }
}
