import { useContext,useState } from 'react';
import {
batchPaidCents,
type CommissionBatch,
type CommissionOverview
} from '../../../../shared/commissions';
import CommissionPanel from '../../components/CommissionPanel';
import CommissionPayroll from '../../components/CommissionPayroll';
import { ReportDownload } from '../../components/ReportDownload';
import { Select } from '../../components/ui/Select';
import { commissionWorkflowAction as commissionAction } from '../../lib/commissions';

import { ActionForm,Field } from './CommissionForm';
import { CommissionAccessContext } from './context';
import { money,today } from './format';

export function Payroll({ data, refresh, reviewStatements }: { data: CommissionOverview; refresh: () => Promise<void>; reviewStatements: () => void }) {
  const invalidate = useContext(CommissionAccessContext);
  return <>
    <CommissionPayroll owner refreshLedger={refresh} onAccessDenied={invalidate} reviewStatements={reviewStatements} />
    <CommissionPanel title="Legacy payroll batch history">
      <p>New payments use monthly or off-cycle payroll above. Cancel an unpaid legacy batch to release its receipts before preparing a new approved report.</p>
      <BatchList batches={data.batches.filter(b => !b.cycleId)} refresh={refresh} />
    </CommissionPanel>
  </>;
}

export function BatchList({
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

export function BatchCard({
  batch: b,
  refresh,
}: {
  batch: CommissionBatch;
  refresh?: () => Promise<void>;
}) {
  const [reference, setReference] = useState(''),
    [date, setDate] = useState(today()),
    [action, setAction] = useState<'payPayroll' | 'cancelPayroll'>('cancelPayroll');
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
                'Revenue source',
                'Agency received (USD)',
                'Producer rate (%)',
                'Producer commission (USD)',
              ],
              rows: b.lines.map((l) => [
                l.accountName,
                l.policyNumber,
                l.revenueKind ? commissionRevenueLabel(l.revenueKind) : 'See original ledger entry',
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
      draft={{ reference, date, action }}
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
        <Select value={action} onChange={(e) => setAction(e.target.value as 'payPayroll' | 'cancelPayroll')}>
          <option value="cancelPayroll">Cancel an unpaid batch</option>
        </Select>
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
