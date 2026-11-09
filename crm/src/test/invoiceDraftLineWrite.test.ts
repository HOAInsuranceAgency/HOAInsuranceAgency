// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccess } from '../../amplify/functions/crm-access/access';
import { writeInvoiceDraftLine } from '../../amplify/functions/crm-access/invoice-line-draft';
import { AccessDenied, type RecordData as Row } from '../../amplify/functions/crm-access/policy';
import type { Write } from '../../amplify/functions/broker-fees/store';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/store', async original => ({
  ...await original<typeof import('../../amplify/functions/broker-fees/store')>(),
  db: { send: mocks.send }, modelTable: (model: string) => model, getFee: async () => undefined,
}));

const now = '2026-11-09T12:00:00.000Z';
const rows = new Map<string, Row>();
const access = () => new AccountAccess({ sub: 'alice', groups: ['STAFF'] }, async (model, key) => structuredClone(rows.get(`${model}:${key}`)));
const input = { invoiceId: 'draft', accountId: 'a', policyId: 'p', kind: 'PREMIUM', retailAmount: 1000, costAmount: 950 };
const write = (field: string, input: Row, extra: Row = {}) => writeInvoiceDraftLine(access(), {
  model: 'InvoiceLine', field, arguments: { input }, ...extra,
});
const sent = (): Write[] => mocks.send.mock.calls[0][0].input.TransactItems;
const parentWrite = () => sent().find(item => item.Update?.TableName === 'Invoice')?.Update;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubEnv('USER_ACCESS_TABLE', 'Team');
  mocks.send.mockReset().mockResolvedValue({});
  rows.clear();
  rows.set('Communication:workflow:a', { id: 'workflow:a', data: { salespersonId: 'alice' } });
  rows.set('Account:a', { id: 'a' });
  rows.set('Policy:p', { id: 'p', accountId: 'a', premium: 1000, billType: 'AGENCY', passThroughCharges: [] });
  rows.set('Quote:q', { id: 'q', accountId: 'a', premium: 1000, billType: 'AGENCY', passThroughCharges: [] });
  rows.set('Invoice:draft', { id: 'draft', accountId: 'a', policyId: 'p', status: 'DRAFT', sourcePricingVersion: 1, updatedAt: now });
  rows.set('InvoiceLine:old', { id: 'old', ...input, description: 'Old description', createdAt: now, updatedAt: now });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('atomic source draft line writes', () => {
  it('creates a native line and records its generated ID on the parent in the same transaction', async () => {
    const result = await write('createInvoiceLine', input);
    expect(result).toMatchObject({ handled: true, line: { ...input, id: expect.any(String), __typename: 'InvoiceLine' } });
    if (!result.handled) throw new Error('Expected the draft write to commit');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(parentWrite()).toMatchObject({
      Key: { id: 'draft' },
      UpdateExpression: 'SET updatedAt = :now ADD #revision :one, #ids :member',
      ExpressionAttributeNames: { '#revision': 'draftLineRevision', '#ids': 'draftLineIds' },
      ExpressionAttributeValues: { ':one': 1, ':member': new Set([result.line.id]), ':old': now, ':now': '2026-11-09T12:00:00.001Z' },
    });
    expect(sent()).toEqual(expect.arrayContaining([
      { Put: { TableName: 'InvoiceLine', Item: result.line, ConditionExpression: 'attribute_not_exists(id)' } },
      { ConditionCheck: expect.objectContaining({ TableName: 'Team', Key: { userId: 'alice' } }) },
      { ConditionCheck: expect.objectContaining({ TableName: 'Communication', Key: { id: 'workflow:a' } }) },
      { ConditionCheck: expect.objectContaining({ TableName: 'Communication', Key: { id: 'deleted-account:a' } }) },
    ]));
  });

  it('tracks an updated legacy line and returns its committed fields', async () => {
    const result = await write('updateInvoiceLine', { id: 'old', costAmount: 900, description: null });
    expect(result).toMatchObject({ handled: true, line: { id: 'old', costAmount: 900, updatedAt: '2026-11-09T12:00:00.001Z' } });
    if (!result.handled) throw new Error('Expected the draft write to commit');
    expect(result.line).not.toHaveProperty('description');
    expect(parentWrite()?.ExpressionAttributeValues?.[':member']).toEqual(new Set(['old']));
    expect(sent()).toContainEqual({ Update: expect.objectContaining({
      TableName: 'InvoiceLine', Key: { id: 'old' }, ConditionExpression: 'updatedAt = :old AND invoiceId = :invoice',
      UpdateExpression: expect.stringContaining(' REMOVE '),
    }) });
  });

  it('removes the live line ID and returns the original line on deletion', async () => {
    expect(await write('deleteInvoiceLine', { id: 'old' })).toEqual({ handled: true, line: rows.get('InvoiceLine:old') });
    expect(parentWrite()).toMatchObject({
      UpdateExpression: 'SET updatedAt = :now ADD #revision :one DELETE #ids :member',
      ExpressionAttributeValues: { ':member': new Set(['old']) },
    });
    expect(sent()).toContainEqual({ Delete: expect.objectContaining({
      TableName: 'InvoiceLine', Key: { id: 'old' }, ConditionExpression: 'updatedAt = :old AND invoiceId = :invoice',
    }) });
  });

  it('fails closed when a concurrent send or group reservation wins the parent check', async () => {
    mocks.send.mockRejectedValueOnce(Object.assign(new Error('Parent changed'), { name: 'TransactionCanceledException' }));
    await expect(write('updateInvoiceLine', { id: 'old', costAmount: 900 })).rejects.toThrow('Refresh the draft');
    const parent = parentWrite()!;
    expect(parent.ConditionExpression).toContain('#status = :draft');
    for (const field of ['invoiceSendOperation', 'supersededByGroupedInvoiceId']) {
      const alias = Object.entries(parent.ExpressionAttributeNames ?? {}).find(([, name]) => name === field)?.[0];
      expect(alias).toBeTruthy();
      expect(parent.ConditionExpression).toContain(`attribute_not_exists(${alias})`);
    }
  });

  it('rejects a line write after the source has been superseded', async () => {
    Object.assign(rows.get('Invoice:draft')!, { status: 'VOID', supersededByGroupedInvoiceId: 'group' });
    await expect(write('updateInvoiceLine', { id: 'old', costAmount: 900 })).rejects.toThrow(/grouped/i);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rejects a reserved draft and source reparenting', async () => {
    Object.assign(rows.get('Invoice:draft')!, { invoiceSendOperation: 'reserved' });
    await expect(write('createInvoiceLine', input)).rejects.toThrow('existing invoice operation');
    delete rows.get('Invoice:draft')!.invoiceSendOperation;
    rows.set('Invoice:other', { id: 'other', accountId: 'a', status: 'DRAFT' });
    await expect(write('updateInvoiceLine', { id: 'old', invoiceId: 'other' })).rejects.toThrow('original invoice');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { arguments: { input: { id: 'old' }, condition: { costAmount: { eq: 950 } } } },
    { nativeConditions: [{ attribute: 'costAmount' }] },
    { nativeAuthFilter: { accountId: { eq: 'a' } } },
    { arguments: { input: { id: 'old', unsupported: true } } },
  ])('rejects a conditional or unsupported atomic write %#', async extra => {
    await expect(write('updateInvoiceLine', { id: 'old' }, extra)).rejects.toThrow('Conditional or unsupported');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([{ sourcePricingVersion: 2 }, { sourcePricingVersion: 1, policyId: null, quoteId: 'q' }, { sourcePricingVersion: null }])(
    'keeps other invoice line operations on the native path %#', async change => {
      Object.assign(rows.get('Invoice:draft')!, change);
      if (change.sourcePricingVersion === 2) rows.get('InvoiceLine:old')!.kind = 'ENDORSEMENT';
      if (change.policyId === null) delete rows.get('InvoiceLine:old')!.policyId;
      expect(await write('updateInvoiceLine', { id: 'old' }, { nativeConditions: [{ allowed: true }] })).toEqual({ handled: false });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it('enforces assignment before returning a native passthrough result', async () => {
    rows.get('Invoice:draft')!.sourcePricingVersion = null;
    rows.get('Communication:workflow:a')!.data = { salespersonId: 'bob' };
    await expect(write('updateInvoiceLine', { id: 'old', costAmount: 900 })).rejects.toThrow(AccessDenied);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('enforces the adjustment charge rules on native passthrough', async () => {
    rows.get('Invoice:draft')!.sourcePricingVersion = 2;
    await expect(write('updateInvoiceLine', { id: 'old', costAmount: 900 })).rejects.toThrow(/Original premium/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
