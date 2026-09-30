// @vitest-environment node
import { QueryCommand, BatchGetCommand, ExecuteStatementCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { packageTerms } from '../../../shared/quotePackages';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../amplify/functions/communications/store', () => ({ db: { send } }));
import {
  dashboardBoundPoliciesPage, dashboardOpenQuotesPage,
  dashboardQuotesPage, dashboardQuoteStates,
} from '../../amplify/functions/communications/dashboardLeadQueries';

const from = '2026-08-31T16:00:00.000Z', to = '2026-09-30T16:00:00.000Z';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
beforeEach(() => {
  send.mockReset();
  vi.stubEnv('DASHBOARD_QUOTE_TABLE', 'quotes');
  vi.stubEnv('DASHBOARD_QUOTE_STATUS_INDEX', 'quotes-by-status');
  vi.stubEnv('DASHBOARD_QUOTE_ACCOUNT_INDEX', 'crmBy_accountId');
  vi.stubEnv('DASHBOARD_POLICY_TABLE', 'policies');
  vi.stubEnv('DASHBOARD_POLICY_DATE_INDEX', 'policies-by-bind-date');
});

describe('open quote discovery', () => {
  it.each(['DRAFT', 'SUBMITTED', 'QUOTED', 'PRESENTED'])('queries one projected %s page and resumes only that status', async status => {
    const key = { id: 'q1', status };
    send.mockResolvedValueOnce({ Items: [{ ...key, accountId: 'a1', notes: 'not needed' }], LastEvaluatedKey: key });
    const first = await dashboardOpenQuotesPage({ status });
    expect(first.items).toEqual([{ id: 'q1', accountId: 'a1', status }]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: 'quotes', IndexName: 'quotes-by-status', Limit: 500,
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status', '#id': 'id', '#account': 'accountId' },
      ExpressionAttributeValues: { ':status': status },
      ProjectionExpression: '#id, #account, #status', ExclusiveStartKey: undefined,
    });
    send.mockResolvedValueOnce({ Items: [{ id: 'q2', accountId: 'a2', status }] });
    expect((await dashboardOpenQuotesPage({ status, nextToken: first.nextToken })).nextToken).toBeUndefined();
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(key);
    await expect(dashboardOpenQuotesPage({ status: status === 'DRAFT' ? 'SUBMITTED' : 'DRAFT', nextToken: first.nextToken })).rejects.toThrow('page token');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects closed statuses and malformed/cross-status keys before reading', async () => {
    for (const status of ['BOUND', 'DECLINED', 'LOST', '', null, ['DRAFT']]) {
      await expect(dashboardOpenQuotesPage({ status })).rejects.toThrow('open quote status');
    }
    for (const nextToken of ['', 'not-json', encode(null), encode({ version: 1, status: 'DRAFT', key: { id: 'q', status: 'BOUND' } }),
      encode({ version: 1, status: 'DRAFT', key: { id: 'q', status: 'DRAFT', accountId: 'other' } })]) {
      await expect(dashboardOpenQuotesPage({ status: 'DRAFT', nextToken })).rejects.toThrow('page token');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('treats an empty last evaluated key as the terminal page', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: 'q', accountId: 'a', status: 'DRAFT' }], LastEvaluatedKey: {} });
    expect(await dashboardOpenQuotesPage({ status: 'DRAFT' })).toEqual({
      items: [{ id: 'q', accountId: 'a', status: 'DRAFT' }], nextToken: undefined,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails incomplete, mismatched, or nonadvancing pages and propagates unavailable indexes', async () => {
    send.mockResolvedValueOnce({ Items: [{ id: 'q', accountId: 'a', status: 'BOUND' }] });
    await expect(dashboardOpenQuotesPage({ status: 'DRAFT' })).rejects.toThrow('incomplete');
    send.mockResolvedValueOnce({ Items: [{ id: 'q', status: 'DRAFT' }] });
    await expect(dashboardOpenQuotesPage({ status: 'DRAFT' })).rejects.toThrow('incomplete');
    const key = { id: 'q', status: 'DRAFT' };
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: key });
    await expect(dashboardOpenQuotesPage({ status: 'DRAFT', nextToken: encode({ version: 1, status: 'DRAFT', key }) })).rejects.toThrow('did not advance');
    send.mockRejectedValueOnce(new Error('Index unavailable'));
    await expect(dashboardOpenQuotesPage({ status: 'DRAFT' })).rejects.toThrow('Index unavailable');
    expect(send).toHaveBeenCalledTimes(4);
  });
});

