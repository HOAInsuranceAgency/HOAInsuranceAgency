import { departureWorklist, type CommissionDeparture, type CommissionEarning } from '../../../shared/commissionExceptions';
import { buildPayrollApproval, defaultPayrollSettings, payrollPreview, suggestPayrollDates, validatePayrollCycle, type PayrollCycle } from '../../../shared/commissionPayroll';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commissionPolicy, commissionAccount, line, statement } from './commissionFixtures';
import {
  appendEntry,
  ipfsFeeBalances,
  carrierReconciliationBalances,
  policyTotals,
  receiptOnlyCarrierTerms,
  type CarrierPaymentArrangement,
  type CommissionPolicy,
} from '../../../shared/commissions';
const h = vi.hoisted(() => ({
  get: vi.fn(),
  getMany: vi.fn(),
  list: vi.fn(),
  commit: vi.fn(),
  session: vi.fn(),
  bind: vi.fn(),
  s3: vi.fn(),
  db: vi.fn(),
  sources: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../../amplify/functions/commissions/store', () => ({
  get: h.get,
  getMany: h.getMany,
  list: h.list,
  commit: h.commit,
  table: () => 'private-ledger',
  db: { send: h.db },
}));
vi.mock('../../amplify/functions/commissions/bind', () => ({
  bindPolicy: h.bind,
}));
vi.mock('../../amplify/functions/crm-access/user-status', () => ({
  assertUserSession: h.session,
}));
vi.mock('../../amplify/functions/crm-access/access', () => ({
  tableName: (model: string) => model,
  AccountAccess: class {
    async get(model: string, id: string) {
      return h.sources.get(`${model}:${id}`);
    }
    async requireRecord(model: string, id: string) {
      const record = h.sources.get(`${model}:${id}`);
      if (!record) throw new Error('Not authorized');
      return record;
    }
  },
}));
vi.mock('@aws-sdk/client-s3', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-s3')>()),
  S3Client: class {
    send = h.s3;
  },
}));
import { handler, type Event } from '../../amplify/functions/commissions/handler';
const request = (
  operation: string,
  input: unknown = {},
  role = 'OWNER',
  groups = [role],
): Event => ({
  fieldName: 'commissionAction',
  identity: { sub: 'producer', groups },
  request: { headers: { 'x-crm-role': role } },
  arguments: { operation, input },
});
const paymentArrangement = (patch: Partial<CarrierPaymentArrangement> = {}): CarrierPaymentArrangement => ({
  id: 'standard',
  from: '2025-01-01',
  basis: 'WRITTEN',
  payor: 'Carrier payments',
  trigger: 'EFFECTIVE',
  cadence: 'MONTHLY',
  lagDays: 15,
  evidence: 'Carrier appointment schedule',
  ...patch,
});
let records: Map<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  records = new Map();
  h.sources.clear();
  h.s3.mockResolvedValue({});
  h.db.mockResolvedValue({ Items: [] });
  h.session.mockResolvedValue(undefined);
  h.get.mockImplementation(async (k, id) => structuredClone(records.get(`${k}:${id}`)));
  h.getMany.mockImplementation(async (refs: { kind: string; id: string }[]) =>
    structuredClone(refs.map((r) => records.get(`${r.kind}:${r.id}`)).filter(Boolean)),
  );
  h.list.mockImplementation(async (k, producer, recordKind) =>
    structuredClone(
      [...records.entries()]
        .filter(([key, v]) =>
          producer
            ? (v as { producerId?: string }).producerId === k &&
              (!recordKind || key.startsWith(`${recordKind}:`))
            : key.startsWith(`${k}:`),
        )
        .map(([key, v]) => ({ ...(v as object), kind: key.split(':')[0] })),
    ),
  );
  h.commit.mockImplementation(
    async (
      changes: {
        kind: string;
        value: { id: string; version?: number };
        previous?: { version: number };
      }[],
    ) => {
      for (const c of changes) {
        const old = records.get(`${c.kind}:${c.value.id}`) as { version: number } | undefined;
        if ((old?.version ?? 0) !== (c.previous?.version ?? 0) || (old && !c.previous)) {
          const e = new Error('conflict');
          e.name = 'TransactionCanceledException';
          throw e;
        }
      }
      for (const c of changes)
        records.set(
          `${c.kind}:${c.value.id}`,
          structuredClone({
            ...c.value,
            version: (c.previous?.version ?? 0) + 1,
          }),
        );
    },
  );
});
it.each([
  ['ADMIN', ['ADMIN']],
  ['STAFF', ['STAFF']],
  ['PRODUCER', ['PRODUCER']],
  ['ADMIN', ['OWNER', 'ADMIN']],
  ['OWNER', ['ADMIN']],
])('denies reconciliation in %s before reading any financial storage', async (role, groups) => {
  for (const op of [
    'savePlan',
    'saveAccountClassification',
    'getAccountClassification',
    'saveCarrier',
    'saveReceiptForecast',
    'saveIpfsFee',
    'postIpfsFee',
    'file',
    'saveStatement',
    'postStatement',
    'voidStatement',
    'preparePayroll',
    'payPayroll',
    'adoptPolicy',
  ])
    expect(await handler(request(op, {}, role as string, groups as string[]))).toMatchObject({
      ok: false,
    });
  expect(h.get).not.toHaveBeenCalled();
  expect(h.list).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});
