import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchGetCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { accountListPartition, accountListScope, accountListSnapshotKey, ACCOUNT_LIST_VERSION, type AccountListCounts, type AccountListIndex, type AccountListItem, type AccountListPage, type AccountListSnapshot } from '../../../shared/accountList';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
const h = vi.hoisted(() => ({ rows: new Map<string, Record<string, any>>(), send: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async load => ({ ...await load<typeof import('@aws-sdk/lib-dynamodb')>(), DynamoDBDocumentClient: { from: () => ({ send: h.send }) } }));
import { accountListRead } from '../../amplify/functions/communications/accountListRead';
import { AccountAccess } from '../../amplify/functions/crm-access/access';
import { authorizeCustom, filterCustom } from '../../amplify/functions/crm-access/custom';

const now = '2026-11-04T15:00:00.000Z', day = '2026-11-04';
const key = (table: string, value: Record<string, any>) => `${table}|${value.pk ? `${value.pk}|${value.sk}` : value.id}`;
const save = (table: string, row: Record<string, any>) => h.rows.set(key(table, row), row);
const args = { stage: 'LEAD', view: 'all', sort: 'name', dir: 'asc', limit: 25 };
const identity = (role = 'PRODUCER', sub = 'alice') => ({ sub, groups: [role] });
const headers = (role: string) => ({ headers: { 'x-crm-role': role } });
const page = (input: Record<string, unknown> = {}, role = 'PRODUCER', sub = 'alice') => accountListRead({ ...args, ...input }, identity(role, sub), headers(role)) as Promise<AccountListPage>;
const counts = (input: Record<string, unknown> = {}, role = 'PRODUCER') => accountListRead({ ...args, ...input }, identity(role), headers(role), true) as Promise<AccountListCounts>;
function add(id: string, owner = 'alice', extra: Partial<AccountListIndex> = {}, sort: 'name' | 'renewal' = 'name', missing = false) {
  const account = { id, name: `Association ${id}`, stage: 'LEAD' as const, type: 'ASSOCIATION' as const, state: 'FL', updatedAt: 'account-v1' };
  const contact = { id: `contact-${id}`, accountId: id, name: `Contact ${id}`, email: `${id}@example.test`, updatedAt: 'contact-v1' };
  save('Account', account); save('Contact', contact);
  save('Communication', { id: `workflow:${id}`, version: 1, data: { salespersonId: owner } });
  save('Communication', { id: `commercial:${id}`, version: 1 });
  const item: AccountListItem = { account, contact, renewalDate: '2027-01-01', commercial: { accountId: id, plan: emptyCommercialPlan(id), salespersonId: owner, workflowVersion: 1, disposition: 'ACTIVE' }, forecast: { cents: null, label: 'No estimate', unfinished: false } };
  const snapshot: AccountListSnapshot = { ...accountListSnapshotKey(id), accountId: id, generation: `generation-${id}`, version: ACCOUNT_LIST_VERSION, builtAt: now, item,
    dependencies: [{ model: 'Account', id, revision: 'account-v1' }, { model: 'Contact', id: contact.id, revision: 'contact-v1' },
      { model: 'Communication', id: `workflow:${id}`, revision: '1' }, { model: 'Communication', id: `commercial:${id}`, revision: '1' },
      { model: 'Communication', id: `lead-snooze:${id}`, revision: '-' }, { model: 'Communication', id: `deleted-account:${id}`, revision: '-' }] };
  save('List', snapshot);
  for (const scope of ['AGENCY', accountListScope(owner)]) save('List', {
    pk: accountListPartition(scope, 'LEAD', sort, missing), sk: `${id}#${id}`, accountId: id, generation: snapshot.generation,
    stage: 'LEAD', state: 'FL', salespersonId: owner, open: true, followUpOn: '', ...extra,
  });
  return snapshot;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  h.rows.clear(); h.send.mockReset();
  process.env.ACCOUNT_LIST_TABLE = 'List'; process.env.COMMUNICATION_TABLE = 'Communication';
  process.env.ACCOUNT_LIST_SOURCE_TABLES = JSON.stringify(Object.fromEntries(['Account', 'Contact', 'Quote', 'Policy', 'UserProfile', 'Communication'].map(model => [model, model])));
  save('List', { pk: 'CONTROL', sk: 'READY', version: ACCOUNT_LIST_VERSION, complete: true, day });
  h.send.mockImplementation(async command => {
    const input = command.input;
    if (command instanceof GetCommand) return { Item: h.rows.get(key(input.TableName, input.Key)) };
    if (command instanceof BatchGetCommand) return { Responses: Object.fromEntries(Object.entries(input.RequestItems).map(([table, request]) => [table,
      (request as { Keys: Record<string, any>[] }).Keys.map(value => h.rows.get(key(table, value))).filter(Boolean),
    ])) };
    if (!(command instanceof QueryCommand)) throw new Error('Read endpoint must never scan');
    const rows = [...h.rows.entries()].filter(([stored, row]) => stored.startsWith(`${input.TableName}|`) && row.pk === input.ExpressionAttributeValues[':pk'])
      .map(([, row]) => row).sort((a, b) => a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0);
    if (input.ScanIndexForward === false) rows.reverse();
    const start = input.ExclusiveStartKey ? rows.findIndex(row => row.pk === input.ExclusiveStartKey.pk && row.sk === input.ExclusiveStartKey.sk) + 1 : 0;
    const items = rows.slice(start, start + input.Limit);
    return { Items: items, ...(start + items.length < rows.length ? { LastEvaluatedKey: { pk: items.at(-1)!.pk, sk: items.at(-1)!.sk } } : {}) };
  });
});
afterEach(() => vi.useRealTimers());

describe('account list read endpoint', () => {
  it.each(['ADMIN', 'OWNER', 'PRODUCER', 'STAFF'])('uses only the current %s partition and consistent reads', async role => {
    add('a'); add('b', 'bob');
    const result = await page({}, role);
    expect(result.items.map(item => item.account.id)).toEqual(['ADMIN', 'OWNER'].includes(role) ? ['a', 'b'] : ['a']);
    const queries = h.send.mock.calls.map(([command]) => command).filter(command => command instanceof QueryCommand);
    expect(queries.every(command => command.input.ExpressionAttributeValues![':pk'].includes(['ADMIN', 'OWNER'].includes(role) ? '#AGENCY#' : '#USER#alice#'))).toBe(true);
    expect(h.send.mock.calls.every(([command]) => command.input.ConsistentRead === true || Object.values(command.input.RequestItems ?? {}).every((request: any) => request.ConsistentRead === true))).toBe(true);
  });
  it.each([undefined, { version: 0, complete: true, day }, { version: ACCOUNT_LIST_VERSION, complete: false, day }, { version: ACCOUNT_LIST_VERSION, complete: true, day: '2026-11-03' }])('falls back before reading records if the readiness control is incomplete or stale: %j', async ready => {
    if (ready) save('List', { pk: 'CONTROL', sk: 'READY', ...ready }); else h.rows.delete('List|CONTROL|READY');
    add('a');
    expect(await page()).toEqual({ ready: false, items: [] });
    expect(await counts()).toEqual({ ready: false, counts: { active: 0, snoozed: 0, due: 0, all: 0 } });
    expect(h.send.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
  });
  it('rejects unassigned role headers and foreign salesperson filters before database access', async () => {
    await expect(accountListRead(args, identity(), headers('OWNER'))).rejects.toThrow('not available');
    await expect(page({ salespersonId: 'bob' })).rejects.toThrow('not available');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('revalidates current assignment, deletion, and dependencies for both pages and counts', async () => {
    add('a');
    expect((await page()).items).toHaveLength(1);
    save('Communication', { id: 'workflow:a', version: 2, data: { salespersonId: 'bob' } });
    expect((await page()).items).toEqual([]); expect((await counts()).counts.all).toBe(0);
    save('Communication', { id: 'workflow:a', version: 1, data: { salespersonId: 'alice' } });
    save('Communication', { id: 'deleted-account:a', version: 1 });
    expect((await page({}, 'OWNER')).items).toEqual([]); expect((await counts({}, 'OWNER')).counts.all).toBe(0);
  });
  it.each(['Contact', 'Quote', 'Policy', 'UserProfile'])('does not return a stale %s dependent snapshot', async model => {
    const snapshot = add('a');
    const depId = model === 'Contact' ? 'contact-a' : `${model}-a`;
    if (model !== 'Contact') {
      save(model, { id: depId, accountId: 'a', updatedAt: 'dep-v1' });
      snapshot.dependencies.push({ model: model as 'Quote', id: depId, revision: 'dep-v1' });
    }
    expect((await page({}, 'ADMIN')).items).toHaveLength(1);
    save(model, { id: depId, accountId: 'a', updatedAt: 'dep-v2' });
    expect((await page({}, 'ADMIN')).items).toEqual([]); expect((await counts({}, 'ADMIN')).counts.all).toBe(0);
  });
  it.each(['Contact', 'Quote', 'Policy'])('does not trust a matching revision after a %s moves to another account', async model => {
    const snapshot = add('a'), depId = model === 'Contact' ? 'contact-a' : `${model}-a`;
    if (model !== 'Contact') snapshot.dependencies.push({ model: model as 'Quote', id: depId, revision: 'child-v1' });
    save(model, { id: depId, accountId: 'b', updatedAt: model === 'Contact' ? 'contact-v1' : 'child-v1' });
    expect((await page({}, 'OWNER')).items).toEqual([]);
  });
  it.each(['Account', 'Contact', 'workflow', 'commercial', 'lead-snooze', 'deleted-account'])('requires the %s dependency before returning materialized fields', async missing => {
    const snapshot = add('a');
    snapshot.dependencies = snapshot.dependencies.filter(dep => missing === 'Account' || missing === 'Contact' ? dep.model !== missing : dep.id !== `${missing}:a`);
    expect((await page({}, 'OWNER')).items).toEqual([]); expect((await counts({}, 'OWNER')).counts.all).toBe(0);
  });
  it.each(['Account', 'Contact'])('requires an existing %s source even if a malformed dependency marks it absent', async model => {
    const snapshot = add('a'), depId = model === 'Account' ? 'a' : 'contact-a';
    snapshot.dependencies.find(dep => dep.model === model && dep.id === depId)!.revision = '-';
    h.rows.delete(`${model}|${depId}`);
    expect((await page({}, 'OWNER')).items).toEqual([]); expect((await counts({}, 'OWNER')).counts.all).toBe(0);
  });
  it('rechecks the next page after an account is reassigned while its cursor is held', async () => {
    add('a'); add('b');
    const first = await page({ limit: 1 }); expect(first.items[0].account.id).toBe('a');
    save('Communication', { id: 'workflow:b', version: 2, data: { salespersonId: 'bob' } });
    expect((await page({ limit: 1, nextToken: first.nextToken })).items).toEqual([]);
  });
  it('does not accept a snapshot whose generation or build day differs from its indexed candidate', async () => {
    const snapshot = add('a'); snapshot.generation = 'different';
    expect((await page()).items).toEqual([]);
    snapshot.generation = 'generation-a'; snapshot.builtAt = '2026-11-03T15:00:00.000Z';
    expect((await page()).items).toEqual([]);
  });
  it('paginates sorted present values before missing values in either direction', async () => {
    add('2027-01', 'alice', {}, 'renewal'); add('2027-02', 'alice', {}, 'renewal'); add('unknown', 'alice', {}, 'renewal', true);
    for (const dir of ['asc', 'desc']) {
      const ids: string[] = []; let nextToken: string | undefined;
      do { const result = await page({ sort: 'renewal', dir, limit: 1, nextToken }); ids.push(...result.items.map(item => item.account.id)); nextToken = result.nextToken; } while (nextToken);
      expect(ids).toEqual(dir === 'asc' ? ['2027-01', '2027-02', 'unknown'] : ['2027-02', '2027-01', 'unknown']);
    }
  });
  it('binds cursors to actor, active role, filters, ordering, and page/count operation', async () => {
    add('a'); add('b');
    const first = await page({ limit: 1 }, 'OWNER'); expect(first.nextToken).toBeTruthy();
    for (const change of [{ state: 'FL' }, { sort: 'renewal' }, { dir: 'desc' }, { stage: 'CLIENT' }, { view: 'due' }, { salespersonId: 'alice' }]) await expect(page({ limit: 1, ...change, nextToken: first.nextToken }, 'OWNER')).rejects.toThrow('pagination token');
    await expect(page({ limit: 1, nextToken: first.nextToken }, 'PRODUCER')).rejects.toThrow('pagination token');
    await expect(page({ limit: 1, nextToken: first.nextToken }, 'OWNER', 'bob')).rejects.toThrow('pagination token');
    await expect(counts({ limit: 1, nextToken: first.nextToken }, 'OWNER')).rejects.toThrow('pagination token');
    const forged = JSON.parse(Buffer.from(first.nextToken!, 'base64url').toString()); forged.key.pk = accountListPartition('USER#bob', 'LEAD', 'name');
    await expect(page({ limit: 1, nextToken: Buffer.from(JSON.stringify(forged)).toString('base64url') }, 'OWNER')).rejects.toThrow('pagination token');
  });
  it('uses the same state, ownership, open, and follow-up filters in pages and counts', async () => {
    add('active'); add('due', 'alice', { followUpOn: day }); add('snoozed', 'alice', { followUpOn: '2026-11-06' }); add('closed', 'alice', { open: false }); add('other-state', 'alice', { state: 'CA' });
    const result = await counts({ state: 'FL' });
    expect(result.counts).toEqual({ active: 2, due: 1, snoozed: 1, all: 4 });
    for (const view of ['active', 'due', 'snoozed', 'all'] as const) expect((await page({ view, state: 'FL' })).items).toHaveLength(result.counts[view]);
  });
  it('bounds count work and continues without skipping or double-counting candidates', async () => {
    for (let i = 0; i < 205; i++) add(String(i).padStart(3, '0'));
    const first = await counts(); expect(first.counts.all).toBe(200); expect(first.nextToken).toBeTruthy();
    expect(h.send.mock.calls.filter(([command]) => command instanceof QueryCommand)).toHaveLength(4);
    const second = await counts({ nextToken: first.nextToken }); expect(second.counts.all).toBe(5); expect(second.nextToken).toBeUndefined();
  });
  it('retries unprocessed keys and propagates storage failure instead of accepting a partial source snapshot', async () => {
    add('a'); const normal = h.send.getMockImplementation()!; let retry = true;
    h.send.mockImplementation(command => {
      if (command instanceof BatchGetCommand && retry) { retry = false; return { Responses: {}, UnprocessedKeys: command.input.RequestItems }; }
      return normal(command);
    });
    expect((await page()).items).toHaveLength(1);
    h.send.mockImplementation(command => command instanceof BatchGetCommand ? Promise.reject(new Error('database unavailable')) : normal(command));
    await expect(page()).rejects.toThrow('database unavailable');
  });
  it('falls back without truncating dependencies when one snapshot exceeds its work budget', async () => {
    const snapshot = add('a');
    for (let i = 0; i < 257; i++) snapshot.dependencies.push({ model: 'Quote', id: `extra-${i}`, revision: '-' });
    expect(await page()).toEqual({ ready: false, items: [] });
    expect(await counts()).toEqual({ ready: false, counts: { active: 0, snoozed: 0, due: 0, all: 0 } });
    expect(h.send.mock.calls.filter(([command]) => command instanceof BatchGetCommand).every(([command]) => Object.keys(command.input.RequestItems).join() === 'List')).toBe(true);
  });
  it('bounds total source keys per query and clears partial counts when a later chunk needs fallback', async () => {
    for (let i = 0; i < 50; i++) add(`a-${String(i).padStart(2, '0')}`);
    for (let i = 0; i < 10; i++) {
      const snapshot = add(`b-${i}`);
      for (let j = 0; j < 244; j++) snapshot.dependencies.push({ model: 'Quote', id: `extra-${i}-${j}`, revision: '-' });
    }
    expect(await counts()).toEqual({ ready: false, counts: { active: 0, snoozed: 0, due: 0, all: 0 } });
  });
  it.each([{ model: 'License', id: 'license', revision: '1' }, { model: 'Quote', id: '', revision: '1' }, { model: 'Quote', id: 'q', revision: '' }])('rejects malformed dependency metadata: %j', dependency => {
    const snapshot = add('a'); snapshot.dependencies.push(dependency as any);
    return expect(page()).rejects.toThrow('rebuilding');
  });
  it('checks current assignment again in the custom postfilter and retains its continuation token', async () => {
    const snapshot = add('a');
    await expect(authorizeCustom(new AccountAccess(identity()), 'communicationRead', { readOperation: 'accountListPage', input: args })).resolves.toBeUndefined();
    await expect(authorizeCustom(new AccountAccess(identity()), 'communicationWrite', { operation: 'accountListPage', input: args })).rejects.toThrow('not available');
    const original = { ok: true, ready: true, items: [snapshot.item], nextToken: 'later' };
    expect(await filterCustom(new AccountAccess(identity()), 'communicationRead', { readOperation: 'accountListPage' }, original)).toEqual(original);
    save('Communication', { id: 'workflow:a', version: 2, data: { salespersonId: 'bob' } });
    expect(await filterCustom(new AccountAccess(identity()), 'communicationRead', { readOperation: 'accountListPage' }, original)).toEqual({ ...original, items: [] });
  });
});
