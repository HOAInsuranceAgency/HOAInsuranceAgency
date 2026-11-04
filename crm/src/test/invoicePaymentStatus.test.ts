import { expect, it } from 'vitest';
import { isNonpayableAdjustmentStatement } from '../../../shared/invoicePaymentStatus';

const sentCredit = { sourcePricingVersion: 2, status: 'SENT', sentAt: '2026-11-04T20:00:00Z',
  remittanceCarrierCents: -8000, remittanceCommissionCents: -2000, remittanceInterestCents: 0, remittanceBrokerFeeCents: 0 };

it('recognizes an issued credit or zero statement without changing its status to paid', () => {
  expect(isNonpayableAdjustmentStatement(sentCredit)).toBe(true);
  expect(isNonpayableAdjustmentStatement({ ...sentCredit, remittanceCarrierCents: 0, remittanceCommissionCents: 0 })).toBe(true);
  expect(isNonpayableAdjustmentStatement({ ...sentCredit, remittanceCarrierCents: -10000, remittanceCommissionCents: 10000 })).toBe(true);
  expect(sentCredit.status).toBe('SENT');
});

it.each(['remittanceCarrierCents', 'remittanceCommissionCents', 'remittanceInterestCents', 'remittanceBrokerFeeCents'])('requires the complete server receipt snapshot, including %s', field => {
  const incomplete: Record<string, unknown> = { ...sentCredit };
  delete incomplete[field];
  expect(isNonpayableAdjustmentStatement(incomplete)).toBe(false);
  expect(isNonpayableAdjustmentStatement({ ...sentCredit, [field]: '0' })).toBe(false);
  expect(isNonpayableAdjustmentStatement({ ...sentCredit, [field]: .5 })).toBe(false);
});

it.each(['stripePaymentLinkId', 'paymentUrl', 'brokerFeeFinanceUrl'])('keeps an adjustment with a %s payment path payable', field => {
  expect(isNonpayableAdjustmentStatement({ ...sentCredit, [field]: 'existing-payment-path' })).toBe(false);
  expect(isNonpayableAdjustmentStatement({ ...sentCredit, [field]: null })).toBe(true);
});

it('does not finalize drafts, ordinary invoices, unknown receipts, agency fees or positive amounts', () => {
  for (const delta of [{ status: 'DRAFT' }, { sourcePricingVersion: 1 }, { sentAt: '' }, { sentAt: undefined },
    { remittanceCarrierCents: 10000, remittanceCommissionCents: 0 },
    { remittanceBrokerFeeCents: 100 }, { remittanceInterestCents: -100 },
    { remittanceCarrierCents: -Number.MAX_SAFE_INTEGER, remittanceCommissionCents: -1 }]) {
    expect(isNonpayableAdjustmentStatement({ ...sentCredit, ...delta })).toBe(false);
  }
  expect(isNonpayableAdjustmentStatement(null)).toBe(false);
});
