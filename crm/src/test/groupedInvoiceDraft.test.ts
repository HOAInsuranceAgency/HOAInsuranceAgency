import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupedDraft, groupedReviewLines } from '../../amplify/functions/crm-access/grouped-draft';
import type { AccountAccess } from '../../amplify/functions/crm-access/access';

const h = vi.hoisted(() => ({ send: vi.fn(), list: vi.fn(), reserve: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/store', () => ({ db: { send: h.send }, modelTable: (model: string) => model, accountModels: h.list }));
vi.mock('../../amplify/functions/invoice-number/handler', () => ({ reserveNextInvoiceNumber: h.reserve }));
vi.mock('../../amplify/functions/live-write', () => ({ sendCrmWrite: (p: Promise<unknown>) => p }));

const updatedAt = '2026-10-21T12:00:00.000Z';
const base = { accountId: 'hoa', updatedAt };
const property = { ...base, id: 'property', quoteId: 'q1', billType: 'AGENCY', status: 'ACTIVE', premium: 50000, lines: ['Commercial Property'],
  effectiveDate: '2026-10-13', expirationDate: '2027-10-13' };
const liability = { ...property, id: 'd-and-o', quoteId: 'q2', carrierBillType: 'DIRECT', policyNumber: 'DO-123', premium: 1500, lines: ['D&O'] };
const source = { ...base, id: 'orig', policyId: property.id, sourcePricingVersion: 1, status: 'DRAFT', dueAt: '2026-11-21' };
const premium = { ...base, id: 'premium', invoiceId: source.id, policyId: property.id, kind: 'PREMIUM', description: 'Property premium', retailAmount: 50000, costAmount: 45000 };
const supplier = { ...premium, id: 'supplier', kind: 'CARRIER_FEE', description: 'Carrier fee', retailAmount: 500, costAmount: 500 };
const input = { accountId: 'hoa', policyIds: [property.id, liability.id] };

function setup(changes: Record<string, object | undefined> = {}) {
  const rows: Record<string, object | undefined> = { 'Account:hoa': { id: 'hoa', updatedAt }, 'Policy:property': property, 'Policy:d-and-o': liability,
    'Quote:q1': { ...base, id: 'q1' }, 'Quote:q2': { ...base, id: 'q2' }, 'Invoice:orig': source,
    'InvoiceLine:premium': premium, 'InvoiceLine:supplier': supplier, ...changes };
  const access = { actor: 'owner', prefetch: async () => undefined,
    get: async (model: string, key: string) => rows[`${model}:${key}`],
    requireRecord: async (model: string, key: string) => {
      const row = rows[`${model}:${key}`]; if (!row) throw new Error('Missing record'); return row;
    } } as unknown as AccountAccess;
  h.list.mockImplementation((model: string) => Promise.resolve(model === 'Invoice' ? [source] : []));
  h.send.mockImplementation((command: { input: { TransactItems?: unknown[] } }) => Promise.resolve(command.input.TransactItems ? {} : { Items: [{ id: premium.id }, { id: supplier.id }] }));
  return access;
}

describe('combined invoice review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T17:00:00Z'));
    vi.stubEnv('USER_ACCESS_TABLE', 'access');
    vi.stubEnv('ACCESS_INDEXES', JSON.stringify({ 'InvoiceLine.invoiceId': 'byInvoice' }));
    h.reserve.mockResolvedValue({ invoiceNumber: 'INV-2026-00006' });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('freezes reviewed supplier costs and a gross direct advance in one unsent transaction', async () => {
    const result = await createGroupedDraft(setup(), input);
    const tx = h.send.mock.calls.map(([cmd]) => cmd.input.TransactItems).filter(Boolean);
    expect(tx).toHaveLength(1);
    const items = tx[0];
    const invoice = items.find((item: { Put?: { TableName: string } }) => item.Put?.TableName === 'Invoice').Put.Item;
    expect(invoice).toMatchObject({ id: result.invoiceId, groupedPolicyIds: [liability.id, property.id], status: 'DRAFT', dueAt: source.dueAt });
    for (const field of ['sentAt', 'paymentUrl', 'stripePaymentLinkId', 'policyId', 'quoteId']) expect(invoice).not.toHaveProperty(field);
    const lines = items.filter((item: { Put?: { TableName: string } }) => item.Put?.TableName === 'InvoiceLine').map((item: { Put: { Item: unknown } }) => item.Put.Item);
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyId: liability.id, retailAmount: 1500, costAmount: 1500 }),
      expect.objectContaining({ policyId: property.id, retailAmount: 50000, costAmount: 45000 }),
      expect.objectContaining({ policyId: property.id, retailAmount: 500, costAmount: 500 }),
    ]));
    expect(items).toContainEqual({ Update: expect.objectContaining({ TableName: 'Invoice', Key: { id: source.id },
      ConditionExpression: expect.stringContaining('attribute_not_exists(invoiceSendOperation)'),
      ExpressionAttributeValues: expect.objectContaining({ ':void': 'VOID' }) }) });
    expect(items.filter((item: { Update?: { TableName: string } }) => item.Update?.TableName === 'Policy')).toHaveLength(2);
  });

  it('rejects an invoice whose publication already started, before reserving a number', async () => {
    const access = setup({ 'Invoice:orig': { ...source, invoiceSendOperation: 'publishing' } });
    await expect(createGroupedDraft(access, input)).rejects.toThrow('cannot be combined');
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('returns an existing identical review without replacing records', async () => {
    const access = setup({ 'Policy:property': { ...property, groupedDraftInvoiceId: 'group' },
      'Policy:d-and-o': { ...liability, groupedDraftInvoiceId: 'group' },
      'Invoice:group': { ...base, id: 'group', status: 'DRAFT', sourcePricingVersion: 3, groupedPolicyIds: input.policyIds } });
    await expect(createGroupedDraft(access, input)).resolves.toEqual({ ok: true, invoiceId: 'group' });
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('refuses unreviewed costs and altered supplier charges', () => {
    expect(() => groupedReviewLines(property, source, [{ ...premium, costAmount: null }])).toThrow('supplier costs');
    expect(() => groupedReviewLines(property, source, [premium, { ...supplier, costAmount: 400 }])).toThrow('actual cost');
  });
});
