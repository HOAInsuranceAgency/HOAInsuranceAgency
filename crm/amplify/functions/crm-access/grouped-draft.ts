import { randomUUID } from 'node:crypto';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { agencyDay } from '../../../../shared/agencyTime';
import { isGroupedInvoice } from '../../../../shared/groupedInvoiceGuard';
import { normalizePassThroughCharges } from '../../../../shared/passThroughCharges';
import { isRealIsoDay } from '../../../../shared/premiumFinance/noticeSequence';
import { accountModels, db, modelTable, type Write } from '../broker-fees/store';
import { reserveNextInvoiceNumber } from '../invoice-number/handler';
import { sendCrmWrite } from '../live-write';
import { validateInvoiceSourceCharges } from '../send-invoice/passThroughInvoice';
import { parseAccessIndexes, resolveAccessIndex } from '../storage/index-config';
import { collectCompletePages } from '../storage/pages';
import { assertTransactionEnvelope } from '../storage/transactions';
import type { AccountAccess } from './access';
import { id, type RecordData as Row } from './policy';
import { activeTeamUserCheck } from './user-status';

type ReviewLine = {
  policyId: string;
  kind: string;
  description: string;
  retailAmount: number;
  costAmount: number;
  sourceQuoteChargeId?: string;
};

const MAX_LINES = 38;
const MAX_MEMBERS = 8;
const retry = 'The source records changed while combining them. Refresh and review the drafts.';
const hasDelivery = (row: Row) => ['sentAt', 'paidAt', 'paymentUrl', 'stripePaymentLinkId', 'stripePaymentIntentId',
  'stripeLinkAmountCents', 'invoiceSendOperation', 'brokerFeeAllocations', 'brokerFeeFinanceUrl']
  .some(key => row[key] != null && row[key] !== '');
const isAdvance = (row: Row) => row.carrierBillType === 'DIRECT';
const reviewDay = (value: unknown): value is string => typeof value === 'string' && isRealIsoDay(value);
const usableId = (value: unknown) => { const key = id(value); if (!key) throw new Error(retry); return key; };
const wholeCents = (amount: unknown) => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 &&
  Number.isSafeInteger(Math.round(amount * 100)) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

/** A review amount is copied from the reviewed supplier lines, not inferred from commission. */
export function groupedReviewLines(policy: Row, draft: Row | undefined, lines: Row[]): ReviewLine[] {
  const policyId = usableId(policy.id);
  if (isAdvance(policy)) {
    if (draft || lines.length || normalizePassThroughCharges(policy.passThroughCharges).length) throw new Error('Review the existing carrier charges before adding this direct-bill advance.');
    if (!wholeCents(policy.premium) || !(Number(policy.premium) > 0) || !id(policy.policyNumber)) throw new Error('Record the carrier policy number and verified gross premium first.');
    return [{ policyId, kind: 'PREMIUM', description: `${policy.policyNumber} — ${(policy.lines as string[]).join(', ')} (HOA collection)`,
      retailAmount: Number(policy.premium), costAmount: Number(policy.premium) }];
  }
  if (!draft || !lines.length) throw new Error('Prepare a reviewed, unsent invoice for each agency-billed policy first.');
  if (draft.status !== 'DRAFT' || draft.sourcePricingVersion !== 1 || draft.policyId !== policyId ||
      draft.accountId !== policy.accountId || hasDelivery(draft) || draft.adjustsInvoiceId || draft.adjustsPremiumLineId) {
    throw new Error('Only unsent original policy drafts can be combined.');
  }
  const checked = lines.map(line => {
    if (line.accountId !== policy.accountId || line.invoiceId !== draft.id || line.policyId !== policyId ||
        line.brokerFeeQuoteId || line.kind === 'BROKER_FEE' || !wholeCents(line.retailAmount) || !wholeCents(line.costAmount) ||
        typeof line.description !== 'string' || !line.description.trim() || line.description.length > 160 || /[\x00-\x1f\x7f]/.test(line.description)) {
      throw new Error('Review the policy draft’s source, amounts, and supplier costs before combining.');
    }
    return { policyId, kind: String(line.kind), description: line.description, retailAmount: Number(line.retailAmount),
      costAmount: Number(line.costAmount), ...(id(line.sourceQuoteChargeId) ? { sourceQuoteChargeId: id(line.sourceQuoteChargeId) } : {}) };
  });
  validateInvoiceSourceCharges({
    invoice: { accountId: String(policy.accountId), policyId, sourcePricingVersion: 1 },
    source: { id: policyId, accountId: String(policy.accountId), billType: 'AGENCY', premium: Number(policy.premium), passThroughCharges: policy.passThroughCharges },
    lines: checked.map(line => ({ ...line, accountId: String(policy.accountId) })),
  });
  return checked;
}

