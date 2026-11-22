import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreGroupedDraft } from '../../amplify/functions/crm-access/grouped-draft';
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
const input = { accountId: 'hoa', policyIds: [property.id, liability.id], reviewedTotals: [{ policyId: property.id, totalCents: 5050000 }] };

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

  it('restores source drafts and releases all members in one conditional transaction', async () => {
    const group = { ...base, id: 'group', sourcePricingVersion: 3, status: 'DRAFT', groupedPolicyIds: input.policyIds,
      groupedSourceInvoiceIds: [source.id] };
    const access = setup({ 'Invoice:group': group, 'Invoice:orig': { ...source, status: 'VOID', supersededByGroupedInvoiceId: group.id },
      'Policy:property': { ...property, groupedDraftInvoiceId: group.id }, 'Policy:d-and-o': { ...liability, groupedDraftInvoiceId: group.id } });
    await expect(restoreGroupedDraft(access, { invoiceId: group.id })).resolves.toEqual({ ok: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    const writes = h.send.mock.calls[0][0].input.TransactItems;
    expect(writes).toContainEqual({ Update: expect.objectContaining({ TableName: 'Invoice', Key: { id: source.id },
      ConditionExpression: expect.stringContaining('supersededByGroupedInvoiceId = :group'),
      ExpressionAttributeValues: expect.objectContaining({ ':draft': 'DRAFT', ':group': group.id }) }) });
    expect(writes).toContainEqual({ Update: expect.objectContaining({ TableName: 'Invoice', Key: { id: group.id },
      ExpressionAttributeValues: expect.objectContaining({ ':void': 'VOID' }) }) });
    expect(writes.filter((item: { Update?: { UpdateExpression: string } }) => item.Update?.UpdateExpression.includes('REMOVE groupedDraftInvoiceId'))).toHaveLength(2);
  });

  it('does not revive an invoice reserved by a different draft', async () => {
    const group = { ...base, id: 'group', sourcePricingVersion: 3, status: 'DRAFT', groupedPolicyIds: input.policyIds,
      groupedSourceInvoiceIds: [source.id] };
    const access = setup({ 'Invoice:group': group, 'Invoice:orig': { ...source, status: 'VOID', supersededByGroupedInvoiceId: 'other' },
      'Policy:property': { ...property, groupedDraftInvoiceId: group.id }, 'Policy:d-and-o': { ...liability, groupedDraftInvoiceId: group.id } });
    await expect(restoreGroupedDraft(access, { invoiceId: group.id })).rejects.toThrow('no longer match');
    expect(h.send).not.toHaveBeenCalled();
  });
});
