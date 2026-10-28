import { beforeEach, expect, it, vi } from 'vitest';
import { commissionPolicy, commissionAccount, line, statement } from './commissionFixtures';
import { appendEntry, type CommissionPolicy } from '../../../shared/commissions';
const h = vi.hoisted(() => ({
  get: vi.fn(),
  getMany: vi.fn(),
  list: vi.fn(),
  commit: vi.fn(),
  session: vi.fn(),
  bind: vi.fn(),
  s3: vi.fn(),
  sources: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../../amplify/functions/commissions/store', () => ({
  get: h.get,
  getMany: h.getMany,
  list: h.list,
  commit: h.commit,
  table: () => 'private-ledger',
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
let records: Map<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  records = new Map();
  h.sources.clear();
  h.s3.mockResolvedValue({});
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
    'saveCarrier',
    'file',
    'saveStatement',
    'postStatement',
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
it('prepares positive earned payroll only, locks entries, cancels safely and confirms payment', async () => {
  const p = appendEntry(
    appendEntry(commissionPolicy(), line(), statement(), 'original'),
    line({ kind: 'REVERSAL', originalId: 'original', agencyCents: -10000 }),
    statement(),
    'reversal',
  );
  records.set('POLICY:p', p);
  const input = {
    producerId: 'producer',
    cutoff: '2026-10-01',
    payDate: '2026-10-15',
    requestId: 'batch',
  };
  expect(await handler(request('preparePayroll', input))).toEqual({ ok: true });
  expect(records.get('BATCH:batch')).toMatchObject({
    totalCents: 16000,
    status: 'APPROVED',
  });
  expect(await handler(request('preparePayroll', { ...input, requestId: 'other' }))).toMatchObject({
    ok: false,
  });
  expect(
    await handler(
      request('cancelPayroll', {
        id: 'batch',
        version: 1,
        reference: 'Export rejected',
      }),
    ),
  ).toEqual({ ok: true });
  expect((records.get('POLICY:p') as CommissionPolicy).entries[0].batchId).toBeUndefined();
  expect(await handler(request('preparePayroll', { ...input, requestId: 'replacement' }))).toEqual({
    ok: true,
  });
  expect(
    await handler(
      request('payPayroll', {
        id: 'replacement',
        version: 1,
        reference: 'PAY-10',
        payDate: '2026-10-15',
      }),
    ),
  ).toEqual({ ok: true });
  expect(records.get('BATCH:replacement')).toMatchObject({
    status: 'PAID',
    totalCents: 16000,
  });
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

it('prepares payroll from only the selected producer partition with fresh batched records', async () => {
  const own = appendEntry(commissionPolicy(), line(), statement(), 'e');
  records.set('POLICY:p', own);
  records.set('POLICY:other', {
    ...own,
    id: 'other',
    producerId: 'someone-else',
  });
  records.set('PLAN:producer', { id: 'producer', producerId: 'producer' });
  expect(
    await handler(
      request('preparePayroll', {
        producerId: 'producer',
        cutoff: '2026-10-01',
        payDate: '2026-10-15',
        requestId: 'batch',
      }),
    ),
  ).toEqual({ ok: true });
  expect(h.list).toHaveBeenCalledExactlyOnceWith('producer', true, 'POLICY');
  expect(h.getMany).toHaveBeenCalledExactlyOnceWith([{ kind: 'POLICY', id: 'p' }]);
  expect(records.get('BATCH:batch')).toMatchObject({
    lines: [{ policyId: 'p' }],
  });
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
it('keeps account classification and its evidence private to the active Owner', async () => {
  records.set('ACCOUNT:a', commissionAccount());
  const owner = request('');
  owner.fieldName = 'commissionOverview';
  expect(await handler(owner)).toMatchObject({
    accounts: [expect.objectContaining({ id: 'a' })],
  });
  const producer = request('', {}, 'PRODUCER');
  producer.fieldName = 'commissionOverview';
  const response = await handler(producer);
  expect(response).not.toHaveProperty('accounts');
  expect(JSON.stringify(response)).not.toContain('Owner reviewed account source');
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
