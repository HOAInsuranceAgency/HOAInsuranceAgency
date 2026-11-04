import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ records: new Map<string, any>(), calls: [] as any[], candidates: new Map<string, any[]>(), unprocessed: 0, cleanupFailure: false, advanceOnProjectMs: 0 }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({
  ...(await original<typeof import('@aws-sdk/lib-dynamodb')>()),
  DynamoDBDocumentClient: { from: () => ({ send: async (command: any) => {
    const input = command.input, name = command.constructor.name; h.calls.push({ name, input });
    const key = (table: string, value: any) => `${table}|${value.id ?? `${value.pk}|${value.sk}`}`;
    if (name === 'GetCommand') return { Item: structuredClone(h.records.get(key(input.TableName, input.Key))) };
    if (name === 'BatchGetCommand') {
      const [table, request] = Object.entries(input.RequestItems)[0] as [string, any];
      if (h.unprocessed-- > 0) return { UnprocessedKeys: { [table]: { Keys: request.Keys } } };
      return { Responses: { [table]: request.Keys.flatMap((value: any) => {
        const record = h.records.get(key(table, value));
        if (!record) return [];
        const fields = request.ExpressionAttributeNames ? Object.values(request.ExpressionAttributeNames) as string[] : undefined;
        return [structuredClone(fields ? Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]])) : record)];
      }) } };
    }
    if (name === 'QueryCommand') {
      if (input.TableName === 'projection') return { Items: [...h.records.values()].filter(record => record.pk === input.ExpressionAttributeValues[':kind']).slice(0, input.Limit) };
      expect(input.IndexName).toBeTruthy();
      const field = input.ExpressionAttributeNames['#field'] ?? input.ExpressionAttributeNames['#owner'];
      const value = input.ExpressionAttributeValues[':value'] ?? input.ExpressionAttributeValues[':owner'];
      const rows = h.candidates.get(input.TableName) ?? [...h.records].filter(([id]) => id.startsWith(`${input.TableName}|`)).map(([, record]) => record);
      return { Items: rows.filter(row => row[field] === value).map(row => ({ id: row.id })) };
    }
    if (name === 'TransactWriteCommand') {
      if (h.cleanupFailure && input.TransactItems.some((item: any) => item.Delete)) { h.cleanupFailure = false; throw new Error('Interrupted cleanup'); }
      expect(input.TransactItems.length).toBeLessThanOrEqual(100);
      if (h.advanceOnProjectMs && input.TransactItems.some((item: any) => item.Put?.Item.sk === 'SNAPSHOT')) vi.setSystemTime(Date.now() + h.advanceOnProjectMs);
      for (const { Put, Delete } of input.TransactItems) {
        if (Put) h.records.set(key(Put.TableName, Put.Item), structuredClone(Put.Item));
        if (Delete) h.records.delete(key(Delete.TableName, Delete.Key));
      }
      return {};
    }
    if (name === 'PutCommand') { h.records.set(key(input.TableName, input.Item), structuredClone(input.Item)); return {}; }
    if (name === 'DeleteCommand') { h.records.delete(key(input.TableName, input.Key)); return {}; }
    if (name === 'UpdateCommand') {
      const current = h.records.get(key(input.TableName, input.Key));
      expect(current.generation).toBe(input.ExpressionAttributeValues[':generation']); delete current.obsoleteKeys; return {};
    }
    throw new Error(`Unexpected ${name}`);
  } }) },
}));
import { emptyCommercialPlan, packageTerms } from '../../../shared/quotePackages';
import { drainNameRefresh, queueNameRefresh, projectAccount, readProjectionSource } from '../../amplify/functions/account-list/store';
const today = '2026-11-04', at = `${today}T15:00:00.000Z`;
const snapshot = () => h.records.get('projection|ACCOUNT#a|SNAPSHOT');
beforeEach(() => {
  h.records.clear(); h.calls.length = 0; h.candidates.clear(); h.unprocessed = 0; h.cleanupFailure = false; h.advanceOnProjectMs = 0;
  process.env.ACCOUNT_LIST_TABLE = 'projection';
  process.env.ACCOUNT_LIST_SOURCE_TABLES = JSON.stringify({ Account: 'accounts', Contact: 'contacts', Quote: 'quotes', Policy: 'policies', Communication: 'comms', UserProfile: 'profiles' });
  process.env.ACCOUNT_LIST_SOURCE_INDEXES = JSON.stringify({ Contact: 'accountId', Quote: 'accountId', Policy: 'accountId', UserProfile: 'userId' });
  h.records.set('accounts|a', { id: 'a', name: 'Elm HOA', stage: 'LEAD', type: 'ASSOCIATION', updatedAt: at });
  h.records.set('comms|workflow:a', { id: 'workflow:a', version: 1, kind: 'WORKFLOW', assignedSalespersonId: 'alice', data: { accountId: 'a', salespersonId: 'alice' } });
  h.records.set('profiles|profile', { id: 'profile', userId: 'alice', firstName: 'Alice', lastName: 'Current', updatedAt: at });
});
afterEach(() => vi.useRealTimers());
it('re-reads GSI candidates consistently and includes a newly visible stream child without exposing its former parent', async () => {
  h.candidates.set('contacts', [{ id: 'moved', accountId: 'a' }]);
  h.records.set('contacts|moved', { id: 'moved', accountId: 'b', name: 'Private B', updatedAt: at });
  h.records.set('contacts|new', { id: 'new', accountId: 'a', name: 'Current A', updatedAt: at });
  const source = await readProjectionSource('a', { Contact: ['new', 'moved'] });
  expect(source.contacts).toEqual([{ id: 'new', accountId: 'a', name: 'Current A', updatedAt: at }]);
  expect(h.calls.filter(call => call.name === 'BatchGetCommand').every(call => Object.values(call.input.RequestItems).every((request: any) => request.ConsistentRead === true))).toBe(true);
  expect(h.calls.some(call => call.name === 'ScanCommand')).toBe(false);
});
it('atomically publishes all keys and its pointer, then removes old assignment/sort keys without reviving them on retries', async () => {
  await projectAccount('a', today, at);
  const first = structuredClone(snapshot());
  expect(first.indexKeys).toHaveLength(30);
  const transaction = h.calls.find(call => call.name === 'TransactWriteCommand').input.TransactItems;
  expect(transaction).toHaveLength(31);
  expect(transaction.at(-1).Put.Item.sk).toBe('SNAPSHOT');
  // Attribute-map ordering is not stable across DynamoDB responses.
  snapshot().indexKeys = snapshot().indexKeys.map(({ pk, sk }: any) => ({ sk, pk }));
  h.records.get('accounts|a').name = 'Renamed'; h.records.get('accounts|a').updatedAt = 'later';
  h.records.get('comms|workflow:a').version = 2; h.records.get('comms|workflow:a').data.salespersonId = 'bob';
  await projectAccount('a', today, at);
  expect(snapshot().generation).not.toBe(first.generation);
  expect(snapshot().indexKeys.every((key: any) => h.records.has(`projection|${key.pk}|${key.sk}`))).toBe(true);
  expect([...h.records].some(([id]) => id.startsWith('projection|V1#USER#alice#'))).toBe(false);
  const writes = h.calls.filter(call => call.name === 'TransactWriteCommand').length;
  expect(await projectAccount('a', today, at)).toMatchObject({ changed: false });
  expect(h.calls.filter(call => call.name === 'TransactWriteCommand')).toHaveLength(writes);
});
it('retains an obsolete-key cleanup journal so interruption resumes after the pointer already changed', async () => {
  await projectAccount('a', today, at);
  h.records.get('accounts|a').name = 'Renamed'; h.records.get('accounts|a').updatedAt = 'later';
  h.cleanupFailure = true;
  await expect(projectAccount('a', today, at)).rejects.toThrow('Interrupted cleanup');
  expect(snapshot().item.account.name).toBe('Renamed');
  expect(snapshot().obsoleteKeys.length).toBeGreaterThan(0);
  const obsolete = structuredClone(snapshot().obsoleteKeys);
  await projectAccount('a', today, at);
  expect(snapshot().obsoleteKeys).toBeUndefined();
  expect(obsolete.every((key: any) => !h.records.has(`projection|${key.pk}|${key.sk}`))).toBe(true);
});
it('removes the snapshot and all keys for deleted sources or an in-progress deletion marker', async () => {
  await projectAccount('a', today, at);
  h.records.set('comms|deleted-account:a', { id: 'deleted-account:a', version: 1 });
  expect(await projectAccount('a', today, at)).toEqual({ changed: true, removed: true });
  expect([...h.records].some(([id]) => id.startsWith('projection|'))).toBe(false);
});
it('retries unprocessed keys and refuses unconfigured source indexes instead of publishing a partial snapshot', async () => {
  h.unprocessed = 1;
  await projectAccount('a', today, at);
  expect(snapshot()).toBeDefined();
  process.env.ACCOUNT_LIST_SOURCE_INDEXES = '{}';
  await expect(projectAccount('a', today, at)).rejects.toThrow('index is not configured');
});

