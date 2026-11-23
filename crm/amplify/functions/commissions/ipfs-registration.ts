import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { brokerFeeCents, feeAllocations } from '../../../../shared/brokerFees';
import { isIpfsEvidenceDocument } from '../../../../shared/ipfsEvidence';
import { integer, MONEY_MAX, required, type CommissionPolicy } from '../../../../shared/commissions';
import { db, getFee, getModel, getRow, modelTable, table, versionCheck, type Write } from '../broker-fees/store';
import { allocateIpfsAgreement, assertPriorIpfsBilling, normalizedIpfsRef } from './ipfs-bind';
import * as store from './store';

type Row = Record<string, unknown> & { id: string; updatedAt?: string };
const priorBilling = 'This term has existing or ambiguous HOA billing or financing. Review that history before registering external collection.';
const feeConflict = 'Historical registration requires a fee-free term. Review the signed fee terms and existing cash history separately.';

/** Old lines and pre-bind loans can omit the header policy link. Strong base-table reads
 * cover historical rows that lag or predate account indexes. An incomplete scan fails closed. */
async function billingRows(model: 'Invoice' | 'InvoiceLine' | 'PfLoan', policy: CommissionPolicy): Promise<Row[]> {
  const term = model === 'InvoiceLine';
  let cursor: Record<string, unknown> | undefined;
  const rows: Row[] = [];
  for (let page = 0; page < 100; page++) {
    const result = await db.send(new ScanCommand({
      TableName: modelTable(model), ConsistentRead: true, ExclusiveStartKey: cursor, Limit: 250,
      FilterExpression: term ? 'policyId = :policy OR brokerFeeQuoteId = :quote' : 'accountId = :account',
      ExpressionAttributeValues: term ? { ':policy': policy.id, ':quote': policy.quoteId } : { ':account': policy.accountId },
      ProjectionExpression: term ? 'invoiceId' : 'id, accountId, policyId, quoteId, groupedPolicyIds, brokerFeeAllocations, #s, updatedAt, sourcePricingVersion, stripePaymentLinkId, paymentUrl, invoiceSendOperation, paidAt, stripePaymentIntentId, downPaidAt, downPaymentIntentId, activatedAt, electedAt, agreementSignedAt, paidThrough, electionCheckoutUrl, electionCheckoutExpiresAt, cancellationEffectiveAt, expectedCarrierRefundAt',
      ...(term ? {} : { ExpressionAttributeNames: { '#s': 'status' } }),
    }));
    rows.push(...(result.Items ?? []) as Row[]);
    if (rows.length > 2500) break;
    cursor = result.LastEvaluatedKey;
    if (!cursor) return rows;
  }
  throw new Error('The historical billing records could not be completely verified. Review the term before registration.');
}

function linkedOrAmbiguous(row: Row, policy: CommissionPolicy) {
  const members = Array.isArray(row.groupedPolicyIds) ? row.groupedPolicyIds : [];
  return row.policyId === policy.id || row.quoteId === policy.quoteId || members.includes(policy.id) ||
    feeAllocations(row.brokerFeeAllocations).some(a => a.quoteId === policy.quoteId || a.policyId === policy.id) ||
    (!row.policyId && !row.quoteId && !members.length);
}

async function priorBillingGuards(policy: CommissionPolicy): Promise<Write[]> {
  const [invoices, lines, loans] = await Promise.all((['Invoice', 'InvoiceLine', 'PfLoan'] as const).map(model => billingRows(model, policy)));
  const byId = new Set(invoices.map(row => row.id));
  if (lines.some(row => typeof row.invoiceId !== 'string' || !byId.has(row.invoiceId))) throw new Error(priorBilling);
  const linkedInvoices = new Set(lines.map(row => row.invoiceId));
  const relevantInvoices = invoices.filter(row => linkedInvoices.has(row.id) || linkedOrAmbiguous(row, policy));
  if (relevantInvoices.some(row => row.paidAt || row.stripePaymentIntentId)) throw new Error(priorBilling);
  return assertPriorIpfsBilling(relevantInvoices, loans.filter(row => linkedOrAmbiguous(row, policy)));
}

