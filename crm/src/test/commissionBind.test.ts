import { beforeEach, expect, it, vi } from 'vitest';
import { packageTerms } from '../../../shared/quotePackages';
import { commissionPolicy, commissionAccount } from './commissionFixtures';
import { receiptOnlyCarrierTerms, type CarrierPaymentArrangement } from '../../../shared/commissions';
const h = vi.hoisted(() => ({
  get: vi.fn(),
  balance: vi.fn(),
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
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  accountAgreements: async () => [],
  table: () => 'Fees',
  getRow: h.balance,
  accountModels: async () => [],
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
import { validateInvoiceSourceCharges } from '../../amplify/functions/send-invoice/passThroughInvoice';
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
  vi.stubEnv('BROKER_FEE_TABLE','Fees');
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
  expect(result.policy.passThroughCharges).toEqual([]);
  expect(()=>validateInvoiceSourceCharges({invoice:{accountId:'a',policyId:String(result.policy.id),sourcePricingVersion:1},source:{id:String(result.policy.id),accountId:String(result.policy.accountId),premium:Number((result.policy as Record<string,unknown>).premium),billType:String(result.policy.billType),passThroughCharges:result.policy.passThroughCharges},lines:[{accountId:'a',kind:'TAX',retailAmount:100,costAmount:100}]})).toThrow('reviewed source quote');
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
  expect(changes[0].value.carrierTerms).not.toHaveProperty('arrangements');
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
it('copies reviewed supplier charges and client conditions without changing premium or producer earnings', async () => {
  const charges = [{ id: 'rt-fee', kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', amountCents: 25000 }];
  const reviewed = { ...quote, passThroughCharges: JSON.stringify(charges), clientConditions: 'No flat cancellations.' };
  h.rows.set('Quote:q', reviewed);
  const result = await bindPolicy(event, { ...input(), terms: packageTerms(reviewed) });
  expect(result.policy).toMatchObject({ passThroughCharges: charges, clientConditions: 'No flat cancellations.', premium: 100000 });
  expect(h.commit.mock.calls[0][0][0].value).toMatchObject({ premiumCents: 10000000, agencyRateUnits: 120000, entries: [] });
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
  await expect(bindPolicy(event, input())).rejects.toThrow(/assign a commission plan/);
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
    await expect(bindPolicy(event, input())).rejects.toThrow(scenario === "missing GIM terms" ? /No GIM rate covers/ : /Owner must/);
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

const scopedPayment = (): CarrierPaymentArrangement => ({
  id: 'property-direct', from: '2026-01-01', to: '2026-12-31',
  lines: ['Property'], billType: 'DIRECT', transaction: 'NEW',
  basis: 'EARNED', payor: 'Carrier payments', trigger: 'EARNED', cadence: 'MONTHLY',
  lagDays: 30, earningMethod: 'DAILY_PRORATA', evidence: 'Property commission agreement',
});
const configureStructuredCarrier = () => {
  const fallback = h.get.getMockImplementation()!;
  const payment = scopedPayment();
  h.get.mockImplementation(async (kind, id) => kind === 'CARRIER'
    ? { ...commissionPolicy().carrierTerms, version: 8, arrangements: [payment] }
    : fallback(kind, id));
  return payment;
};
it('freezes the confirmed applicable carrier arrangement and guards the parent version', async () => {
  const payment = configureStructuredCarrier();
  await bindPolicy(event, {
    ...input(), carrierTermsVersion: 8, carrierArrangementId: payment.id,
  });
  const [changes, , guards] = h.commit.mock.calls[0];
  expect(changes[0].value).toMatchObject({
    carrierTerms: { version: 8, basis: 'EARNED', evidence: payment.evidence, payment: { ...payment, lines: ['PROPERTY'] } },
    entries: [],
  });
  expect(changes[0].value.carrierTerms).not.toHaveProperty('arrangements');
  expect(guards).toContainEqual({
    ConditionCheck: {
      TableName: 'commissions', Key: { kind: 'CARRIER', id: 'c' },
      ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: { ':v': 8 },
    },
  });
});
it.each([
  {},
  { carrierTermsVersion: 7, carrierArrangementId: 'property-direct' },
  { carrierTermsVersion: 8, carrierArrangementId: 'other-scope' },
])('blocks unconfirmed or changed structured carrier payment terms %#', async (confirmation) => {
  configureStructuredCarrier();
  await expect(bindPolicy(event, { ...input(), ...confirmation })).rejects.toThrow(/confirm/i);
  expect(h.commit).not.toHaveBeenCalled();
});
it('requires an applicable carrier arrangement for the policy term rather than using an expired default', async () => {
  configureStructuredCarrier();
  const future = { ...quote, effectiveDate: '2027-01-01', expirationDate: '2028-01-01' };
  h.rows.set('Quote:q', future);
  await expect(bindPolicy(event, {
    ...input(), terms: packageTerms(future), carrierTermsVersion: 8, carrierArrangementId: 'property-direct',
  })).rejects.toThrow(/carrier|arrangement|terms/i);
  expect(h.commit).not.toHaveBeenCalled();
});

it('binds receipt-only tracking without guessing a payment arrangement and still freezes the plan', async () => {
  const original = h.get.getMockImplementation()!;
  h.get.mockImplementation(async (...args) => args[0] === 'CARRIER'
    ? receiptOnlyCarrierTerms({ id: 'c', name: 'Carrier', version: 6 }) : original(...args));
  await bindPolicy(event, { ...input(), carrierTermsVersion: 6 });
  const [changes, , guards] = h.commit.mock.calls[0];
  expect(changes[0].value).toMatchObject({ producerBps: 1600, planVersion: 3, entries: [],
    carrierTerms: { version: 6, receiptOnly: true, basis: 'UNSPECIFIED' } });
  expect(changes[0].value.carrierTerms).not.toHaveProperty('payment');
  expect(guards).toContainEqual({ ConditionCheck: { TableName: 'commissions', Key: { kind: 'CARRIER', id: 'c' },
    ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': 6 } } });
});

it('binds a fee-free IPFS term only with explicit proof and freezes that proof without a cash entry', async () => {
  const accepted = { ...quote, billType: 'AGENCY', ipfsAmountFinanced: 10000, carrierBillToAgency: true };
  h.rows.set('Quote:q', accepted);
  const request = { ...input(), terms: packageTerms(accepted), billType: 'AGENCY' };
  await expect(bindPolicy(event, request)).rejects.toThrow(/IPFS agreement reference/);
  await expect(bindPolicy(event, { ...request, ipfsAgreementRef: 'IPFS-123' })).rejects.toThrow(/Confirm the signed IPFS/);
  await expect(bindPolicy(event, { ...request, billType: 'DIRECT', ipfsAgreementRef: 'IPFS-123', ipfsConfirmed: true })).rejects.toThrow(/billing route/);
  expect(h.commit).not.toHaveBeenCalled();
  const proof = { ipfsAgreementRef: ' IPFS-123 ', ipfsConfirmed: true };
  const result = await bindPolicy(event, { ...request, ...proof });
  expect(result.policy).toMatchObject({ ipfsAgreementRef: 'IPFS-123', ipfsAmountFinanced: 10000, ipfsConfirmedBy: 'owner',
    carrierBillToAgency: true, carrierBillType: 'DIRECT', billType: 'AGENCY' });
  const snapshot = h.commit.mock.calls[0][0][0].value;
  expect(snapshot).toMatchObject({ ipfsCollectionRef: 'IPFS-123', ipfsConfirmedAt: result.policy.ipfsConfirmedAt, ipfsConfirmedBy: 'owner',
    ipfsAmountFinancedCents: 1000000, entries: [], brokerFeeCents: 0 });
  h.rows.set('Policy:' + result.policy.id, result.policy);
  h.get.mockImplementation(async kind => kind === 'POLICY' ? snapshot : undefined);
  await expect(bindPolicy(event, { ...request, ...proof })).resolves.toMatchObject({ replayed: true });
  await expect(bindPolicy(event, { ...request, ...proof, ipfsAgreementRef: 'IPFS-999' })).rejects.toThrow(/original IPFS/);
  expect(h.commit).toHaveBeenCalledTimes(1);
});

it('preserves the client collection route and lender reference on accepted terms', async () => {
  const chosen = { ...quote, clientBillingSelected: true, billType: 'AGENCY' };
  h.rows.set('Quote:q', chosen);
  await expect(bindPolicy(event, { ...input(), terms: packageTerms(chosen), billType:'DIRECT' })).rejects.toThrow(/billing route/);
  const financed = { ...chosen, ipfsAmountFinanced: 10000, ipfsQuoteRef: 'IPFS-456' };
  h.rows.set('Quote:q', financed);
  await expect(bindPolicy(event, { ...input(), terms: packageTerms(financed), billType:'AGENCY', ipfsAgreementRef:'IPFS-999', ipfsConfirmed:true })).rejects.toThrow(/reference from the accepted quote/);
  expect(h.commit).not.toHaveBeenCalled();
});

it('rejects IPFS evidence on an ordinary PIF policy', async () => {
  await expect(bindPolicy(event, { ...input(), ipfsConfirmed: true, ipfsAgreementRef: 'wrong-term' })).rejects.toThrow(/does not use IPFS/);
  expect(h.commit).not.toHaveBeenCalled();
});

it('shares one fee cap across terms with the same agreement and uses the observed version for concurrent bind protection', async () => {
  const { allocateIpfsAgreement } = await import('../../amplify/functions/commissions/ipfs-bind');
  const term = { billType: 'AGENCY', ipfsAmountFinanced: 10000, brokerFee: 2000 };
  const first = await allocateIpfsAgreement('a', 'ipfs 101', term);
  expect(first.write.Put).toMatchObject({ TableName: 'Fees', ConditionExpression: 'attribute_not_exists(id)',
    Item: { hasBoundTerms:true, amountFinancedCents: 1000000, brokerFeesCents: 200000, financedBrokerFeesCents: 200000, version: 1 } });
  const existing = first.write.Put!.Item!;
  h.balance.mockImplementation(async (id: string) => existing.id === id ? existing : undefined);
  await expect(allocateIpfsAgreement('a', ' IPFS101 ', term)).rejects.toThrow(/remaining cap/);
  const next = await allocateIpfsAgreement('a', 'IPFS101', { ...term, ipfsPriorBrokerFees: 2000 });
  expect(next.write.Put).toMatchObject({ ConditionExpression: '#v = :v', ExpressionAttributeValues: { ':v': 1 } });
  expect(next.write.Put!.Item).toMatchObject({ id: existing.id, brokerFeesCents: 400000, financedBrokerFeesCents: 300000 });
  expect(next.split).toEqual({ feeCents: 200000, financedFeeCents: 100000, downPaymentFeeCents: 100000 });
  await expect(allocateIpfsAgreement('a', 'IPFS101', { ...term, ipfsAmountFinanced: 10001 })).rejects.toThrow(/must match/);
  expect((await allocateIpfsAgreement('other', 'IPFS101', term)).write.Put!.Item!.id).not.toBe(existing.id);
  expect((await allocateIpfsAgreement('a', 'IPFS102', term)).write.Put!.Item!.id).not.toBe(existing.id);
});


it('keeps live or settled HOA billing out of a new IPFS bind and preserves verified void history', async () => {
  const { assertPriorIpfsBilling } = await import('../../amplify/functions/commissions/ipfs-bind');
  vi.stubEnv('ACCESS_TABLES', JSON.stringify({ Invoice:'Invoice', PfLoan:'PfLoan' }));
  const invoice = { id:'invoice', status:'DRAFT', updatedAt:'2026-01-01T00:00:00Z' };
  for (const status of ['DRAFT','SENT','PROCESSING','PAID'])
    expect(() => assertPriorIpfsBilling([{...invoice,status}],[])).toThrow(/existing HOA invoice/);
  expect(() => assertPriorIpfsBilling([{ ...invoice, status:'VOID', stripePaymentLinkId:'legacy-link' }],[])).toThrow(/resolve its payment/);
  expect(() => assertPriorIpfsBilling([], [{ id:'loan', status:'ACTIVE', downPaidAt:invoice.updatedAt }])).toThrow(/finance agreement/);
  const withdrawn = { ...invoice, status:'VOID', sourcePricingVersion:1 };
  expect(assertPriorIpfsBilling([withdrawn],[])).toEqual([expect.objectContaining({
    ConditionCheck:expect.objectContaining({ TableName:'Invoice', Key:{id:invoice.id} }),
  })]);
});
