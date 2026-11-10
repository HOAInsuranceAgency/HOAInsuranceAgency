import { beforeEach, expect, it, vi } from 'vitest';
import { commissionPolicy } from './commissionFixtures';
import { receiptOnlyCarrierTerms, type CarrierPaymentArrangement } from '../../../shared/commissions';

const h = vi.hoisted(() => ({ get: vi.fn(), requireRecord: vi.fn() }));
vi.mock('../../amplify/functions/commissions/store', () => ({ get: h.get }));
vi.mock('../../amplify/functions/crm-access/access', () => ({
  AccountAccess: class { requireRecord = h.requireRecord; },
}));
import { previewCarrierPaymentTerms } from '../../amplify/functions/commissions/payment-preview';

const payment: CarrierPaymentArrangement = {
  id: 'written-direct', from: '2026-01-01', basis: 'WRITTEN', payor: 'Harbor MGA',
  trigger: 'EFFECTIVE', cadence: 'MONTHLY', lagDays: 5, cutoffDay: 25, paymentDay: 15,
  billType: 'DIRECT', evidence: 'Private contract 2026', notes: 'Private carrier correspondence',
};
const event = (billType = 'DIRECT') => ({
  identity: { sub: 'producer', groups: ['PRODUCER'] },
  request: { headers: { 'x-crm-role': 'PRODUCER' } },
  arguments: { quoteId: 'q', billType },
});
beforeEach(() => {
  vi.resetAllMocks();
  h.requireRecord.mockResolvedValue({ carrierId: 'c', effectiveDate: '2026-10-01', lines: ['Property'] });
  h.get.mockResolvedValue({ ...commissionPolicy().carrierTerms, arrangements: [payment] });
});
it('returns only the selected arrangement summary, without private evidence or other carrier rules', async () => {
  const result = await previewCarrierPaymentTerms(event());
  expect(h.requireRecord).toHaveBeenCalledExactlyOnceWith('Quote', 'q');
  expect(result).toEqual({ carrierTermsVersion: 1, basis: 'WRITTEN', payment: {
    id: 'written-direct', payor: 'Harbor MGA', trigger: 'EFFECTIVE', cadence: 'MONTHLY',
    lagDays: 5, cutoffDay: 25, paymentDay: 15,
  } });
  expect(JSON.stringify(result)).not.toContain('Private');
  expect(result).not.toHaveProperty('arrangements');
});
it('checks quote access before reading the private carrier ledger', async () => {
  h.requireRecord.mockRejectedValue(new Error('Not authorized'));
  await expect(previewCarrierPaymentTerms(event())).rejects.toThrow('Not authorized');
  expect(h.get).not.toHaveBeenCalled();
});
it('does not infer structured timing from a legacy carrier schedule', async () => {
  h.get.mockResolvedValue(commissionPolicy().carrierTerms);
  expect(await previewCarrierPaymentTerms(event())).toEqual({
    carrierTermsVersion: 1, basis: 'COLLECTED',
  });
});
it('rejects missing matches and invalid bill types without returning another arrangement', async () => {
  await expect(previewCarrierPaymentTerms(event('AGENCY'))).rejects.toThrow();
  h.get.mockClear();
  await expect(previewCarrierPaymentTerms(event('MONTHLY'))).rejects.toThrow('Choose a bill type');
  expect(h.get).not.toHaveBeenCalled();
});

it('previews explicit receipt-only tracking without inventing or exposing carrier payment rules', async () => {
  h.get.mockResolvedValue(receiptOnlyCarrierTerms({ id: 'c', name: 'Carrier', version: 3 }));
  expect(await previewCarrierPaymentTerms(event())).toEqual({ carrierTermsVersion: 3, basis: 'UNSPECIFIED' });
});
