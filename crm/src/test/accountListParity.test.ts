import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_LIST_SORTS, type AccountListCounts, type AccountListPage, type AccountListRequest, type AccountListSort } from '../../../shared/accountList';
import { emptyCommercialPlan, packageTerms, pendingCommission, type CommercialPlan } from '../../../shared/quotePackages';
import { acquisitionLabel, websiteFormLabel } from '../../../shared/leadSource';
import { primaryContact } from '../lib/contacts';

const h = vi.hoisted(() => ({ records: new Map<string, any>(), calls: [] as { name: string; input: any }[] }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({ ...await original<typeof import('@aws-sdk/lib-dynamodb')>(), DynamoDBDocumentClient: { from: () => ({ send: async (command: any) => {
  const input = command.input, name = command.constructor.name; h.calls.push({ name, input });
  const key = (table: string, value: any) => `${table}|${value.id ?? `${value.pk}|${value.sk}`}`;
  const clone = (value: any) => value === undefined ? undefined : structuredClone(value);
  if (name === 'GetCommand') return { Item: clone(h.records.get(key(input.TableName, input.Key))) };
  if (name === 'BatchGetCommand') return { Responses: Object.fromEntries(Object.entries(input.RequestItems).map(([table, request]: [string, any]) => [table,
    request.Keys.flatMap((value: any) => {
      const row = clone(h.records.get(key(table, value))); if (!row) return [];
      if (!request.ProjectionExpression) return [row];
      const projected: Record<string, any> = {};
      for (const field of request.ProjectionExpression.split(',')) {
        const path = field.trim().split('.').map((part: string) => request.ExpressionAttributeNames?.[part] ?? part);
        const selected = path.reduce((current: any, part: string) => current?.[part], row);
        if (selected === undefined) continue;
        let target = projected;
        for (const part of path.slice(0, -1)) target = target[part] ??= {};
        target[path.at(-1)] = selected;
      }
      return [projected];
    }),
  ])) };
  if (name === 'QueryCommand') {
    const all = [...h.records].filter(([stored]) => stored.startsWith(`${input.TableName}|`)).map(([, row]) => row);
    if (input.IndexName) {
      const field = input.ExpressionAttributeNames['#field'] ?? input.ExpressionAttributeNames['#owner'];
      const value = input.ExpressionAttributeValues[':value'] ?? input.ExpressionAttributeValues[':owner'];
      const rows = all.filter(row => row[field] === value).sort((a, b) => a.id.localeCompare(b.id));
      const start = input.ExclusiveStartKey ? rows.findIndex(row => row.id === input.ExclusiveStartKey.id) + 1 : 0;
      const page = rows.slice(start, start + input.Limit);
      return { Items: page.map(row => ({ id: row.id })), ...(start + page.length < rows.length ? { LastEvaluatedKey: { id: page.at(-1)!.id } } : {}) };
    }
    const rows = all.filter(row => row.pk === input.ExpressionAttributeValues[':pk']).sort((a, b) => Buffer.compare(Buffer.from(a.sk), Buffer.from(b.sk)));
    if (input.ScanIndexForward === false) rows.reverse();
    const start = input.ExclusiveStartKey ? rows.findIndex(row => row.pk === input.ExclusiveStartKey.pk && row.sk === input.ExclusiveStartKey.sk) + 1 : 0;
    const page = rows.slice(start, start + input.Limit);
    return { Items: clone(page), ...(start + page.length < rows.length ? { LastEvaluatedKey: { pk: page.at(-1)!.pk, sk: page.at(-1)!.sk } } : {}) };
  }
  if (name === 'TransactWriteCommand') {
    expect(input.TransactItems.length).toBeLessThanOrEqual(100);
    const identities = input.TransactItems.map(({ Put, Delete }: any) => key((Put ?? Delete).TableName, Put?.Item ?? Delete.Key));
    expect(new Set(identities).size).toBe(identities.length);
    for (const { Put, Delete } of input.TransactItems) {
      if (Put) h.records.set(key(Put.TableName, Put.Item), clone(Put.Item));
      if (Delete) h.records.delete(key(Delete.TableName, Delete.Key));
    }
    return {};
  }
  if (name === 'UpdateCommand') {
    const row = h.records.get(key(input.TableName, input.Key));
    expect(row.generation).toBe(input.ExpressionAttributeValues[':generation']); delete row.obsoleteKeys; return {};
  }
  throw new Error(`Unexpected command in paged account flow: ${name}`);
} }) } }));
import { projectAccount } from '../../amplify/functions/account-list/store';
import { accountListRead } from '../../amplify/functions/communications/accountListRead';

const day = '2026-11-04', at = `${day}T15:00:00.000Z`;
type Source = { account: any; contacts: any[]; policies: any[]; quotes: any[]; plan: CommercialPlan; owner: string; disposition: string; followUpOn: string | null; profile: any };
let sources: Source[];
const save = (table: string, row: any) => h.records.set(`${table}|${row.id ?? `${row.pk}|${row.sk}`}`, structuredClone(row));
function source(id: string, name: string, rank: number, options: { stage?: 'LEAD' | 'CLIENT'; owner?: string; missing?: boolean; partial?: boolean; closed?: boolean; followUpOn?: string } = {}): Source {
  const owner = options.owner ?? 'alice', missing = options.missing;
  const account = { id, name, stage: options.stage ?? 'LEAD', type: ['ASSOCIATION', 'PERSONAL', 'COMMERCIAL_OTHER'][rank % 3],
    ...(missing ? {} : { city: ['Boston', 'Austin', 'Chicago', 'Denver', 'Erie'][rank % 5], state: rank % 2 ? 'TX' : 'Massachusetts', unitCount: rank === 0 ? 0 : rank * 11, totalInsuredValue: rank * 100000.25,
      createdAt: `2026-0${rank + 1}-01T15:00:00.000Z`, currentPolicyExpiration: `2027-0${rank + 1}-15`,
      leadSource: ['PHONE', 'EMAIL', 'GOOGLE_AD_WEBSITE', 'ORGANIC_WEBSITE', 'PROPERTY_MANAGER'][rank % 5], source: ['website-quote', 'website-contact', 'website-assessment:one', 'website-ho6:one'][rank % 4] }),
    updatedAt: at, privateIntakeBlob: 'never put this in a list response' };
  const contacts = missing ? [] : [
    { id: `old-${id}`, accountId: id, name: `Former ${name}`, isPrimary: true, validUntil: '2026-01-01', updatedAt: at },
    { id: `current-${id}`, accountId: id, name: `${String.fromCharCode(65 + rank)} Contact`, email: `${id}@example.test`, isPrimary: true, validFrom: '2026-01-01', updatedAt: at, phone: 'private unused phone' },
    { id: `future-${id}`, accountId: id, name: 'Future contact', isPrimary: true, validFrom: '2027-01-01', updatedAt: at },
  ];
  const policies = missing ? [] : [
    { id: `later-${id}`, accountId: id, status: 'ACTIVE', expirationDate: `2028-0${rank + 1}-01`, updatedAt: at },
    { id: `earlier-${id}`, accountId: id, status: 'ACTIVE', expirationDate: `2027-0${rank + 1}-01`, updatedAt: at },
    { id: `expired-${id}`, accountId: id, status: 'EXPIRED', expirationDate: '2025-01-01', updatedAt: at },
  ];
  const quotes = missing ? [] : [0, 1].map(n => ({ id: `q-${id}-${n}`, accountId: id, status: account.stage === 'CLIENT' ? options.partial && n === 1 ? 'QUOTED' : 'BOUND' : 'QUOTED',
    carrierId: 'carrier', premium: (rank + 1) * 1000, commissionPct: 10, lines: ['GL'], effectiveDate: '2027-01-01', expirationDate: '2028-01-01', updatedAt: at }));
  const terms = Object.fromEntries(quotes.map(quote => [quote.id, packageTerms(quote)]));
  const plan = { ...emptyCommercialPlan(id), estimatedCents: missing ? null : rank * 12345, requiredLines: ['GL'],
    options: quotes.length ? [{ id: 'selected', name: 'Chosen option', quoteIds: quotes.map(quote => quote.id), reviewed: { at, by: owner, terms } }] : [],
    ...(account.stage === 'CLIENT' ? { selectedOptionId: 'selected', selectedTerms: terms } : {}) };
  const disposition = options.closed ? 'LOST' : account.stage === 'CLIENT' ? 'BOUND' : 'ACTIVE';
  return { account, contacts, policies, quotes, plan, owner, disposition, followUpOn: options.followUpOn ?? null,
    profile: { id: `profile-${owner}`, userId: owner, firstName: owner === 'alice' ? 'Alice' : 'Bob', lastName: 'Sales', updatedAt: at } };
}
function persist(input: Source) {
  const id = input.account.id;
  save('Account', input.account); for (const row of input.contacts) save('Contact', row); for (const row of input.policies) save('Policy', row); for (const row of input.quotes) save('Quote', row);
  save('UserProfile', input.profile);
  save('Communication', { id: `workflow:${id}`, version: 1, kind: 'WORKFLOW', assignedSalespersonId: input.owner, accountId: id, data: { accountId: id, salespersonId: input.owner, disposition: input.disposition } });
  save('Communication', { id: `commercial:${id}`, version: 1, kind: 'COMMERCIAL_PLAN', accountId: id, data: input.plan });
  if (input.followUpOn) save('Communication', { id: `lead-snooze:${id}`, version: 1, kind: 'LEAD_SNOOZE', accountId: id, data: { accountId: id, version: 1, followUpOn: input.followUpOn, note: `Contact ${id} later` } });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); h.records.clear(); h.calls.length = 0;
  process.env.ACCOUNT_LIST_TABLE = 'Projection'; process.env.COMMUNICATION_TABLE = 'Communication';
  process.env.ACCOUNT_LIST_SOURCE_TABLES = JSON.stringify(Object.fromEntries(['Account', 'Contact', 'Quote', 'Policy', 'Communication', 'UserProfile'].map(model => [model, model])));
  process.env.ACCOUNT_LIST_SOURCE_INDEXES = JSON.stringify({ Contact: 'byAccount', Quote: 'byAccount', Policy: 'byAccount', UserProfile: 'byUser' });
  sources = [source('a', 'Willow', 0), source('b', 'Willow Bay', 1, { owner: 'bob', followUpOn: day }), source('c', 'Willow Creek', 2), source('d', 'A', 3, { missing: true }),
    source('e', 'A B', 4, { stage: 'CLIENT', partial: true, owner: 'bob' }), source('f', 'Elm', 5, { stage: 'CLIENT', owner: 'bob' }), source('g', 'Lost', 6, { closed: true, followUpOn: day }), source('h', 'Snoozed', 7, { followUpOn: '2026-12-01' })];
  for (const input of sources) persist(input);
  for (const input of sources) await projectAccount(input.account.id, day, at);
  save('Projection', { pk: 'CONTROL', sk: 'READY', version: 1, complete: true, day });
});
afterEach(() => vi.useRealTimers());

