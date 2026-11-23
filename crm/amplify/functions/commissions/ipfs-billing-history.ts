import { partitionIndexPage } from '../communications/reportIndexPage';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { feeAllocations } from '../../../../shared/brokerFees';
import type { CommissionPolicy } from '../../../../shared/commissions';
import { db, modelTable, type Write } from '../broker-fees/store';
import { batchGetComplete } from '../storage/batchGet';
import { assertPriorIpfsBilling } from './ipfs-bind';

type Row = Record<string, unknown> & { id: string };
type BillingPartition = 'Invoice.accountId' | 'PfLoan.accountId';
export const priorBilling = 'This term has existing or ambiguous HOA billing or financing. Review that history before registering external collection.';
const incomplete = () => new Error('The historical billing records could not be completely verified. Review the term before registration.');

async function currentRows(table: string, candidates: Record<string, unknown>[]) {
  const keys = candidates.map(item => {
    if (typeof item.id !== 'string' || !item.id) throw incomplete();
    return { id: item.id };
  });
  return batchGetComplete<Row>({
    send: command => db.send(command), table, keys, maxKeys: 100, attempts: 5,
    read: { ConsistentRead: true }, sizeError: incomplete, incompleteError: incomplete,
  });
}

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
    const rows = await currentRows(table, page.Items ?? []);
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

async function lineLinkedInvoices(invoiceIds: string[], policy: CommissionPolicy): Promise<Set<string>> {
  const linked = new Set<string>();
  const index = (JSON.parse(process.env.ACCESS_INDEXES ?? '{}') as Record<string, string>)['InvoiceLine.invoiceId'];
  if (!index) throw incomplete();
  const table = modelTable('InvoiceLine');
  for (let offset = 0; offset < invoiceIds.length; offset += 25) {
    const values = invoiceIds.slice(offset, offset + 25), scope = new Set(values);
    let nextToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await partitionIndexPage({ table, index, partition: 'invoiceId', fields: ['id'], values, pageSize: 100, nextToken });
      for (const line of await currentRows(table, page.items)) {
        if (typeof line.invoiceId === 'string' && scope.has(line.invoiceId) &&
          (line.policyId === policy.id || line.brokerFeeQuoteId === policy.quoteId)) linked.add(line.invoiceId);
      }
      nextToken = page.nextToken;
      if (nextToken) {
        if (seen.has(nextToken)) throw incomplete();
        seen.add(nextToken);
      }
    } while (nextToken);
  }
  return linked;
}

async function invoiceGuards(policy: CommissionPolicy): Promise<Write[]> {
  const guards = new Map<string, Write>();
  for await (const page of currentPages('Invoice.accountId', policy.accountId)) {
    const matched = new Set(page.filter(invoice => linkedOrAmbiguous(invoice, policy)).map(invoice => invoice.id));
    const otherIds = page.map(invoice => invoice.id).filter(id => !matched.has(id));
    if (otherIds.length) for (const id of await lineLinkedInvoices(otherIds, policy)) matched.add(id);
    for (const invoice of page) {
      if (!matched.has(invoice.id)) continue;
      if (invoice.paidAt || invoice.stripePaymentIntentId) throw new Error(priorBilling);
      guards.set(invoice.id, assertPriorIpfsBilling([invoice], [])[0]);
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
