import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isOpenQuoteStatus } from '../../../src/lib/quoteStatus';
import { db } from './store';
import { reportBatchGet, reportIds } from './dashboardStore';
import { reportDatePage } from './reportDatePage';
import { reportIndexPage } from './reportIndexPage';

const QUOTE_FIELDS = ['id', 'accountId', 'status'];
// Exact inputs to shared packageTerms/authorizedQuoteTerms. Keep signing
// snapshots and unrelated quote metadata out of the work-list response.
const QUOTE_TERM_FIELDS = [
  ...QUOTE_FIELDS, 'carrierId', 'premium', 'effectiveDate', 'expirationDate',
  'perOccurrenceDeductible', 'perUnitDeductible', 'blanketLimit', 'coinsurancePct',
  'replacementCostType', 'glEachOccurrence', 'glDamageToRentedPremises',
  'glMedicalExpense', 'glPersonalAdvInjury', 'glGeneralAggregate',
  'glProductsCompletedOps', 'glClaimsMade', 'glAggregateAppliesTo',
  'minimumEarnedPremiumPct', 'lines', 'commissionPct', 'offerExpiresAt',
  'renewalPolicyId', 'notes',
];
function configured(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Dashboard lead storage is not configured');
  return value;
}
function recordId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
function compactQuote(item: Record<string, unknown>) {
  // Keep unknown historical statuses visible to pipeline classification. They
  // are not open quotes, but dropping them would incorrectly mean "No quotes".
  if (!recordId(item.id) || !recordId(item.accountId) || item.status != null && typeof item.status !== 'string') {
    throw new Error('Quote states are incomplete; refresh to try again');
  }
  return { id: item.id, accountId: item.accountId, status: item.status as string | null | undefined };
}
function statusKey(value: unknown, status: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lead page token');
  const key = value as Record<string, unknown>;
  if (Object.keys(key).length !== 2 || !recordId(key.id) || key.status !== status) throw new Error('Invalid lead page token');
  return { id: key.id, status };
}

/** Caller enforces ADMIN. Discover open work from a status index, without
 * hydrating every historical quote or scanning closed work. */
export async function dashboardOpenQuotesPage(input: Record<string, unknown>) {
  const { status, nextToken } = input;
  if (typeof status !== 'string' || !isOpenQuoteStatus(status)) throw new Error('Choose an open quote status');
  let cursor: ReturnType<typeof statusKey> | undefined;
  if (nextToken != null) {
    if (typeof nextToken !== 'string' || !nextToken || nextToken.length > 4000) throw new Error('Invalid lead page token');
    try {
      const page = JSON.parse(Buffer.from(nextToken, 'base64url').toString()) as Record<string, unknown>;
      if (page.version !== 1 || page.status !== status) throw new Error();
      cursor = statusKey(page.key, status);
    } catch { throw new Error('Invalid lead page token'); }
  }
  const result = await db.send(new QueryCommand({
    TableName: configured('DASHBOARD_QUOTE_TABLE'),
    IndexName: configured('DASHBOARD_QUOTE_STATUS_INDEX'),
    KeyConditionExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status', '#id': 'id', '#account': 'accountId' },
    ExpressionAttributeValues: { ':status': status },
    ProjectionExpression: '#id, #account, #status',
    ExclusiveStartKey: cursor,
    Limit: 500,
  }));
  const items = (result.Items ?? []).map(item => {
    const quote = compactQuote(item);
    if (quote.status !== status) throw new Error('Open quote states are incomplete; refresh to try again');
    return quote;
  });
  const key = result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length ? statusKey(result.LastEvaluatedKey, status) : undefined;
  if (key && cursor?.id === key.id) throw new Error('Lead pages did not advance; refresh to try again');
  return { items, nextToken: key ? Buffer.from(JSON.stringify({ version: 1, status, key })).toString('base64url') : undefined };
}

/** Read binds by their actual bind timestamp, never by policy effective date. */
export async function dashboardBoundPoliciesPage(input: Record<string, unknown>) {
  const page = await reportDatePage({
    table: configured('DASHBOARD_POLICY_TABLE'),
    index: configured('DASHBOARD_POLICY_DATE_INDEX'),
    type: 'Policy', dateField: 'datePolicyBound', fields: ['id', 'accountId', 'datePolicyBound'],
    from: input.from, to: input.to, nextToken: input.nextToken,
  });
  return { items: page.items.map(item => {
    if (!recordId(item.id) || !recordId(item.accountId) || typeof item.datePolicyBound !== 'string' ||
      !Number.isFinite(Date.parse(item.datePolicyBound)) || new Date(item.datePolicyBound).toISOString() !== item.datePolicyBound ||
      item.datePolicyBound < String(input.from) || item.datePolicyBound > String(input.to)) {
      throw new Error('Recent policy binds are incomplete; refresh to try again');
    }
    return { id: item.id, accountId: item.accountId, datePolicyBound: item.datePolicyBound };
  }), nextToken: page.nextToken };
}

/** Compact quote states support pipeline charts. Full terms are only requested
 * for the selected salesperson's visible work list; both use the account GSI. */
export async function dashboardQuotesPage(input: Record<string, unknown>) {
  const accountIds = reportIds(input.accountIds, 25);
  if (input.details != null && typeof input.details !== 'boolean') throw new Error('Choose a valid quote detail mode');
  const page = await reportIndexPage({
    table: configured('DASHBOARD_QUOTE_TABLE'), index: configured('DASHBOARD_QUOTE_ACCOUNT_INDEX'),
    partition: 'accountId', fields: input.details === true ? QUOTE_TERM_FIELDS : QUOTE_FIELDS,
    pageSize: input.details === true ? 20 : 500,
    values: accountIds, nextToken: input.nextToken,
  });
  const requested = new Set(accountIds);
  return { items: page.items.map(item => {
    const quote = compactQuote(item);
    if (!requested.has(quote.accountId)) throw new Error('Quote details are outside the requested accounts');
    return input.details === true ? Object.fromEntries(QUOTE_TERM_FIELDS.filter(field => field in item).map(field => [field, item[field]])) : quote;
  }), nextToken: page.nextToken };
}

/** A selected package can reference a removed quote. Return missing IDs
 * explicitly, and never mistake an unprocessed/throttled key for removal. */
export async function dashboardQuoteStates(input: Record<string, unknown>) {
  const ids = reportIds(input.quoteIds);
  if (!ids.length) return { items: [], missingIds: [] };
  const found = await reportBatchGet(configured('DASHBOARD_QUOTE_TABLE'), ids, ['accountId', 'status']);
  return {
    items: ids.flatMap(id => {
      const item = found.get(id);
      return item ? [compactQuote(item)] : [];
    }),
    missingIds: ids.filter(id => !found.has(id)),
  };
}