const base: AccountListRequest = { stage: 'LEAD', view: 'all', sort: 'name', dir: 'asc', limit: 2 };
async function pages(input: Partial<AccountListRequest> = {}, role = 'OWNER') {
  const items: AccountListPage['items'] = [], tokens = new Set<string>(); let nextToken: string | undefined;
  do {
    const result = await accountListRead({ ...base, ...input, nextToken }, { sub: 'alice', groups: [role] }, { headers: { 'x-crm-role': role } }) as AccountListPage;
    expect(result.ready).toBe(true); expect(result.items.length).toBeLessThanOrEqual(input.limit ?? 2);
    items.push(...result.items); nextToken = result.nextToken;
    if (nextToken) { expect(tokens.has(nextToken)).toBe(false); tokens.add(nextToken); }
  } while (nextToken);
  expect(new Set(items.map(item => item.account.id)).size).toBe(items.length);
  return items;
}
function legacy(input: Partial<AccountListRequest> = {}, role = 'OWNER') {
  const query = { ...base, ...input };
  return sources.filter(row => {
    if (!['ADMIN', 'OWNER'].includes(role) && row.owner !== 'alice' || query.salespersonId && row.owner !== query.salespersonId) return false;
    if (query.state && (row.account.state === 'Massachusetts' ? 'MA' : row.account.state) !== query.state) return false;
    const forecast = pendingCommission(row.plan, row.quotes, day);
    if (row.account.stage !== query.stage && !(query.stage === 'LEAD' && row.account.stage === 'CLIENT' && forecast.unfinished)) return false;
    if (query.stage === 'CLIENT' || query.view === 'all') return true;
    if (row.account.stage !== 'CLIENT' && ['LOST', 'DISQUALIFIED', 'BOUND'].includes(row.disposition)) return false;
    if (query.view === 'snoozed') return !!row.followUpOn && row.followUpOn > day;
    if (query.view === 'due') return !!row.followUpOn && row.followUpOn <= day;
    return !row.followUpOn || row.followUpOn <= day;
  });
}
function oldValue(row: Source, sort: AccountListSort, stage: 'LEAD' | 'CLIENT') {
  switch (sort) {
    case 'name': return row.account.name;
    case 'type': return row.account.type;
    case 'contact': return primaryContact(row.contacts)?.name;
    case 'city': return row.account.city;
    case 'state': return row.account.state;
    case 'salesperson': return `${row.profile.firstName} ${row.profile.lastName}`;
    case 'source': return acquisitionLabel(row.account.leadSource, row.account.source);
    case 'form': return websiteFormLabel(row.account.source);
    case 'estimate': return row.plan.estimatedCents;
    case 'pending': return pendingCommission(row.plan, row.quotes, day).cents;
    case 'units': return row.account.unitCount;
    case 'tiv': return row.account.totalInsuredValue;
    case 'entered': return row.account.createdAt;
    case 'followUp': return row.account.stage === 'LEAD' ? row.followUpOn : null;
    case 'renewal': return stage === 'LEAD' ? row.account.currentPolicyExpiration : row.policies.filter(policy => policy.status === 'ACTIVE').map(policy => policy.expirationDate).sort()[0];
  }
}
const normalized = (value: any) => value === undefined || value === '' ? null : value;
function oldCompare(a: any, b: any, dir: 'asc' | 'desc') {
  a = normalized(a); b = normalized(b);
  if (a === null && b === null) return 0; if (a === null) return 1; if (b === null) return -1;
  return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { sensitivity: 'base' })) * (dir === 'asc' ? 1 : -1);
}

