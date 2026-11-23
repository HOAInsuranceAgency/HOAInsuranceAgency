import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { feeAllocations } from '../../../../shared/brokerFees';
import type { CommissionPolicy } from '../../../../shared/commissions';
import { db, modelTable, type Write } from '../broker-fees/store';
import { batchGetComplete } from '../storage/batchGet';
import { assertPriorIpfsBilling } from './ipfs-bind';

type Row = Record<string, unknown> & { id: string };
type BillingPartition = 'Invoice.accountId' | 'PfLoan.accountId' | 'InvoiceLine.invoiceId';
export const priorBilling = 'This term has existing or ambiguous HOA billing or financing. Review that history before registering external collection.';
const incomplete = () => new Error('The historical billing records could not be completely verified. Review the term before registration.');

/** The partition index discovers keys only. Decisions use consistent base-table
 * reads, including lines that predate the denormalized line account ID. */
async function* currentPages(partition: BillingPartition, owner: string): AsyncGenerator<Row[]> {
  const [model, field] = partition.split('.');
  const index = (JSON.parse(process.env.ACCESS_INDEXES ?? '{}') as Record<string, string>)[partition];
  if (!index) throw incomplete();
  const table = modelTable(model), cursors = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new QueryCommand({
      TableName: table, IndexName: index, KeyConditionExpression: '#owner = :owner',
      ExpressionAttributeNames: { '#owner': field }, ExpressionAttributeValues: { ':owner': owner },
      ProjectionExpression: 'id', ExclusiveStartKey: cursor, Limit: 100,
    }));
    const keys = (page.Items ?? []).map(item => {
      if (typeof item.id !== 'string' || !item.id) throw incomplete();
      return { id: item.id };
    });
    const rows = await batchGetComplete<Row>({
      send: command => db.send(command), table, keys, maxKeys: 100, attempts: 5,
      read: { ConsistentRead: true }, sizeError: incomplete, incompleteError: incomplete,
    });
    yield rows.filter(row => row[field] === owner);
    cursor = page.LastEvaluatedKey;
    if (cursor) {
      const token = JSON.stringify(cursor);
      if (cursors.has(token)) throw incomplete();
      cursors.add(token);
    }
  } while (cursor);
}

function linkedOrAmbiguous(row: Row, policy: CommissionPolicy): boolean {
  const members = Array.isArray(row.groupedPolicyIds) ? row.groupedPolicyIds : [];
  return row.policyId === policy.id || row.quoteId === policy.quoteId || members.includes(policy.id) ||
    feeAllocations(row.brokerFeeAllocations).some(a => a.quoteId === policy.quoteId || a.policyId === policy.id) ||
    (!row.policyId && !row.quoteId && !members.length);
}

async function coversPolicy(invoice: Row, policy: CommissionPolicy): Promise<boolean> {
  if (linkedOrAmbiguous(invoice, policy)) return true;
  for await (const lines of currentPages('InvoiceLine.invoiceId', invoice.id)) {
    if (lines.some(line => line.policyId === policy.id || line.brokerFeeQuoteId === policy.quoteId)) return true;
  }
  return false;
}

async function invoiceGuards(policy: CommissionPolicy): Promise<Write[]> {
  const guards = new Map<string, Write>();
  for await (const page of currentPages('Invoice.accountId', policy.accountId)) {
    for (let offset = 0; offset < page.length; offset += 5) {
      const invoices = page.slice(offset, offset + 5);
      const matches = await Promise.all(invoices.map(invoice => coversPolicy(invoice, policy)));
      invoices.forEach((invoice, index) => {
        if (!matches[index]) return;
        if (invoice.paidAt || invoice.stripePaymentIntentId) throw new Error(priorBilling);
        guards.set(invoice.id, assertPriorIpfsBilling([invoice], [])[0]);
      });
    }
  }
  return [...guards.values()];
}

async function loanGuards(policy: CommissionPolicy): Promise<Write[]> {
  const guards = new Map<string, Write>();
  for await (const page of currentPages('PfLoan.accountId', policy.accountId)) {
    for (const loan of page) if (linkedOrAmbiguous(loan, policy)) guards.set(loan.id, assertPriorIpfsBilling([], [loan])[0]);
  }
  return [...guards.values()];
}

export async function priorBillingGuards(policy: CommissionPolicy): Promise<Write[]> {
  const [invoices, loans] = await Promise.all([invoiceGuards(policy), loanGuards(policy)]);
  return [...invoices, ...loans];
}