it('checkpoints large name fan-outs so each bounded slice progresses and source events only enqueue', async () => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  for (let i = 0; i < 8; i++) {
    const id = `book${i}`;
    h.records.set(`accounts|${id}`, { id, name: id, stage: 'LEAD', type: 'ASSOCIATION', updatedAt: at });
    h.records.set(`comms|workflow:${id}`, { id: `workflow:${id}`, kind: 'WORKFLOW', version: 1, assignedSalespersonId: 'alice', data: { accountId: id, salespersonId: 'alice' } });
  }
  h.records.delete('comms|workflow:a');
  await queueNameRefresh('alice', ['profile']);
  expect(h.calls.filter(call => call.name === 'QueryCommand')).toHaveLength(0);
  h.advanceOnProjectMs = 50;
  await drainNameRefresh({ budgetMs: 100 });
  expect(h.records.get('projection|FANOUT|alice').pendingIds).toEqual(['book4', 'book5', 'book6', 'book7']);
  await drainNameRefresh({ budgetMs: 100 });
  expect(h.records.has('projection|FANOUT|alice')).toBe(false);
  expect([...h.records.values()].filter(record => record.sk === 'SNAPSHOT')).toHaveLength(8);
});

it('keeps approved coverage terms in compact quote reads so reviewed packages retain their pending commission', async () => {
  const quote = { id: 'q', accountId: 'a', status: 'QUOTED', carrierId: 'carrier', lines: ['GL'], premium: 1000, commissionPct: 10,
    effectiveDate: '2026-12-01', expirationDate: '2027-12-01', perOccurrenceDeductible: 5000, glEachOccurrence: 1000000, minimumEarnedPremiumPct: 25, notes: 'Approved terms', updatedAt: at };
  const terms = { q: packageTerms(quote) };
  const plan = { ...emptyCommercialPlan('a'), requiredLines: ['GL'], options: [{ id: 'chosen', name: 'Chosen', quoteIds: ['q'], reviewed: { at, by: 'sales', terms } }] };
  h.records.set('quotes|q', quote);
  h.records.set('comms|commercial:a', { id: 'commercial:a', version: 1, data: plan });
  await projectAccount('a', today, at);
  expect(snapshot().item.forecast).toMatchObject({ cents: 10000, label: 'Lowest complete package' });
  expect(snapshot().item).not.toHaveProperty('quotes');
});

