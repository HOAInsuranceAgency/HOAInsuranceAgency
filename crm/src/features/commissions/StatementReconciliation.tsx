import { useContext,useEffect,useRef,useState } from 'react';
import {
carrierReconciliationBalances,
isCarrierReceipt,
COMMISSION_BASES,
decimal,
ratio,
type CommissionOverview,
type CommissionPolicy,
type CommissionStatement,
type StatementLine
} from '../../../../shared/commissions';
import CommissionPanel from '../../components/CommissionPanel';
import CommissionStatementImport from '../../components/CommissionStatementImport';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { Textarea } from '../../components/ui/Textarea';
import { isAuthorizationError } from '../../../../shared/authorizationError';
import { useEditProtection,useCommissionUnsavedChanges as useUnsavedChanges } from '../../lib/commissionEditProtection';
import { commissionWorkflowAction as commissionAction } from '../../lib/commissions';
import { attachCommissionStatement } from '../../lib/commissionStatementAttachment';
import { useCommissionWorkflow } from '../../lib/commissionWorkflow';

import { ActionForm,Field } from './CommissionForm';
import { CarrierBalances } from './CommissionLedger';
import { CommissionAccessContext } from './context';
import { money,today } from './format';

export function Statements({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const {target}=useCommissionWorkflow();
  const [editing, setEditing] = useState<CommissionStatement | null | undefined>(undefined);
  useEffect(()=>{if(target.statementId){const statement=data.statements.find(s=>s.id===target.statementId);if(statement)setEditing(statement);}},[target.statementId,data.statements]);
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
        <Button variant="primary" onClick={() => requestLeave(() => setEditing(null))}>New reconciliation</Button>
      </div>
      <label className="field">Find a statement<Input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Statement, settlement, transaction, or policy" /></label>
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

export type LineDraft = Omit<StatementLine, 'agencyCents'> & {
  amount: string;
  reportedPremium?: string;
  reportedRate?: string;
};

export const blankLine = (): LineDraft => ({
  policyId: '',
  lineRef: '',
  kind: 'RECEIPT',
  amount: '',
  eligible: false,
  reviewStatus: 'PENDING',
  eligibilityNote: '',
});

export function StatementEditor({
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
          <Select
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
          </Select>
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
          <Select
            value={settlementType}
            onChange={(e) => setType(e.target.value as typeof settlementType)}
          >
            <option value="DEPOSIT">Carrier deposit</option>
            <option value="RETAINED">Agency-bill retained commission</option>
            <option value="NET_SETTLEMENT">Net settlement / offset</option>
          </Select>
        </label>
      </div>
      <label className="field commission-file-field">
        Original carrier statement
        <Input
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
        const balances = p ? carrierReconciliationBalances(p, receivedOn || today()) : undefined;
        return (
          <div className="commission-period" key={i}>
            <h3>Statement line {i + 1}</h3>
            <div className="form-grid">
              <label className="field">
                Policy term
                <Select
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
                </Select>
              </label>
              <Field
                label={`Carrier transaction reference ${i + 1}`}
                value={l.lineRef}
                change={(v) => update(i, { lineRef: v })}
              />
              <label className="field">
                Transaction
                <Select
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
                </Select>
              </label>
              <Field
                label={`Agency commission received / reversed ($) ${i + 1}`}
                value={l.amount}
                change={(v) => update(i, { amount: v })}
              />
            </div>
            {p && balances && (
              <p className="small">
                CRM expectation: {money(balances.fullTermEstimate)} for the full term · Premium{' '}
                {money(p.premiumCents)} at {p.agencyRateUnits / 10000}% · Received so far{' '}
                {money(balances.receivedToDate)} ·{' '}
                {COMMISSION_BASES[p.carrierTerms.payment?.basis ?? p.carrierTerms.basis]} ·{' '}
                {p.carrierTerms.payment
                  ? `${p.carrierTerms.payment.payor} · ${p.carrierTerms.payment.cadence.toLowerCase()} remittance · ${p.carrierTerms.payment.lagDays} additional lag days`
                  : `Legacy timing: ${p.carrierTerms.schedule}`}
              </p>
            )}
            {balances && (
              <CarrierBalances balances={balances} />
            )}
            <div className="form-grid">
              <label className="field">
                Carrier premium basis for this line ($, optional)
                <Input
                  inputMode="decimal"
                  value={l.reportedPremium ?? ''}
                  onChange={(e) => update(i, { reportedPremium: e.target.value })}
                />
              </label>
              <label className="field">
                Carrier commission rate (%, optional)
                <Input
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
                <Select
                  required
                  value={l.originalId ?? ''}
                  onChange={(e) => update(i, { originalId: e.target.value })}
                >
                  <option value="">Choose the original transaction…</option>
                  {p?.entries.filter(isCarrierReceipt)
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
                </Select>
              </label>
            )}
            <label className="field">Eligibility decision {i + 1}
              <Select value={l.reviewStatus ?? 'PENDING'} onChange={e => update(i, { reviewStatus: e.target.value as StatementLine['reviewStatus'], eligible: e.target.value === 'ELIGIBLE' })}>
                <option value="PENDING">Pending review - cannot post</option>
                {l.kind === 'RECEIPT' && <option value="ELIGIBLE">Eligible - agreement requirements verified</option>}
                <option value="INELIGIBLE">{l.kind === 'RECEIPT' ? 'Not eligible - explain in review notes' : 'Adjustment - original allocation verified'}</option>
              </Select>
            </label>
            <label className="field">Eligibility and variance review notes {i + 1}
              <Textarea required maxLength={2000} value={l.eligibilityNote} onChange={e => update(i, { eligibilityNote: e.target.value })} />
              <span className="small muted">{l.eligibilityNote.length}/2,000 characters · evidence, eligibility, and any differences</span>
            </label>
            <Button
              variant="secondary"
              type="button"
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              Remove line
            </Button>
          </div>
        );
      })}
      <Button
        variant="secondary"
        type="button"
        disabled={lines.length >= 20}
        onClick={() => setLines([...lines, blankLine()])}
      >
        Add statement line
      </Button>
    </ActionForm>
  );
}

export function StatementCard({
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
      <Button
        type="button"
        variant="secondary"
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
      </Button>
      {fileError && <p role="alert">{fileError}</p>}
      <div className="commission-scroll">
        <Table>
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
        </Table>
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
      draft={confirmed}
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
      <Button variant="secondary" type="button" onClick={edit}>
        Edit draft
      </Button>
      <label className="commission-check">
        <Input
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
        <label className="field">Reason for voiding<Textarea required maxLength={1000} value={voidReason} onChange={e => setVoidReason(e.target.value)} /></label>
        <label className="commission-check"><Input type="checkbox" checked={voidConfirmed} onChange={e => setVoidConfirmed(e.target.checked)} />This draft must not be posted.</label>
      </ActionForm>
    </CommissionPanel></>
  );
}

export function carrierComparison(line: LineDraft, policy?: CommissionPolicy) {
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