it('rejects disabled and revoked sessions even for an Owner', async () => {
  h.session.mockRejectedValue(new Error('Inactive session'));
  expect(await handler(request('postStatement', { id: 's' }))).toMatchObject({
    ok: false,
    error: 'Inactive session',
  });
  expect(h.get).not.toHaveBeenCalled();
});
it('keeps monthly payroll operations within existing Owner access', async () => {
  for (const operation of ['payrollWorkspace', 'downloadPayrollCycle', 'confirmPayrollCycle', 'approvePayrollCycle', 'savePayrollSettings']) {
    const event = request(operation, {}, 'STAFF');
    expect(await handler(event)).toMatchObject({ ok: false });
  }
  expect(h.get).not.toHaveBeenCalled();
  expect(h.commit).not.toHaveBeenCalled();
});
it('does not expose a separate HR payroll endpoint', async () => {
  const event = request('payrollWorkspace', {}, 'STAFF');
  event.fieldName = 'commissionPayroll';
  expect(await handler(event)).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown commission request/) });
  expect(h.list).not.toHaveBeenCalled();
});
it('posts a statement atomically with source deduplication and safely retries', async () => {
  const s = { ...statement(), lines: [line()] };
  records.set('STATEMENT:s', s);
  records.set('POLICY:p', commissionPolicy());
  expect(await handler(request('postStatement', { id: 's', version: 1, confirmed: true }))).toEqual(
    { ok: true },
  );
  expect((records.get('POLICY:p') as CommissionPolicy).entries[0].producerCents).toBe(16000);
  const changes = h.commit.mock.calls[0][0];
  expect(changes.map((c: { kind: string }) => c.kind)).toEqual(
    expect.arrayContaining(['CARRIER_TRANSACTION', 'SETTLEMENT', 'STATEMENT', 'POLICY']),
  );
  expect(await handler(request('postStatement', { id: 's', version: 1, confirmed: true }))).toEqual(
    { ok: true },
  );
  expect(h.commit).toHaveBeenCalledTimes(1);
});
it('prevents the same carrier transaction from earning again on another statement', async () => {
  records.set('POLICY:p', commissionPolicy());
  records.set('STATEMENT:s', { ...statement(), lines: [line()] });
  await handler(request('postStatement', { id: 's', version: 1, confirmed: true }));
  records.set('STATEMENT:s2', {
    ...statement(),
    id: 's2',
    settlementRef: 'different',
    lines: [line()],
  });
  expect(
    await handler(request('postStatement', { id: 's2', version: 1, confirmed: true })),
  ).toMatchObject({
    ok: false,
    error: expect.stringMatching(/already posted/),
  });
  expect((records.get('POLICY:p') as CommissionPolicy).entries).toHaveLength(1);
});
it('rechecks aggregate reversal limits at posting and makes no partial write', async () => {
  const p = appendEntry(commissionPolicy(), line(), statement(), 'original');
  records.set('POLICY:p', p);
  records.set('STATEMENT:s', {
    ...statement(),
    totalCents: -150000,
    lines: [
      line({
        lineRef: 'r1',
        kind: 'REVERSAL',
        originalId: 'original',
        agencyCents: -75000,
      }),
      line({
        lineRef: 'r2',
        kind: 'REVERSAL',
        originalId: 'original',
        agencyCents: -75000,
      }),
    ],
  });
  expect(
    await handler(request('postStatement', { id: 's', version: 1, confirmed: true })),
  ).toMatchObject({ ok: false, error: expect.stringMatching(/exceed/) });
  expect(h.commit).not.toHaveBeenCalled();
});
it('releases unpaid legacy allocations but cannot bypass approved payroll reports', async () => {
  const p = appendEntry(commissionPolicy(), line(), statement(), 'original');
  p.entries[0].batchId = 'legacy';
  records.set('POLICY:p', p);
  records.set('BATCH:legacy', { id: 'legacy', version: 1, producerId: 'producer', producerName: 'Avery', cutoff: '2026-10-01', payDate: '2026-10-15', status: 'APPROVED', totalCents: 16000, lines: [{ policyId: 'p', entryId: 'original', amountCents: 16000 }] });
  expect(await handler(request('preparePayroll', { producerId: 'producer', cutoff: '2026-10-01', payDate: '2026-10-15', requestId: 'new' }))).toMatchObject({ ok: false, error: expect.stringMatching(/off-cycle/) });
  expect(await handler(request('payPayroll', { id: 'legacy', version: 1, reference: 'PAY', payDate: '2026-10-15' }))).toMatchObject({ ok: false, error: expect.stringMatching(/off-cycle/) });
  expect(await handler(request('cancelPayroll', { id: 'legacy', version: 1, reference: 'Move to reviewed off-cycle report' }))).toEqual({ ok: true });
  expect((records.get('POLICY:p') as CommissionPolicy).entries[0].batchId).toBeUndefined();
  expect(records.get('BATCH:legacy')).toMatchObject({ status: 'CANCELLED' });
});
it('returns only the authenticated producer’s records and excludes reconciliation data', async () => {
  const own = commissionPolicy();
  records.set('POLICY:p', own);
  records.set('POLICY:other', {
    ...own,
    id: 'other',
    producerId: 'someone-else',
  });
  records.set('STATEMENT:s', statement());
  const event = request('', {}, 'PRODUCER');
  event.fieldName = 'commissionOverview';
  event.arguments = { producerId: 'someone-else' };
  const result = await handler(event);
  expect(result).toMatchObject({
    ok: true,
    policies: [{ id: 'p', producerId: 'producer' }],
  });
  expect(result).not.toHaveProperty('statements');
  expect(result).not.toHaveProperty('plans');
  expect(h.list).toHaveBeenCalledWith('producer', true);
});
it('does not post when the owner has not confirmed the reconciliation', async () => {
  records.set('STATEMENT:s', { ...statement(), lines: [line()] });
  expect(
    await handler(request('postStatement', { id: 's', version: 1, confirmed: false })),
  ).toMatchObject({ ok: false });
  expect(h.commit).not.toHaveBeenCalled();
});

it.each([
  [undefined, 'NEW'],
  [null, 'NEW'],
  ['2025-06-01', 'RENEWAL'],
])(
  'repairs historical dates (%s, %s) during audited atomic adoption',
  async (oldDate, transaction) => {
    h.sources.set('Policy:legacy', {
      id: 'legacy',
      accountId: 'a',
      carrierId: 'c',
      effectiveDate: oldDate,
      expirationDate: oldDate,
      updatedAt: 'original',
    });
    h.sources.set('Account:a', { id: 'a', name: 'Cedar HOA' });
    records.set('ACCOUNT:a', commissionAccount());
    records.set('PLAN:original-producer', {
      id: 'original-producer',
      name: 'Original Producer',
      version: 2,
      terms: [
        {
          from: '2025-01-01',
          newBps: 1600,
          renewalBps: 800,
          agreement: 'Original signed plan',
        },
      ],
    });
    records.set('CARRIER:c', commissionPolicy().carrierTerms);
    expect(
      await handler(
        request('adoptPolicy', {
          policyId: 'legacy',
          producerId: 'original-producer',
          boundOn: '2026-01-01',
          transaction,
          premium: '100000.01',
          agencyRate: '12.3456',
          evidence: 'Historical binder and signed producer allocation',
          effectiveDate: '2026-01-01',
          expirationDate: '2027-01-01',
        }),
      ),
    ).toEqual({ ok: true });
    expect(records.get('POLICY:legacy')).toMatchObject({
      producerId: 'original-producer',
      effectiveDate: '2026-01-01',
      expirationDate: '2027-01-01',
      originalTermDates: {
        effectiveDate: oldDate ?? null,
        expirationDate: oldDate ?? null,
      },
      premiumCents: 10000001,
      agencyRateUnits: 123456,
      producerBps: transaction === 'NEW' ? 1600 : 800,
      entries: [],
    });
    expect(h.commit.mock.calls[0][2][0].Update).toMatchObject({
      TableName: 'Policy',
      ConditionExpression: 'updatedAt = :old AND attribute_not_exists(commissionSnapshotId)',
      ExpressionAttributeValues: {
        ':premium': 100000.01,
        ':rate': 12.3456,
        ':old': 'original',
        ':effective': '2026-01-01',
        ':expiration': '2027-01-01',
      },
    });
  },
);
it('retains carrier-reported comparison values and refuses an unbalanced settlement', async () => {
  records.set('CARRIER:c', commissionPolicy().carrierTerms);
  records.set('POLICY:p', commissionPolicy());
  const input = {
    version: 0,
    carrierId: 'c',
    reference: 'STATEMENT-7',
    source: 'statements/00000000-0000-0000-0000-000000000000',
    receivedOn: '2026-10-01',
    settlementRef: 'DEPOSIT-7',
    settlementType: 'DEPOSIT',
    totalCents: 100000,
    lines: [line({ reportedPremiumCents: 1000000, reportedRateUnits: 100000 })],
  };
  expect(await handler(request('saveStatement', input))).toEqual({ ok: true });
  const saved = [...records.values()].find(
    (v) => (v as { reference?: string }).reference === 'STATEMENT-7',
  );
  expect(saved).toMatchObject({
    status: 'DRAFT',
    lines: [{ reportedPremiumCents: 1000000, reportedRateUnits: 100000 }],
  });
  h.commit.mockClear();
  expect(
    await handler(
      request('saveStatement', {
        ...input,
        reference: 'STATEMENT-8',
        totalCents: 99999,
      }),
    ),
  ).toMatchObject({ ok: false, error: expect.stringMatching(/must equal/) });
  expect(h.commit).not.toHaveBeenCalled();
});