async function currentLines(access: AccountAccess, invoiceId: string) {
  const error = () => new Error('The invoice lines could not be verified completely.');
  const index = resolveAccessIndex(parseAccessIndexes(process.env.ACCESS_INDEXES, error), 'InvoiceLine.invoiceId', { error });
  const keys = await collectCompletePages<string>(async cursor => {
    const result = await db.send(new QueryCommand({ TableName: modelTable('InvoiceLine'), IndexName: index,
      KeyConditionExpression: 'invoiceId = :invoice', ExpressionAttributeValues: { ':invoice': invoiceId },
      ProjectionExpression: 'id', ExclusiveStartKey: cursor }));
    return { items: (result.Items ?? []).map(row => usableId(row.id)), next: result.LastEvaluatedKey };
  }, { maxPages: 10, maxRows: 100, error });
  await access.prefetch('InvoiceLine', keys);
  const rows = await Promise.all(keys.map(key => access.get('InvoiceLine', key)));
  if (rows.some(row => !row || row.invoiceId !== invoiceId)) throw error();
  return (rows as Row[]).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
}

function versionCondition(row: Row) {
  if (typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error(retry);
  return { Key: { id: usableId(row.id) }, ConditionExpression: 'updatedAt = :old', ExpressionAttributeValues: { ':old': row.updatedAt } };
}

const check = (model: string, row: Row): Write => ({ ConditionCheck: { TableName: modelTable(model), ...versionCondition(row) } });

async function saveReview(writes: Write[]) {
  assertTransactionEnvelope(writes, { maxBytes: 3_500_000, keyFields: () => ['id'], error: () => new Error('Too many source records to combine at once.') });
  try { await sendCrmWrite(db.send(new TransactWriteCommand({ TransactItems: writes }))); }
  catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') throw new Error(retry);
    throw error;
  }
}

