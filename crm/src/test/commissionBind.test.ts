import { beforeEach, expect, it, vi } from 'vitest';
import { packageTerms } from '../../../shared/quotePackages';
import { commissionPolicy, commissionAccount } from './commissionFixtures';
const h = vi.hoisted(() => ({
  get: vi.fn(),
  commit: vi.fn(),
  send: vi.fn(),
  rows: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../../amplify/functions/commissions/store', () => ({
  get: h.get,
  commit: h.commit,
  db: { send: h.send },
  table: () => 'commissions',
}));
vi.mock('../../amplify/functions/crm-access/user-status', () => ({
  activeTeamUserCheck: (id: string) => ({
    ConditionCheck: { TableName: 'users', Key: { userId: id } },
  }),
}));
vi.mock('../../amplify/functions/crm-access/access', () => ({
  tableName: (model: string) => model,
  AccountAccess: class {
    actor = 'owner';
    get(model: string, id: string) {
      return Promise.resolve(h.rows.get(`${model}:${id}`));
    }
    async requireRecord(model: string, id: string) {
      const r = h.rows.get(`${model}:${id}`);
      if (!r) throw new Error('Not authorized');
      return r;
    }
  },
}));
import { bindPolicy } from '../../amplify/functions/commissions/bind';
const quote = {
  id: 'q',
  accountId: 'a',
  carrierId: 'c',
  status: 'QUOTED',
  premium: 100000,
  commissionPct: 12,
  effectiveDate: '2026-01-01',
  expirationDate: '2027-01-01',
  lines: ['Property'],
  updatedAt: '2026-01-01T00:00:00Z',
};
const input = () => ({
  quoteId: 'q',
  premium: '100000',
  agencyRate: '12',
  billType: 'DIRECT',
  policyNumber: 'POL-1',
  terms: packageTerms(quote),
});
const event = {
  identity: { sub: 'owner', groups: ['OWNER'] },
  request: { headers: { 'x-crm-role': 'OWNER' } },
};
beforeEach(() => {
  vi.resetAllMocks();
  h.rows.clear();
  vi.stubEnv('COMMISSION_POLICY_ACCOUNT_INDEX', 'verified-account-index');
  h.rows.set('Quote:q', quote);
  h.rows.set('Account:a', {
    id: 'a',
    name: 'Cedar HOA',
    stage: 'LEAD',
    updatedAt: '2026-01-01',
  });
  h.rows.set('Communication:workflow:a', {
    data: { salespersonId: 'producer' },
  });
  h.get.mockImplementation(async (kind) =>
    kind === 'PLAN'
      ? {
          id: 'producer',
          producerId: 'producer',
          name: 'Avery',
          version: 3,
          terms: [
            {
              from: '2020-01-01',
              newBps: 1600,
              renewalBps: 800,
              agreement: 'Signed',
            },
          ],
        }
      : kind === 'ACCOUNT'
        ? commissionAccount()
        : kind === 'CARRIER'
          ? commissionPolicy().carrierTerms
          : undefined,
  );
  h.send.mockResolvedValue({ Items: [] });
  h.commit.mockResolvedValue(undefined);
});
it('atomically binds, converts the lead, and freezes the original producer rate without a receipt', async () => {
  const result = await bindPolicy(event, input());
  expect(result.account).toMatchObject({ stage: 'CLIENT' });
  const [changes, actor, extras] = h.commit.mock.calls[0];
  expect(actor).toBe('owner');
  expect(changes[0].value).toMatchObject({
    producerId: 'producer',
    producerBps: 1600,
    planVersion: 3,
    premiumCents: 10000000,
    agencyRateUnits: 120000,
    entries: [],
  });
  expect(extras).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: 'Policy',
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({ TableName: 'Quote' }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({ TableName: 'Account' }),
      }),
    ]),
  );
  expect(h.send.mock.calls[0][0].input.IndexName).toBe('verified-account-index');
});
it.each([
  { billType: '' },
  { agencyRate: '' },
  { agencyRate: '11' },
  { premium: '100000.001' },
  { terms: 'stale' },
])('rejects invalid or unconfirmed bind values %#', async (patch) => {
  await expect(bindPolicy(event, { ...input(), ...patch })).rejects.toThrow();
  expect(h.commit).not.toHaveBeenCalled();
});
it('uses the renewal rate and freezes it separately', async () => {
  const renewal = { ...quote, renewalPolicyId: 'prior' };
  h.rows.set('Quote:q', renewal);
  h.rows.set('Policy:prior', { id: 'prior', accountId: 'a' });
  await bindPolicy(event, { ...input(), terms: packageTerms(renewal) });
  expect(h.commit.mock.calls[0][0][0].value).toMatchObject({
    transaction: 'RENEWAL',
    producerBps: 800,
  });
});
it('returns the existing result on retry without a second write', async () => {
  const prior = commissionPolicy();
  h.get.mockImplementation(async (kind, id) => (kind === 'POLICY' ? { ...prior, id } : undefined));
  // Capture the deterministic ID from a successful first request shape.
  const { createHash } = await import('node:crypto');
  const id = `bound-${createHash('sha256').update('q').digest('hex').slice(0, 40)}`;
  h.rows.set(`Policy:${id}`, { id, accountId: 'a' });
  expect(await bindPolicy(event, input())).toMatchObject({
    replayed: true,
    policy: { id },
  });
  expect(h.commit).not.toHaveBeenCalled();
});
it('checks later legacy policy pages before a new bind', async () => {
  h.send
    .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: 'cursor' } })
    .mockResolvedValueOnce({ Items: [{ id: 'old', quoteId: 'q' }] });
  await expect(bindPolicy(event, input())).rejects.toThrow(/already has/);
  expect(h.commit).not.toHaveBeenCalled();
});
it('blocks a stale client selection and missing agreement setup', async () => {
  h.rows.set('Communication:commercial:a', {
    data: {
      selectedOptionId: 'opt',
      options: [{ id: 'opt', quoteIds: ['q'] }],
      selectedTerms: { q: 'old' },
    },
  });
  await expect(bindPolicy(event, input())).rejects.toThrow(/selected package/);
  h.rows.delete('Communication:commercial:a');
  h.get.mockResolvedValue(undefined);
  await expect(bindPolicy(event, input())).rejects.toThrow(/configure/);
  expect(h.commit).not.toHaveBeenCalled();
});

