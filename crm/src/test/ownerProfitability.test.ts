import { beforeEach, expect, it, vi } from 'vitest';
import type { EmployeeCompensation } from '../../../shared/employeeProfitability';

const h = vi.hoisted(() => ({ send: vi.fn(), batchGet: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({
  ...await original<typeof import('@aws-sdk/lib-dynamodb')>(),
  DynamoDBDocumentClient: { from: () => ({ send: h.send }) },
}));
vi.mock('../../amplify/functions/communications/dashboardStore', () => ({ reportBatchGet: h.batchGet }));
import { createHandler, repository } from '../../amplify/functions/owner-profitability/handler';

const pay: EmployeeCompensation = { userId: 'employee-1', version: 2, terms: [{ from: '2026-01-01', annualSalaryCents: 3_650_000, producerShareBps: 2500 }] };
const source = () => ({
  employees: [{ userId: 'employee-1', name: 'Salesperson', salesperson: true }, { userId: 'office', name: 'Office employee', salesperson: false }],
  compensations: { 'employee-1': pay },
  policies: [{ id: 'policy-1', accountId: 'account-1', premium: 10000, commissionPct: 10, status: 'ACTIVE', effectiveDate: '2026-01-12' }],
  assignments: { 'account-1': { salespersonId: 'employee-1' } },
});
const request = (fieldName = 'ownerProfitability', args: Record<string, unknown> = { from: '2026-01-01', to: '2026-01-31' }) => ({
  fieldName, identity: { sub: 'owner-1', groups: ['OWNER'] }, request: { headers: { 'x-crm-role': 'OWNER' } }, arguments: args,
});
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ['OWNER_COMPENSATION_TABLE', 'POLICY_TABLE', 'USER_PROFILE_TABLE', 'COMMUNICATION_TABLE']) vi.stubEnv(key, key);
});

