import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useIsOwner } from '../lib/auth';
import { useAsyncResource } from '../lib/useAsyncResource';
import { client, listAllPages, fmtMoney } from '../lib/client';
import { communicationRequest, type TeamEligibility } from '../lib/communications';
import { commissionAction, readCommissions } from '../lib/commissions';
import AccountPicker from '../components/AccountPicker';
import { ReportDownload } from '../components/ReportDownload';
import {
  COMMISSION_BASES,
  ACCOUNT_COMMISSION_CLASSES,
  type CommissionAccount,
  type AccountCommissionClass,
  decimal,
  policyTotals,
  recoveryBalances,
  ratio,
  sum,
  type CommissionOverview,
  type CommissionPlan,
  type CarrierCommissionTerms,
  type CommissionStatement,
  type CommissionBatch,
  type CommissionPolicy,
  type StatementLine,
} from '../../../shared/commissions';
import './Commissions.css';

const money = (cents: number) => fmtMoney(cents / 100);
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
  const resource = useAsyncResource(readCommissions, [], {
    errorMessage: 'Could not load commissions.',
    clearDataOnError: () => true,
  });
  const [tab, setTab] = useState('ledger');
  const snapshot = resource.data;
  return (
    <div className="commissions">
      <header>
        <p className="muted small">
          {owner ? 'Owner · private commission management' : 'Your commission statements'}
        </p>
        <h1>Commissions</h1>
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
            ['settings', 'Agreements & carriers'],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'primary' : 'secondary'}
              onClick={() => setTab(id)}
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
          {owner && tab === 'payroll' && <Payroll data={snapshot} refresh={resource.refetch} />}
          {!owner && <BatchList batches={snapshot.batches} />}
        </>
      )}
    </div>
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
                'Agency commission (USD)',
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
              Expected agency commission {money(t.expectedAgency)} · Received{' '}
              {money(t.receivedAgency)} · Producer earned {money(t.earned)} · Proposed adjustments{' '}
              {money(t.proposedRecovery)}
            </p>
            {owner && <PolicyNumber key={`${p.id}:${p.version}`} policy={p} refresh={refresh} />}
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
                          {e.kind}
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
                </table>
              </div>
            ) : (
              <p className="muted">
                Awaiting carrier receipts. Binding does not create payable commission.
              </p>
            )}
          </section>
        );
      })}
    </>
  );
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
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={(e) => void run(e)}>
      <h2>{title}</h2>
      <fieldset disabled={busy}>
        {children}
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
      {saved && <p role="status">Saved.</p>}
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
        listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
      ]);
      return { team: team.team, carriers };
    },
    [],
    { clearDataOnError: () => true },
  );
  const [producer, setProducer] = useState(''),
    [carrier, setCarrier] = useState('');
  if (!references.data)
    return (
      <p role={references.error ? 'alert' : undefined}>
        {references.error || 'Loading teammates and carriers…'}
      </p>
    );
  return (
    <>
      <p>
        Rates are set for each producer. New business uses the bind date; renewals use the term
        effective date. Saved policy snapshots keep their original rates when agreements change.
      </p>
      <label className="field">
        Producer
        <select value={producer} onChange={(e) => setProducer(e.target.value)}>
          <option value="">Choose a producer…</option>
          {references.data.team.map((t) => (
            <option key={t.userId} value={t.userId}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {producer && (
        <PlanEditor
          key={`${producer}:${data.plans.find((p) => p.id === producer)?.version ?? 0}`}
          producerId={producer}
          name={references.data.team.find((t) => t.userId === producer)?.name ?? producer}
          plan={data.plans.find((p) => p.id === producer)}
          refresh={refresh}
        />
      )}
      <label className="field">
        Carrier
        <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
          <option value="">Choose a carrier…</option>
          {references.data.carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {carrier && (
        <CarrierEditor
          key={`${carrier}:${data.carriers.find((c) => c.id === carrier)?.version ?? 0}`}
          id={carrier}
          terms={data.carriers.find((c) => c.id === carrier)}
          refresh={refresh}
        />
      )}
      <AccountClassifications />
      <LegacyPolicies data={data} refresh={refresh} />
    </>
  );
}
function PlanEditor({
  producerId,
  name,
  plan,
  refresh,
}: {
  producerId: string;
  name: string;
  plan?: CommissionPlan;
  refresh: () => Promise<void>;
}) {
  const [accountBoundFrom, setAccountBoundFrom] = useState(plan?.accountBoundFrom ?? '');
  const [receiptsFrom, setReceiptsFrom] = useState(plan?.receiptsFrom ?? '');
  const [terms, setTerms] = useState(
    plan?.terms.map((t) => ({
      ...t,
      to: t.to ?? '',
      newRate: String(t.newBps / 100),
      renewalRate: String(t.renewalBps / 100),
      gimEnabled: !!t.gim,
      gimNewRate: t.gim ? String(t.gim.newBps / 100) : '',
      gimRenewalRate: t.gim ? String(t.gim.renewalBps / 100) : '',
      gimAgreement: t.gim?.agreement ?? '',
    })) ?? [
      {
        from: '',
        to: '',
        newRate: '',
        renewalRate: '',
        agreement: '',
        gimEnabled: false,
        gimNewRate: '',
        gimRenewalRate: '',
        gimAgreement: '',
      },
    ],
  );
  return (
    <ActionForm
      title={`${name} · commission agreement`}
      button="Save producer agreement"
      onDone={refresh}
      submit={() =>
        commissionAction('savePlan', {
          producerId,
          name,
          version: plan?.version ?? 0,
          ...(accountBoundFrom ? { accountBoundFrom } : {}),
          ...(receiptsFrom ? { receiptsFrom } : {}),
          terms: terms.map((t) => ({
            from: t.from,
            ...(t.to ? { to: t.to } : {}),
            newBps: decimal(t.newRate),
            renewalBps: decimal(t.renewalRate),
            agreement: t.agreement,
            ...(t.gimEnabled
              ? {
                  gim: {
                    newBps: decimal(t.gimNewRate),
                    renewalBps: decimal(t.gimRenewalRate),
                    agreement: t.gimAgreement,
                  },
                }
              : {}),
          })),
        })
      }
    >
      <div className="form-grid">
        <label className="field">
          Account first-bind cutoff (optional)
          <input
            type="date"
            value={accountBoundFrom}
            onChange={(e) => setAccountBoundFrom(e.target.value)}
          />
        </label>
        <label className="field">
          Agency receipt eligibility begins (optional)
          <input
            type="date"
            value={receiptsFrom}
            onChange={(e) => setReceiptsFrom(e.target.value)}
          />
        </label>
      </div>
      <p className="small muted">
        Accounts first bound before the cutoff earn no producer commission, including later
        renewals. The cutoff date itself is eligible. This rule uses the account’s original first
        bind, not the current policy’s bind or effective date. Blank means no cutoff for this
        producer.
      </p>
      {terms.map((t, i) => (
        <div key={i} className="commission-period">
          <div className="form-grid">
            <Field
              label={`Effective from ${i + 1}`}
              type="date"
              value={t.from}
              change={(v) => setTerms(terms.map((r, j) => (i === j ? { ...r, from: v } : r)))}
            />
            <label className="field">
              Through (optional)
              <input
                type="date"
                value={t.to}
                onChange={(e) =>
                  setTerms(terms.map((r, j) => (i === j ? { ...r, to: e.target.value } : r)))
                }
              />
            </label>
            <Field
              label={`New business % ${i + 1}`}
              value={t.newRate}
              change={(v) => setTerms(terms.map((r, j) => (i === j ? { ...r, newRate: v } : r)))}
            />
            <Field
              label={`Renewal % ${i + 1}`}
              value={t.renewalRate}
              change={(v) =>
                setTerms(terms.map((r, j) => (i === j ? { ...r, renewalRate: v } : r)))
              }
            />
          </div>
          <Field
            label={`Agreement reference ${i + 1}`}
            value={t.agreement}
            change={(v) => setTerms(terms.map((r, j) => (i === j ? { ...r, agreement: v } : r)))}
          />
          <h3>GIM Property Management · house-account rates</h3>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={t.gimEnabled}
              onChange={(e) =>
                setTerms(
                  terms.map((r, j) => (i === j ? { ...r, gimEnabled: e.target.checked } : r)),
                )
              }
            />
            {`Configure GIM rates for period ${i + 1}`}
          </label>
          {t.gimEnabled ? (
            <>
              <div className="form-grid">
                <Field
                  label={`GIM new business % ${i + 1}`}
                  value={t.gimNewRate}
                  change={(v) =>
                    setTerms(terms.map((r, j) => (i === j ? { ...r, gimNewRate: v } : r)))
                  }
                />
                <Field
                  label={`GIM renewal % ${i + 1}`}
                  value={t.gimRenewalRate}
                  change={(v) =>
                    setTerms(terms.map((r, j) => (i === j ? { ...r, gimRenewalRate: v } : r)))
                  }
                />
              </div>
              <Field
                label={`GIM agreement reference ${i + 1}`}
                value={t.gimAgreement}
                change={(v) =>
                  setTerms(terms.map((r, j) => (i === j ? { ...r, gimAgreement: v } : r)))
                }
              />
              <p className="small muted">
                GIM rates use this period’s dates. Add a rate period when either schedule changes.
              </p>
            </>
          ) : (
            <p className="small muted">
              GIM terms pending. GIM policies cannot be bound under this period until both rates and
              the agreement reference are configured.
            </p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={terms.length === 1}
            onClick={() => setTerms(terms.filter((_, j) => j !== i))}
          >
            Remove period
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          setTerms([
            ...terms,
            {
              from: '',
              to: '',
              newRate: '',
              renewalRate: '',
              agreement: '',
              gimEnabled: false,
              gimNewRate: '',
              gimRenewalRate: '',
              gimAgreement: '',
            },
          ])
        }
      >
        Add rate period
      </button>
      <p className="small muted">
        Both rates are percentages of agency commission received. Explicit 0% means no commission;
        blank is not zero. Salary remains in private pay settings.
      </p>
    </ActionForm>
  );
}
function AccountClassifications() {
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
      commissionAction<{ classification: CommissionAccount | null; accountName: string }>(
        'getAccountClassification',
        { id },
      ),
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
function CarrierEditor({
  id,
  terms,
  refresh,
}: {
  id: string;
  terms?: CarrierCommissionTerms;
  refresh: () => Promise<void>;
}) {
  const [basis, setBasis] = useState(terms?.basis ?? ''),
    [schedule, setSchedule] = useState(terms?.schedule ?? ''),
    [evidence, setEvidence] = useState(terms?.evidence ?? '');
  return (
    <ActionForm
      title="Carrier commission payment terms"
      onDone={refresh}
      submit={() =>
        commissionAction('saveCarrier', {
          id,
          version: terms?.version ?? 0,
          basis,
          schedule,
          evidence,
        })
      }
    >
      <label className="field">
        Commission basis
        <select required value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
          <option value="">Choose…</option>
          {Object.entries(COMMISSION_BASES).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Field label="Remittance schedule / expected lag" value={schedule} change={setSchedule} />
      <Field label="Carrier agreement reference" value={evidence} change={setEvidence} />
      <p className="small muted">
        The schedule forecasts receipts; it does not generate earnings. Agency billing and direct
        billing remain separate policy settings.
      </p>
    </ActionForm>
  );
}
function Statements({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<CommissionStatement | null | undefined>(undefined);
  return (
    <>
      <p>
        Only Owners can upload, match, review, and post carrier statements. Posting requires a
        verified settlement and reviewed eligibility for every line.
      </p>
      <button className="primary" onClick={() => setEditing(null)}>
        New reconciliation
      </button>
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
      {data.statements.length === 0 && <p className="muted">No statements yet.</p>}
      {data.statements.map((s) => (
        <StatementCard
          key={`${s.id}:${s.version}`}
          statement={s}
          policies={data.policies}
          edit={() => setEditing(s)}
          refresh={refresh}
        />
      ))}
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
      amount: String(l.agencyCents / 100),
      reportedPremium: l.reportedPremiumCents == null ? '' : String(l.reportedPremiumCents / 100),
      reportedRate: l.reportedRateUnits == null ? '' : String(l.reportedRateUnits / 10000),
    })) ?? [blankLine()],
  );
  const [uploading, setUploading] = useState(false),
    [fileError, setFileError] = useState(''),
    [fileName, setFileName] = useState(statement ? 'Previously attached statement' : '');
  const update = (index: number, change: Partial<LineDraft>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
  async function upload(file: File) {
    setUploading(true);
    setFileError('');
    setSource('');
    try {
      const contentType =
        file.type || (file.name.endsWith('.csv') ? 'text/csv' : 'application/pdf');
      const result = await commissionAction<{ key: string; url: string }>('file', {
        action: 'upload',
        size: file.size,
        contentType,
        filename: file.name,
      });
      const response = await fetch(result.url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'If-None-Match': '*' },
        body: file,
      });
      if (!response.ok) throw new Error('Statement upload failed.');
      setSource(result.key);
      setFileName(file.name);
    } catch (e) {
      setFileError((e as Error).message);
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
        return commissionAction('saveStatement', {
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
        });
      }}
    >
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
      <label className="field">
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
      <p className="small">{uploading ? 'Uploading privately…' : fileName}</p>
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
                {money(policyTotals(p).receivedAgency)} · {p.carrierTerms.basis.toLowerCase()}{' '}
                premium · {p.carrierTerms.schedule}
              </p>
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
            {l.kind === 'RECEIPT' && (
              <label>
                <input
                  type="checkbox"
                  checked={l.eligible}
                  onChange={(e) => update(i, { eligible: e.target.checked })}
                />{' '}
                Producer eligibility verified (license, qualifying transaction, documentation, and
                applicable agreement)
              </label>
            )}
            <Field
              label={`Eligibility and variance review notes ${i + 1}`}
              value={l.eligibilityNote}
              change={(v) => update(i, { eligibilityNote: v })}
            />
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
  const [confirmed, setConfirmed] = useState(false),
    [fileError, setFileError] = useState('');
  const body = (
    <>
      <p>
        {s.receivedOn} · {s.status} · Settlement {s.settlementRef} · {money(s.totalCents)}
      </p>
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
                  {l.eligible ? 'Eligible' : 'Not eligible / adjustment'} · {l.eligibilityNote}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
  if (s.status === 'POSTED')
    return (
      <section className="card">
        <h2>{s.reference}</h2>
        {body}
      </section>
    );
  return (
    <ActionForm
      title={s.reference}
      disabled={!confirmed}
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
      <label className="commission-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{' '}
        I verified settlement evidence, policy terms, eligibility, and any differences. The
        allocation total has not already been posted.
      </label>
    </ActionForm>
  );
}
function Payroll({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
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
            <select required value={producerId} onChange={(e) => setProducer(e.target.value)}>
              <option value="">Choose…</option>
              {[...new Map(data.policies.map((p) => [p.producerId, p.producerName])).entries()].map(
                ([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ),
              )}
            </select>
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
function BatchList({
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
    [action, setAction] = useState('payPayroll');
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
          <option value="payPayroll">Confirm the full batch was paid</option>
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
        Only confirm a fully paid batch. For a rejected payroll export, cancel the unpaid batch
        before preparing a replacement.
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
          Recorded premium {selected.premium == null ? 'Missing' : fmtMoney(selected.premium)} ·
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
    <details>
      <summary>Update carrier policy number</summary>
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
    </details>
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
