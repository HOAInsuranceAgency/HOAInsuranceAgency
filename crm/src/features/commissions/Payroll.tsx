import { useState } from 'react';
import {
  type CommissionBatch,
  type CommissionOverview
} from '../../../../shared/commissions';
import { ReportDownload } from '../../components/ReportDownload';
import { Select } from "../../components/ui/Select";
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';
import { money, today } from './format';

export function Payroll({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const [producerId, setProducer] = useState(''),
    [cutoff, setCutoff] = useState(''),
    [payDate, setDate] = useState(''),
    [requestId, setRequest] = useState(() => crypto.randomUUID());
  return (
    <>
      <p>
        Choose the receipt cutoff and pay date from the applicable agreement and payroll calendar.
        Proposed recoveries are excluded. Exporting a batch does not mark it paid.
      </p>
      <ActionForm
        title="Approve a producer payroll batch"
        draft={{ producerId, cutoff, payDate }}
        button="Approve batch"
        onDone={async () => {
          setRequest(crypto.randomUUID());
          await refresh();
        }}
        submit={() =>
          commissionAction('preparePayroll', {
            producerId,
            cutoff,
            payDate,
            requestId,
          })
        }
      >
        <div className="form-grid">
          <label className="field">
            Producer
            <Select required value={producerId} onChange={(e) => setProducer(e.target.value)}>
              <option value="">Choose…</option>
              {[...new Map(data.policies.map((p) => [p.producerId, p.producerName])).entries()].map(
                ([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ),
              )}
            </Select>
          </label>
          <Field
            label="Include receipts through (inclusive)"
            type="date"
            value={cutoff}
            change={setCutoff}
          />
          <Field label="Scheduled pay date" type="date" value={payDate} change={setDate} />
        </div>
      </ActionForm>
      <BatchList batches={data.batches} refresh={refresh} />
    </>
  );
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
    [action, setAction] = useState<'payPayroll' | 'cancelPayroll'>('payPayroll');
  const body = (
    <>
      <p>
        {b.producerName} · {b.status} · {money(b.totalCents)} · Pay date {b.payDate} · Receipt
        cutoff {b.cutoff}
      </p>
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
  if (!refresh || b.status !== 'APPROVED')
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
        <Select value={action} onChange={(e) => { if (e.target.value === "payPayroll" || e.target.value === "cancelPayroll") setAction(e.target.value); }}>
          <option value="payPayroll">Confirm the full batch was paid</option>
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
        Only confirm a fully paid batch. For a rejected payroll export, cancel the unpaid batch
        before preparing a replacement.
      </p>
    </ActionForm>
  );
}
