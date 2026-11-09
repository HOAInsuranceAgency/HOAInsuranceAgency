// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { loadGroupedFinance } from '../../amplify/functions/grouped-finance';
import type { LambdaDataClient } from '../../amplify/functions/data-client';

const storage = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../../amplify/functions/broker-fees/store', async importOriginal => ({
  ...await importOriginal<typeof import('../../amplify/functions/broker-fees/store')>(),
  getModel: async (model: string, id: string) => storage.get(`${model}:${id}`),
  modelTable: (model: string) => model,
  db: { send: async ({ input }: { input: { RequestItems: Record<string, { Keys: { id: string }[]; ConsistentRead: boolean }> } }) => {
    const [model, request] = Object.entries(input.RequestItems)[0]!;
    expect(request.ConsistentRead).toBe(true);
    return { Responses: { [model]: request.Keys.flatMap(({ id }) => storage.get(`${model}:${id}`) ?? []) } };
  } },
}));

const old = '2026-10-21T04:00:00Z';
const put = (model: string, id: string, values: Record<string, unknown>) => storage.set(`${model}:${id}`, { id, updatedAt: old, ...values });
const load = () => loadGroupedFinance({} as LambdaDataClient, 'group');

beforeEach(() => {
  storage.clear();
  put('Account', 'account', { state: 'MA', type: 'HOA' });
  put('Carrier', 'carrier', { name: 'Commercial Carrier' });
  put('Invoice', 'group', { accountId: 'account', number: 'INV-EXAMPLE', status: 'DRAFT', sourcePricingVersion: 3,
    groupedPolicyIds: ['ordinary', 'advance'], groupedSourceInvoiceIds: ['source'], groupedReviewedTotals: [['ordinary', 5050000]] });
  put('Invoice', 'source', { accountId: 'account', policyId: 'ordinary', status: 'VOID', sourcePricingVersion: 1,
    supersededByGroupedInvoiceId: 'group' });
  const policy = { accountId: 'account', status: 'ACTIVE', billType: 'AGENCY', effectiveDate: '2026-10-13',
    expirationDate: '2099-10-13', groupedDraftInvoiceId: 'group', carrierId: 'carrier', lines: ['Commercial Property'] };
  put('Policy', 'ordinary', { ...policy, premium: 50000, policyNumber: 'PROPERTY' });
  put('Policy', 'advance', { ...policy, premium: 1521, policyNumber: 'DNO', lines: ['D&O'], carrierBillType: 'DIRECT' });
  const line = (index: number, policyId: string, kind: string, retailAmount: number, costAmount: number) =>
    put('InvoiceLine', `group:${index}`, { invoiceId: 'group', accountId: 'account', sortOrder: index, policyId,
      kind, retailAmount, costAmount, description: kind });
  line(0, 'ordinary', 'PREMIUM', 50000, 45000);
  line(1, 'ordinary', 'WHOLESALER_FEE', 500, 500);
  line(2, 'advance', 'PREMIUM', 1521, 1521);
});

it('loads the exact reviewed gross amounts from an existing group without line count or index reads', async () => {
  const grouped = await load();
  expect(grouped.premium).toBe(52021);
  expect(grouped.agreementLines).toEqual([
    expect.stringContaining('PROPERTY'),
    expect.stringContaining('DNO'),
  ]);
  expect(grouped.agreementLines[1]).toContain('$1,521.00');
  expect(grouped.guards.map(guard => guard.ConditionCheck?.Key?.id)).toEqual([
    'account', 'ordinary', 'advance', 'source', 'group:0', 'group:1', 'group:2',
  ]);
  expect(grouped.invoiceGuard.ConditionCheck?.Key?.id).toBe('group');
});

it('refuses a group with missing reviewed supplier charges even if its premiums still exist', async () => {
  storage.delete('InvoiceLine:group:1');
  await expect(load()).rejects.toThrow('no longer matches');
});

it('refuses a group when a separate source invoice has a payment path', async () => {
  storage.get('Invoice:source')!.stripePaymentLinkId = 'other-link';
  await expect(load()).rejects.toThrow('no longer matches');
});

it('refuses a member if its recorded premium changed after review', async () => {
  storage.get('Policy:advance')!.premium = 1600;
  await expect(load()).rejects.toThrow('no longer matches');
});
