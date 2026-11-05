// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn(), crm: vi.fn(), owner: vi.fn(), personal: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async original => ({
  ...await original<typeof import('@aws-sdk/lib-dynamodb')>(),
  DynamoDBDocumentClient: { from: () => ({ send: h.send }) },
}));
vi.mock('../../amplify/functions/live-changes', () => ({
  publishCrmChange: h.crm, publishOwnerChange: h.owner, publishPersonalChange: h.personal,
}));
import { sendCrmWrite, sendOwnerWrite } from '../../amplify/functions/live-write';
import * as communications from '../../amplify/functions/communications/store';
import * as commissions from '../../amplify/functions/commissions/store';
import * as fees from '../../amplify/functions/broker-fees/store';
import { createHandler } from '../../amplify/functions/owner-profitability/handler';

beforeEach(() => {
  vi.resetAllMocks();
  h.send.mockResolvedValue({}); h.crm.mockResolvedValue(undefined);
  h.owner.mockResolvedValue(undefined); h.personal.mockResolvedValue(undefined);
  vi.stubEnv('COMMUNICATION_TABLE', 'communications'); vi.stubEnv('COMMISSION_TABLE', 'private-pay');
  vi.stubEnv('BROKER_FEE_TABLE', 'fees'); vi.stubEnv('HOA_MIGRATION_PREVIEW', 'false');
  vi.stubEnv('HOA_MIGRATION_BUSINESS_HELD', 'false');
});

describe('post-commit invalidations', () => {
  it('publishes one opaque CRM pulse only after the complete communication transaction commits', async () => {
    let finish!: (value: object) => void;
    h.send.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const work = communications.commit([
      communications.put(communications.row('COMMUNICATION', 'message', { subject: 'private subject' })),
      communications.put(communications.row('WORKFLOW', 'workflow', { accountId: 'private-account' })),
    ]);
    expect(h.crm).not.toHaveBeenCalled();
    finish({}); await work;
    expect(h.crm.mock.calls).toEqual([[]]);
    expect(h.owner).not.toHaveBeenCalled(); expect(h.personal).not.toHaveBeenCalled();
  });

  it('does not turn reads, version fences, bookkeeping or failed transactions into change events', async () => {
    await communications.get('message');
    await communications.commit([communications.absent('fence')]);
    for (const kind of ['BUDGET', 'AUTH_HOLD', 'QUEUE_CURSOR', 'MIGRATION', 'CONTACT_FENCE'])
      await communications.commit([communications.put(communications.row(kind, kind, {}))]);
    h.send.mockRejectedValueOnce(new Error('write failed'));
    await expect(communications.commit([communications.put(communications.row('COMMUNICATION', 'message', {}))])).rejects.toThrow('write failed');
    expect(h.crm).not.toHaveBeenCalled();
  });

  it('publishes a fee transaction once and preserves the committed outcome if notification delivery fails', async () => {
    h.crm.mockRejectedValueOnce(new Error('delivery unavailable'));
    await expect(fees.transact([
      fees.feePut({ id: 'fee:quote', privateAmount: 50000 }),
      fees.feePut({ id: 'agreement', privateSignature: 'signature' }),
    ])).resolves.toBeUndefined();
    expect(h.crm.mock.calls).toEqual([[]]);
    h.crm.mockClear(); h.send.mockRejectedValueOnce(new Error('condition failed'));
    await expect(fees.transact([fees.feePut({ id: 'fee:quote' })])).rejects.toThrow('condition failed');
    expect(h.crm).not.toHaveBeenCalled();
  });

  it('keeps private pay invalidations off CRM and notifies each affected previous or current producer once', async () => {
    await commissions.commit([
      { kind: 'PLAN', value: { id: 'plan', producerId: 'producer-a' }, previous: { producerId: 'producer-old', version: 1 } },
      { kind: 'BATCH', value: { id: 'batch', producerId: 'producer-a' } },
      { kind: 'POLICY', value: { id: 'policy', producerId: 'producer-b', entries: [] } },
      { kind: 'STATEMENT', value: { id: 'statement', privatePay: 500000 } },
    ], 'owner');
    expect(h.crm).not.toHaveBeenCalled(); expect(h.owner.mock.calls).toEqual([[]]);
    expect(h.personal.mock.calls.map(call => call[0]).sort()).toEqual(['producer-a', 'producer-b', 'producer-old']);
    h.owner.mockClear(); h.personal.mockClear(); h.send.mockRejectedValueOnce(new Error('write failed'));
    await expect(commissions.commit([{ kind: 'PLAN', value: { id: 'plan', producerId: 'producer-a' } }], 'owner')).rejects.toThrow('write failed');
    expect(h.owner).not.toHaveBeenCalled(); expect(h.personal).not.toHaveBeenCalled();
  });

  it('publishes Owner-only compensation changes after an authorized successful save', async () => {
    const compensation = { userId: 'employee', version: 1, terms: [{ from: '2026-01-01', annualSalaryCents: 100000, producerShareBps: 2500 }] };
    const store = { read: vi.fn(), save: vi.fn().mockResolvedValue({ ...compensation, version: 2 }) };
    const event = { fieldName: 'saveEmployeeCompensation', identity: { sub: 'owner', groups: ['OWNER'] },
      request: { headers: { 'x-crm-role': 'OWNER' } }, arguments: compensation };
    expect(await createHandler(store)(event)).toMatchObject({ ok: true });
    expect(h.owner.mock.calls).toEqual([[]]); expect(h.crm).not.toHaveBeenCalled(); expect(h.personal).not.toHaveBeenCalled();
    h.owner.mockClear(); store.save.mockRejectedValueOnce(new Error('condition failed'));
    expect(await createHandler(store)(event)).toMatchObject({ ok: false });
    expect(h.owner).not.toHaveBeenCalled();
  });

  it('never changes raw write return values or failure semantics', async () => {
    const value = { paymentPosted: true };
    h.crm.mockRejectedValueOnce(new Error('notification failed'));
    expect(await sendCrmWrite(Promise.resolve(value))).toBe(value);
    h.owner.mockRejectedValueOnce(new Error('notification failed'));
    expect(await sendOwnerWrite(Promise.resolve(value))).toBe(value);
    h.crm.mockClear();
    await expect(sendCrmWrite(Promise.reject(new Error('payment failed')))).rejects.toThrow('payment failed');
    expect(h.crm).not.toHaveBeenCalled();
  });
});
