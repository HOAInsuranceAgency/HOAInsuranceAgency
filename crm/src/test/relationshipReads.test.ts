import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn(), portfolio: vi.fn(), records: new Map<string, any>() }));
vi.mock('../../amplify/functions/communications/store', async original => ({ ...await original<any>(), db: { send: h.send } }));
vi.mock('../../amplify/functions/communications/data', () => ({ dataClient: async () => ({ models: { AccountRelationship: { listAccountRelationshipByPartyId: h.portfolio } } }) }));
import { relationshipRead } from '../../amplify/functions/communications/relationshipReads';
const alice = { sub: 'alice', groups: ['PRODUCER'] };
beforeEach(() => {
  h.records.clear(); h.send.mockReset(); h.portfolio.mockReset();
  for (const model of ['Party', 'AccountRelationship', 'Account', 'Communication', 'Contact']) process.env[`${model.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_TABLE`] = model;
  h.send.mockImplementation(async cmd => {
    if (cmd.input.RequestItems) return { Responses: Object.fromEntries(Object.entries(cmd.input.RequestItems).map(([table, request]: [string, any]) => [table, request.Keys.flatMap((k: any) => h.records.has(`${table}:${k.id}`) ? [h.records.get(`${table}:${k.id}`)] : [])])) };
    return { Items: [], LastEvaluatedKey: { id: `page-${h.send.mock.calls.length}` } };
  });
});
it('bounds a sparse directory search to four filtered scans and returns a continuation', async () => {
  const result = await relationshipRead('relationshipSearch', { query: 'APEX', kind: 'ORGANIZATION' }, alice);
  expect(result.items).toEqual([]); expect(result.nextToken).toBeTruthy();
  expect(h.send).toHaveBeenCalledTimes(4);
  for (const [cmd] of h.send.mock.calls) {
    expect(cmd.input.Limit).toBe(25);
    expect(cmd.input.FilterExpression).toContain('contains(#search, :query)');
    expect(cmd.input.ExpressionAttributeValues[':query']).toBe('apex');
    expect(cmd.input.ExpressionAttributeValues[':kind']).toBe('ORGANIZATION');
  }
  await expect(relationshipRead('relationshipSearch', { query: 'OTHER', nextToken: result.nextToken }, alice)).rejects.toThrow('Search changed');
  await expect(relationshipRead('relationshipSearch', { query: 'APEX', kind: 'ORGANIZATION', nextToken: result.nextToken }, { sub: 'bob' })).rejects.toThrow('Search changed');
});
it('fetches a requested set of profiles in one batch and caps caller-provided IDs', async () => {
  h.records.set('Party:p', { id: 'p', name: 'Apex', directorySearch: 'apex', privateExtra: 'not returned' });
  const result = await relationshipRead('relationshipProfiles', { ids: ['p', 'p'] }, alice);
  expect(result.items).toHaveLength(1); expect(result.items[0]).not.toHaveProperty('directorySearch'); expect(result.items[0]).not.toHaveProperty('privateExtra');
  expect(h.send).toHaveBeenCalledTimes(1);
  await expect(relationshipRead('relationshipProfiles', { ids: Array(101).fill('p') }, alice)).rejects.toThrow('100');
});
it('pages a portfolio and batch-checks current account assignments without per-account requests', async () => {
  const links = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, partyId: 'p', accountId: `a${i}`, role: 'MANAGER' }));
  h.portfolio.mockResolvedValue({ data: links, nextToken: 'more-links' });
  for (const [i, link] of links.entries()) {
    h.records.set(`AccountRelationship:${link.id}`, link);
    h.records.set(`Account:${link.accountId}`, { id: link.accountId, name: `Account ${i}`, stage: 'CLIENT' });
    h.records.set(`Communication:workflow:${link.accountId}`, { id: `workflow:${link.accountId}`, data: { salespersonId: i % 2 ? 'bob' : 'alice' } });
  }
  const result = await relationshipRead('relationshipPortfolio', { partyId: 'p' }, alice);
  expect(result.items).toHaveLength(13); expect(result.nextToken).toBeTruthy();
  expect(h.portfolio).toHaveBeenCalledWith({ partyId: 'p' }, { limit: 25, nextToken: undefined });
  expect(h.send).toHaveBeenCalledTimes(3); // relationships, accounts, assignment/tombstone batch
  expect(result.items.every((r: any) => Number(r.account.id.slice(1)) % 2 === 0)).toBe(true);
});
it('filters legacy candidates in storage, names only the current page, and preserves empty authorized continuations', async () => {
  h.send.mockImplementation(async cmd => {
    if (cmd.input.RequestItems) return { Responses: { Account: [{ id: 'foreign', name: 'Hidden insured' }], Communication: [{ id: 'workflow:foreign', data: { salespersonId: 'bob' } }] } };
    expect(cmd.input.FilterExpression).toContain('attribute_not_exists(#party)');
    expect(cmd.input.FilterExpression).toContain('#until > :day');
    return { Items: [{ id: 'c', accountId: 'foreign', type: 'MANAGER' }], LastEvaluatedKey: { id: `next-${h.send.mock.calls.length}` } };
  });
  const result = await relationshipRead('relationshipLegacyCandidates', {}, alice);
  expect(result.items).toEqual([]); expect(result.nextToken).toBeTruthy();
  expect(h.send.mock.calls.filter(([cmd]) => cmd.input.RequestItems)).toHaveLength(2);
});