it('keeps optional packet terms in compact reads without counting supplier charges or HOA fees as pending premium commission', async () => {
  const charges = [{ id: 'supplier', kind: 'WHOLESALER_FEE', description: 'Supplier charge marker', amountCents: 25000 }];
  const quote = { id: 'q', accountId: 'a', status: 'QUOTED', carrierId: 'carrier', lines: ['GL'], premium: 1000, commissionPct: 10,
    brokerFee: 125.50, billType: 'AGENCY', passThroughCharges: JSON.stringify(charges), clientConditions: 'Reviewed client condition marker',
    effectiveDate: '2026-12-01', expirationDate: '2027-12-01', updatedAt: at };
  const terms = { q: packageTerms(quote) }, plan = { ...emptyCommercialPlan('a'), requiredLines: ['GL'], selectedOptionId: 'chosen', selectedTerms: terms,
    options: [{ id: 'chosen', name: 'Chosen', quoteIds: ['q'], reviewed: { at, by: 'sales', terms } }] };
  h.records.set('quotes|q', quote); h.records.set('comms|commercial:a', { id: 'commercial:a', version: 1, data: plan });
  const source = await readProjectionSource('a');
  expect(source.quotes[0]).toMatchObject({ brokerFee: 125.50, billType: 'AGENCY', passThroughCharges: JSON.stringify(charges), clientConditions: quote.clientConditions });
  expect(packageTerms(source.quotes[0] as never)).toBe(terms.q);
  await projectAccount('a', today, at);
  expect(snapshot().item.forecast).toMatchObject({ cents: 10000, label: 'Client-selected package' });
  expect(JSON.stringify(snapshot().item)).not.toMatch(/Supplier charge marker|Reviewed client condition marker|passThroughCharges|clientConditions|selectedTerms/);
});

