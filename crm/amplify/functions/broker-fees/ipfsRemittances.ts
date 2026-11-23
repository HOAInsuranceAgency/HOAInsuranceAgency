import type { CommissionEntry, CommissionPolicy } from '../../../../shared/commissions';
import { feePut, getFee, modelTable, type Write } from './store';

/** Update the signed receivable and its public totals in the same transaction as the private earnings. */
export async function ipfsBrokerReceiptWrites(policy: CommissionPolicy, entry: CommissionEntry): Promise<Write[]> {
  const fee = await getFee(policy.quoteId);
  if (!policy.ipfsCollectionRef || !fee?.signedAt || !fee.agreementId ||
      fee.ipfsCollectionRef !== policy.ipfsCollectionRef || fee.accountId !== policy.accountId ||
      fee.policyId !== policy.id || fee.quoteId !== policy.quoteId || fee.amountCents !== policy.brokerFeeCents)
    throw new Error('The signed broker fee and bound IPFS collection agreement must match before posting a remittance.');

  const grossChange = entry.kind === 'RECEIPT' ? entry.agencyCents : 0;
  const refundChange = entry.kind === 'RECEIPT' ? 0 : -entry.agencyCents;
  const collectedCents = fee.collectedCents + grossChange;
  const submittedCents = fee.submittedCents + grossChange;
  const refundedCents = fee.refundedCents + refundChange;
  const ipfsRemittance = {
    collectedCents: (fee.ipfsRemittance?.collectedCents ?? 0) + grossChange,
    refundedCents: (fee.ipfsRemittance?.refundedCents ?? 0) + refundChange,
  };
  if (submittedCents > fee.amountCents || collectedCents > submittedCents ||
      refundedCents < 0 || refundedCents > collectedCents ||
      ipfsRemittance.refundedCents < 0 || ipfsRemittance.refundedCents > ipfsRemittance.collectedCents)
    throw new Error('This remittance exceeds the signed broker fee or the amount available for refund.');

  const latestReceipt = policy.entries.filter(row => row.revenueKind === 'BROKER_FEE' && row.kind === 'RECEIPT')
    .reduce((latest, row) => row.receivedOn > latest ? row.receivedOn : latest, entry.receivedOn);
  return [
    feePut({ ...fee, collectedCents, submittedCents, refundedCents, ipfsRemittance }, fee),
    { Update: {
      TableName: modelTable('Policy'), Key: { id: policy.id },
      UpdateExpression: 'SET brokerFeeCollected = :gross, brokerFeeRefunded = :refund' +
        (entry.kind === 'RECEIPT' ? ', brokerFeeCollectedAt = :at' : ''),
      ConditionExpression: 'accountId = :account AND quoteId = :quote AND ipfsAgreementRef = :agreement',
      ExpressionAttributeValues: {
        ':gross': collectedCents / 100, ':refund': refundedCents / 100,
        ':account': policy.accountId, ':quote': policy.quoteId, ':agreement': policy.ipfsCollectionRef,
        ...(entry.kind === 'RECEIPT' ? { ':at': `${latestReceipt}T12:00:00Z` } : {}),
      },
    } },
  ];
}
