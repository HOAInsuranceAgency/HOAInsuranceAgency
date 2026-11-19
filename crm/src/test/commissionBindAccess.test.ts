// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { packageTerms } from '../../../shared/quotePackages';
import { commissionAccount, commissionPolicy } from './commissionFixtures';
import { assertTransactionEnvelope } from '../../amplify/functions/storage/transactions';

type Row = Record<string, any>;
const h = vi.hoisted(() => ({ rows: new Map<string, Row>(), transactions: [] as any[][], agreements: [] as Row[],
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
  accountAgreements: async () => structuredClone(h.agreements),
  accountModels: async (model: string, accountId: string) => structuredClone([...h.rows.entries()]
    .filter(([key, row]) => key.startsWith(`${model}:`) && row.accountId === accountId).map(([, row]) => row)),
  getModel: async (model: string, id: string) => structuredClone(h.rows.get(`${model}:${id}`)),
}));
vi.mock('../../amplify/functions/commissions/store', () => ({
  table: () => 'commissions',
  get: async (kind: string, id: string) => structuredClone(h.rows.get(`commissions:${kind}:${id}`)),
  db: { send: async (command: { input: Row }) => {
    const input = command.input, values = input.ExpressionAttributeValues;
    if (input.TableName !== 'Document') return { Items: [] };
    return { Items: structuredClone([...h.rows.entries()].filter(([key, row]) => key.startsWith('Document:')
      && row.entityId === values[':entity'] && row.entityType === values[':type'] && row.quoteId === values[':quote']).map(([, row]) => row)) };
  } },
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
        const absent = /^attribute_not_exists\((#\w+)\)$/.exec(term);
        if (absent && prior && Object.hasOwn(prior, names[absent[1]])) fail();
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
import { AccountAccess } from '../../amplify/functions/crm-access/access';
import { authorizedQuoteTerms } from '../../../shared/quoteAuthorization';

const settingsKey = 'Communication:settings:salesperson-access:v1';
const event = (actor = 'alice', role = 'PRODUCER') => ({ identity: { sub: actor, groups: [role] }, request: { headers: { 'x-crm-role': role } } });
const input = () => ({ quoteId: 'q', premium: '100000', agencyRate: '12', billType: 'DIRECT',
  policyNumber: 'POL-1', terms: packageTerms(h.rows.get('Quote:q') as any) });
beforeEach(() => {
  h.rows.clear(); h.transactions = []; h.agreements = []; h.beforeCommit = undefined; h.committed = 0;
  vi.stubEnv('COMMUNICATION_TABLE', 'Communication');
  vi.stubEnv('USER_ACCESS_TABLE', 'users');
  vi.stubEnv('ACCESS_TABLES', JSON.stringify({ Account: 'Account', Quote: 'Quote', Policy: 'Policy', Invoice: 'Invoice', PfLoan: 'PfLoan', Document: 'Document', PfComplianceLog: 'PfComplianceLog' }));
  vi.stubEnv('BROKER_FEE_TABLE', 'Fees');
  vi.stubEnv('ACCESS_INDEXES', JSON.stringify({ 'Document.entityId': 'document-entity' }));
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

function linkedSources() {
  const updatedAt = '2026-01-01T00:00:00Z';
  h.rows.set('Invoice:invoice', { id: 'invoice', accountId: 'a', quoteId: 'q', status: 'PAID', updatedAt,
    sourcePricingVersion: 1, paidAt: updatedAt, stripePaymentIntentId: 'pi_history', retailAmount: 100000 });
  h.rows.set('Document:document', { id: 'document', entityType: 'ACCOUNT', entityId: 'a', quoteId: 'q',
    category: 'BUDGET', name: 'budget.pdf', s3Key: 'documents/ACCOUNT/a/document/budget.pdf', updatedAt, lastWriteBy: 'uploader' });
  h.rows.set('PfLoan:loan', { id: 'loan', accountId: 'a', quoteId: 'q', status: 'ACTIVE', state: 'TX', updatedAt,
    principalFinanced: 90000, paidThrough: 3, balance: 60000, autopayPendingIntentId: 'pi_pending' });
  h.rows.set('PfLoan:terminal', { ...h.rows.get('PfLoan:loan'), id: 'terminal', status: 'CANCELLED' });
  h.rows.set('PfLoan:grouped', { ...h.rows.get('PfLoan:loan'), id: 'grouped', groupedInvoiceId: 'grouped-invoice', groupedPolicyIds: ['older-policy'] });
}

it.each(['PAID', 'PROCESSING'])('atomically completes %s quote billing links for a bind-only salesperson before losing LEADS visibility', async status => {
  linkedSources();
  h.rows.get('Invoice:invoice')!.status = status;
  const { updatedAt: _invoiceVersion, ...originalInvoice } = structuredClone(h.rows.get('Invoice:invoice')!);
  const { updatedAt: _loanVersion, ...originalLoan } = structuredClone(h.rows.get('PfLoan:loan')!);
  await expect(new AccountAccess(event().identity).requireCapability('a', 'invoice')).rejects.toThrow();
  const result = await bindPolicy(event(), input());
  expect(h.committed).toBe(1);
  expect(result.account.stage).toBe('CLIENT');
  for (const key of ['Invoice:invoice', 'Document:document', 'PfLoan:loan'])
    expect(h.rows.get(key)).toMatchObject({ quoteId: 'q', policyId: result.policy.id });
  expect(h.rows.get('Invoice:invoice')).toMatchObject(originalInvoice!);
  expect(h.rows.get('PfLoan:loan')).toMatchObject(originalLoan!);
  expect(h.rows.get('PfLoan:terminal')).not.toHaveProperty('policyId');
  expect(h.rows.get('PfLoan:grouped')).not.toHaveProperty('policyId');
  const log = [...h.rows.entries()].find(([key]) => key.startsWith('PfComplianceLog:'))![1];
  expect(log).toMatchObject({ accountId: 'a', jurisdiction: 'TX', rule: 'bind-rollover', outcome: 'PASS', actor: 'alice', actorName: 'alice' });
  expect(JSON.parse(log.inputs)).toEqual({ loanId: 'loan', quoteId: 'q', policyId: result.policy.id });
  expect(log.configSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await new AccountAccess(event().identity).canAccount('a')).toBe(false);
});

it.each(['Invoice:invoice', 'Document:document', 'PfLoan:loan'])('never overwrites an existing different policy link on %s', async key => {
  linkedSources(); h.rows.get(key)!.policyId = 'other-policy';
  await expect(bindPolicy(event(), input())).rejects.toThrow('already belongs to another policy');
  expect(h.committed).toBe(0); expect(h.transactions).toHaveLength(0);
  expect(h.rows.get(key)!.policyId).toBe('other-policy');
});

it.each(['invoice deleted', 'document deleted', 'loan deleted', 'invoice paid state changed', 'invoice account changed', 'loan cancelled', 'loan linked elsewhere', 'bind permission revoked'])(
  'leaves the quote and all other sources unbound when %s at commit', async change => {
    linkedSources();
    h.beforeCommit = () => {
      if (change === 'invoice deleted') h.rows.delete('Invoice:invoice');
      if (change === 'document deleted') h.rows.delete('Document:document');
      if (change === 'loan deleted') h.rows.delete('PfLoan:loan');
      if (change === 'invoice paid state changed') h.rows.get('Invoice:invoice')!.status = 'PROCESSING';
      if (change === 'invoice account changed') h.rows.get('Invoice:invoice')!.accountId = 'other-account';
      if (change === 'loan cancelled') h.rows.get('PfLoan:loan')!.status = 'CANCELLED';
      if (change === 'loan linked elsewhere') h.rows.get('PfLoan:loan')!.policyId = 'other-policy';
      if (change === 'bind permission revoked') { h.rows.get(settingsKey)!.version++; h.rows.get(settingsKey)!.data.policy.bind = false; }
    };
    await expect(bindPolicy(event(), input())).rejects.toThrow('Concurrent access change');
    expect(h.committed).toBe(0);
    expect(h.rows.get('Quote:q')!.status).toBe('QUOTED');
    expect(h.rows.get('Account:a')!.stage).toBe('LEAD');
    expect([...h.rows.keys()].some(key => key.startsWith('Policy:') || key.startsWith('commissions:POLICY:') || key.startsWith('PfComplianceLog:'))).toBe(false);
    if (change.endsWith(' deleted')) expect(h.rows.has({ 'invoice deleted': 'Invoice:invoice', 'document deleted': 'Document:document', 'loan deleted': 'PfLoan:loan' }[change]!)).toBe(false);
  },
);

it('retains signed package evidence on the existing single Document update without duplicating its transaction target', async () => {
  const source = h.rows.get('Quote:q')!;
  h.agreements = [{ id: 'bfa_signed', version: 1, accountId: 'a', accountName: 'Cedar HOA', jurisdiction: '',
    signature: { consent: true, signedAt: '2026-01-01T00:00:00Z' }, signedDocumentId: 'disclosure',
    quotes: [{ id: 'q', accountId: 'a', brokerFee: 0, terms: authorizedQuoteTerms(source), agencyCommissionPct: 12 }] }];
  h.rows.set('Fees:bfa_signed', h.agreements[0]);
  h.rows.set('Document:disclosure', { id: 'disclosure', entityType: 'ACCOUNT', entityId: 'a', quoteId: 'q', quoteIds: ['q'],
    policyIds: ['historical-policy'], brokerFeeAgreementId: 'bfa_signed', category: 'BROKER_FEE_DISCLOSURE', updatedAt: '2026-01-01T00:00:00Z' });
  const result = await bindPolicy(event(), input());
  expect(h.rows.get('Document:disclosure')!.policyIds).toEqual(['historical-policy', result.policy.id]);
  expect(h.rows.get('Document:disclosure')).not.toHaveProperty('policyId');
  expect(h.transactions[0].filter(guard => guard.Update?.TableName === 'Document' && guard.Update.Key.id === 'disclosure')).toHaveLength(1);
});

it.each(['record count', 'source bytes'])('refuses an excessive bind %s before committing any policy or links', async budget => {
  const count = budget === 'record count' ? 76 : 8;
  for (let n = 0; n < count; n++) h.rows.set(`Document:doc-${n}`, { id: `doc-${n}`, entityType: 'ACCOUNT', entityId: 'a', quoteId: 'q',
    updatedAt: '2026-01-01T00:00:00Z', ...(budget === 'source bytes' ? { ocrText: 'x'.repeat(280000) } : {}) });
  await expect(bindPolicy(event(), input())).rejects.toThrow(budget === 'record count' ? 'Too many quote-linked documents' : 'safe bind size');
  expect(h.committed).toBe(0); expect(h.transactions).toHaveLength(0);
  expect(h.rows.get('Account:a')!.stage).toBe('LEAD'); expect(h.rows.get('Quote:q')!.status).toBe('QUOTED');
});