it.each(['NEW', 'RENEWAL'] as const)(
  'freezes GIM %s terms and guards classification against concurrent edits',
  async (transaction) => {
    const fallback = h.get.getMockImplementation()!;
    h.get.mockImplementation(async (kind, id) => {
      const original = await fallback(kind, id);
      if (kind === 'ACCOUNT')
        return {
          ...commissionAccount(),
          periods: [
            {
              from: '2020-01-01',
              classification: 'GIM',
              evidence: 'GIM management source',
            },
          ],
        };
      if (kind === 'PLAN')
        return {
          ...original,
          terms: original.terms.map((t: object) => ({
            ...t,
            gim: { newBps: 500, renewalBps: 250, agreement: 'GIM addendum' },
          })),
        };
      return original;
    });
    if (transaction === 'RENEWAL') {
      h.rows.set('Quote:q', { ...quote, renewalPolicyId: 'prior' });
      h.rows.set('Policy:prior', { id: 'prior', accountId: 'a' });
    }
    await bindPolicy(event, {
      ...input(),
      terms: packageTerms(h.rows.get('Quote:q') as unknown as typeof quote),
    });
    const [changes, , guards] = h.commit.mock.calls[0];
    expect(changes[0].value).toMatchObject({
      transaction,
      producerBps: transaction === 'NEW' ? 500 : 250,
      agreement: 'GIM addendum',
      accountClassification: {
        classification: 'GIM',
        version: 2,
        evidence: 'GIM management source',
      },
    });
    expect(guards).toContainEqual({
      ConditionCheck: {
        TableName: 'commissions',
        Key: { kind: 'ACCOUNT', id: 'a' },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': 2 },
      },
    });
  },
);
it.each(['missing account', 'missing GIM terms'])(
  'blocks %s without writing a policy or converting the lead',
  async (scenario) => {
    const fallback = h.get.getMockImplementation()!;
    h.get.mockImplementation(async (kind, id) =>
      kind === 'ACCOUNT'
        ? scenario === 'missing account'
          ? undefined
          : {
              ...commissionAccount(),
              periods: [{ from: '2020-01-01', classification: 'GIM', evidence: 'GIM' }],
            }
        : fallback(kind, id),
    );
    await expect(bindPolicy(event, input())).rejects.toThrow(/Owner must/);
    expect(h.commit).not.toHaveBeenCalled();
  },
);

it('records the first bind atomically with the policy and replaces the duplicate account guard', async () => {
  const fallback = h.get.getMockImplementation()!;
  h.get.mockImplementation(async (kind, id) => {
    const value = await fallback(kind, id);
    if (kind === 'ACCOUNT')
      return { ...value, neverBound: true, bindingEvidence: 'Owner confirmed never bound' };
    if (kind === 'PLAN') return { ...value, accountBoundFrom: '2026-10-01' };
    return value;
  });
  await bindPolicy(event, input());
  const [changes, , guards] = h.commit.mock.calls[0];
  expect(changes[0].value.eligibility.eligible).toBe(true);
  expect(changes[1]).toMatchObject({
    kind: 'ACCOUNT',
    previous: { version: 2 },
    value: {
      firstBoundOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      firstBindPolicyId: changes[0].value.id,
    },
  });
  expect(changes[1].value.neverBound).toBeUndefined();
  expect(
    guards.some(
      (g: { ConditionCheck?: { Key?: { kind: string } } }) =>
        g.ConditionCheck?.Key?.kind === 'ACCOUNT',
    ),
  ).toBe(false);
});
it('preserves the account exclusion on a later renewal', async () => {
  const fallback = h.get.getMockImplementation()!;
  h.get.mockImplementation(async (kind, id) => {
    const value = await fallback(kind, id);
    if (kind === 'ACCOUNT')
      return { ...value, firstBoundOn: '2026-09-30', bindingEvidence: 'Original binder' };
    if (kind === 'PLAN') return { ...value, accountBoundFrom: '2026-10-01' };
    return value;
  });
  const renewal = {
    ...quote,
    effectiveDate: '2027-01-01',
    expirationDate: '2028-01-01',
    renewalPolicyId: 'prior',
  };
  h.rows.set('Quote:q', renewal);
  h.rows.set('Policy:prior', { id: 'prior', accountId: 'a' });
  await bindPolicy(event, { ...input(), terms: packageTerms(renewal) });
  expect(h.commit.mock.calls[0][0][0].value).toMatchObject({
    producerBps: 0,
    eligibility: { eligible: false, accountFirstBoundOn: '2026-09-30' },
  });
});
