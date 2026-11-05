import { useState } from 'react';
import {
  ACCOUNT_COMMISSION_CLASSES,
  carrierReconciliationBalances,
  decimal,
  policyTotals,
  recoveryBalances,
  sum,
  type CommissionOverview,
  type CommissionPolicy,
  type CommissionReconciliationBalances
} from '../../../../shared/commissions';
import { ReportDownload } from '../../components/ReportDownload';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Table } from "../../components/ui/Table";
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';
import { money, today } from './format';

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
  const totals = data.policies.map(policyTotals),
    recoveries = data.policies.map((p) => recoveryBalances(p, data.batches)),
    paid = sum(data.batches.filter((b) => b.status === 'PAID').map((b) => b.totalCents));
  const earned = sum(totals.map((t) => t.earned));
  return (
    <>
      <div className="stat-row">
        {[
          ['Agency received', sum(totals.map((t) => t.receivedAgency))],
          ['Producer earned', earned],
          ['Paid', paid],
          ['Unpaid earnings', earned - paid],
          ['Proposed paid recoveries', sum(recoveries.map((t) => t.paidRecovery))],
          ['Unpaid adjustments to review', sum(recoveries.map((t) => t.unpaidAdjustment))],
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
              ],
              rows: data.policies.flatMap((p) =>
                p.entries.map((e) => [
                  p.producerName,
                  p.accountName,
                  p.policyNumber,
                  e.receivedOn,
                  e.kind,
                  e.revenueKind === "BROKER_FEE" ? "Broker fee" : "Carrier commission",
                  e.agencyCents / 100,
                  p.producerBps / 100,
                  e.producerCents / 100,
                  e.batchId ?? '',
                ]),
              ),
            },
          ],
        }}
      />
      {!data.policies.length && (
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
      {data.policies.map((p) => {
        const t = policyTotals(p);
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
              Premium {money(p.premiumCents)} · Agency {p.agencyRateUnits / 10000}% · Producer{' '}
              {p.producerBps / 100}% of agency commission
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
              {money(t.receivedAgency)} · Producer earned {money(t.earned)} · Proposed adjustments{' '}
              {money(t.proposedRecovery)}
            </p>
            {owner ? (
              <>
                <CarrierBalances balances={carrierReconciliationBalances(p, asOf)} />
                <details className="commission-forecast-editor">
                  <summary>Manage expected receipts</summary>
                  <ReceiptForecastEditor
                    key={`${p.id}:${p.version}`}
                    policy={p}
                    refresh={refresh}
                  />
                </details>
                <PolicyNumber key={`${p.id}:${p.version}`} policy={p} refresh={refresh} />
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
                          {e.kind}
                          <div className="small">{e.revenueKind === "BROKER_FEE" ? "Broker fee" : "Carrier commission"}</div>
                          <div className="small muted">{e.lineRef}</div>
                        </td>
                        <td>{money(e.agencyCents)}</td>
                        <td>{money(e.producerCents)}</td>
                        <td>
                          {e.kind !== 'RECEIPT'
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
                </Table>
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
          <Button variant="secondary"
            type="button"

            onClick={() => setItems(items.filter((_, j) => i !== j))}
          >
            Remove expected receipt {i + 1}
          </Button>
        </div>
      ))}
      <Button variant="secondary"
        type="button"

        disabled={items.length >= 100}
        onClick={() => setItems([...items, { dueOn: '', amount: '' }])}
      >
        Add expected receipt
      </Button>
      <Field label="Receipt forecast evidence" value={evidence} change={setEvidence} />
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
    <details>
      <summary>Update carrier policy number</summary>
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
    </details>
  );
}
