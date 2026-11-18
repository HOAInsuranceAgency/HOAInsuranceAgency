import { useState } from 'react';
import {
ACCOUNT_COMMISSION_CLASSES,
batchPaidCents,
carrierReconciliationBalances,
COMMISSION_REVIEW_CATEGORIES,
decimal,
policyTotals,
recoveryBalances,
sum,
type CommissionOverview,
type CommissionPolicy,
type CommissionReconciliationBalances
} from '../../../../shared/commissions';
import CommissionPanel from '../../components/CommissionPanel';
import { ReportDownload } from '../../components/ReportDownload';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { commissionWorkflowAction as commissionAction } from '../../lib/commissions';
import { CommissionTarget,useCommissionWorkflow } from '../../lib/commissionWorkflow';

import { ActionForm,Field } from './CommissionForm';
import { money,today } from './format';

export function Ledger({
  data,
  owner,
  refresh,
}: {
  data: CommissionOverview;
  owner: boolean;
  refresh: () => Promise<void>;
}) {
  const [asOf, setAsOf] = useState(today);
  const { target, navigate } = useCommissionWorkflow();
  const [search, setSearch] = useState('');
  const displayed = data.policies.filter(p => (!target.policyId || p.id === target.policyId) && (p.policyNumber + ' ' + p.accountName + ' ' + p.producerName + ' ' + p.entries.map(e => e.lineRef).join(' ')).toLowerCase().includes(search.toLowerCase()));
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
      {!!earningRows.length && <section className="card"><h2>Shared commission & adjustment earnings</h2><div className="commission-scroll"><Table><thead><tr>{owner&&<th>Employee</th>}<th>Policy</th><th>Date</th><th>Source</th><th>Share / rate</th><th>Employee amount</th><th>Status</th></tr></thead><tbody>{earningRows.map(e=><tr key={e.id}>{owner&&<td>{e.producerName}</td>}<td>{e.accountName}<div className="small muted">{e.policyNumber}</div></td><td>{e.receivedOn}</td><td>{e.source==='ADJUSTMENT'?'Approved adjustment':'Shared receipt'}</td><td>{e.shareBps===undefined?'—':e.shareBps/100+'% share · '+e.producerBps/100+'% rate'}</td><td>{money(e.amountCents)}</td><td>{e.batchId?(data.batches.find(b=>b.id===e.batchId)?.status??'Allocated'):e.status}
      {owner && e.status==='PAYABLE' && !e.batchId && e.amountCents>0 && <Button variant="secondary" onClick={()=>navigate({tab:'payroll',earningKeys:[JSON.stringify(['earning',e.id])],producerId:e.producerId})}>Prepare off-cycle payment</Button>}
      {owner && <Button variant="secondary" onClick={()=>navigate({tab:'exceptions',...(e.adjustmentId?{adjustmentId:e.adjustmentId}:{policyId:e.policyId}),producerId:e.producerId})}>Review source & decisions</Button>}</td></tr>)}</tbody></Table></div><p className="small muted">Shared earnings reference one carrier receipt. Compensation adjustments do not change agency cash received.</p></section>}
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
          <Input
            type="date"
            required
            value={asOf}
            onChange={(e) => setAsOf(e.target.value || today())}
          />
        </label>
      )}
      <label className="field">Search ledger<Input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Policy, employee or transaction reference" /></label>
      {target.policyId && <Button variant="secondary" onClick={() => navigate({ tab: 'ledger' })}>Show all policies</Button>}
      {displayed.map((p) => {
        const t = policyTotals(p);
        const allocatedEarnings = earningRows.filter(e => e.policyId === p.id && e.status === 'PAYABLE');
        const employeeEarned = t.earned + sum(allocatedEarnings.map(e => e.amountCents));
        const hasSharedReceipts = p.entries.some(e => e.allocationId);
        return (
          <CommissionTarget kind="policyId" id={p.id} key={p.id}><section className="card">
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
                <div className="commission-action-bar"><Button variant="secondary" onClick={() => navigate({ tab: 'exceptions', policyId: p.id, producerId: p.producerId })}>Review shares, adjustments & employee decisions</Button></div>
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
                <Table>
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
                        {owner && <td><details><summary>Evidence</summary>{e.eligibilityNote}</details>
                          {!e.batchId && !e.supersededBy && !e.excludedByCase && !e.allocationId && e.kind === 'RECEIPT' && e.producerCents > 0 && <Button variant="secondary" onClick={() => navigate({ tab: 'payroll', earningKeys: [JSON.stringify(['receipt', p.id, e.id])], producerId: p.producerId })}>Prepare off-cycle payment</Button>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : (
              <p className="muted">
                Awaiting carrier commission, broker fee, or IPFS fee receipts. Binding alone does not create payable earnings.
              </p>
            )}
          </section></CommissionTarget>
        );
      })}
    </>
  );
}

export function PolicyReview({ policy, refresh }: { policy: CommissionPolicy; refresh: () => Promise<void> }) {
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
      <label className="field">Review category<Select value={category} onChange={e => setCategory(e.target.value)}>{COMMISSION_REVIEW_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</Select></label>
      <Field label="Issue and supporting evidence" value={note} change={setNote} /><Field label="Review due date" type="date" value={dueOn} change={setDueOn} />
    </ActionForm>
  </CommissionPanel>;
}

export function CarrierBalances({ balances: b }: { balances: CommissionReconciliationBalances }) {
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

export function ReceiptForecastEditor({
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
      draft={{ items, evidence, confirmed, complete }}
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
          <Select required value={confirmed} onChange={(e) => setConfirmed(e.target.value)}>
            <option value="">Choose…</option>
            <option value="false">Estimate — timing or amounts not confirmed</option>
            <option value="true">Confirmed by carrier evidence</option>
          </Select>
        </label>
        <label className="field">
          Receipt schedule coverage
          <Select required value={complete} onChange={(e) => setComplete(e.target.value)}>
            <option value="">Choose…</option>
            <option value="false">Partial — remaining dates or amounts unknown</option>
            <option value="true">Complete — all expected receipts included</option>
          </Select>
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
          <Button
            type="button"
            variant="secondary"
            onClick={() => setItems(items.filter((_, j) => i !== j))}
          >
            Remove expected receipt {i + 1}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        disabled={items.length >= 100}
        onClick={() => setItems([...items, { dueOn: '', amount: '' }])}
      >
        Add expected receipt
      </Button>
      <Field label="Receipt forecast evidence" value={evidence} change={setEvidence} />
    </ActionForm>
  );
}

export function PolicyNumber({
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
      draft={number}
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
