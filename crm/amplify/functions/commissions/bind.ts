import { agencyDay } from '../../../../shared/agencyTime';
import { getFee } from '../broker-fees/store';
import { brokerFeeCents } from '../../../../shared/brokerFees';
import { normalizeClientConditions, normalizePassThroughCharges } from '../../../../shared/passThroughCharges';
import { brokerFeeBindWrites } from '../broker-fees/bindValidation';
import { reconcileQuotePayments } from '../broker-fees/payments';
import { bindDay, firstBindDate } from './account-history';
import { createHash } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { collectCompletePages } from '../storage/pages';
import { AccountAccess, tableName } from '../crm-access/access';
import { isActiveOwner } from '../crm-access/active-role';
import { activeTeamUserCheck } from '../crm-access/user-status';
import { object } from '../api-input';
import {
  packageTerms,
  type PackageQuote,
  type CommercialPlan,
} from '../../../../shared/quotePackages';
import { authorizedQuoteTerms } from '../../../../shared/quoteAuthorization';
import {
  selectCommissionTerms,
  selectCarrierPaymentTerms,
  type CommissionAccount,
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
  const issuedRenewal = Object.hasOwn(input, 'issuedRenewalEvidence') || Object.hasOwn(input, 'carrierBillType');
  if (issuedRenewal && !isActiveOwner(event.identity, event.request))
    throw new Error('Only the active Owner can record an already-issued renewal.');
  const issuedRenewalEvidence = issuedRenewal
    ? required(input.issuedRenewalEvidence, 'the issued renewal evidence', 2000)
    : undefined;
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
    if (previous.brokerFeeCents) await reconcileQuotePayments(quoteId);
    return { policy, account, replayed: true };
  }
  if (!['DRAFT', 'SUBMITTED', 'QUOTED', 'PRESENTED'].includes(String(quote.status)))
    throw new Error('This quote is no longer open. Refresh before binding.');
  if (input.terms !== packageTerms(quote as unknown as PackageQuote))
    throw new Error('The quote changed. Refresh and confirm its exact terms.');
  if (quote.bindAuthorizedAt && quote.bindAuthorizedTerms !== authorizedQuoteTerms(quote))
    throw new Error('Renew client authorization for the changed policy terms before binding.');
  const billType = input.billType;
  if (billType !== 'AGENCY' && billType !== 'DIRECT')
    throw new Error('Choose a bill type.');
  const carrierBillType = issuedRenewal ? input.carrierBillType : billType;
  if (carrierBillType !== 'AGENCY' && carrierBillType !== 'DIRECT')
    throw new Error('Choose the carrier bill type.');
  if (issuedRenewal && quote.billType != null && quote.billType !== carrierBillType)
    throw new Error('The carrier’s billing type must match the recorded quote.');
  const fillQuoteBillType = issuedRenewal && quote.billType == null;
  if (carrierBillType !== billType && !(carrierBillType === 'DIRECT' && billType === 'AGENCY'))
    throw new Error('HOA collection can only be selected for a carrier direct-bill renewal.');
  const policyNumber = issuedRenewal
    ? required(input.policyNumber, 'the issued policy number', 128)
    : typeof input.policyNumber === 'string' ? input.policyNumber.trim() : '';
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
  const transaction = issuedRenewal || quote.renewalPolicyId ? 'RENEWAL' : 'NEW';
  if (commercialPlan?.selectedOptionId && transaction === 'NEW') {
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
    today = agencyDay(at);
  const selectedCarrierTerms = selectCarrierPaymentTerms(carrierTerms, {
    effectiveDate,
    lines: quote.lines.filter((line): line is string => typeof line === 'string'),
    billType: carrierBillType,
    transaction,
  });
  if (
    carrierTerms.arrangements?.length &&
    (input.carrierTermsVersion !== carrierTerms.version ||
      input.carrierArrangementId !== selectedCarrierTerms.payment?.id)
  )
    throw new Error('Carrier payment terms changed or were not confirmed. Review and confirm the current payment terms before binding.');
  // Freeze only the resolved contract, not every carrier arrangement. Apart
  // from being unrelated history, the full configuration can exceed item limits.
  const { arrangements: _arrangements, ...carrierSnapshotTerms } = selectedCarrierTerms;
  if (quote.renewalPolicyId) {
    const prior = await access.requireRecord('Policy', String(quote.renewalPolicyId));
    if (prior.accountId !== accountId)
      throw new Error('The renewal must refer to a policy on this account.');
  }
  const rateDate = transaction === 'RENEWAL' ? effectiveDate : today;
  const commissionAccount = await get<CommissionAccount>('ACCOUNT', accountId);
  if (issuedRenewal && commissionAccount?.neverBound)
    throw new Error('Correct the account’s original first-bind history before recording an issued renewal.');

  // Catch pre-feature policies whose quote status was never updated. Follow all
  // pages; do not turn a filtered empty first page into permission to rebind.
  let hasPolicies = false,
    earliestKnown: string | undefined;
  await collectCompletePages<never>(async cursor => {
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
    for (const priorPolicy of found.Items ?? []) {
      if (issuedRenewal && priorPolicy.carrierId === carrierId && priorPolicy.effectiveDate === effectiveDate &&
          String(priorPolicy.policyNumber ?? '').trim().toUpperCase() === policyNumber.toUpperCase())
        throw new Error('This carrier policy and term already exist. Review the existing policy.');
      hasPolicies = true;
      const bound = bindDay(priorPolicy.datePolicyBound);
      if (bound && (!earliestKnown || bound < earliestKnown)) earliestKnown = bound;
    }
    return { items: [], next: found.LastEvaluatedKey };
  }, { maxPages: 100, error: () => new Error('Could not finish checking existing policies.') });
  const accountFirstBoundOn = firstBindDate(commissionAccount, today, hasPolicies, earliestKnown);
  const selectedTerms = selectCommissionTerms(
    plan,
    commissionAccount,
    rateDate,
    transaction,
    accountFirstBoundOn,
  );
  const firstBinding = commissionAccount?.neverBound === true;
  const fields = [
    'brokerFee',
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
  const initialFee=brokerFeeCents(quote.brokerFee as number|undefined)>0?await getFee(quoteId):undefined;
  const policy = {
    commissionSnapshotId: policyId,
    ...(initialFee?{brokerFeeReportingKey:"BROKER_FEE",brokerFeeCollected:initialFee.collectedCents/100,brokerFeeRefunded:initialFee.refundedCents/100}:{}),
    ...Object.fromEntries(fields.filter((f) => quote[f] != null).map((f) => [f, quote[f]])),
    passThroughCharges: normalizePassThroughCharges(quote.passThroughCharges),
    ...(quote.clientConditions != null ? { clientConditions: normalizeClientConditions(quote.clientConditions) } : {}),
    id: policyId,
    __typename: 'Policy',
    accountId,
    quoteId,
    policyNumber,
    status: 'ACTIVE',
    ...(!issuedRenewal ? { datePolicyBound: at } : {}),
    billType,
    ...(carrierBillType !== billType ? { carrierBillType } : {}),
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
    ...(issuedRenewal ? { issuedRenewalEvidence } : { boundAt: at }),
    effectiveDate,
    expirationDate,
    transaction,
    premiumCents,
    agencyRateUnits,
    brokerFeeCents: brokerFeeCents(quote.brokerFee as number|undefined),
    ...selectedTerms,
    planVersion: plan.version,
    carrierTerms: carrierSnapshotTerms,
    entries: [],
  };
  const guards: Transaction = [
    ...await brokerFeeBindWrites(quote,policyId,billType,initialFee?.version),
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
        UpdateExpression: 'SET #s = :bound, updatedAt = :at, lastWriteBy = :actor' +
          (fillQuoteBillType ? ', #bt = :carrierBillType' : ''),
        ConditionExpression: 'updatedAt = :old AND #s = :status' +
          (fillQuoteBillType ? ' AND (attribute_not_exists(#bt) OR attribute_type(#bt, :nullType))' : ''),
        ExpressionAttributeNames: { '#s': 'status', ...(fillQuoteBillType ? { '#bt': 'billType' } : {}) },
        ExpressionAttributeValues: {
          ':bound': 'BOUND',
          ':at': at,
          ':actor': access.actor,
          ':old': quote.updatedAt,
          ':status': quote.status,
          ...(fillQuoteBillType ? { ':carrierBillType': carrierBillType, ':nullType': 'NULL' } : {}),
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
  if (!firstBinding)
    guards.push({
      ConditionCheck: {
        TableName: table(),
        Key: { kind: 'ACCOUNT', id: accountId },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': commissionAccount!.version },
      },
    });
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
      ? {
          ...account,
          stage: 'CLIENT',
          convertedAt: at,
          updatedAt: at,
          lastWriteBy: access.actor,
        }
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
    [
      { kind: 'POLICY', value: snapshot as unknown as Data & { id: string } },
      ...(firstBinding
        ? [
            {
              kind: 'ACCOUNT',
              previous: commissionAccount as unknown as Data,
              value: {
                ...commissionAccount!,
                neverBound: undefined,
                firstBoundOn: today,
                firstBindPolicyId: policyId,
              } as unknown as Data & { id: string },
            },
          ]
        : []),
    ],
    access.actor,
    guards,
  );
  if (snapshot.brokerFeeCents) {
    try { await reconcileQuotePayments(quoteId); }
    catch(error) { console.error("Broker fee allocation queued for durable recovery",error); }
  }
  return { policy, account: updatedAccount, replayed: false };
}
