import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ disclosure: vi.fn(), sign: vi.fn(), session: vi.fn(), account: vi.fn(), fees: vi.fn(), fee: vi.fn(), reconcile: vi.fn() }));
vi.mock('../../amplify/functions/broker-fees/agreements', () => ({ brokerFeeDisclosure: h.disclosure, signBrokerFeeDisclosure: h.sign }));
vi.mock('../../amplify/functions/broker-fees/store', () => ({ accountFees: h.fees, getFee: h.fee }));
vi.mock('../../amplify/functions/crm-access/user-status', () => ({ assertUserSession: h.session }));
vi.mock('../../amplify/functions/crm-access/access', () => ({ AccountAccess: class { requireRecord = h.account; } }));
vi.mock('../../amplify/functions/broker-fees/payments', () => ({ reconcilePendingPayments: h.reconcile }));
import { handler } from '../../amplify/functions/broker-fees/handler';
beforeEach(() => { vi.clearAllMocks(); delete process.env.HOA_MIGRATION_PREVIEW; delete process.env.HOA_MIGRATION_BUSINESS_HELD; h.disclosure.mockResolvedValue({ ok: true, state: 'open' }); h.sign.mockResolvedValue({ ok: true, state: 'signed' }); h.session.mockResolvedValue(undefined); h.account.mockResolvedValue({ id: 'a1' }); h.fees.mockResolvedValue([]); });
it('accepts Amplify top-level fieldName for public token reads', async () => {
  expect(await handler({ fieldName: 'brokerFeeDisclosure', arguments: { token: 'test-token' } })).toEqual({ ok: true, state: 'open' });
  expect(h.disclosure).toHaveBeenCalledWith('test-token'); expect(h.session).not.toHaveBeenCalled();
});
it('does not let an anonymous caller read account fee status', async () => {
  h.session.mockRejectedValue(new Error('Sign in to access the CRM.'));
  expect(await handler({ fieldName: 'brokerFeeAction', arguments: { input: { op: 'status', accountId: 'a1' } } })).toMatchObject({ ok: false }); expect(h.fees).not.toHaveBeenCalled();
});
it('checks account authorization before selecting fee rows and filters foreign rows', async () => {
  h.fee.mockImplementation(async (quoteId: string) => ({ id: `fee:${quoteId}`, quoteId, accountId: quoteId === 'own' ? 'a1' : 'foreign' }));
  const result = await handler({ fieldName: 'brokerFeeAction', identity: { sub: 'actor' }, arguments: { input: JSON.stringify({ op: 'status', accountId: 'a1', quoteIds: ['own', 'foreign'] }) } });
  expect(h.account).toHaveBeenCalledWith('Account', 'a1'); expect(result).toEqual({ ok: true, fees: [{ id: 'fee:own', quoteId: 'own', accountId: 'a1' }] });
});
it('blocks signing and scheduled payment writes while migration business execution is held', async () => {
  process.env.HOA_MIGRATION_BUSINESS_HELD = 'true';
  await expect(handler({ fieldName: 'signBrokerFeeDisclosure', arguments: { token: 'token' } })).rejects.toThrow('disabled');
  await expect(handler({ source: 'aws.events' })).rejects.toThrow('disabled'); expect(h.sign).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled();
});
it('throws scheduled reconciliation failures so event delivery can retry', async () => {
  h.reconcile.mockRejectedValue(new Error('Temporary accounting failure'));
  await expect(handler({ source: 'aws.events' })).rejects.toThrow('Temporary accounting failure');
});
