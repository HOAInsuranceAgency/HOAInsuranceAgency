import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { PF_CONFIG_SHA256 } from '../../../../shared/premiumFinance/jurisdictions';
import type { BrokerFeeRecord } from '../../../../shared/brokerFees';
import { getModel, modelTable } from '../broker-fees/store';
import { quoteSourceBillingHistory } from '../quote-source-billing';
import { collectCompletePages } from '../storage/pages';
import { parseAccessIndexes, resolveAccessIndex } from '../storage/index-config';
import { db, type Data, type Transaction } from './store';

const LIVE_LOANS = new Set(['QUOTED', 'ACCEPTED', 'ACTIVE', 'DEFAULTED']);
const MAX_LINKS = 75;
// Reserve substantial room for the bind's existing source/ledger/audit items.
// DynamoDB remains the authoritative all-or-nothing total-item size check.
const MAX_LINK_SOURCE_BYTES = 2_000_000;

/** Only provenance moves at bind: quoted money, payment state, and history stay
 * untouched. These writes share the bind's authorization/source transaction. */
export async function bindLinkWrites(quote: Data, policyId: string, at: string, actor: { id: string; name: string }, fee?: BrokerFeeRecord): Promise<Transaction> {
  const accountId = String(quote.accountId), quoteId = String(quote.id);
  const { invoices, loans } = await quoteSourceBillingHistory(quote, fee);
  const writes: Transaction = [];
  let sourceBytes = 0;
  const checkBudget = () => {
    if (writes.length > MAX_LINKS) throw new Error('Too many quote-linked records to bind atomically. Review the quote attachments before binding.');
    if (sourceBytes > MAX_LINK_SOURCE_BYTES) throw new Error('Quote-linked records exceed the safe bind size. Review the quote attachments before binding.');
  };
  const attach = (model: 'Invoice' | 'Document' | 'PfLoan', row: Data, fields: string[]) => {
    if (row.policyId === policyId) return;
    if (row.policyId) throw new Error('A quote-linked record already belongs to another policy. Review it before binding.');
    if (typeof row.id !== 'string' || !row.id || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)))
      throw new Error('A quote-linked record could not be verified. Reload the quote before binding.');
    const names: Record<string, string> = {}, values: Data = { ':policy': policyId, ':at': at };
    const conditions = fields.map((field, index) => {
      const name = `#source${index}`, value = `:source${index}`;
      names[name] = field;
      if (!Object.hasOwn(row, field)) return `attribute_not_exists(${name})`;
      values[value] = row[field];
      return `${name} = ${value}`;
    });
    writes.push({ Update: { TableName: modelTable(model), Key: { id: row.id },
      UpdateExpression: 'SET policyId = :policy, updatedAt = :at', ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
    sourceBytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
    checkBudget();
  };
  for (const invoice of invoices) {
    if (invoice.accountId !== accountId || invoice.quoteId !== quoteId)
      throw new Error('A quote invoice no longer matches its account and quote. Review it before binding.');
    attach('Invoice', invoice, ['accountId', 'quoteId', 'policyId', 'updatedAt', 'status', 'sourcePricingVersion']);
  }
  for (const loan of loans) {
    // A grouped/fee-allocation loan is not this quote's single-policy loan.
    // Terminal records retain the source they closed under, as in servicing.
    if (loan.quoteId !== quoteId || loan.groupedInvoiceId || Array.isArray(loan.groupedPolicyIds) && loan.groupedPolicyIds.length || !LIVE_LOANS.has(String(loan.status))) continue;
    if (loan.accountId !== accountId) throw new Error('A financing loan no longer matches its quote account. Review it before binding.');
    const before = writes.length;
    attach('PfLoan', loan, ['accountId', 'quoteId', 'policyId', 'updatedAt', 'status']);
    if (writes.length !== before) {
      const id = `bind-rollover-${createHash('sha256').update(JSON.stringify([loan.id, policyId])).digest('hex')}`;
      writes.push({ Put: { TableName: modelTable('PfComplianceLog'), Item: { id, __typename: 'PfComplianceLog',
        accountId, jurisdiction: loan.state, rule: 'bind-rollover', outcome: 'PASS',
        reason: `Loan rolled from quote ${quoteId} to policy ${policyId} at bind.`,
        inputs: JSON.stringify({ loanId: loan.id, quoteId, policyId }), actor: actor.id, actorName: actor.name,
        configSha256: PF_CONFIG_SHA256, occurredAt: at, createdAt: at, updatedAt: at }, ConditionExpression: 'attribute_not_exists(id)' } });
      checkBudget();
    }
  }

  const error = () => new Error('Quote document lookup is not configured.');
  const index = resolveAccessIndex(parseAccessIndexes(process.env.ACCESS_INDEXES, error), 'Document.entityId', { error });
  const ids = new Set<string>();
  // Account-rooted documents are the normal layout; retain support for old
  // quote-rooted rows without a global scan or a browser-owned record list.
  for (const [entityType, entityId] of [['ACCOUNT', accountId], ['QUOTE', quoteId]]) {
    await collectCompletePages<never>(async cursor => {
      const result = await db.send(new QueryCommand({ TableName: modelTable('Document'), IndexName: index,
        KeyConditionExpression: 'entityId = :entity', FilterExpression: 'entityType = :type AND quoteId = :quote',
        ExpressionAttributeValues: { ':entity': entityId, ':type': entityType, ':quote': quoteId }, Limit: 100, ExclusiveStartKey: cursor }));
      for (const row of result.Items ?? []) if (typeof row.id === 'string') ids.add(row.id);
      if (ids.size > MAX_LINKS) throw new Error('Too many quote-linked documents to bind atomically. Review the quote attachments before binding.');
      return { items: [], next: result.LastEvaluatedKey };
    }, { maxPages: 100, error: () => new Error('The quote document list could not be loaded completely. Reload before binding.') });
  }
  for (const id of ids) {
    const document = await getModel<Data>('Document', id);
    if (!document) continue;
    if (document.quoteId !== quoteId || !(document.entityType === 'ACCOUNT' && document.entityId === accountId || document.entityType === 'QUOTE' && document.entityId === quoteId))
      throw new Error('A quote document no longer matches its account and quote. Review it before binding.');
    // Signed package disclosures can cover several quotes/policies. Their
    // existing verified brokerFeeBindWrites updates policyIds, never replace
    // that evidence with a single-policy link or duplicate its transaction item.
    if (document.category === 'BROKER_FEE_DISCLOSURE') continue;
    attach('Document', document, ['entityType', 'entityId', 'quoteId', 'policyId', 'updatedAt', 'category']);
  }
  return writes;
}
