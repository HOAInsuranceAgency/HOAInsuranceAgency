// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { packageTerms } from '../../../shared/quotePackages';
import { commissionAccount, commissionPolicy } from './commissionFixtures';
import { assertTransactionEnvelope } from '../../amplify/functions/storage/transactions';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({ rows: new Map<string, Row>(), transactions: [] as any[][],
  beforeCommit: undefined as (() => void) | undefined, committed: 0 }));
vi.mock('../../amplify/functions/crm-access/access', async original => {
  const actual = await original<typeof import('../../amplify/functions/crm-access/access')>();
  return { ...actual, AccountAccess: class extends actual.AccountAccess {
    constructor(identity: ConstructorParameters<typeof actual.AccountAccess>[0], _reader?: unknown,
      request?: ConstructorParameters<typeof actual.AccountAccess>[2]) {
      super(identity, async (model, key) => structuredClone(h.rows.get(`${model}:${key}`)), request);
    }
  } };
});
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  accountAgreements: async () => [],
}));
vi.mock('../../amplify/functions/commissions/store', () => ({
  table: () => 'commissions',
  get: async (kind: string, id: string) => structuredClone(h.rows.get(`commissions:${kind}:${id}`)),
  db: { send: async () => ({ Items: [] }) },
  commit: async (changes: Row[], _actor: string, guards: Row[]) => {
    h.transactions.push(structuredClone(guards));
    assertTransactionEnvelope(guards, { keyFields: () => ['id'], error: () => new Error('Duplicate transaction target') });
    const before = h.beforeCommit; h.beforeCommit = undefined; before?.();
    for (const guard of guards) {
      const op = guard.ConditionCheck ?? guard.Update ?? guard.Put;
      const key = op.Key ?? { id: op.Item.id };
      const prior = h.rows.get(`${op.TableName}:${key.kind ? `${key.kind}:` : ''}${key.id ?? key.userId}`);
      const names = op.ExpressionAttributeNames ?? {}, values = op.ExpressionAttributeValues ?? {};
      const fail = () => { throw Object.assign(new Error('Concurrent access change'), { name: 'TransactionCanceledException' }); };
      for (let term of String(op.ConditionExpression ?? '').split(' AND ')) {
        if (term.startsWith('(') && term.endsWith(')')) term = term.slice(1, -1);
        if (term === 'attribute_not_exists(id)' && prior) fail();
        if (term === 'attribute_not_exists(#disabled) OR #disabled = :active') {
          if (prior?.disabled !== undefined && prior.disabled !== values[':active']) fail();
          continue;
        }
        const equality = /^(#\w+|updatedAt) = (:\w+)$/.exec(term);
        if (equality && JSON.stringify(prior?.[names[equality[1]] ?? equality[1]]) !== JSON.stringify(values[equality[2]])) fail();
      }
    }
    // Simulate DynamoDB's all-or-nothing application only after every real
    // authorization/source condition has passed.
    for (const change of changes) h.rows.set(`commissions:${change.kind}:${change.value.id}`, structuredClone(change.value));
    for (const guard of guards) {
      if (guard.Put) h.rows.set(`${guard.Put.TableName}:${guard.Put.Item.id}`, structuredClone(guard.Put.Item));
      if (guard.Update) {
        const op = guard.Update, row = h.rows.get(`${op.TableName}:${op.Key.id}`)!;
        for (const assignment of op.UpdateExpression.replace(/^SET /, '').split(', ')) {
          const [field, value] = assignment.split(' = ');
          row[op.ExpressionAttributeNames?.[field] ?? field] = op.ExpressionAttributeValues[value];
        }
      }
    }
    h.committed++;
  },
}));
import { bindPolicy } from '../../amplify/functions/commissions/bind';

const settingsKey = 'Communication:settings:salesperson-access:v1';
const event = (actor = 'alice', role = 'PRODUCER') => ({ identity: { sub: actor, groups: [role] }, request: { headers: { 'x-crm-role': role } } });
const input = () => ({ quoteId: 'q', premium: '100000', agencyRate: '12', billType: 'DIRECT',
  policyNumber: 'POL-1', terms: packageTerms(h.rows.get('Quote:q') as any) });
beforeEach(() => {
  h.rows.clear(); h.transactions = []; h.beforeCommit = undefined; h.committed = 0;
  vi.stubEnv('COMMUNICATION_TABLE', 'Communication');
  vi.stubEnv('USER_ACCESS_TABLE', 'users');
  vi.stubEnv('ACCESS_TABLES', JSON.stringify({ Account: 'Account', Quote: 'Quote', Policy: 'Policy' }));
  vi.stubEnv('COMMISSION_POLICY_ACCOUNT_INDEX', 'by-account');
  h.rows.set('Quote:q', { id: 'q', accountId: 'a', carrierId: 'c', status: 'QUOTED', premium: 100000,
    commissionPct: 12, effectiveDate: '2026-01-01', expirationDate: '2027-01-01', lines: ['Property'], updatedAt: '2026-01-01T00:00:00Z' });
  h.rows.set('Account:a', { id: 'a', name: 'Cedar HOA', stage: 'LEAD', updatedAt: '2026-01-01T00:00:00Z' });
  h.rows.set('Communication:workflow:a', { id: 'workflow:a', data: { salespersonId: 'producer' } });
  h.rows.set(settingsKey, { id: 'settings:salesperson-access:v1', version: 1,
    data: { policy: { visibility: 'LEADS', level: 'READ', send: false, invoice: false, bind: true } } });
  h.rows.set('commissions:PLAN:producer', { id: 'producer', producerId: 'producer', name: 'Avery', version: 3,
    terms: [{ from: '2020-01-01', newBps: 1600, renewalBps: 800, agreement: 'Signed' }] });
  h.rows.set('commissions:ACCOUNT:a', commissionAccount());
  h.rows.set('commissions:CARRIER:c', commissionPolicy().carrierTerms);
});
afterEach(() => vi.unstubAllEnvs());

it.each(['LEAD', 'CLIENT'])('binds a permitted shared %s without duplicate Account targets or changing commission attribution', async stage => {
  h.rows.get('Account:a')!.stage = stage;
  if (stage === 'CLIENT') h.rows.get(settingsKey)!.data.policy.visibility = 'ALL';
  await bindPolicy(event(), input());
  expect(h.committed).toBe(1);
  const snapshot = [...h.rows.entries()].find(([key]) => key.startsWith('commissions:POLICY:'))![1];
  expect(snapshot).toMatchObject({ producerId: 'producer', producerName: 'Avery', producerBps: 1600 });
  const targets = h.transactions[0].filter(guard => (guard.Update ?? guard.ConditionCheck)?.TableName === 'Account');
  expect(targets).toHaveLength(1);
  const accountGuard = targets[0].Update ?? targets[0].ConditionCheck;
  expect(accountGuard.ConditionExpression).toContain('#stage = :stage');
  expect(h.transactions[0].filter(guard => guard.ConditionCheck?.TableName === 'users').map(guard => guard.ConditionCheck.Key.userId).sort()).toEqual(['alice', 'producer']);
});

it.each(['bind revoked', 'visibility revoked', 'ownership changed', 'stage changed without a timestamp change', 'caller deactivated', 'assigned producer deactivated'])(
  'rejects the whole shared bind when %s after permission preflight', async change => {
    h.beforeCommit = () => {
      if (change === 'bind revoked') { h.rows.get(settingsKey)!.version++; h.rows.get(settingsKey)!.data.policy.bind = false; }
      if (change === 'visibility revoked') { h.rows.get(settingsKey)!.version++; h.rows.get(settingsKey)!.data.policy.visibility = 'ASSIGNED'; }
      if (change === 'ownership changed') h.rows.get('Communication:workflow:a')!.data.salespersonId = 'other-producer';
      if (change === 'stage changed without a timestamp change') h.rows.get('Account:a')!.stage = 'CLIENT';
      if (change === 'caller deactivated') h.rows.set('users:alice', { userId: 'alice', disabled: true });
      if (change === 'assigned producer deactivated') h.rows.set('users:producer', { userId: 'producer', disabled: true });
    };
    await expect(bindPolicy(event(), input())).rejects.toThrow('Concurrent access change');
    expect(h.transactions).toHaveLength(1);
    expect(h.committed).toBe(0);
    expect([...h.rows.keys()].some(key => key.startsWith('Policy:') || key.startsWith('commissions:POLICY:'))).toBe(false);
    expect(h.rows.get('Quote:q')!.status).toBe('QUOTED');
  },
);

it.each(['assigned', 'admin'])('preserves existing %s bind access when the shared permission changes', async mode => {
  h.beforeCommit = () => { h.rows.get(settingsKey)!.version++; h.rows.get(settingsKey)!.data.policy.bind = false; };
  await bindPolicy(mode === 'assigned' ? event('producer') : event('owner', 'OWNER'), input());
  expect(h.committed).toBe(1);
  expect(h.transactions[0].some(guard => guard.ConditionCheck?.Key.id === 'settings:salesperson-access:v1')).toBe(false);
  const users = h.transactions[0].filter(guard => guard.ConditionCheck?.TableName === 'users');
  expect(users).toHaveLength(mode === 'assigned' ? 1 : 2);
});
