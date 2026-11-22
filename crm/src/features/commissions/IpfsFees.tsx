import { useState } from 'react';
import { decimal, ipfsFeeBalances, type CommissionEntry, type CommissionPolicy } from '../../../../shared/commissions';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';
import { money, today } from './format';

type Refresh = () => Promise<void>;

export function IpfsFees({ policies, refresh, initialPolicyId }: { policies: CommissionPolicy[]; refresh: Refresh; initialPolicyId?: string }) {
  const [policyId, setPolicyId] = useState(initialPolicyId ?? '');
  const policy = policies.find(row => row.id === policyId);
  const fees = policies.filter(row => (row.ipfsFeeCents ?? 0) > 0);
  return (
    <>
      <h2>IPFS financing fees</h2>
      {fees.length ? <div className="commission-scroll"><Table>
        <thead><tr>
          <th>Policy term</th><th>IPFS agreement</th><th>Expected</th><th>Received</th>
          <th>Refunded</th><th>Net received</th><th>Outstanding</th>
        </tr></thead>
        <tbody>{fees.map(row => {
          const balance = ipfsFeeBalances(row);
          return <tr key={row.id}>
            <td>{row.accountName} · {row.policyNumber} · {row.effectiveDate}</td><td>{row.ipfsAgreementRef}</td>
            <td>{money(balance.expected)}</td><td>{money(balance.collected)}</td>
            <td>{money(balance.refunded)}</td><td>{money(balance.net)}</td><td>{money(balance.outstanding)}</td>
          </tr>;
        })}</tbody>
      </Table></div> : <p>No IPFS fees recorded.</p>}
      <label className="field">
        Policy term to record or reconcile
        <Select value={policyId} onChange={event => setPolicyId(event.target.value)}>
          <option value="">Choose a bound policy…</option>
          {policies.map(row => <option key={row.id} value={row.id}>
            {row.accountName} · {row.policyNumber} · {row.effectiveDate}
          </option>)}
        </Select>
      </label>
      {policy && <IpfsFeeEditor key={`${policy.id}:${policy.version}`} policy={policy} refresh={refresh} />}
    </>
  );
}

function IpfsFeeEditor({ policy, refresh }: { policy: CommissionPolicy; refresh: Refresh }) {
  const [amount, setAmount] = useState(String((policy.ipfsFeeCents ?? 0) / 100));
  const [agreement, setAgreement] = useState(policy.ipfsAgreementRef ?? '');
  return <>
    <ActionForm title="Expected IPFS fee" button="Save expected fee" draft={{ amount, agreement }} onDone={refresh}
      submit={() => commissionAction('saveIpfsFee', {
        policyId: policy.id, version: policy.version, expectedCents: decimal(amount), agreementRef: agreement,
      })}>
      <p>Enter the agency fee recorded in IPFS. For an agreement covering several policies, enter each term’s share.</p>
      <div className="form-grid">
        <Field label="Expected fee ($)" value={amount} change={setAmount} />
        <Field label="IPFS agreement reference" value={agreement} change={setAgreement} />
      </div>
    </ActionForm>
    {!!policy.ipfsFeeCents && <Settlement policy={policy} refresh={refresh} />}
  </>;
}

function Settlement({ policy, refresh }: { policy: CommissionPolicy; refresh: Refresh }) {
  const [kind, setKind] = useState<CommissionEntry['kind']>('RECEIPT');
  const [originalId, setOriginalId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState('');
  const [deposit, setDeposit] = useState('');
  const [remittanceTotal, setRemittanceTotal] = useState('');
  const entries = policy.entries.filter(entry => entry.revenueKind === 'IPFS_FEE');
  const originals = entries.filter(entry => kind === 'REVERSAL' ? entry.kind !== 'REVERSAL' : entry.kind === 'REVERSAL');
  return <ActionForm title="Reconcile IPFS remittance" button="Post verified settlement"
    draft={{ kind, originalId, amount, date, reference, deposit, remittanceTotal }} onDone={refresh}
    submit={() => commissionAction('postIpfsFee', {
      policyId: policy.id, version: policy.version, kind, amountCents: decimal(amount),
      lineRef: reference, settlementRef: deposit, receivedOn: date,
      ...(remittanceTotal.trim() ? { settlementTotalCents: decimal(remittanceTotal) } : {}), ...(originalId ? { originalId } : {}),
    })}>
    <div className="form-grid">
      <label className="field">IPFS transaction
        <Select value={kind} onChange={event => { setKind(event.target.value as CommissionEntry['kind']); setOriginalId(''); }}>
          <option value="RECEIPT">Fee received</option>
          <option value="REVERSAL">Fee refunded</option>
          <option value="RESTORATION">Refund reversed</option>
        </Select>
      </label>
      {kind !== 'RECEIPT' && <label className="field">Original IPFS transaction
        <Select required value={originalId} onChange={event => setOriginalId(event.target.value)}>
          <option value="">Choose a transaction…</option>
          {originals.map(entry => <option value={entry.id} key={entry.id}>
            {entry.receivedOn} · {entry.lineRef} · {money(entry.agencyCents)}
          </option>)}
        </Select>
      </label>}
      <Field label="Allocated fee amount ($)" value={amount} change={setAmount} />
      <label className="field">Total IPFS fees on shared remittance ($)
        <Input inputMode="decimal" value={remittanceTotal} onChange={event => setRemittanceTotal(event.target.value)} />
      </label>
      <Field label="Actual settlement date" type="date" value={date} change={setDate} />
      <Field label="Unique IPFS transaction or allocation reference" value={reference} change={setReference} />
      <Field label="Verified remittance or deposit reference" value={deposit} change={setDeposit} />
    </div>
    <p className="small">For a shared remittance, enter the verified total for this transaction type, the same deposit reference and a distinct allocation reference per policy. A single-policy remittance uses the allocated fee as its total.</p>
  </ActionForm>;
}
