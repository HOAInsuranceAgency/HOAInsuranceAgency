import { useState } from 'react';
import {
  ACCOUNT_COMMISSION_CLASSES,
  type AccountCommissionClass,
  type CommissionAccount
} from '../../../../shared/commissions';
import AccountPicker from '../../components/AccountPicker';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { commissionAction } from '../../lib/commissions';
import { useAsyncResource } from '../../lib/useAsyncResource';
import { ActionForm, Field } from './CommissionForm';

export function AccountClassifications() {
  const [accountId, setAccountId] = useState('');
  return (
    <section>
      <h2>Account commission classification</h2>
      <p>
        GIM Property Management is the only house-account program. Review each account as Standard
        or GIM before binding. Classification is an Owner decision; changing a management
        relationship does not change commission terms.
      </p>
      <AccountPicker value={accountId} onChange={setAccountId} disabled={false} />
      {accountId && <AccountClassificationResource key={accountId} id={accountId} />}
    </section>
  );
}

function AccountClassificationResource({ id }: { id: string }) {
  const resource = useAsyncResource(
    () =>
      commissionAction('getAccountClassification', { id }),
    [id],
    { clearDataOnError: () => true, live: { topics: ['CRM', 'OWNER', 'PERSONAL'] } },
  );
  if (resource.error)
    return (
      <div role="alert">
        <p>{resource.error}</p>
        <Button variant="secondary" type="button" onClick={() => void resource.refetch()}>
          Retry account classification
        </Button>
      </div>
    );
  if (!resource.data || resource.loading) return <p>Loading account classification…</p>;
  return (
    <AccountClassificationEditor
      key={`${id}:${resource.data.classification?.version ?? 0}`}
      id={id}
      name={resource.data.accountName}
      account={resource.data.classification ?? undefined}
      refresh={resource.refetch}
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
      draft={{ history, firstBoundOn, bindingEvidence, periods }}
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
        <Select required value={history} onChange={(e) => setHistory(e.target.value)}>
          <option value="">Confirm the account’s history…</option>
          <option value="NEW">Never bound with this agency</option>
          <option value="BOUND">Previously bound with this agency</option>
        </Select>
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
              <Input
                type="date"
                value={p.to}
                onChange={(e) =>
                  setPeriods(periods.map((r, j) => (i === j ? { ...r, to: e.target.value } : r)))
                }
              />
            </label>
            <label className="field">
              {`Account classification ${i + 1}`}
              <Select
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
              </Select>
            </label>
          </div>
          <Field
            label={`Classification reference ${i + 1}`}
            value={p.evidence}
            change={(v) => setPeriods(periods.map((r, j) => (i === j ? { ...r, evidence: v } : r)))}
          />
          <Button variant="secondary"
            type="button"

            disabled={periods.length === 1}
            onClick={() => setPeriods(periods.filter((_, j) => i !== j))}
          >
            Remove classification period
          </Button>
        </div>
      ))}
      <Button variant="secondary"
        type="button"

        onClick={() =>
          setPeriods([...periods, { from: '', to: '', classification: '', evidence: '' }])
        }
      >
        Add classification period
      </Button>
    </ActionForm>
  );
}