it('refuses the retired manual approval endpoint without reserving any earnings', async () => {
  const own = appendEntry(commissionPolicy(), line(), statement(), 'e');
  records.set('POLICY:p', own);
  expect(await handler(request('preparePayroll', { producerId: 'producer', cutoff: '2026-10-01', payDate: '2026-10-15', requestId: 'batch' }))).toMatchObject({ ok: false });
  expect(h.commit).not.toHaveBeenCalled();
  expect(records.get('POLICY:p')).toEqual(own);
});
it('updates shared and private policy numbers in the same version-guarded transaction', async () => {
  records.set('POLICY:p', commissionPolicy());
  h.sources.set('Policy:p', {
    id: 'p',
    updatedAt: 'old',
    commissionSnapshotId: 'p',
  });
  expect(
    await handler(
      request('updatePolicyNumber', {
        id: 'p',
        version: 1,
        policyNumber: 'CORRECT-1',
      }),
    ),
  ).toEqual({ ok: true });
  expect(records.get('POLICY:p')).toMatchObject({ policyNumber: 'CORRECT-1' });
  expect(h.commit.mock.calls[0][2][0].Update).toMatchObject({
    TableName: 'Policy',
    Key: { id: 'p' },
    ConditionExpression: 'updatedAt = :old',
    ExpressionAttributeValues: { ':number': 'CORRECT-1', ':old': 'old' },
  });
});

it('validates cumulative draft reversals from one batch without modifying the ledger', async () => {
  const policy = appendEntry(commissionPolicy(), line(), statement(), 'receipt');
  records.set('POLICY:p', policy);
  records.set('CARRIER:c', policy.carrierTerms);
  const input = {
    version: 0,
    carrierId: 'c',
    reference: 'REV-1',
    source: 'statements/00000000-0000-0000-0000-000000000000',
    receivedOn: '2026-10-02',
    settlementRef: 'OFFSET-1',
    settlementType: 'NET_SETTLEMENT',
    totalCents: -120000,
    lines: [
      line({
        lineRef: 'R1',
        kind: 'REVERSAL',
        originalId: 'receipt',
        agencyCents: -60000,
      }),
      line({
        lineRef: 'R2',
        kind: 'REVERSAL',
        originalId: 'receipt',
        agencyCents: -60000,
      }),
    ],
  };
  expect(await handler(request('saveStatement', input))).toMatchObject({
    ok: false,
    error: expect.stringMatching(/exceed the original/),
  });
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.getMany).toHaveBeenCalledExactlyOnceWith([{ kind: 'POLICY', id: 'p' }]);
  expect(h.get.mock.calls.filter(([kind]) => kind === 'POLICY')).toEqual([]);
  expect(records.get('POLICY:p')).toEqual(policy);
  input.lines[1].agencyCents = -40000;
  input.totalCents = -100000;
  expect(await handler(request('saveStatement', input))).toEqual({ ok: true });
  expect(records.get('POLICY:p')).toEqual(policy);
});

it('saves Owner account classification with an audit version and rejects stale edits', async () => {
  h.sources.set('Account:a', { id: 'a', name: 'Authoritative account name' });
  const input = { ...commissionAccount(), version: 0 };
  expect(await handler(request('saveAccountClassification', input))).toEqual({
    ok: true,
  });
  expect(records.get('ACCOUNT:a')).toMatchObject({
    name: 'Authoritative account name',
    version: 1,
  });
  expect(await handler(request('saveAccountClassification', input))).toMatchObject({
    ok: false,
    error: expect.stringMatching(/changed/),
  });
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(
    await handler(request('saveAccountClassification', { ...input, id: 'nonexistent' })),
  ).toMatchObject({ ok: false });
});
it('shows saved account classifications in the Owner overview and keeps them private to Owners', async () => {
  records.set('ACCOUNT:a', commissionAccount());
  h.sources.set('Account:a', { id: 'a', name: 'Cedar HOA' });
  expect(await handler(request('getAccountClassification', { id: 'a' }))).toMatchObject({
    classification: { id: 'a', version: 2 }, accountName: 'Cedar HOA',
  });
  const owner = request('');
  owner.fieldName = 'commissionOverview';
  expect(await handler(owner)).toMatchObject({ accounts: [{ id: 'a', version: 2, periods: commissionAccount().periods }] });
  expect(h.list).toHaveBeenCalledWith('ACCOUNT');
  h.list.mockClear();
  const producer = request('', {}, 'PRODUCER');
  producer.fieldName = 'commissionOverview';
  const result = await handler(producer);
  expect(result).not.toHaveProperty('accounts');
  expect(h.list.mock.calls.some(([kind]) => kind === 'ACCOUNT')).toBe(false);
  expect(JSON.stringify(result)).not.toContain('Owner reviewed account source');
  expect(await handler(request('getAccountClassification', { id: 'a' }, 'PRODUCER'))).toMatchObject({ ok: false });
});

it.each(['NEW', 'RENEWAL'] as const)(
  'adopts historical GIM %s with original dated classification and concurrency guard',
  async (transaction) => {
    h.sources.set('Account:a', { id: 'a', name: 'Account' });
    h.sources.set('Policy:old', {
      id: 'old',
      accountId: 'a',
      carrierId: 'c',
      updatedAt: 'before',
    });
    records.set('ACCOUNT:a', {
      ...commissionAccount(),
      periods: [
        {
          from: '2025-01-01',
          to: '2026-01-31',
          classification: 'GIM',
          evidence: 'Historical GIM source',
        },
        {
          from: '2026-02-01',
          classification: 'STANDARD',
          evidence: 'Left GIM',
        },
      ],
    });
    records.set('CARRIER:c', commissionPolicy().carrierTerms);
    records.set('PLAN:producer', {
      id: 'producer',
      name: 'Producer',
      version: 3,
      terms: [
        {
          from: '2025-01-01',
          newBps: 2000,
          renewalBps: 1000,
          agreement: 'Standard',
          gim: { newBps: 500, renewalBps: 250, agreement: 'GIM' },
        },
      ],
    });
    const input = {
      policyId: 'old',
      producerId: 'producer',
      transaction,
      boundOn: '2026-01-01',
      effectiveDate: '2026-02-01',
      expirationDate: '2027-02-01',
      premium: '100000',
      agencyRate: '12',
      evidence: 'Original agreement and binder',
    };
    expect(await handler(request('adoptPolicy', input))).toEqual({ ok: true });
    expect(records.get('POLICY:old')).toMatchObject({
      producerBps: transaction === 'NEW' ? 500 : 1000,
      accountClassification: {
        classification: transaction === 'NEW' ? 'GIM' : 'STANDARD',
        version: 2,
      },
    });
    expect(h.commit.mock.calls[0][2]).toContainEqual({
      ConditionCheck: {
        TableName: 'private-ledger',
        Key: { kind: 'ACCOUNT', id: 'a' },
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': 2 },
      },
    });
  },
);

