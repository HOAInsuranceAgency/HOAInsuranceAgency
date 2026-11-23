import { client } from '../../lib/client';
import { listAllPages } from '../../../../shared/pagination';
import { isIpfsEvidenceDocument } from '../../../../shared/ipfsEvidence';
import { useAsyncResource } from '../../lib/useAsyncResource';
import { useState } from 'react';
import { decimal, ipfsFeeBalances, isIpfsBrokerEntry, type CommissionEntry, type CommissionPolicy, type IpfsRevenueKind } from '../../../../shared/commissions';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Table } from '../../components/ui/Table';
import { commissionAction } from '../../lib/commissions';
import { ActionForm, Field } from './CommissionForm';
import { money, today } from './format';

type Refresh = () => Promise<void>;
const sourceLabels = { BROKER_FEE: 'Policy broker fee', IPFS_FEE: 'Separate lender compensation' };

function feeSources(policy: CommissionPolicy): IpfsRevenueKind[] {
  const sources: IpfsRevenueKind[] = [];
  if (policy.ipfsCollectionRef && policy.brokerFeeCents) sources.push('BROKER_FEE');
  if (policy.ipfsFeeCents) sources.push('IPFS_FEE');
  return sources;
}

export function IpfsFees({ policies, refresh, initialPolicyId }: { policies: CommissionPolicy[]; refresh: Refresh; initialPolicyId?: string }) {
  const [policyId, setPolicyId] = useState(initialPolicyId ?? '');
  const policy = policies.find(row => row.id === policyId);
  const fees = policies.flatMap(row => feeSources(row).map(source => ({ row, source })));
  return (
    <>
      <h2>IPFS remittances</h2>
      {fees.length ? <div className="commission-scroll"><Table>
        <thead><tr>
          <th>Policy term</th><th>Fee source</th><th>IPFS agreement</th><th>Expected</th><th>Received</th>
          <th>Refunded</th><th>Net received</th><th>Outstanding</th>
        </tr></thead>
        <tbody>{fees.map(({ row, source }) => {
          const balance = ipfsFeeBalances(row, source);
          return <tr key={row.id + source}>
            <td>{row.accountName} · {row.policyNumber} · {row.effectiveDate}</td><td>{sourceLabels[source]}</td>
            <td>{source === 'BROKER_FEE' ? row.ipfsCollectionRef : row.ipfsAgreementRef}</td>
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
  const sources = feeSources(policy);
  const [register, setRegister] = useState(false);
  const compensationForm = <ActionForm title="Expected lender compensation" button="Save expected fee" draft={{ amount, agreement }} onDone={refresh}
      submit={() => commissionAction('saveIpfsFee', {
        policyId: policy.id, version: policy.version, expectedCents: decimal(amount), agreementRef: agreement,
        ...(policy.ipfsCollectionRef ? { revenueKind: 'IPFS_FEE' as const } : {}),
      })}>
      <p>For a shared agreement, enter this term’s share of the additional lender compensation.</p>
      <div className="form-grid">
        <Field label="Expected fee ($)" value={amount} change={setAmount} />
        <Field label="IPFS agreement reference" value={agreement} change={setAgreement} />
      </div>
    </ActionForm>;
  return <>
    {policy.ipfsCollectionRef ? <details>
      <summary>Record separate lender compensation</summary>
      {compensationForm}
    </details> : compensationForm}
    {!policy.ipfsCollectionRef && !policy.brokerFeeCents && <details onToggle={event => setRegister(event.currentTarget.open)}>
      <summary>Register a previously bound IPFS term</summary>
      {register && <LegacyRegistration policy={policy} refresh={refresh} />}
    </details>}
    {!!sources.length && <Settlement policy={policy} sources={sources} refresh={refresh} />}
  </>;
}

function LegacyRegistration({ policy, refresh }: { policy: CommissionPolicy; refresh: Refresh }) {
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const docs = useAsyncResource(async () => {
    const rows = await listAllPages(async nextToken => {
      const page = await client.models.Document.listDocumentByEntityId({ entityId: policy.accountId },
        { filter: { entityType: { eq: 'ACCOUNT' } }, nextToken, selectionSet: ['id', 'name', 's3Key', 'entityType', 'entityId', 'category', 'policyId', 'quoteId', 'policyIds', 'quoteIds'] });
      if (page.errors?.length) throw new Error(page.errors[0].message);
      return page;
    });
    return rows.filter(doc => isIpfsEvidenceDocument(doc, policy));
  }, [policy.id, policy.accountId, policy.quoteId], { errorMessage: 'Could not load linked agreement documents.' });
  return <ActionForm title="Verify existing IPFS collection" button="Register IPFS collection" onDone={refresh}
    disabled={!confirmed || !documentId} draft={{ amount, reference, documentId, confirmed }}
    submit={() => commissionAction('registerLegacyIpfsCollection', { policyId: policy.id, version: policy.version,
      agreementRef: reference, amountFinancedCents: decimal(amount), documentId, confirmed })}>
    <div className="form-grid">
      <Field label="Signed IPFS agreement reference" value={reference} change={setReference} />
      <Field label="Agreement amount financed ($)" value={amount} change={setAmount} />
      <label className="field">Signed agreement document
        <Select value={documentId} onChange={event => setDocumentId(event.target.value)}>
          <option value="">Choose an attached document…</option>
          {docs.data?.map(doc => <option key={doc.id} value={doc.id}>{doc.name}</option>)}
        </Select>
      </label>
    </div>
    {docs.error && <p role="alert">{docs.error}</p>}
    {!docs.loading && !docs.error && !docs.data?.length && <p>In Account documents, upload the signed IPFS agreement and link it to this term.</p>}
    <label><Input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Verified zero broker fee and IPFS down payment against the signed agreement</label>
  </ActionForm>;
}

function Settlement({ policy, sources, refresh }: { policy: CommissionPolicy; sources: IpfsRevenueKind[]; refresh: Refresh }) {
  const [source, setSource] = useState(sources[0]);
  const [kind, setKind] = useState<CommissionEntry['kind']>('RECEIPT');
  const [originalId, setOriginalId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState('');
  const [deposit, setDeposit] = useState('');
  const [remittanceTotal, setRemittanceTotal] = useState('');
  const entries = policy.entries.filter(entry => entry.revenueKind === source &&
    (source !== 'BROKER_FEE' || isIpfsBrokerEntry(entry.id)));
  const originals = entries.filter(entry => kind === 'REVERSAL' ? entry.kind !== 'REVERSAL' : entry.kind === 'REVERSAL');
  return <ActionForm title="Reconcile IPFS remittance" button="Post verified settlement"
    draft={{ source, kind, originalId, amount, date, reference, deposit, remittanceTotal }} onDone={refresh}
    submit={() => commissionAction('postIpfsFee', {
      policyId: policy.id, version: policy.version, kind, amountCents: decimal(amount),
      ...(policy.ipfsCollectionRef ? { revenueKind: source } : {}),
      lineRef: reference, settlementRef: deposit, receivedOn: date,
      ...(remittanceTotal.trim() ? { settlementTotalCents: decimal(remittanceTotal) } : {}), ...(originalId ? { originalId } : {}),
    })}>
    <div className="form-grid">
      <label className="field">Remittance fee source
        <Select value={source} onChange={event => { setSource(event.target.value as IpfsRevenueKind); setOriginalId(''); }}>
          {sources.map(value => <option key={value} value={value}>{sourceLabels[value]}</option>)}
        </Select>
      </label>
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
    <p className="small">Use the verified fee subtotal for this transaction type, excluding premium. For a shared remittance, use the same deposit reference and a distinct allocation reference for each policy and fee source. A single allocation uses its fee amount as the subtotal.</p>
  </ActionForm>;
}