describe('recent bound policies', () => {
  it('uses the shared date index window and returns only actual bind attribution', async () => {
    const key = { id: 'p1', __typename: 'Policy', datePolicyBound: from };
    send.mockResolvedValueOnce({ Items: [{ ...key, accountId: 'a', premium: 1000, effectiveDate: '2026-10-01' }], LastEvaluatedKey: key });
    const first = await dashboardBoundPoliciesPage({ from, to });
    expect(first.items).toEqual([{ id: 'p1', accountId: 'a', datePolicyBound: from }]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: 'policies', IndexName: 'policies-by-bind-date', Limit: 500,
      KeyConditionExpression: '#type = :type AND #date BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':type': 'Policy', ':from': from, ':to': to },
    });
    send.mockResolvedValueOnce({ Items: [{ id: 'p2', accountId: 'b', datePolicyBound: to }] });
    await dashboardBoundPoliciesPage({ from, to, nextToken: first.nextToken });
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(key);
    await expect(dashboardBoundPoliciesPage({ from: '2026-09-01T16:00:00.000Z', to, nextToken: first.nextToken })).rejects.toThrow('page token');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects unbounded/noncanonical windows, wrong model cursors and out-of-window/undated rows', async () => {
    for (const input of [
      { from: '2026-01-01T00:00:00.000Z', to }, { from: to, to: from },
      { from: '2026-09-01T00:00:00Z', to },
      { from, to, nextToken: encode({ version: 1, type: 'PfLoanPayment', dateField: 'datePolicyBound', from, to, key: { id: 'p', __typename: 'Policy', datePolicyBound: from } }) },
    ]) await expect(dashboardBoundPoliciesPage(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    for (const row of [
      { id: 'p', accountId: 'a' },
      { id: 'p', accountId: 'a', datePolicyBound: '2026-08-30T16:00:00.000Z' },
      { id: 'p', datePolicyBound: from },
    ]) {
      send.mockResolvedValueOnce({ Items: [row] });
      await expect(dashboardBoundPoliciesPage({ from, to })).rejects.toThrow('incomplete');
    }
  });
});

describe('scoped quote terms and states', () => {
  it('reads a compact page from several account partitions, retaining unknown legacy statuses', async () => {
    send.mockResolvedValueOnce({ Items: [
      { id: 'q1', accountId: 'a1', status: 'BOUND', premium: 1000 },
      { id: 'q2', accountId: 'a2', status: null },
      { id: 'q3', accountId: 'a2', status: 'LEGACY' },
    ], NextToken: 'next' });
    const page = await dashboardQuotesPage({ accountIds: ['a2', 'a1'] });
    expect(page.items).toEqual([
      { id: 'q1', accountId: 'a1', status: 'BOUND' },
      { id: 'q2', accountId: 'a2', status: null },
      { id: 'q3', accountId: 'a2', status: 'LEGACY' },
    ]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ExecuteStatementCommand);
    expect(send.mock.calls[0][0].input).toEqual({
      Statement: 'SELECT "accountId", "id", "status" FROM "quotes"."crmBy_accountId" WHERE "accountId" IN [?, ?]',
      Parameters: ['a1', 'a2'], Limit: 500,
    });
    await expect(dashboardQuotesPage({ accountIds: ['a1', 'a2'], details: true, nextToken: page.nextToken })).rejects.toThrow('page token');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('projects every package assessment input while excluding signed snapshots and unrelated fields', async () => {
    const quote = {
      id: 'q1', accountId: 'a1', status: 'QUOTED', carrierId: 'carrier', premium: 800,
      effectiveDate: '2026-10-01', expirationDate: '2027-10-01', perOccurrenceDeductible: 1,
      perUnitDeductible: 2, blanketLimit: 3, coinsurancePct: 4, replacementCostType: 'RC',
      glEachOccurrence: 5, glDamageToRentedPremises: 6, glMedicalExpense: 7, glPersonalAdvInjury: 8,
      glGeneralAggregate: 9, glProductsCompletedOps: 10, glClaimsMade: true, glAggregateAppliesTo: 'POLICY',
      minimumEarnedPremiumPct: 11, lines: ['Property'], commissionPct: 12,
      offerExpiresAt: '2026-10-01', renewalPolicyId: 'p1', notes: 'Quote note',
      bindAuthorizedTerms: 'Large signed snapshot', lastWriteBy: 'private-user',
    };
    send.mockImplementation(async command => {
      const projection = command.input.Statement.split(' FROM ')[0].replace('SELECT ', '').split(', ').map((field: string) => JSON.parse(field));
      return { Items: [Object.fromEntries(projection.map((field: string) => [field, quote[field as keyof typeof quote]]))] };
    });
    const page = await dashboardQuotesPage({ accountIds: ['a1'], details: true });
    expect(packageTerms(page.items[0] as typeof quote)).toBe(packageTerms(quote));
    expect(page.items[0]).not.toHaveProperty('bindAuthorizedTerms');
    expect(page.items[0]).not.toHaveProperty('lastWriteBy');
    expect(send.mock.calls[0][0].input.Limit).toBe(20);
  });

  it('rejects too many accounts, invalid detail flags and records outside the requested accounts', async () => {
    await expect(dashboardQuotesPage({ accountIds: Array.from({ length: 26 }, (_, i) => `a${i}`) })).rejects.toThrow('25');
    await expect(dashboardQuotesPage({ accountIds: ['a1'], details: 'true' })).rejects.toThrow('detail mode');
    expect(send).not.toHaveBeenCalled();
    for (const details of [false, true]) {
      send.mockResolvedValueOnce({ Items: [{ id: 'q', accountId: 'other', status: 'BOUND' }] });
      await expect(dashboardQuotesPage({ accountIds: ['a1'], details })).rejects.toThrow('outside');
    }
  });

  it('retries unprocessed quote states, preserves requested order and reports genuine missing IDs', async () => {
    send.mockResolvedValueOnce({ Responses: { quotes: [{ id: 'q2', accountId: 'a', status: 'BOUND', notes: 'not needed' }] }, UnprocessedKeys: { quotes: { Keys: [{ id: 'q1' }] } } })
      .mockResolvedValueOnce({ Responses: { quotes: [{ id: 'q1', accountId: 'a', status: 'PRESENTED' }] } });
    expect(await dashboardQuoteStates({ quoteIds: ['q1', 'q2', 'missing', 'q1'] })).toEqual({
      items: [{ id: 'q1', accountId: 'a', status: 'PRESENTED' }, { id: 'q2', accountId: 'a', status: 'BOUND' }], missingIds: ['missing'],
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(BatchGetCommand);
    expect(send.mock.calls[0][0].input.RequestItems.quotes).toEqual({
      Keys: [{ id: 'q1' }, { id: 'q2' }, { id: 'missing' }], ConsistentRead: true,
      ProjectionExpression: '#f0, #f1, #f2', ExpressionAttributeNames: { '#f0': 'id', '#f1': 'accountId', '#f2': 'status' },
    });
    expect(send.mock.calls[1][0].input.RequestItems.quotes.Keys).toEqual([{ id: 'q1' }]);
  });

  it('bounds quote batches and never classifies exhausted or malformed reads as missing', async () => {
    await expect(dashboardQuoteStates({ quoteIds: Array.from({ length: 501 }, (_, i) => `q${i}`) })).rejects.toThrow('500');
    expect(await dashboardQuoteStates({ quoteIds: [] })).toEqual({ items: [], missingIds: [] });
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ Responses: { quotes: [{ id: 'q1', status: 'BOUND' }] } });
    await expect(dashboardQuoteStates({ quoteIds: ['q1'] })).rejects.toThrow('incomplete');
    send.mockResolvedValue({ UnprocessedKeys: { quotes: { Keys: [{ id: 'q1' }] } } });
    await expect(dashboardQuoteStates({ quoteIds: ['q1'] })).rejects.toThrow('incomplete');
    expect(send).toHaveBeenCalledTimes(5);
  });
});
