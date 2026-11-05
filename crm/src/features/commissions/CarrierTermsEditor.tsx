import { useState } from 'react';
import {
  COMMISSION_BASES,
  type CarrierCommissionTerms,
  type CarrierPaymentArrangement
} from '../../../../shared/commissions';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Textarea } from "../../components/ui/Textarea";
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';

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

export function CarrierEditor({
  id,
  terms,
  refresh,
}: {
  id: string;
  terms?: CarrierCommissionTerms;
  refresh: () => Promise<void>;
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
  return (
    <ActionForm
      title="Carrier commission payment terms"
      draft={arrangements}
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
            terms?.schedule || `${first.cadence} · ${first.trigger} · ${first.lagDays} day lag`,
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
        Commission basis, remittance timing, and the client’s premium payment plan are separate.
        Terms apply by policy effective date; saved policy snapshots keep their original terms.
      </p>
      {terms && !terms.arrangements?.length && (
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
            <label className="field">
              {`Carrier terms through ${i + 1} (optional)`}
              <Input type="date" value={a.to} onChange={(e) => update(i, { to: e.target.value })} />
            </label>
            <label className="field">
              {`Lines of business ${i + 1} (blank = all)`}
              <Input
                value={a.lines}
                placeholder="Use the policy coverage line names"
                onChange={(e) => update(i, { lines: e.target.value })}
              />
            </label>
            <label className="field">
              {`Business type ${i + 1}`}
              <Select
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
              </Select>
            </label>
            <label className="field">
              {`Billing scope ${i + 1}`}
              <Select
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
              </Select>
            </label>
            <label className="field">
              {`Commission basis ${i + 1}`}
              <Select
                required
                value={a.basis}
                onChange={(e) =>
                  update(i, {
                    basis: e.target.value as ArrangementDraft['basis'],
                    trigger: '',
                    earningMethod: '',
                  })
                }
              >
                <option value="">Confirm the premium basis…</option>
                {Object.entries(COMMISSION_BASES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <Field
              label={`Commission payor ${i + 1}`}
              value={a.payor}
              change={(v) => update(i, { payor: v })}
            />
            <label className="field">
              {`Receipt trigger ${i + 1}`}
              <Select
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
              </Select>
            </label>
            <label className="field">
              {`Remittance frequency ${i + 1}`}
              <Select
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
              </Select>
            </label>
            <label className="field">
              {`Additional lag days ${i + 1}`}
              <Input
                required
                type="number"
                min="0"
                max="730"
                step="1"
                value={a.lagDays}
                onChange={(e) => update(i, { lagDays: e.target.value })}
              />
            </label>
            <label className="field">
              {`Statement cutoff day ${i + 1} (optional)`}
              <Input
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
              <Input
                type="number"
                min="1"
                max="31"
                step="1"
                value={a.paymentDay}
                onChange={(e) => update(i, { paymentDay: e.target.value })}
              />
            </label>
            {a.basis === 'EARNED' && (
              <label className="field">
                {`Earned premium method ${i + 1}`}
                <Select
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
                </Select>
              </label>
            )}
          </div>
          <Field
            label={`Carrier agreement reference ${i + 1}`}
            value={a.evidence}
            change={(v) => update(i, { evidence: v })}
          />
          <label className="field">
            {`Original carrier wording / notes ${i + 1} (optional)`}
            <Textarea value={a.notes} onChange={(e) => update(i, { notes: e.target.value })} />
          </label>
          <Button variant="secondary"
            type="button"

            onClick={() => setArrangements(arrangements.filter((_, j) => i !== j))}
          >
            Remove payment arrangement {i + 1}
          </Button>
        </div>
      ))}
      <Button variant="secondary"
        type="button"

        disabled={arrangements.length >= 100}
        onClick={() => setArrangements([...arrangements, blankArrangement()])}
      >
        Add payment arrangement
      </Button>
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
    </ActionForm>
  );
}