it.each(['passThroughCharges', 'clientConditions'])('fails closed when compact current %s are malformed instead of reusing a legacy approval', async field => {
  const quote = { id: 'q', accountId: 'a', status: 'QUOTED', carrierId: 'carrier', lines: ['GL'], premium: 1000, commissionPct: 10,
    effectiveDate: '2026-12-01', expirationDate: '2027-12-01', updatedAt: at };
  const terms = { q: packageTerms(quote) }, plan = { ...emptyCommercialPlan('a'), requiredLines: ['GL'],
    options: [{ id: 'chosen', name: 'Chosen', quoteIds: ['q'], reviewed: { at, by: 'sales', terms } }] };
  h.records.set('quotes|q', quote); h.records.set('comms|commercial:a', { id: 'commercial:a', version: 1, data: plan });
  await projectAccount('a', today, at); expect(snapshot().item.forecast.cents).toBe(10000);
  Object.assign(quote, { [field]: field === 'passThroughCharges' ? '{bad' : 'invalid\0condition', updatedAt: '2026-11-04T16:00:00Z' });
  await projectAccount('a', today, at);
  expect(snapshot().item.forecast).toMatchObject({ cents: null, label: 'Incomplete package' });
});

it('preserves a legacy package approval when optional packet fields are saved empty', async () => {
  const quote = { id: 'q', accountId: 'a', status: 'QUOTED', carrierId: 'carrier', lines: ['GL'], premium: 1000, commissionPct: 10,
    effectiveDate: '2026-12-01', expirationDate: '2027-12-01', updatedAt: at };
  const terms = { q: packageTerms(quote) }, plan = { ...emptyCommercialPlan('a'), requiredLines: ['GL'],
    options: [{ id: 'chosen', name: 'Chosen', quoteIds: ['q'], reviewed: { at, by: 'sales', terms } }] };
  Object.assign(quote, { passThroughCharges: [], clientConditions: '  ' });
  h.records.set('quotes|q', quote); h.records.set('comms|commercial:a', { id: 'commercial:a', version: 1, data: plan });
  expect(packageTerms((await readProjectionSource('a')).quotes[0] as never)).toBe(terms.q);
  await projectAccount('a', today, at);
  expect(snapshot().item.forecast).toMatchObject({ cents: 10000, label: 'Lowest complete package' });
});
