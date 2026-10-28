import { createHash } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AccountAccess, tableName } from '../crm-access/access';
import { activeTeamUserCheck } from '../crm-access/user-status';
import { object } from '../crm-access/policy';
import {
  packageTerms,
  type PackageQuote,
  type CommercialPlan,
} from '../../../../shared/quotePackages';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import {
  day,
  decimal,
  integer,
  required,
  MONEY_MAX,
  type CommissionPlan,
  type CarrierCommissionTerms,
  type CommissionPolicy,
} from '../../../../shared/commissions';
import { db, get, commit, table, type Data, type Transaction } from './store';
import type { Event } from './handler';

/** Financial snapshot, policy, quote status and client conversion share one
 * transaction. Retrying the same quote returns its original policy. */
export async function bindPolicy(event: Event, input: Data) {
  const access = new AccountAccess(event.identity, undefined, event.request),
    quoteId = required(input.quoteId, 'a quote');
  const quote = await access.requireRecord('Quote', quoteId),
    accountId = required(quote.accountId, 'an account');
  const account = await access.requireRecord('Account', accountId);
  const policyId = `bound-${createHash('sha256').update(quoteId).digest('hex').slice(0, 40)}`;
  const previous = await get<CommissionPolicy>('POLICY', policyId);
  if (previous) {
    const policy = await access.requireRecord('Policy', policyId);
    if (previous.accountId !== accountId || policy.accountId !== previous.accountId)
      throw new Error(
        'The quote account changed after binding. Review the original policy before continuing.',
      );
    return { policy, account, replayed: true };
  }
  if (!['DRAFT', 'SUBMITTED', 'QUOTED', 'PRESENTED'].includes(String(quote.status)))
    throw new Error('This quote is no longer open. Refresh before binding.');
  if (input.terms !== packageTerms(quote as unknown as PackageQuote))
    throw new Error('The quote changed. Refresh and confirm its exact terms.');
  if (quote.bindAuthorizedAt && quote.bindAuthorizedTerms !== authorizedQuoteTerms(quote))
    throw new Error('Renew client authorization for the changed policy terms before binding.');
  if (!['AGENCY', 'DIRECT'].includes(String(input.billType)))
    throw new Error('Choose a bill type.');
  const premiumCents = integer(
    decimal(required(input.premium, 'the exact premium')),
    1,
    MONEY_MAX,
    'premium',
  );
  const agencyRateUnits = integer(
    decimal(required(input.agencyRate, 'the agency commission percentage'), 4),
    0,
    1_000_000,
    'agency commission rate',
  );
  if (
    quote.premium == null ||
    quote.commissionPct == null ||
    premiumCents !== decimal(String(quote.premium)) ||
    agencyRateUnits !== decimal(String(quote.commissionPct), 4)
  )
    throw new Error(
      'The confirmed premium and agency rate must match the quote. Edit and review the quote first.',
    );
  const carrierId = required(quote.carrierId, 'a carrier'),
    effectiveDate = day(quote.effectiveDate),
    expirationDate = day(quote.expirationDate);
  if (
    expirationDate <= effectiveDate ||
    !Array.isArray(quote.lines) ||
    !quote.lines.filter(Boolean).length
  )
    throw new Error('Record valid policy dates and coverage lines.');
  const workflow = await access.get('Communication', `workflow:${accountId}`),
    commercial = await access.get('Communication', `commercial:${accountId}`);
  const producerId = required(object(workflow?.data).salespersonId, 'an assigned producer');
  const commercialPlan = commercial?.data as CommercialPlan | undefined;
  if (commercialPlan?.selectedOptionId && !quote.renewalPolicyId) {
    const selected = commercialPlan.options.find((o) => o.id === commercialPlan.selectedOptionId);
    if (
      !selected?.quoteIds.includes(quoteId) ||
      commercialPlan.selectedTerms?.[quoteId] !== packageTerms(quote as unknown as PackageQuote)
    )
      throw new Error('Review the client-selected package before binding.');
  }
  const plan = await get<CommissionPlan>('PLAN', producerId),
    carrierTerms = await get<CarrierCommissionTerms>('CARRIER', carrierId);
  if (!plan)
    throw new Error('An Owner must configure this producer’s commission agreement before binding.');
  if (!carrierTerms)
    throw new Error(
      'An Owner must configure this carrier’s commission payment terms before binding.',
    );
  const at = new Date().toISOString(),
    today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  const transaction = quote.renewalPolicyId ? 'RENEWAL' : 'NEW';
  if (quote.renewalPolicyId) {
    const prior = await access.requireRecord('Policy', String(quote.renewalPolicyId));
    if (prior.accountId !== accountId)
      throw new Error('The renewal must refer to a policy on this account.');
  }
  const rateDate = transaction === 'RENEWAL' ? effectiveDate : today;
  const term = plan.terms.find((t) => t.from <= rateDate && (!t.to || t.to >= rateDate));
  if (!term)
    throw new Error(`An Owner must configure a commission agreement covering ${rateDate}.`);
  // Catch pre-feature policies whose quote status was never updated. Follow all
  // pages; do not turn a filtered empty first page into permission to rebind.
  let cursor: Data | undefined;
  for (let page = 0; ; page++) {
    if (page === 100) throw new Error('Could not finish checking existing policies.');
    const found = await db.send(
      new QueryCommand({
        TableName: tableName('Policy'),
        IndexName: process.env.COMMISSION_POLICY_ACCOUNT_INDEX,
        KeyConditionExpression: 'accountId = :account',
        ExpressionAttributeValues: { ':account': accountId },
        ExclusiveStartKey: cursor,
      }),
    );
    if (found.Items?.some((p) => p.quoteId === quoteId))
      throw new Error(
        'This quote already has a policy. Review the existing policy instead of binding again.',
      );
    cursor = found.LastEvaluatedKey;
    if (!cursor) break;
  }
  const fields = [
    'carrierId',
    'lines',
    'premium',
    'commissionPct',
    'effectiveDate',
    'expirationDate',
    'glEachOccurrence',
    'glDamageToRentedPremises',
    'glMedicalExpense',
    'glPersonalAdvInjury',
    'glGeneralAggregate',
    'glProductsCompletedOps',
    'glClaimsMade',
    'glAggregateAppliesTo',
    'perOccurrenceDeductible',
    'perUnitDeductible',
    'blanketLimit',
    'coinsurancePct',
    'replacementCostType',
    'minimumEarnedPremiumPct',
  ];
  const policy = {
    commissionSnapshotId: policyId,
    ...Object.fromEntries(fields.filter((f) => quote[f] != null).map((f) => [f, quote[f]])),
    id: policyId,
    __typename: 'Policy',
    accountId,
    quoteId,
    policyNumber: typeof input.policyNumber === 'string' ? input.policyNumber.trim() : '',
    status: 'ACTIVE',
    datePolicyBound: at,
    billType: input.billType,
    createdAt: at,
    updatedAt: at,
    lastWriteBy: access.actor,
  };
  const snapshot: CommissionPolicy = {
    id: policyId,
    version: 0,
    accountId,
    accountName: String(account.name ?? accountId),
    quoteId,
    policyNumber: policy.policyNumber || policyId,
    carrierId,
    carrierName: carrierTerms.name,
    producerId,
    producerName: plan.name,
    boundAt: at,
    effectiveDate,
    expirationDate,
    transaction,
    premiumCents,
    agencyRateUnits,
    producerBps: transaction === 'NEW' ? term.newBps : term.renewalBps,
    agreement: term.agreement,
    planVersion: plan.version,
    carrierTerms,
    entries: [],
  };
  const guards: Transaction = [
    {
      Put: {
        TableName: tableName('Policy'),
        Item: policy,
        ConditionExpression: 'attribute_not_exists(id)',
      },
    },
    {
      Update: {
        TableName: tableName('Quote'),
        Key: { id: quoteId },
        UpdateExpression: 'SET #s = :bound, updatedAt = :at, lastWriteBy = :actor',
        ConditionExpression: 'updatedAt = :old AND #s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':bound': 'BOUND',
          ':at': at,
          ':actor': access.actor,
          ':old': quote.updatedAt,
          ':status': quote.status,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: table(),
        Key: { kind: 'PLAN', id: producerId },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': plan.version },
      },
    },
    {
      ConditionCheck: {
        TableName: table(),
        Key: { kind: 'CARRIER', id: carrierId },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': carrierTerms.version },
      },
    },
    activeTeamUserCheck(producerId),
  ];
  for (const [id, row] of [
    [`workflow:${accountId}`, workflow],
    [`commercial:${accountId}`, commercial],
  ] as const)
    guards.push({
      ConditionCheck: {
        TableName: tableName('Communication'),
        Key: { id },
        ConditionExpression: row ? '#d = :d' : 'attribute_not_exists(id)',
        ...(row
          ? {
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':d': row.data },
            }
          : {}),
      },
    });
  const updatedAccount =
    account.stage === 'LEAD'
      ? { ...account, stage: 'CLIENT', convertedAt: at, updatedAt: at, lastWriteBy: access.actor }
      : account;
  if (account.stage === 'LEAD')
    guards.push({
      Update: {
        TableName: tableName('Account'),
        Key: { id: accountId },
        UpdateExpression:
          'SET #s = :client, convertedAt = :at, updatedAt = :at, lastWriteBy = :actor',
        ConditionExpression: 'updatedAt = :old',
        ExpressionAttributeNames: { '#s': 'stage' },
        ExpressionAttributeValues: {
          ':client': 'CLIENT',
          ':at': at,
          ':old': account.updatedAt,
          ':actor': access.actor,
        },
      },
    });
  else
    guards.push({
      ConditionCheck: {
        TableName: tableName('Account'),
        Key: { id: accountId },
        ConditionExpression: 'updatedAt = :old',
        ExpressionAttributeValues: { ':old': account.updatedAt },
      },
    });
  await commit(
    [{ kind: 'POLICY', value: snapshot as unknown as Data & { id: string } }],
    access.actor,
    guards,
  );
  return { policy, account: updatedAccount, replayed: false };
}