export async function registerLegacyIpfsCollection(input: store.Data, actor: string) {
  const id = required(input.policyId, 'a bound policy'), reference = required(input.agreementRef, 'the signed IPFS agreement reference', 200);
  const documentId = required(input.documentId, 'the signed agreement document');
  const cents = integer(input.amountFinancedCents, 1, MONEY_MAX, 'the amount financed');
  if (input.confirmed !== true) throw new Error('Confirm the executed IPFS agreement, zero client broker fee and IPFS down payment.');
  const policy = await store.get<CommissionPolicy>('POLICY', id);
  if (!policy) throw new Error('Commission policy not found.');
  if (policy.ipfsCollectionRef) {
    if (policy.ipfsLegacyDocumentId === documentId && policy.ipfsAmountFinancedCents === cents &&
        normalizedIpfsRef(policy.ipfsCollectionRef) === normalizedIpfsRef(reference)) return;
    throw new Error('The term already has an IPFS collection agreement.');
  }
  if (policy.version !== input.version) throw new Error('This policy changed. Refresh before registering collection.');
  const markerId = `hoa-collection-policy:${id}`;
  const [publicPolicy, quote, doc, fee, collection] = await Promise.all([
    getModel<Row>('Policy', id), getModel<Row>('Quote', policy.quoteId), getModel<Row>('Document', documentId),
    getFee(policy.quoteId), getRow(markerId),
  ]);
  if (!publicPolicy || publicPolicy.quoteId !== policy.quoteId || publicPolicy.accountId !== policy.accountId ||
      publicPolicy.status !== 'ACTIVE' || publicPolicy.billType !== 'AGENCY' || !quote || quote.status !== 'BOUND' ||
      quote.accountId !== policy.accountId || quote.billType === 'DIRECT' || quote.ipfsAmountFinanced != null ||
      publicPolicy.ipfsAmountFinanced != null || publicPolicy.ipfsAgreementRef != null)
    throw new Error('Verify the active agency-billed policy, its bound quote and its current collection route.');
  if (policy.brokerFeeCents || publicPolicy.brokerFeeCollected || publicPolicy.brokerFeeRefunded ||
      [publicPolicy, quote].some(row => brokerFeeCents(row.brokerFee as number | null | undefined)) ||
      policy.entries.some(entry => entry.revenueKind === 'BROKER_FEE') || fee) throw new Error(feeConflict);
  if (collection || [publicPolicy, quote].some(row => row.groupedDraftInvoiceId || row.sourcePricingInvoiceId || row.sourcePricingLoanId)) throw new Error(priorBilling);
  if (!doc || !isIpfsEvidenceDocument(doc, policy)) throw new Error('Select an uploaded external agreement linked to this policy or its original quote.');
  const history = await priorBillingGuards(policy);
  const agreement = await allocateIpfsAgreement(policy.accountId, reference, { ipfsAmountFinanced: cents / 100 });
  const now = new Date().toISOString();
  const absence = (key: string): Write => ({ ConditionCheck: {
    TableName: table(), Key: { id: key }, ConditionExpression: 'attribute_not_exists(id)',
  } });
  await store.commit([{ kind: 'POLICY', previous: { ...policy }, value: {
    ...policy, ipfsCollectionRef: reference, ipfsAmountFinancedCents: cents, ipfsFinancedBrokerFeeCents: 0,
    ipfsDownPaymentBrokerFeeCents: 0, ipfsConfirmedAt: now, ipfsConfirmedBy: actor, ipfsLegacyDocumentId: documentId,
  } }], actor, [
    agreement.write, absence(markerId), absence(`fee:${policy.quoteId}`), versionCheck(modelTable('Document'), doc), versionCheck(modelTable('Quote'), quote), ...history,
    { Update: { TableName: modelTable('Policy'), Key: { id },
      ConditionExpression: 'accountId = :account AND quoteId = :quote AND updatedAt = :old AND (attribute_not_exists(ipfsAmountFinanced) OR ipfsAmountFinanced = :nil) AND (attribute_not_exists(groupedDraftInvoiceId) OR groupedDraftInvoiceId = :nil) AND (attribute_not_exists(sourcePricingInvoiceId) OR sourcePricingInvoiceId = :nil) AND (attribute_not_exists(sourcePricingLoanId) OR sourcePricingLoanId = :nil)',
      UpdateExpression: 'SET ipfsAmountFinanced = :amount, ipfsAgreementRef = :ref, ipfsConfirmedAt = :now, ipfsConfirmedBy = :actor, updatedAt = :now, lastWriteBy = :actor',
      ExpressionAttributeValues: { ':account': policy.accountId, ':quote': policy.quoteId, ':old': publicPolicy.updatedAt, ':nil': null,
        ':amount': cents / 100, ':ref': reference, ':now': now, ':actor': actor },
    } },
  ]);
}