describe('real projector and reader semantic parity', () => {
  it.each(ACCOUNT_LIST_SORTS.flatMap(sort => (['asc', 'desc'] as const).map(dir => ({ sort, dir }))))('preserves legacy $sort $dir ordering with full cursor traversal and nulls last', async ({ sort, dir }) => {
    for (const stage of ['LEAD', 'CLIENT'] as const) {
      const actual = await pages({ sort, dir, stage });
      const expected = legacy({ stage }).sort((a, b) => oldCompare(oldValue(a, sort, stage), oldValue(b, sort, stage), dir));
      expect(new Set(actual.map(item => item.account.id))).toEqual(new Set(expected.map(row => row.account.id)));
      // Equal-valued rows have no guaranteed native scan order. Compare their
      // column values, while checking the complete ID set and no duplicates.
      expect(actual.map(item => normalized(oldValue(sources.find(row => row.account.id === item.account.id)!, sort, stage))))
        .toEqual(expected.map(row => normalized(oldValue(row, sort, stage))));
    }
  });
  it('retains complete row values, dated primary contacts, forecast terms, earliest active policies, and safe payloads', async () => {
    for (const stage of ['LEAD', 'CLIENT'] as const) for (const item of await pages({ stage })) {
      const row = sources.find(row => row.account.id === item.account.id)!;
      expect(item.contact?.id).toBe(primaryContact(row.contacts)?.id); expect(item.contact?.email).toBe(primaryContact(row.contacts)?.email);
      expect(item.forecast).toEqual(pendingCommission(row.plan, row.quotes, day));
      expect(item.renewalDate).toBe(oldValue(row, 'renewal', stage) ?? null);
      expect(item.commercial.plan.estimatedCents).toBe(row.plan.estimatedCents);
      expect(item.commercial.plan.options).toEqual([]);
      expect(JSON.stringify(item)).not.toContain('privateIntakeBlob'); expect(JSON.stringify(item)).not.toContain('private unused phone');
    }
    expect((await pages()).map(item => item.account.id)).toContain('e');
    expect((await pages()).map(item => item.account.id)).not.toContain('f');
    expect((await pages({ stage: 'CLIENT' })).map(item => item.account.id)).toEqual(['e', 'f']);
  });
  it.each(['ADMIN', 'OWNER', 'PRODUCER', 'STAFF'])('matches all stage/view/state/salesperson filters and paged counts in %s', async role => {
    for (const stage of ['LEAD', 'CLIENT'] as const) for (const state of [undefined, 'MA', 'TX']) for (const salespersonId of ['ADMIN', 'OWNER'].includes(role) ? [undefined, 'alice', 'bob'] : [undefined, 'alice']) {
      const input = { stage, state, salespersonId };
      let nextToken: string | undefined; const total = { active: 0, snoozed: 0, due: 0, all: 0 };
      do {
        const result = await accountListRead({ ...base, ...input, nextToken }, { sub: 'alice', groups: [role] }, { headers: { 'x-crm-role': role } }, true) as AccountListCounts;
        expect(result.ready).toBe(true); for (const view of ['active', 'snoozed', 'due', 'all'] as const) total[view] += result.counts[view]; nextToken = result.nextToken;
      } while (nextToken);
      for (const view of ['active', 'snoozed', 'due', 'all'] as const) {
        const actual = await pages({ ...input, view }, role), expected = legacy({ ...input, view }, role);
        expect(new Set(actual.map(item => item.account.id))).toEqual(new Set(expected.map(row => row.account.id)));
        // Client routes have a single all-clients view; lead counters retain
        // their individual active/snoozed/due classification.
        if (stage === 'LEAD' || view === 'all') expect(total[view]).toBe(expected.length);
      }
    }
  });
  it('removes obsolete assignment and name keys after a source edit and never revives them on an idempotent retry', async () => {
    const row = sources.find(row => row.account.id === 'a')!;
    row.account.name = 'Willow Renamed'; row.account.updatedAt = '2026-11-04T16:00:00.000Z'; row.owner = 'bob';
    persist(row); await projectAccount('a', day, at);
    expect((await pages({}, 'PRODUCER')).map(item => item.account.id)).not.toContain('a');
    expect((await pages({ salespersonId: 'bob' })).find(item => item.account.id === 'a')?.account.name).toBe('Willow Renamed');
    const before = (await pages()).map(item => item.account.id);
    expect(await projectAccount('a', day, at)).toMatchObject({ changed: false });
    expect((await pages()).map(item => item.account.id)).toEqual(before);
    expect([...h.records.values()].filter(row => row.pk?.startsWith('V1#USER#alice#') && row.accountId === 'a')).toEqual([]);
  });
  it('continues real projected counts beyond the 200-candidate request budget without duplicates or missing views', async () => {
    for (let i = 0; i < 205; i++) {
      const input = source(`extra-${String(i).padStart(3, '0')}`, `Extra ${i}`, 3, { missing: true });
      sources.push(input); persist(input); await projectAccount(input.account.id, day, at);
    }
    const totals = { active: 0, snoozed: 0, due: 0, all: 0 }, seen = new Set<string>(); let nextToken: string | undefined, requests = 0;
    do {
      const result = await accountListRead({ ...base, nextToken }, { sub: 'alice', groups: ['OWNER'] }, { headers: { 'x-crm-role': 'OWNER' } }, true) as AccountListCounts;
      expect(result.ready).toBe(true); for (const view of ['active', 'snoozed', 'due', 'all'] as const) totals[view] += result.counts[view]; requests++; nextToken = result.nextToken;
      if (nextToken) { expect(seen.has(nextToken)).toBe(false); seen.add(nextToken); }
    } while (nextToken);
    expect(requests).toBeGreaterThan(1);
    for (const view of ['active', 'snoozed', 'due', 'all'] as const) expect(totals[view]).toBe(legacy({ view }).length);
  });
});
