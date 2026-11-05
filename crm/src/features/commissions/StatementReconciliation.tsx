import { useState } from 'react';
import {
  carrierReconciliationBalances,
  COMMISSION_BASES,
  decimal,
  policyTotals,
  ratio,
  type CommissionOverview,
  type CommissionPolicy,
  type CommissionStatement,
  type StatementLine
} from '../../../../shared/commissions';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Table } from "../../components/ui/Table";
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';
import { CarrierBalances } from './CommissionLedger';
import { money, today } from './format';

export function Statements({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<CommissionStatement | null | undefined>(undefined);
  return (
    <>
      <p>
        Only Owners can upload, match, review, and post carrier statements. Posting requires a
        verified settlement and reviewed eligibility for every line.
      </p>
      <Button variant="primary" onClick={() => setEditing(null)}>
        New reconciliation
      </Button>
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
      const result = await commissionAction('file', {
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
      draft={{ carrierId, reference, source, receivedOn, settlementRef, total, settlementType, lines, uploading }}
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
      <label className="field">
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
                <Select
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
                </Select>
              </label>
            )}
            {l.kind === 'RECEIPT' && (
              <label>
                <Input
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
            <Button variant="secondary"

              type="button"
              disabled={lines.length === 1}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              Remove line
            </Button>
          </div>
        );
      })}
      <Button variant="secondary"

        type="button"
        disabled={lines.length >= 20}
        onClick={() => setLines([...lines, blankLine()])}
      >
        Add statement line
      </Button>
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
      <Button variant="secondary"
        type="button"

        onClick={async () => {
          try {
            const r = await commissionAction('file', {
              key: s.source,
            });
            window.location.assign(r.url);
          } catch (e) {
            setFileError((e as Error).message);
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
                  {l.eligible ? 'Eligible' : 'Not eligible / adjustment'} · {l.eligibilityNote}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
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
      draft={confirmed}
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
      <Button variant="secondary" type="button" onClick={edit}>
        Edit draft
      </Button>
      <label className="commission-confirm">
        <Input
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