it('adopts an old pre-cutoff policy at zero and rejects eligible receipts without changing the agency amount', async () => {
  h.sources.set('Account:a', { id: 'a', name: 'Legacy account' });
  h.sources.set('Policy:old', { id: 'old', accountId: 'a', carrierId: 'c', updatedAt: 'before' });
  records.set('ACCOUNT:a', {
    ...commissionAccount(),
    firstBoundOn: '2026-09-15',
    bindingEvidence: 'Original binder',
  });
  records.set('PLAN:producer', {
    id: 'producer',
    name: 'Brian',
    version: 1,
    accountBoundFrom: '2026-10-01',
    receiptsFrom: '2026-10-01',
    terms: [{ from: '2026-10-01', newBps: 2000, renewalBps: 1000, agreement: 'Signed plan' }],
  });
  records.set('CARRIER:c', commissionPolicy().carrierTerms);
  const input = {
    policyId: 'old',
    producerId: 'producer',
    transaction: 'NEW',
    boundOn: '2026-09-15',
    effectiveDate: '2026-09-15',
    expirationDate: '2027-09-15',
    premium: '10000',
    agencyRate: '10',
    evidence: 'Original binder',
  };
  expect(await handler(request('adoptPolicy', input))).toEqual({ ok: true });
  const policy = records.get('POLICY:old') as CommissionPolicy;
  expect(policy).toMatchObject({
    producerBps: 0,
    eligibility: { eligible: false, accountFirstBoundOn: '2026-09-15' },
  });
  expect(() => appendEntry(policy, line(), statement(), 'receipt')).toThrow(/noncommissionable/);
  expect(
    appendEntry(policy, line({ eligible: false }), statement(), 'receipt').entries[0],
  ).toMatchObject({ agencyCents: 100000, producerCents: 0 });
  expect(h.db).toHaveBeenCalledTimes(1);
});
it('will not reset recorded account history to never bound', async () => {
  h.sources.set('Account:a', { id: 'a', name: 'Old account' });
  records.set('ACCOUNT:a', {
    ...commissionAccount(),
    firstBoundOn: '2026-09-01',
    bindingEvidence: 'Original binder',
  });
  expect(
    await handler(
      request('saveAccountClassification', {
        ...commissionAccount(),
        neverBound: true,
        bindingEvidence: 'Reset',
      }),
    ),
  ).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be reset/) });
  expect(h.commit).not.toHaveBeenCalled();
});