export async function createGroupedDraft(access: AccountAccess, args: Row) {
  const accountId = usableId(args.accountId);
  const policyIds = Array.isArray(args.policyIds) ? args.policyIds.map(usableId).sort() : [];
  if (policyIds.length < 2 || policyIds.length > MAX_MEMBERS || new Set(policyIds).size !== policyIds.length) {
    throw new Error('Choose two to eight different policies.');
  }
  const account = await access.requireRecord('Account', accountId);
  const policies = await Promise.all(policyIds.map(key => access.requireRecord('Policy', key)));
  const now = new Date().toISOString();
  const today = agencyDay(now);
  if (policies.some(row => row.accountId !== accountId || row.status !== 'ACTIVE' || row.billType !== 'AGENCY' ||
      !reviewDay(row.effectiveDate) || !reviewDay(row.expirationDate) || row.expirationDate <= row.effectiveDate || row.expirationDate <= today ||
      !Array.isArray(row.lines) || !row.lines.length || row.lines.some(line => typeof line !== 'string' || !line.trim()) ||
      Number(row.brokerFee ?? 0) !== 0 || Number(row.brokerFeeCollected ?? 0) !== 0)) {
    throw new Error('Choose active, agency-collected policies with valid terms and no HOA broker fee.');
  }
  if (new Set(policies.map(row => `${row.effectiveDate}/${row.expirationDate}`)).size !== 1) throw new Error('The policies must have the same coverage term.');
  const owners = [...new Set(policies.map(row => id(row.groupedDraftInvoiceId)).filter(Boolean))];
  for (const owner of owners) {
    const group = await access.get('Invoice', owner);
    if (!group || group.accountId !== accountId || !isGroupedInvoice(group)) throw new Error('The existing grouped invoice could not be verified.');
    if (group.status === 'VOID') continue;
    if (group.status === 'DRAFT' && Array.isArray(group.groupedPolicyIds) && policies.every(row => row.groupedDraftInvoiceId === owner) &&
        JSON.stringify([...group.groupedPolicyIds].sort()) === JSON.stringify(policyIds)) return { ok: true, invoiceId: owner };
    throw new Error('A selected policy already belongs to a grouped invoice.');
  }

  // Include quote pointers as well as index-discovered rows so a pre-bind send
  // or loan is still visible while its index entry catches up.
  const quoteIds = [...new Set(policies.map(row => id(row.quoteId)).filter(Boolean))];
  const quotes = await Promise.all(quoteIds.map(key => access.requireRecord('Quote', key)));
  if (quotes.some(row => row.accountId !== accountId)) throw new Error(retry);
  const [invoiceCandidates, loanCandidates] = await Promise.all([
    accountModels<Row>('Invoice', accountId), accountModels<Row>('PfLoan', accountId),
  ]);
  const relevant = (row: Row) => policyIds.includes(id(row.policyId)) || quoteIds.includes(id(row.quoteId)) ||
    Array.isArray(row.groupedPolicyIds) && row.groupedPolicyIds.some(value => policyIds.includes(id(value)));
  const loanIds = [...new Set([...loanCandidates.filter(relevant).map(row => usableId(row.id)),
    ...quotes.flatMap(row => row.sourcePricingLoanId == null ? [] : [usableId(row.sourcePricingLoanId)])])];
  const invoiceIds = [...new Set([...invoiceCandidates.filter(row => relevant(row) || !row.policyId && !row.quoteId && !isGroupedInvoice(row)).map(row => usableId(row.id)),
    ...quotes.flatMap(row => row.sourcePricingInvoiceId == null ? [] : [usableId(row.sourcePricingInvoiceId)])])];
  if (invoiceIds.length + loanIds.length > 100) throw new Error('Too much billing history to combine these policies safely.');
  await Promise.all([access.prefetch('Invoice', invoiceIds), access.prefetch('PfLoan', loanIds)]);
  for (const key of loanIds) {
    const loan = await access.get('PfLoan', key);
    if (!loan || loan.accountId !== accountId || loan.status !== 'CANCELLED' || loan.agreementSignedAt || loan.electedAt || loan.downPaidAt || loan.downPaymentIntentId || loan.electionCheckoutUrl) {
      throw new Error('A selected policy has existing financing that must be reviewed first.');
    }
  }
  const sources = new Map<string, { invoice: Row; lines: Row[] }>();
  for (const key of invoiceIds) {
    const invoice = await access.get('Invoice', key);
    if (!invoice || invoice.accountId !== accountId) throw new Error(retry);
    if (invoice.status === 'VOID') {
      if (relevant(invoice) && hasDelivery(invoice)) throw new Error('A selected policy has an issued invoice that must be reviewed first.');
      continue;
    }
    const lines = await currentLines(access, key);
    if (!relevant(invoice) && !lines.some(line => policyIds.includes(id(line.policyId)))) continue;
    const policyId = id(invoice.policyId);
    if (!policyIds.includes(policyId) || sources.has(policyId) || invoice.status !== 'DRAFT' || hasDelivery(invoice) || isGroupedInvoice(invoice)) {
      throw new Error('A selected policy already has billing that cannot be combined.');
    }
    sources.set(policyId, { invoice, lines });
  }
  const lines = policies.flatMap(policy => {
    const source = sources.get(String(policy.id));
    return groupedReviewLines(policy, source?.invoice, source?.lines ?? []);
  });
  const sourceLineCount = [...sources.values()].reduce((count, source) => count + source.lines.length, 0);
  if (!lines.length || lines.length > MAX_LINES || 3 + quotes.length + policies.length + sources.size + sourceLineCount + lines.length > 100) {
    throw new Error('Too many invoice lines to combine in one review.');
  }

  const { invoiceNumber: number } = await reserveNextInvoiceNumber();
  const invoiceId = randomUUID();
  const dueAt = [...sources.values()].map(({ invoice }) => invoice.dueAt).filter(reviewDay).sort()[0] ?? today;
  const base = { accountId, lastWriteBy: access.actor, updatedAt: now };
  const writes: Write[] = [activeTeamUserCheck(access.actor), check('Account', account), ...quotes.map(row => check('Quote', row)),
    { Put: { TableName: modelTable('Invoice'), ConditionExpression: 'attribute_not_exists(id)', Item: {
      ...base, id: invoiceId, __typename: 'Invoice', number, sourcePricingVersion: 3, groupedPolicyIds: policyIds,
      groupedSourceInvoiceIds: [...sources.values()].map(({ invoice }) => usableId(invoice.id)),
      status: 'DRAFT', issuedAt: today, dueAt, createdAt: now,
    } } }];
  for (const policy of policies) {
    const guard = versionCondition(policy);
    const previous = id(policy.groupedDraftInvoiceId);
    writes.push({ Update: { TableName: modelTable('Policy'), ...guard,
      ConditionExpression: guard.ConditionExpression + (previous ? ' AND groupedDraftInvoiceId = :previous' : ' AND attribute_not_exists(groupedDraftInvoiceId)'),
      UpdateExpression: 'SET groupedDraftInvoiceId = :draft, updatedAt = :now, lastWriteBy = :actor',
      ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ...(previous ? { ':previous': previous } : {}),
        ':draft': invoiceId, ':now': now, ':actor': access.actor },
    } });
  }
  for (const { invoice, lines: sourceLines } of sources.values()) {
    const guard = versionCondition(invoice);
    writes.push({ Update: { TableName: modelTable('Invoice'), ...guard,
      ConditionExpression: `${guard.ConditionExpression} AND #status = :draft AND attribute_not_exists(invoiceSendOperation)`,
      UpdateExpression: 'SET #status = :void, updatedAt = :now, lastWriteBy = :actor, supersededByGroupedInvoiceId = :replacement', ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ':draft': 'DRAFT', ':void': 'VOID', ':now': now, ':actor': access.actor, ':replacement': invoiceId },
    } });
    writes.push(...sourceLines.map(row => check('InvoiceLine', row)));
  }
  writes.push(...lines.map((line, sortOrder): Write => ({ Put: { TableName: modelTable('InvoiceLine'),
    ConditionExpression: 'attribute_not_exists(id)', Item: { ...line, id: `${invoiceId}:${sortOrder}`, invoiceId, accountId,
      __typename: 'InvoiceLine', sortOrder, createdAt: now, updatedAt: now, updatedBy: access.actor },
  } })));
  await saveReview(writes);
  return { ok: true, invoiceId };
}

