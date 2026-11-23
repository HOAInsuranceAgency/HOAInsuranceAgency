import { retainIpfsEvidence } from './ipfs-evidence';
import { priorBilling, priorBillingGuards } from './ipfs-billing-history';
import { brokerFeeCents } from '../../../../shared/brokerFees';
import { isIpfsEvidenceDocument } from '../../../../shared/ipfsEvidence';
import { integer, MONEY_MAX, required, type CommissionPolicy } from '../../../../shared/commissions';
import { getFee, getModel, getRow, modelTable, table, type Write } from '../broker-fees/store';
import { allocateIpfsAgreement, normalizedIpfsRef } from './ipfs-bind';
import * as store from './store';

type Row = Record<string, unknown> & { id: string; updatedAt?: string };
const feeConflict = 'Historical registration requires a fee-free term. Review the signed fee terms and existing cash history separately.';

export async function registerLegacyIpfsCollection(input: store.Data, actor: string) {
  const id = required(input.policyId, 'a bound policy'), suppliedReference = required(input.agreementRef, 'the signed IPFS agreement reference', 200);
  const documentId = required(input.documentId, 'the signed agreement document');
  const cents = integer(input.amountFinancedCents, 1, MONEY_MAX, 'the amount financed');
  if (input.confirmed !== true) throw new Error('Confirm the executed IPFS agreement, zero client broker fee and IPFS down payment.');
  const policy = await store.get<CommissionPolicy>('POLICY', id);
  if (!policy) throw new Error('Commission policy not found.');
  const replay = !!policy.ipfsCollectionRef;
  if (replay && !(policy.ipfsLegacyDocumentId === documentId && policy.ipfsAmountFinancedCents === cents &&
      normalizedIpfsRef(policy.ipfsCollectionRef!) === normalizedIpfsRef(suppliedReference)))
    throw new Error('The term already has an IPFS collection agreement.');
  if (!replay && policy.version !== input.version) throw new Error('This policy changed. Refresh before registering collection.');
  const reference = policy.ipfsCollectionRef ?? suppliedReference;
  const markerId = `hoa-collection-policy:${id}`;
  const [publicPolicy, quote, doc, fee, collection] = await Promise.all([
    getModel<Row>('Policy', id), getModel<Row>('Quote', policy.quoteId), getModel<Row>('Document', documentId),
    getFee(policy.quoteId), getRow(markerId),
  ]);
  if (!publicPolicy || publicPolicy.quoteId !== policy.quoteId || publicPolicy.accountId !== policy.accountId ||
      publicPolicy.status !== 'ACTIVE' || publicPolicy.billType !== 'AGENCY' || !quote || quote.status !== 'BOUND' ||
      quote.accountId !== policy.accountId || quote.billType === 'DIRECT' || quote.ipfsAmountFinanced != null ||
      (quote.ipfsRegisteredPolicyId != null && quote.ipfsRegisteredPolicyId !== id) ||
      (replay ? publicPolicy.ipfsAmountFinanced !== cents / 100 || publicPolicy.ipfsAgreementRef !== policy.ipfsCollectionRef
        : publicPolicy.ipfsAmountFinanced != null || publicPolicy.ipfsAgreementRef != null || quote.ipfsRegisteredPolicyId != null))
    throw new Error('Verify the active agency-billed policy, its bound quote and its current collection route.');
  if (replay && quote.ipfsRegisteredPolicyId === id && policy.ipfsLegacyEvidence) return;
  if (policy.brokerFeeCents || publicPolicy.brokerFeeCollected || publicPolicy.brokerFeeRefunded ||
      [publicPolicy, quote].some(row => brokerFeeCents(row.brokerFee as number | null | undefined)) ||
      policy.entries.some(entry => entry.revenueKind === 'BROKER_FEE') || fee) throw new Error(feeConflict);
  if (collection || [publicPolicy, quote].some(row => row.groupedDraftInvoiceId || row.sourcePricingInvoiceId || row.sourcePricingLoanId)) throw new Error(priorBilling);
  if (!doc || !isIpfsEvidenceDocument(doc, policy) || typeof doc.s3Key !== 'string') throw new Error('Select an uploaded external agreement linked to this policy or its original quote.');
  const history = await priorBillingGuards(policy);
  const agreement = await allocateIpfsAgreement(policy.accountId, reference, { ipfsAmountFinanced: cents / 100 });
  const archive = await retainIpfsEvidence(id, doc.s3Key, typeof doc.name === 'string' && doc.name ? doc.name : 'Signed IPFS agreement');
  const now = new Date().toISOString();
  const priorPointer = '(attribute_not_exists(sourcePricingInvoiceId) OR sourcePricingInvoiceId = :nil) AND (attribute_not_exists(sourcePricingLoanId) OR sourcePricingLoanId = :nil)';
  const absence = (key: string): Write => ({ ConditionCheck: {
    TableName: table(), Key: { id: key }, ConditionExpression: 'attribute_not_exists(id)',
  } });
  await store.commit([{ kind: 'POLICY', previous: { ...policy }, value: {
    ...policy, ipfsCollectionRef: reference, ipfsAmountFinancedCents: cents, ipfsFinancedBrokerFeeCents: 0,
    ipfsDownPaymentBrokerFeeCents: 0, ipfsConfirmedAt: policy.ipfsConfirmedAt ?? now, ipfsConfirmedBy: policy.ipfsConfirmedBy ?? actor, ipfsLegacyDocumentId: documentId, ipfsLegacyEvidence: archive,
  } }], actor, [
    agreement.write, absence(markerId), absence(`fee:${policy.quoteId}`), { ConditionCheck: {
      TableName: modelTable('Document'), Key: { id: doc.id }, ConditionExpression: 'updatedAt = :old AND entityId = :account AND s3Key = :source',
      ExpressionAttributeValues: { ':old': doc.updatedAt, ':account': policy.accountId, ':source': doc.s3Key },
    } }, ...history,
    { Update: { TableName: modelTable('Quote'), Key: { id: policy.quoteId },
      UpdateExpression: 'SET ipfsRegisteredPolicyId = :policy, updatedAt = :now, lastWriteBy = :actor',
      ConditionExpression: `accountId = :account AND #status = :bound AND updatedAt = :old AND (attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil) AND (attribute_not_exists(ipfsRegisteredPolicyId) OR ipfsRegisteredPolicyId = :nil OR ipfsRegisteredPolicyId = :policy) AND ${priorPointer}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':account': policy.accountId, ':old': quote.updatedAt, ':policy': id,
        ':bound': 'BOUND', ':nil': null, ':now': now, ':actor': actor },
    } },
    { Update: { TableName: modelTable('Policy'), Key: { id },
      ConditionExpression: `accountId = :account AND quoteId = :quote AND updatedAt = :old AND ${replay ? 'ipfsAmountFinanced = :amount AND ipfsAgreementRef = :ref' : '(attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil)'} AND (attribute_not_exists(groupedDraftInvoiceId) OR groupedDraftInvoiceId = :nil) AND ${priorPointer}`,
      UpdateExpression: 'SET ipfsAmountFinanced = :amount, ipfsAgreementRef = :ref, ipfsConfirmedAt = if_not_exists(ipfsConfirmedAt, :now), ipfsConfirmedBy = if_not_exists(ipfsConfirmedBy, :actor), updatedAt = :now, lastWriteBy = :actor',
      ExpressionAttributeValues: { ':account': policy.accountId, ':quote': policy.quoteId, ':old': publicPolicy.updatedAt, ':nil': null,
        ':amount': cents / 100, ':ref': reference, ':now': now, ':actor': actor },
    } },
  ]);
}