it.each([undefined, '2026-10-01'])(
  'does not clear or move a confirmed pre-cutoff date forward (%s)',
  async (firstBoundOn) => {
    h.sources.set('Account:a', { id: 'a', name: 'Old account' });
    records.set('ACCOUNT:a', {
      ...commissionAccount(),
      firstBoundOn: '2026-09-01',
      bindingEvidence: 'Original binder',
    });
    expect(
      await handler(
        request('saveAccountClassification', {
          ...commissionAccount(),
          firstBoundOn,
          bindingEvidence: 'Attempted update',
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/cleared or moved forward/) });
    expect(h.commit).not.toHaveBeenCalled();
  },
);

it('preserves original history and the server policy link when only classification fields are saved', async () => {
  h.sources.set('Account:a', { id: 'a', name: 'Old account' });
  records.set('ACCOUNT:a', {
    ...commissionAccount(),
    firstBoundOn: '2026-09-01',
    bindingEvidence: 'Original binder',
    firstBindPolicyId: 'original-policy',
  });
  expect(
    await handler(
      request('saveAccountClassification', {
        ...commissionAccount(),
        periods: [{ from: '2026-01-01', classification: 'GIM', evidence: 'GIM management source' }],
        firstBindPolicyId: 'forged',
      }),
    ),
  ).toEqual({ ok: true });
  expect(records.get('ACCOUNT:a')).toMatchObject({
    firstBoundOn: '2026-09-01',
    bindingEvidence: 'Original binder',
    firstBindPolicyId: 'original-policy',
    periods: [{ classification: 'GIM' }],
  });
});

it('saves structured carrier payment arrangements with authoritative identity and rejects a stale edit', async () => {
  h.sources.set('Carrier:c', { id: 'c', name: 'Current carrier name' });
  const input = {
    id: 'c',
    version: 0,
    arrangements: [paymentArrangement(), paymentArrangement({
      id: 'property',
      lines: ['Property'],
      basis: 'EARNED',
      trigger: 'EARNED',
      earningMethod: 'DAILY_PRORATA',
    })],
  };
  expect(await handler(request('saveCarrier', input))).toEqual({ ok: true });
  expect(records.get('CARRIER:c')).toMatchObject({
    name: 'Current carrier name',
    version: 1,
    basis: 'WRITTEN',
    evidence: 'Carrier appointment schedule',
    schedule: '',
    arrangements: [{ basis: 'WRITTEN' }, { id: 'property', basis: 'EARNED' }],
  });
  expect(h.commit.mock.calls[0][1]).toBe('producer');
  expect(await handler(request('saveCarrier', input))).toMatchObject({
    ok: false,
    error: expect.stringMatching(/changed/),
  });
  expect(h.commit).toHaveBeenCalledTimes(1);
});

it.each([
  undefined,
  [],
  [paymentArrangement({ lagDays: -1 })],
  [paymentArrangement({ from: '2026-02-30' })],
  [paymentArrangement({ from: '2026-01-01', to: '2025-12-31' })],
  [paymentArrangement({ basis: 'EARNED', trigger: 'COLLECTION' })],
  [paymentArrangement(), paymentArrangement({ id: 'overlapping' })],
])('rejects unconfirmed or invalid carrier arrangements without writing %#', async (arrangements) => {
  h.sources.set('Carrier:c', { id: 'c', name: 'Carrier' });
  expect(await handler(request('saveCarrier', {
    ...commissionPolicy().carrierTerms,
    version: 0,
    arrangements,
  }))).toMatchObject({ ok: false });
  expect(h.commit).not.toHaveBeenCalled();
});

it('revises only the receipt forecast and records which receipt history the Owner reviewed', async () => {
  const original = appendEntry(commissionPolicy(), line(), statement(), 'received');
  records.set('POLICY:p', original);
  const receiptForecast = {
    items: [],
    evidence: 'Cancelled term; carrier confirms no future installments',
    confirmed: true,
    complete: true,
    reviewedEntryCount: 900,
  };
  expect(await handler(request('saveReceiptForecast', {
    policyId: 'p', version: 1, receiptForecast,
  }))).toEqual({ ok: true });
  expect(records.get('POLICY:p')).toEqual({
    ...original,
    version: 2,
    receiptForecast: { ...receiptForecast, reviewedEntryCount: 1 },
  });
  expect(h.commit.mock.calls[0][0]).toHaveLength(1);
  expect(h.commit.mock.calls[0][0][0].previous).toEqual(original);
  expect(await handler(request('saveReceiptForecast', {
    policyId: 'p', version: 1, receiptForecast,
  }))).toMatchObject({ ok: false, error: expect.stringMatching(/changed/) });
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(payrollPreview([records.get('POLICY:p') as CommissionPolicy], '2026-10-01')).toMatchObject([{ amountCents: 16000 }]);
});

it.each([
  undefined,
  { items: [{ dueOn: '2026-02-30', agencyCents: 1 }], evidence: 'Source', confirmed: true, complete: true },
  { items: [{ dueOn: '2026-10-01', agencyCents: -1 }], evidence: 'Source', confirmed: true, complete: true },
  { items: [], evidence: '', confirmed: true, complete: true },
])('rejects invalid receipt forecasts without modifying the policy %#', async (receiptForecast) => {
  const policy = commissionPolicy();
  records.set('POLICY:p', policy);
  expect(await handler(request('saveReceiptForecast', { policyId: 'p', version: 1, receiptForecast })))
    .toMatchObject({ ok: false });
  expect(h.commit).not.toHaveBeenCalled();
  expect(records.get('POLICY:p')).toEqual(policy);
});

it('returns safe receipt balances to producers while retaining legacy policy readability', async () => {
  const policy = {
    ...commissionPolicy(),
    receiptForecast: {
      items: [{ dueOn: '2026-10-01', agencyCents: 100000 }],
      evidence: 'Private cancellation correspondence',
      confirmed: true,
      complete: true,
    },
  };
  records.set('POLICY:p', policy);
  records.set('POLICY:legacy', { ...commissionPolicy(), id: 'legacy' });
  const producer = request('', {}, 'PRODUCER');
  producer.fieldName = 'commissionOverview';
  const response = await handler(producer);
  expect(response).toMatchObject({
    ok: true,
    asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    policies: [
      { id: 'p', reconciliationBalances: { asOf: expect.any(String) } },
      { id: 'legacy', reconciliationBalances: { asOf: expect.any(String) } },
    ],
  });
  const serialized = JSON.stringify(response);
  expect(serialized).not.toContain('carrierTerms');
  expect(serialized).not.toContain('receiptForecast');
  expect(serialized).not.toContain('Private cancellation correspondence');
  expect(serialized).not.toContain('Carrier contract');
});

it('adopts the carrier arrangement applicable to historical term facts, not current defaults', async () => {
  h.sources.set('Account:a', { id: 'a', name: 'Account' });
  h.sources.set('Policy:old', {
    id: 'old', accountId: 'a', carrierId: 'c', updatedAt: 'before',
    lines: ['Property'], billType: 'DIRECT',
  });
  records.set('ACCOUNT:a', commissionAccount());
  records.set('PLAN:producer', {
    id: 'producer', name: 'Producer', version: 3,
    terms: [{ from: '2020-01-01', newBps: 1600, renewalBps: 800, agreement: 'Original agreement' }],
  });
  const historical = paymentArrangement({
    id: 'old-earned', to: '2026-12-31', lines: ['Property'], billType: 'DIRECT',
    transaction: 'RENEWAL', basis: 'EARNED', trigger: 'EARNED', earningMethod: 'DAILY_PRORATA',
  });
  records.set('CARRIER:c', {
    ...commissionPolicy().carrierTerms,
    version: 7,
    arrangements: [historical, paymentArrangement({ id: 'current', from: '2027-01-01' })],
  });
  expect(await handler(request('adoptPolicy', {
    policyId: 'old', producerId: 'producer', transaction: 'RENEWAL',
    boundOn: '2025-12-15', effectiveDate: '2026-01-01', expirationDate: '2027-01-01',
    premium: '100000', agencyRate: '12', evidence: 'Original binder and carrier schedule',
  }))).toEqual({ ok: true });
  expect(records.get('POLICY:old')).toMatchObject({
    carrierTerms: { version: 7, basis: 'EARNED', payment: { ...historical, lines: ['PROPERTY'] } }, entries: [],
  });
  expect((records.get('POLICY:old') as CommissionPolicy).carrierTerms).not.toHaveProperty('arrangements');
  expect(h.commit.mock.calls[0][2]).toContainEqual({
    ConditionCheck: {
      TableName: 'private-ledger', Key: { kind: 'CARRIER', id: 'c' },
      ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' },
      ExpressionAttributeValues: { ':v': 7 },
    },
  });
});

it('saves receipt-only tracking with authoritative identity and a versioned audit, without inventing timing', async () => {
  h.sources.set('Carrier:c', { id: 'c', name: 'Authoritative carrier' });
  const input = { id: 'c', version: 0, receiptOnly: true, name: 'Untrusted name' };
  expect(await handler(request('saveCarrier', input))).toEqual({ ok: true });
  expect(records.get('CARRIER:c')).toEqual({
    ...receiptOnlyCarrierTerms({ id: 'c', name: 'Authoritative carrier', version: 1 }),
  });
  expect(h.commit.mock.calls[0][1]).toBe('producer');
  expect(await handler(request('saveCarrier', input))).toMatchObject({ ok: false, error: expect.stringMatching(/changed/) });
  expect(h.commit).toHaveBeenCalledTimes(1);
});
it('changes tracking mode only for future snapshots and allows a later confirmed forecast', async () => {
  h.sources.set('Carrier:c', { id: 'c', name: 'Carrier' });
  const prior = { ...commissionPolicy().carrierTerms, arrangements: [paymentArrangement()] };
  records.set('CARRIER:c', prior);
  const policy = commissionPolicy();
  records.set('POLICY:p', policy);
  expect(await handler(request('saveCarrier', { id: 'c', version: 1, receiptOnly: true }))).toEqual({ ok: true });
  expect(records.get('CARRIER:c')).toMatchObject({ version: 2, receiptOnly: true, basis: 'UNSPECIFIED' });
  expect(records.get('CARRIER:c')).not.toHaveProperty('arrangements');
  expect(h.commit.mock.calls[0][0][0].previous).toEqual(prior);
  expect(records.get('POLICY:p')).toEqual(policy);
  expect(await handler(request('saveCarrier', { id: 'c', version: 2, arrangements: [paymentArrangement()] }))).toEqual({ ok: true });
  expect(records.get('CARRIER:c')).toMatchObject({ version: 3, basis: 'WRITTEN', arrangements: [paymentArrangement()] });
  expect(records.get('CARRIER:c')).not.toHaveProperty('receiptOnly');
  expect(records.get('POLICY:p')).toEqual(policy);
});
it('rejects contradictory receipt-only and forecast setup without writing', async () => {
  h.sources.set('Carrier:c', { id: 'c', name: 'Carrier' });
  expect(await handler(request('saveCarrier', { id: 'c', version: 0, receiptOnly: true, arrangements: [paymentArrangement()] }))).toMatchObject({ ok: false });
  expect(h.commit).not.toHaveBeenCalled();
});
it('adopts a historical policy with receipt-only tracking and preserves its eligibility checks', async () => {
  h.sources.set('Account:a', { id: 'a', name: 'Cedar HOA' });
  h.sources.set('Policy:old', { id: 'old', accountId: 'a', carrierId: 'c', updatedAt: 'before' });
  records.set('ACCOUNT:a', commissionAccount());
  records.set('PLAN:producer', { id: 'producer', producerId: 'producer', name: 'Producer', version: 1,
    terms: [{ from: '2020-01-01', newBps: 2000, renewalBps: 1000, agreement: 'Signed agreement' }] });
  records.set('CARRIER:c', receiptOnlyCarrierTerms({ id: 'c', name: 'Carrier', version: 4 }));
  expect(await handler(request('adoptPolicy', {
    policyId: 'old', producerId: 'producer', transaction: 'NEW', boundOn: '2026-01-01',
    effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premium: '10000', agencyRate: '10',
    evidence: 'Original binder and agency agreement',
  }))).toEqual({ ok: true });
  expect(records.get('POLICY:old')).toMatchObject({ producerBps: 2000, planVersion: 1,
    carrierTerms: { version: 4, receiptOnly: true, basis: 'UNSPECIFIED' }, entries: [] });
});

it('voids only a reviewed draft and retains its evidence without creating earnings', async () => {
  const original = { ...statement(), lines: [line()] };
  records.set('STATEMENT:s', original);
  records.set('POLICY:p', commissionPolicy());
  const input = { id: 's', version: 1, reason: 'TEST duplicate; do not post', confirmed: true };
  expect(await handler(request('voidStatement', input))).toEqual({ ok: true });
  expect(records.get('STATEMENT:s')).toMatchObject({ ...original, status: 'VOID', version: 2, voidReason: input.reason, voidedBy: 'producer', voidedAt: expect.any(String) });
  expect((records.get('POLICY:p') as CommissionPolicy).entries).toEqual([]);
  expect(h.commit.mock.calls[0][0].map((c: {kind: string})=>c.kind)).toEqual(['STATEMENT','PAYROLL_STATE']);
  expect(await handler(request('voidStatement', input))).toEqual({ ok: true });
  expect(h.commit).toHaveBeenCalledTimes(1);
  expect(await handler(request('postStatement', {id:'s',version:2,confirmed:true}))).toMatchObject({ok:false,error:expect.stringMatching(/Only a draft/)});
});
it.each([
  [{ confirmed: false }, /Confirm/],
  [{ reason: ' ' }, /reason/],
  [{ version: 0 }, /changed/i],
])('rejects invalid void requests without changing history: %j', async (patch, error) => {
  records.set('STATEMENT:s', {...statement(),lines:[line()]});
  expect(await handler(request('voidStatement', {id:'s',version:1,reason:'Duplicate',confirmed:true,...patch}))).toMatchObject({ok:false,error:expect.stringMatching(error)});
  expect(h.commit).not.toHaveBeenCalled();
});
it('cannot void a posted receipt or overwrite a different void decision', async () => {
  records.set('STATEMENT:s', {...statement(),status:'POSTED'});
  expect(await handler(request('voidStatement',{id:'s',version:1,reason:'Wrong draft',confirmed:true}))).toMatchObject({ok:false});
  records.set('STATEMENT:s', {...statement(),status:'VOID',voidReason:'Original reason',voidedBy:'producer'});
  expect(await handler(request('voidStatement',{id:'s',version:1,reason:'New reason',confirmed:true}))).toMatchObject({ok:false});
  expect(h.commit).not.toHaveBeenCalled();
});

it('matches partial IPFS receipts once, preserves carrier balances and uses the bound producer rate in payroll', async () => {
  const policy = commissionPolicy();
  records.set('POLICY:p', policy);
  const current = () => records.get('POLICY:p') as CommissionPolicy;
  const expected = { policyId: 'p', version: 1, expectedCents: 30000, agreementRef: 'IPFS-123' };
  expect(await handler(request('saveIpfsFee', expected))).toEqual({ ok: true });
  expect(policyTotals(current())).toMatchObject({ expectedAgency: 1230000, receivedAgency: 0, earned: 0 });
  const receipt = { policyId: 'p', version: 2, kind: 'RECEIPT', amountCents: 12345, receivedOn: '2026-10-01',
    lineRef: 'Alloc-1', settlementRef: 'Deposit-1', settlementTotalCents: 30000 };
  const post = (patch = {}) => handler(request('postIpfsFee', { ...receipt, ...patch }));
  expect(await post()).toEqual({ ok: true });
  expect(await post({ lineRef: 'alloc-1' })).toEqual({ ok: true });
  expect(await post({ amountCents: 12346 })).toMatchObject({ ok: false });
  records.set('POLICY:other', { ...policy, id: 'other', accountId: 'another-account', ipfsAgreementRef: 'IPFS-123', ipfsFeeCents: 30000 });
  expect(await post({ policyId: 'other', version: 1 })).toMatchObject({ ok: false });
  expect(await post({ policyId: 'other', version: 1, lineRef: 'Alloc-X', amountCents: 17656 })).toMatchObject({ ok: false, error: expect.stringMatching(/exceed the verified/) });
  expect(await post({ policyId: 'other', version: 1, lineRef: 'Alloc-X', settlementTotalCents: 50000 })).toMatchObject({ ok: false });
  const originalId = current().entries[0].id;
  expect(await post({ kind: 'REVERSAL', lineRef: 'Refund-1', receivedOn: '2026-10-02',
    amountCents: 1000, settlementTotalCents: 1000, originalId, version: 3 })).toEqual({ ok: true });
  expect(ipfsFeeBalances(current())).toEqual({ expected: 30000, collected: 12345, refunded: 1000, net: 11345, outstanding: 17655 });
  expect(await post({ lineRef: 'Alloc-2', version: 4, amountCents: 17656 })).toMatchObject({ ok: false });
  expect(await post({ lineRef: 'Alloc-2', version: 4, amountCents: 17655 })).toEqual({ ok: true });
  expect(carrierReconciliationBalances(current(), '2026-10-30')).toMatchObject({ receivedToDate: 0, adjustmentReview: false });
  expect(policyTotals(current())).toMatchObject({ receivedAgency: 29000, earned: 4800, proposedRecovery: 160 });
  const payable = payrollPreview([current()], '2026-10-12');
  expect(payable.reduce((total, row) => total + row.amountCents, 0)).toBe(4800);
  expect(payable.map(row => row.revenueKind)).toEqual(['IPFS_FEE', 'IPFS_FEE']);
  const refundId = current().entries[1].id;
  expect(await post({ kind: 'RESTORATION', lineRef: 'Restored-1', receivedOn: '2026-10-03',
    amountCents: 1000, settlementTotalCents: 1000, originalId: refundId, version: current().version })).toEqual({ ok: true });
  expect(ipfsFeeBalances(current())).toEqual({ expected: 30000, collected: 30000, refunded: 0, net: 30000, outstanding: 0 });
  expect(policyTotals(current())).toMatchObject({ earned: 4800, proposedRecovery: 0 });
  expect(await handler(request('saveIpfsFee', { ...expected, version: current().version, agreementRef: 'Other' }))).toMatchObject({ ok: false });
});

it('isolates IPFS adjustments and enforces frozen receipt eligibility and valid settlement dates', async () => {
  const policy = appendEntry(commissionPolicy(), line(), statement(), 'carrier-receipt');
  records.set('POLICY:p', { ...policy, ipfsAgreementRef: 'Test', ipfsFeeCents: 20000, receiptsFrom: '2026-10-01' });
  const receipt = { policyId: 'p', version: 1, kind: 'RECEIPT', amountCents: 10000, receivedOn: '2026-09-30',
    lineRef: 'Fee-1', settlementRef: 'Deposit-1' };
  const post = (patch = {}) => handler(request('postIpfsFee', { ...receipt, ...patch }));
  expect(await post({ receivedOn: '2099-01-01' })).toMatchObject({ ok: false });
  expect(await post({ kind: 'REVERSAL', originalId: 'carrier-receipt' })).toMatchObject({ ok: false });
  expect(await post()).toEqual({ ok: true });
  const updated = records.get('POLICY:p') as CommissionPolicy;
  expect(updated.entries[1]).toMatchObject({ producerCents: 0, eligible: false, revenueKind: 'IPFS_FEE' });
  const carrierReversal = line({ kind: 'REVERSAL', agencyCents: -100, originalId: updated.entries[1].id });
  expect(() => appendEntry(updated, carrierReversal, statement(), 'carrier-reversal')).toThrow(/original/);
});

it('serializes concurrent allocations of one IPFS remittance across different policy terms and accounts', async () => {
  for (const id of ['p1', 'p2'])
    records.set(`POLICY:${id}`, { ...commissionPolicy(), id, accountId: `account-${id}`, ipfsFeeCents: 7500, ipfsAgreementRef: 'Package' });
  const post = (policyId: string, amountCents: number) => handler(request('postIpfsFee', {
    policyId, version: 1, kind: 'RECEIPT', receivedOn: '2026-10-01', amountCents,
    settlementTotalCents: 10000, settlementRef: 'Deposit', lineRef: `Deposit/${policyId}`,
  }));
  const result = await Promise.all([post('p1', 7500), post('p2', 7500)]);
  const posted = result.map(outcome => typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok === true);
  expect(posted.filter(Boolean)).toHaveLength(1);
  const loser = posted[0] ? 'p2' : 'p1';
  expect(await post(loser, 7500)).toMatchObject({ ok: false, error: expect.stringMatching(/exceed the verified/) });
  expect(await post(loser, 2500)).toEqual({ ok: true });
  const entries = ['p1', 'p2'].flatMap(id => (records.get(`POLICY:${id}`) as CommissionPolicy).entries);
  expect(entries).toHaveLength(2);
  expect(entries.reduce((total, entry) => total + entry.agencyCents, 0)).toBe(10000);
  expect(entries.reduce((total, entry) => total + entry.producerCents, 0)).toBe(1600);
});

it('posts IPFS fee cash once and applies each participant’s frozen share through retained payroll', async () => {
  const policy: CommissionPolicy = {
    ...commissionPolicy(), receiptsFrom: '2026-11-01', ipfsFeeCents: 10000, ipfsAgreementRef: 'IPFS-A',
    allocations: [{ id: 'split', from: '2026-01-01', agreement: 'A', approvedBy: 'Owner', approvedAt: '2026-01-01',
      method: 'INDIVIDUAL_PLAN_RATE', houseBps: 0, participants: [
        { producerId: 'one', producerName: 'One', shareBps: 6000, producerBps: 2000, eligible: true, planVersion: 1, agreement: 'B' },
        { producerId: 'two', producerName: 'Two', shareBps: 4000, producerBps: 1000, eligible: true, planVersion: 1, agreement: 'C' },
      ] }],
  };
  records.set('POLICY:p', policy);
  const splitCycle = { ...suggestPayrollDates('2026-10'), version: 1, revision: 1, status: 'APPROVED',
    batchIds: [], totalCents: 0, cycleType: 'OFF_CYCLE' };
  records.set('PAYROLL_CYCLE:one', { ...splitCycle, id: 'one', producerIds: ['one'] });
  records.set('PAYROLL_CYCLE:bound', { ...splitCycle, id: 'bound', producerIds: [policy.producerId] });
  const fee = { policyId: 'p', version: 1, kind: 'RECEIPT', amountCents: 10000, receivedOn: '2026-10-01', lineRef: 'A-1', settlementRef: 'D-1' };
  expect(await handler(request('postIpfsFee', fee))).toEqual({ ok: true });
  expect(records.get('PAYROLL_CYCLE:one')).toMatchObject({version: 2, reviewRequired: expect.stringMatching(/IPFS/i)});
  expect(records.get('PAYROLL_CYCLE:bound')).toMatchObject({version: 1});
  const current = () => records.get('POLICY:p') as CommissionPolicy;
  expect(current().entries).toMatchObject([{ revenueKind: 'IPFS_FEE', agencyCents: 10000, producerCents: 0, allocationId: 'split' }]);
  const earnings = () => [...records].filter(([key]) => key.startsWith('EARNING:')).map(([,value]) => value as CommissionEarning);
  expect(earnings().map(row => row.revenueKind)).toEqual(['IPFS_FEE', 'IPFS_FEE']);
  const cycle = validatePayrollCycle({
    id: '2026-10', version: 0, revision: 1, cutoff: '2026-10-23', reviewOn: '2026-10-24',
    hrDueOn: '2026-10-26', processingOn: '2026-10-26', payDate: '2026-10-30', status: 'OPEN', batchIds: [], totalCents: 0,
  });
  // Older shared earnings can be identified from the original IPFS receipt ID.
  const restoredEarnings = earnings().map(e => e.producerId === 'one' ? { ...e, revenueKind: undefined } : e);
  const approved = buildPayrollApproval(cycle, [current()], [], defaultPayrollSettings(), 'owner', '2026-10-24T12:00:00Z', restoredEarnings);
  expect(approved.batches.map(b => [b.producerId, b.lines[0].revenueKind, b.totalCents])).toEqual([
    ['one', 'IPFS_FEE', 1200], ['two', 'IPFS_FEE', 400],
  ]);
  for (const e of approved.earnings) records.set('EARNING:' + e.id, e);
  for (const b of approved.batches) records.set('BATCH:' + b.id, { ...b, status: 'PAID' });
  const member = request('', {}, 'PRODUCER');
  member.identity = { sub: 'one', groups: ['PRODUCER'] };
  member.fieldName = 'commissionOverview';
  expect(await handler(member)).toMatchObject({
    ok: true, policies: [], earnings: [{ producerId: 'one', revenueKind: 'IPFS_FEE', amountCents: 1200 }],
    batches: [{ status: 'PAID', paidCents: 1200, lines: [{ source: 'SHARED_RECEIPT', revenueKind: 'IPFS_FEE' }] }],
  });
  const refund = { ...fee, version: 2, kind: 'REVERSAL', amountCents: 5000, originalId: current().entries[0].id, receivedOn: '2026-10-03', lineRef: 'Refund', settlementRef: 'D-2' };
  expect(await handler(request('postIpfsFee', refund))).toEqual({ ok: true });
  expect(await handler(request('postIpfsFee', refund))).toEqual({ ok: true });
  expect(earnings().filter(e => e.status === 'REVIEW').map(e => e.amountCents)).toEqual([-600, -200]);
  expect(earnings()).toHaveLength(4);
  expect(records.get('PAYROLL_STATE:reconciliation')).toMatchObject({ version: 2 });
});

describe('late IPFS remittances and approved payroll', () => {
  const input = { policyId: 'p', version: 1, kind: 'RECEIPT', amountCents: 10000,
    receivedOn: '2026-10-23', lineRef: 'late-allocation', settlementRef: 'late-remittance' };
  function cycle(id: string, patch: Partial<PayrollCycle> = {}) {
    const value: PayrollCycle = { ...suggestPayrollDates('2026-10'), id, version: 1, revision: 1,
      status: 'APPROVED', batchIds: [], totalCents: 0, cutoff: '2026-10-23', ...patch };
    records.set('PAYROLL_CYCLE:' + id, value);
    return () => records.get('PAYROLL_CYCLE:' + id) as PayrollCycle;
  }
  const post = (overrides = {}) => handler(request('postIpfsFee', { ...input, ...overrides }));
  beforeEach(() => {
    records.set('POLICY:p', { ...commissionPolicy(), ipfsFeeCents: 20000, ipfsAgreementRef: 'IPFS-test' });
  });

  it('holds only approved payroll that would include this receipt, in the posting transaction, once', async () => {
    const monthly = cycle('2026-10');
    const other = cycle('2026-10-OFF-aaaa1111', { cycleType: 'OFF_CYCLE', producerIds: ['other'] });
    const selected = cycle('2026-10-OFF-aaaa2222', { cycleType: 'OFF_CYCLE', producerIds: ['producer'], selectedEarningKeys: ['existing-selection'] });
    const before = cycle('2026-09', { cutoff: '2026-10-22' });
    const paid = cycle('2026-08', { status: 'PAID' });
    const open = cycle('2026-11', { status: 'OPEN' });
    const existing = cycle('2026-10-OFF-aaaa3333', { reviewRequired: 'Review the original report.' });
    expect(await post()).toEqual({ ok: true });
    expect(monthly().reviewRequired).toMatch(/IPFS/i);
    expect([other, selected, before, paid, open].map(read => read().reviewRequired)).toEqual(Array(5).fill(undefined));
    expect(existing().reviewRequired).toBe('Review the original report.');
    const changes = h.commit.mock.calls.at(-1)![0];
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: 'PAYROLL_CYCLE', previous: expect.objectContaining({id: '2026-10', version: 1})}),
      ...['IPFS_TRANSACTION', 'IPFS_SETTLEMENT', 'POLICY', 'PAYROLL_STATE'].map(kind => expect.objectContaining({kind})),
    ]));
    expect(await post()).toEqual({ ok: true });
    expect(monthly().version).toBe(2);
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('holds a selected original receipt for material refunds and restorations without changing approved amounts', async () => {
    expect(await post()).toEqual({ ok: true });
    const policy = () => records.get('POLICY:p') as CommissionPolicy;
    const originalId = policy().entries[0].id;
    const selected = { cycleType: 'OFF_CYCLE' as const, producerIds: ['producer'],
      selectedEarningKeys: [JSON.stringify(['receipt', 'p', originalId])], totalCents: 1600 };
    const originalCycle = cycle('2026-10-OFF-1111aaaa', selected);
    const other = cycle('2026-10-OFF-2222aaaa', { ...selected, selectedEarningKeys: ['unrelated'] });
    for (const [kind, version] of [['REVERSAL', 2], ['RESTORATION', 3]] as const) {
      if (kind === 'RESTORATION') cycle('2026-10-OFF-1111aaaa', { ...selected, version: 3 });
      const adjustment = { kind, version, originalId: policy().entries.at(-1)!.id, amountCents: 5000, lineRef: kind, settlementRef: kind };
      expect(await post(adjustment)).toEqual({ ok: true });
      expect(originalCycle()).toMatchObject({ reviewRequired: expect.stringMatching(/IPFS/i), totalCents: 1600 });
      expect(other().reviewRequired).toBeUndefined();
      const heldVersion = originalCycle().version;
      expect(await post(adjustment)).toEqual({ ok: true });
      expect(originalCycle().version).toBe(heldVersion);
    }
    expect(policy().entries.map(entry => entry.producerCents)).toEqual([1600, -800, 800]);
  });

  it('leaves approved payroll open for unrelated agency-only receipts', async () => {
    const approved = cycle('2026-10');
    records.set('POLICY:p', { ...commissionPolicy(), receiptsFrom: '2026-11-01',
      ipfsFeeCents: 20000, ipfsAgreementRef: 'IPFS-test' });
    expect(await post()).toEqual({ ok: true });
    expect((records.get('POLICY:p') as CommissionPolicy).entries).toMatchObject([{ agencyCents: 10000, producerCents: 0 }]);
    expect(approved().version).toBe(1);
  });

  it.each([0, 100])('keeps confirmed payroll immutable when %i cents were previously paid', async paid => {
    const readCycle = cycle('2026-10', { batchIds: ['approved-batch'], totalCents: 1000 });
    const batch = { id: 'approved-batch', version: 1, cycleId: '2026-10', cycleRevision: 1,
      producerId: 'producer', producerName: 'Avery', cutoff: readCycle().cutoff, payDate: readCycle().payDate,
      status: 'APPROVED', totalCents: 1000, lines: [{ policyId: 'older', entryId: 'old', amountCents: 1000 }],
      payments: paid ? [{id: 'prior', paidOn: '2026-10-26', amountCents: paid, reference: 'prior'}] : [] };
    records.set('BATCH:approved-batch', batch);
    expect(await post()).toEqual({ ok: true });
    expect(records.get('BATCH:approved-batch')).toEqual(batch);
    expect(readCycle().totalCents).toBe(1000);
    const payment = { id: '2026-10', version: readCycle().version, confirmed: true,
      paidOn: '2026-10-27', paymentReference: 'confirmed', batchId: batch.id };
    if (paid) {
      expect(readCycle().reviewRequired).toBeUndefined();
      const pending = payrollPreview([records.get('POLICY:p') as CommissionPolicy], readCycle().cutoff);
      expect(pending).toMatchObject([{amountCents: 1600, revenueKind: 'IPFS_FEE'}]);
      expect(await handler(request('confirmPayrollCycle', payment))).toEqual({ok: true});
      expect(await handler(request('confirmPayrollCycle', payment))).toEqual({ok: true});
      expect(records.get('BATCH:approved-batch')).toMatchObject({ status: 'PAID', totalCents: 1000,
        payments: [{amountCents: 100}, {amountCents: 900}] });
    } else {
      expect(readCycle().reviewRequired).toMatch(/IPFS/i);
      for (const action of ['confirmPayrollEmployee', 'confirmPayrollCycle'])
        expect(await handler(request(action, payment))).toMatchObject({ok: false, error: expect.stringMatching(/IPFS/i)});
      expect(records.get('BATCH:approved-batch')).toEqual(batch);
    }
  });

  it('rejects a racing payroll approval without saving money or earnings and re-evaluates the cycle on retry', async () => {
    const list = h.list.getMockImplementation()!;
    let racing = true;
    h.list.mockImplementation(async (...args) => {
      const found = await list(...args);
      if (racing && args[0] === 'PAYROLL_CYCLE') {
        racing = false;
        cycle('2026-10');
        records.set('PAYROLL_STATE:reconciliation', {id: 'reconciliation', version: 1});
      }
      return found;
    });
    expect(await post()).toMatchObject({ ok: false });
    expect([...records.keys()].some(key => /^IPFS_(TRANSACTION|SETTLEMENT):|^EARNING:/.test(key))).toBe(false);
    expect((records.get('POLICY:p') as CommissionPolicy).entries).toHaveLength(0);
    expect(await post()).toEqual({ ok: true });
    expect(records.get('PAYROLL_CYCLE:2026-10')).toMatchObject({version: 2, reviewRequired: expect.stringMatching(/IPFS/i)});
  });
});