/** Undo a review without deleting any policy or invoice history. */
export async function restoreGroupedDraft(access: AccountAccess, args: Row) {
  const invoiceId = usableId(args.invoiceId);
  const invoice = await access.requireRecord('Invoice', invoiceId);
  const policyIds = Array.isArray(invoice.groupedPolicyIds) ? invoice.groupedPolicyIds.map(usableId) : [];
  const sourceIds = Array.isArray(invoice.groupedSourceInvoiceIds) ? invoice.groupedSourceInvoiceIds.map(usableId) : null;
  if (invoice.sourcePricingVersion !== 3 || hasDelivery(invoice) || policyIds.length < 2 || policyIds.length > MAX_MEMBERS ||
      new Set(policyIds).size !== policyIds.length || !sourceIds || sourceIds.length > policyIds.length || new Set(sourceIds).size !== sourceIds.length || sourceIds.includes(invoiceId)) {
    throw new Error('Only a complete, unsent grouped review can be restored.');
  }
  if (invoice.status === 'VOID' && invoice.groupedRestoredAt) return { ok: true };
  if (invoice.status !== 'DRAFT') throw new Error('Only a grouped draft can be restored.');
  const accountId = usableId(invoice.accountId);
  const [policies, sources] = await Promise.all([
    Promise.all(policyIds.map(key => access.requireRecord('Policy', key))),
    Promise.all(sourceIds.map(key => access.requireRecord('Invoice', key))),
  ]);
  if (policies.some(policy => policy.accountId !== accountId || policy.groupedDraftInvoiceId !== invoiceId) ||
      sources.some(source => source.accountId !== accountId || !policyIds.includes(id(source.policyId)) ||
        source.sourcePricingVersion !== 1 || source.status !== 'VOID' || source.supersededByGroupedInvoiceId !== invoiceId || hasDelivery(source))) {
    throw new Error('The separate drafts no longer match this grouped review.');
  }
  const now = new Date().toISOString();
  const guard = versionCondition(invoice);
  const writes: Write[] = [activeTeamUserCheck(access.actor), { Update: { TableName: modelTable('Invoice'), ...guard,
    ConditionExpression: `${guard.ConditionExpression} AND #status = :draft`,
    UpdateExpression: 'SET #status = :void, groupedRestoredAt = :now, updatedAt = :now, lastWriteBy = :actor',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ...guard.ExpressionAttributeValues, ':draft': 'DRAFT', ':void': 'VOID', ':now': now, ':actor': access.actor },
  } }];
  for (const source of sources) {
    const version = versionCondition(source);
    writes.push({ Update: { TableName: modelTable('Invoice'), ...version,
      ConditionExpression: `${version.ConditionExpression} AND #status = :void AND supersededByGroupedInvoiceId = :group`,
      UpdateExpression: 'SET #status = :draft, updatedAt = :now, lastWriteBy = :actor REMOVE supersededByGroupedInvoiceId',
      ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ...version.ExpressionAttributeValues,
        ':void': 'VOID', ':group': invoiceId, ':draft': 'DRAFT', ':now': now, ':actor': access.actor },
    } });
  }
  for (const policy of policies) {
    const version = versionCondition(policy);
    writes.push({ Update: { TableName: modelTable('Policy'), ...version,
      ConditionExpression: `${version.ConditionExpression} AND groupedDraftInvoiceId = :group`,
      UpdateExpression: 'SET updatedAt = :now, lastWriteBy = :actor REMOVE groupedDraftInvoiceId',
      ExpressionAttributeValues: { ...version.ExpressionAttributeValues, ':group': invoiceId, ':now': now, ':actor': access.actor },
    } });
  }
  await saveReview(writes);
  return { ok: true };
}
