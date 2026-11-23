import CommissionReferenceField from '../../components/CommissionReferenceField';
import { useContext,useState } from 'react';
import {
ACCOUNT_COMMISSION_CLASSES,
type AccountCommissionClass,
type CommissionAccount
} from '../../../../shared/commissions';
import AccountPicker from '../../components/AccountPicker';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { isAuthorizationError } from '../../../../shared/authorizationError';
import { commissionWorkflowAction as commissionAction } from '../../lib/commissions';
import { useAsyncResource } from '../../lib/useAsyncResource';

import { ActionForm,Field } from './CommissionForm';
import { CommissionAccessContext } from './context';

export function AccountClassifications({ accounts, refresh }: { accounts: CommissionAccount[]; refresh: () => Promise<void> }) {
  const [accountId, setAccountId] = useState(''), [editing, setEditing] = useState(false);
  return <section className="card commission-setting-section" id="commission-account-eligibility">
    <div className="commission-section-heading"><div><h2>Account eligibility</h2><p>Confirm Standard or GIM and the original first-bind history for the accounts you are testing.</p></div><Button variant="secondary" type="button" onClick={() => setEditing(v => !v)}>{editing ? 'Close account form' : 'Add account classification'}</Button></div>
    {accounts.length ? <div className="commission-scroll"><Table aria-label="Saved account classifications"><thead><tr><th>Account</th><th>Classification / dates</th><th>First bind</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{accounts.map(a => <tr key={a.id}><td><strong>{a.name}</strong></td><td>{a.periods.map((p, i) => <div className="commission-summary-period" key={i}>{p.classification === 'GIM' ? 'GIM' : 'Standard'}<span className="commission-row-note">{p.from}{p.to ? ' – ' + p.to : ' onward'}</span></div>)}</td><td>{a.firstBoundOn || (a.neverBound ? 'Never bound' : 'Needs review')}</td><td><Button type="button" variant="secondary" aria-label={'Edit account ' + a.name} onClick={() => { setAccountId(a.id); setEditing(true); }}>Edit</Button></td></tr>)}</tbody></Table></div> : <p className="commission-compact-empty">No account classifications saved.</p>}
    <div hidden={!editing} className="commission-inline-editor"><AccountPicker value={accountId} onChange={setAccountId} disabled={false} />{accountId && <AccountClassificationResource key={accountId} id={accountId} onSaved={refresh} />}</div>
  </section>;
}

export function AccountClassificationResource({ id, onSaved }: { id: string; onSaved: () => Promise<void> }) {
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
        <Button type="button" variant="secondary" onClick={() => void resource.refetch()}>
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
      refresh={async () => { await resource.refetch(); await onSaved(); }}
    />
  );
}

export function AccountClassificationEditor({
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
      <CommissionReferenceField
        scope={{entityType:"ACCOUNT",entityId:id}}
        references={[account?.bindingEvidence]}
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
          <CommissionReferenceField
            scope={{entityType:"ACCOUNT",entityId:id}}
            references={account?.periods.map(period => period.evidence)}
            label={`Classification reference ${i + 1}`}
            value={p.evidence}
            change={(v) => setPeriods(periods.map((r, j) => (i === j ? { ...r, evidence: v } : r)))}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={periods.length === 1}
            onClick={() => setPeriods(periods.filter((_, j) => i !== j))}
          >
            Remove classification period
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          setPeriods([...periods, { from: '', to: '', classification: '', evidence: '' }])
        }
      >
        Add classification period
      </Button>
    </ActionForm>
  );
}