it('keeps fee cash separate from a departing employee’s pending carrier balance and its resolution', () => {
  const departure: CommissionDeparture = {
    id: 'producer', producerId: 'producer', producerName: 'Avery', version: 1, employmentEndOn: '2026-10-31',
    reviewOn: '2026-10-31', paymentDueOn: '2026-11-01', laterReceipts: 'REVIEW', renewals: 'REVIEW', status: 'APPROVED',
    agreement: 'Signed plan', evidence: 'Departure notice', decisions: [],
  };
  const policy = { ...commissionPolicy(), premiumCents: 100000, agencyRateUnits: 100000 };
  const fee = appendEntry(policy, line({ revenueKind: 'IPFS_FEE', agencyCents: 10000 }), statement(), 'fee');
  const pending = (p: CommissionPolicy) => departureWorklist(departure, [p], [], []).pending;
  expect(pending(fee)).toMatchObject([{ expectedAgencyCents: 10000, receivedAgencyCents: 0 }]);
  departure.pendingResolutions = [{ policyId: policy.id, receiptCount: 0, reason: 'Carrier confirmed', at: '2026-09-30', by: 'Owner' }];
  expect(pending(fee)).toEqual([]);
  const carrier = appendEntry(fee, line({ agencyCents: 1000 }), statement(), 'carrier');
  expect(pending(carrier)).toMatchObject([{ expectedAgencyCents: 10000, receivedAgencyCents: 1000 }]);
});