it.each([
  ['ADMIN', 'ADMIN'], ['PRODUCER', 'PRODUCER'], ['STAFF', 'STAFF'], ['ADMIN', 'OWNER'],
])('rejects %s in the %s view before reading or writing pay data', async (group, view) => {
  const store = { read: vi.fn(), save: vi.fn() }, handler = createHandler(store);
  for (const field of ['ownerProfitability', 'saveEmployeeCompensation']) {
    const event = request(field);
    event.identity.groups = [group]; event.request.headers['x-crm-role'] = view;
    expect(await handler(event)).toMatchObject({ ok: false });
  }
  expect(store.read).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
});
it('does not expose salary data to an Owner using a separately assigned Admin view', async () => {
  const store = { read: vi.fn(), save: vi.fn() }, event = request();
  event.identity.groups = ['OWNER', 'ADMIN']; event.request.headers['x-crm-role'] = 'ADMIN';
  expect(await createHandler(store)(event)).toMatchObject({ ok: false });
  expect(store.read).not.toHaveBeenCalled();
});
it.each([undefined, { accountId: 'aws-account', userArn: 'arn:aws:iam::account:role/role' }, { sub: 'user', groups: [] }, { groups: ['OWNER'] }, { sub: ' ', groups: ['OWNER'] }])(
  'rejects absent, IAM, or incomplete identities before accessing private data', async identity => {
    const store = { read: vi.fn(), save: vi.fn() }, handler = createHandler(store);
    for (const fieldName of ['ownerProfitability', 'saveEmployeeCompensation']) {
      expect(await handler({ ...request(fieldName), identity })).toMatchObject({ ok: false });
    }
    expect(store.read).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  },
);
it('returns estimated agency contribution and the complete roster for private pay setup', async () => {
  const result = await createHandler({ read: async () => source(), save: vi.fn() })(request());
  expect(result).toMatchObject({ ok: true, employees: [{ userId: 'employee-1' }, { userId: 'office' }], report: {
    rows: [{ userId: 'employee-1', grossCommissionCents: 100000, producerShareCents: 25000, netRevenueCents: 75000, salaryCents: 310000, contributionCents: -235000 }],
  } });
});
it('rejects invalid windows before reading any source tables', async () => {
  const store = { read: vi.fn(), save: vi.fn() };
  expect(await createHandler(store)(request('ownerProfitability', { from: '2026-03-01', to: '2026-02-30' }))).toMatchObject({ ok: false });
  expect(store.read).not.toHaveBeenCalled();
});
it('retains unrostered policy owners as incomplete instead of dropping their agency revenue', async () => {
  const data = source(); data.assignments['account-1'].salespersonId = 'former-employee';
  const result = await createHandler({ read: async () => data, save: vi.fn() })(request());
  expect(result).toMatchObject({ ok: true, report: {
    rows: expect.arrayContaining([expect.objectContaining({ userId: 'former-employee', grossCommissionCents: 100000,
      salaryCents: null, contributionCents: null, complete: false })]),
    totals: { grossCommissionCents: 100000, contributionCents: null, complete: false },
  } });
});
it('retains the name of a non-producer whose undated policy makes revenue incomplete', async () => {
  const data = source(); data.assignments['account-1'].salespersonId = 'office'; data.policies[0].effectiveDate = '2026-02-30';
  expect(await createHandler({ read: async () => data, save: vi.fn() })(request())).toMatchObject({ ok: true, report: {
    rows: expect.arrayContaining([expect.objectContaining({ userId: 'office', name: 'Office employee', grossCommissionCents: null, complete: false })]),
  } });
});
it('does not pull unrelated historical employees into the report solely from cancelled policies', async () => {
  const data = source(); data.assignments['account-1'].salespersonId = 'office'; data.policies[0].status = 'CANCELLED';
  const result = await createHandler({ read: async () => data, save: vi.fn() })(request());
  expect(result).toMatchObject({ ok: true, report: { rows: [{ userId: 'employee-1', policyCount: 0 }], cancelledPolicyCount: 1, totals: { complete: true } } });
  if ('report' in result) expect(result.report?.rows).toHaveLength(1);
});
it('validates pay history before writing and passes the verified actor to its private audit', async () => {
  const store = { read: vi.fn(), save: vi.fn().mockResolvedValue({ ...pay, version: 3 }) }, handler = createHandler(store);
  expect(await handler(request('saveEmployeeCompensation', { ...pay, terms: JSON.stringify(pay.terms) }))).toMatchObject({ ok: true, compensation: { version: 3 } });
  expect(store.save).toHaveBeenCalledWith(pay, 'owner-1');
  store.save.mockClear();
  const invalid = [{ ...pay.terms[0], producerShareBps: 10001 }];
  expect(await handler(request('saveEmployeeCompensation', { ...pay, terms: invalid }))).toMatchObject({ ok: false });
  expect(store.save).not.toHaveBeenCalled();
});
it('paginates empty source pages, reads private compensation consistently, and keeps salaries out of shared tables', async () => {
  h.send.mockImplementation(async command => {
    const input = command.input;
    if (input.TableName === 'USER_PROFILE_TABLE') return { Items: [{ userId: 'employee-1', firstName: 'Sales', lastName: 'Person' }] };
    if (input.TableName === 'OWNER_COMPENSATION_TABLE') return { Items: [{ id: 'compensation:employee-1', ...pay }] };
    if (input.TableName === 'POLICY_TABLE') return input.ExclusiveStartKey ? { Items: source().policies } : { Items: [], LastEvaluatedKey: { id: 'page-two' } };
    if (input.TableName === 'COMMUNICATION_TABLE') return { Items: [{ data: { userId: 'employee-1', salesperson: true } }] };
    throw new Error('Unexpected source');
  });
  h.batchGet.mockResolvedValue(new Map([['workflow:account-1', { data: { salespersonId: 'employee-1' } }]]));
  const result = await repository.read();
  expect(result.policies).toHaveLength(1);
  expect(result.compensations['employee-1']).toEqual(pay);
  expect(result.employees).toEqual([{ userId: 'employee-1', name: 'Sales Person', salesperson: true }]);
  const payRead = h.send.mock.calls.find(([c]) => c.input.TableName === 'OWNER_COMPENSATION_TABLE')![0];
  expect(payRead.constructor.name).toBe('QueryCommand');
  expect(payRead.input).toMatchObject({ ConsistentRead: true, KeyConditionExpression: '#kind = :kind', ExpressionAttributeValues: { ':kind': 'COMPENSATION' } });
  expect(payRead.input.IndexName).toBeUndefined();
  expect(h.send.mock.calls.every(([c]) => ['ScanCommand', 'QueryCommand'].includes(c.constructor.name))).toBe(true);
});
it('does not render a partial report when any source read fails', async () => {
  h.send.mockImplementation(async command => {
    if (command.input.TableName === 'POLICY_TABLE') throw new Error('Policies unavailable');
    return { Items: [] };
  });
  expect(await createHandler(repository)(request())).toMatchObject({ ok: false, error: 'Policies unavailable' });
});
it('includes eligible producers without optional profiles and preserves former employees from compensation history', async () => {
  h.send.mockImplementation(async command => {
    if (command.input.TableName === 'COMMUNICATION_TABLE') return { Items: [{ data: { userId: 'new-producer', name: 'New Producer', salesperson: true } }] };
    if (command.input.TableName === 'OWNER_COMPENSATION_TABLE') return { Items: [{ id: 'compensation:employee-1', ...pay, employeeName: 'Former Employee' }] };
    return { Items: [] };
  });
  const result = await createHandler(repository)(request());
  expect(result).toMatchObject({ ok: true, employees: [
    { userId: 'employee-1', name: 'Former Employee', salesperson: false },
    { userId: 'new-producer', name: 'New Producer', salesperson: true },
  ], report: { rows: expect.arrayContaining([expect.objectContaining({ userId: 'new-producer', salaryCents: null, complete: false })]), totals: { complete: false } } });
});
it('fails the complete snapshot if workflow reads remain unprocessed', async () => {
  h.send.mockImplementation(async command => ({ Items: command.input.TableName === 'POLICY_TABLE' ? source().policies : [] }));
  h.batchGet.mockRejectedValue(new Error('Report details are incomplete. Refresh to try again.'));
  expect(await createHandler(repository)(request())).toMatchObject({ ok: false, error: 'Report details are incomplete. Refresh to try again.' });
});
it('keeps missing workflows as explicit unassigned production', async () => {
  h.send.mockImplementation(async command => ({ Items: command.input.TableName === 'POLICY_TABLE' ? source().policies : [] }));
  h.batchGet.mockResolvedValue(new Map());
  expect(await createHandler(repository)(request())).toMatchObject({ ok: true, report: {
    rows: [{ userId: null, grossCommissionCents: 100000, contributionCents: null, complete: false }],
  } });
});
it('joins more than one bounded workflow batch without omitting the final accounts', async () => {
  const policies = Array.from({ length: 501 }, (_, i) => ({ ...source().policies[0], id: `policy-${i}`, accountId: `account-${i}` }));
  h.send.mockImplementation(async command => ({ Items: command.input.TableName === 'POLICY_TABLE' ? policies : [] }));
  h.batchGet.mockImplementation(async (_table, ids: string[]) => new Map(ids.map(id => [id, { data: { salespersonId: 'former-employee' } }])));
  const result = await repository.read();
  expect(h.batchGet.mock.calls.map(([, ids]) => ids.length)).toEqual([500, 1]);
  expect(Object.keys(result.assignments)).toHaveLength(501);
  expect(result.assignments['account-500']).toEqual({ salespersonId: 'former-employee' });
});
it('fails closed on a repeating source cursor rather than returning duplicate or partial amounts', async () => {
  h.send.mockImplementation(async command => command.input.TableName === 'POLICY_TABLE'
    ? { Items: [], LastEvaluatedKey: { id: 'repeated' } } : { Items: [] });
  expect(await createHandler(repository)(request())).toMatchObject({ ok: false, error: 'The report could not finish loading. Please retry.' });
  expect(h.batchGet).not.toHaveBeenCalled();
});
it('saves compensation with a conditional version and same-transaction private history', async () => {
  h.send.mockImplementation(async command => {
    if (command.constructor.name === 'GetCommand') return { Item: { ...pay, employeeName: 'Sales Person' } };
    if (command.constructor.name === 'ScanCommand') return { Items: [{ userId: pay.userId, firstName: 'Sales', lastName: 'Person' }] };
    return {};
  });
  const result = await repository.save(pay, 'owner-1');
  expect(result.version).toBe(3);
  expect(h.send.mock.calls[0][0].input.Key).toEqual({ kind: 'COMPENSATION', id: 'compensation:employee-1' });
  const transaction = h.send.mock.calls.find(([c]) => c.constructor.name === 'TransactWriteCommand')![0].input;
  expect(transaction.TransactItems).toHaveLength(2);
  expect(transaction.TransactItems.every((item: { Put: { TableName: string } }) => item.Put.TableName === 'OWNER_COMPENSATION_TABLE')).toBe(true);
  expect(transaction.TransactItems[0].Put).toMatchObject({ ConditionExpression: '#version = :version', ExpressionAttributeValues: { ':version': 2 }, Item: { version: 3, updatedBy: 'owner-1' } });
  expect(transaction.TransactItems[1].Put.Item).toMatchObject({ kind: 'COMPENSATION_AUDIT', actor: 'owner-1', previous: pay, current: { ...pay, version: 3 } });
});
it('rejects stale compensation before creating an audit or overwriting pay history', async () => {
  h.send.mockResolvedValue({ Item: { ...pay, version: 3 } });
  await expect(repository.save(pay, 'owner-1')).rejects.toThrow('Refresh before saving');
  expect(h.send).toHaveBeenCalledTimes(1);
});
it('creates first compensation only for an existing profile or verified eligibility record', async () => {
  h.send.mockImplementation(async command => command.constructor.name === 'ScanCommand' ? { Items: [] } : {});
  h.batchGet.mockResolvedValue(new Map([['eligibility:employee-1', { kind: 'ELIGIBILITY', data: { userId: 'employee-1', name: 'New Producer' } }]]));
  expect(await repository.save({ ...pay, version: 0 }, 'owner-1')).toMatchObject({ version: 1 });
  const transaction = h.send.mock.calls.find(([c]) => c.constructor.name === 'TransactWriteCommand')![0].input;
  expect(transaction.TransactItems[0].Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(id)', Item: { employeeName: 'New Producer', version: 1 } });
  expect(transaction.TransactItems[1].Put.Item.previous).toBeNull();
  expect(h.batchGet).toHaveBeenCalledWith('COMMUNICATION_TABLE', ['eligibility:employee-1'], ['kind', 'data.userId', 'data.name']);
});
it.each([new Map(), new Map([['eligibility:employee-1', { kind: 'ELIGIBILITY', data: { userId: 'different-employee' } }]])])(
  'rejects a fabricated employee without creating a compensation record or audit', async eligibility => {
    h.send.mockImplementation(async command => command.constructor.name === 'ScanCommand' ? { Items: [] } : {});
    h.batchGet.mockResolvedValue(eligibility);
    await expect(repository.save({ ...pay, version: 0 }, 'owner-1')).rejects.toThrow('Choose an existing employee');
    expect(h.send.mock.calls.some(([command]) => command.constructor.name === 'TransactWriteCommand')).toBe(false);
  },
);
it('can update a former employee with existing compensation after their profile is gone', async () => {
  h.send.mockImplementation(async command => {
    if (command.constructor.name === 'GetCommand') return { Item: { ...pay, employeeName: 'Former Employee' } };
    return command.constructor.name === 'ScanCommand' ? { Items: [] } : {};
  });
  expect(await repository.save(pay, 'owner-1')).toMatchObject({ version: 3 });
  expect(h.batchGet).not.toHaveBeenCalled();
  const transaction = h.send.mock.calls.find(([c]) => c.constructor.name === 'TransactWriteCommand')![0].input;
  expect(transaction.TransactItems[0].Put.Item.employeeName).toBe('Former Employee');
});
it.each(['TransactionCanceledException', 'ConditionalCheckFailedException'])('reports a concurrent save failure without claiming it was saved (%s)', async name => {
  h.send.mockImplementation(async command => {
    if (command.constructor.name === 'GetCommand') return { Item: pay };
    if (command.constructor.name === 'ScanCommand') return { Items: [{ userId: pay.userId, firstName: 'Employee' }] };
    throw Object.assign(new Error('concurrent update'), { name });
  });
  const result = await createHandler(repository)(request('saveEmployeeCompensation', pay as unknown as Record<string, unknown>));
  expect(result).toEqual({ ok: false, error: 'Compensation changed. Refresh before saving.' });
});
