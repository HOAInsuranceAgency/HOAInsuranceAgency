import { expect, it } from 'vitest';
import { firstBindDate, bindDay } from '../../amplify/functions/commissions/account-history';
import { commissionAccount } from './commissionFixtures';
it('records a genuinely new account on its first bind, but never resets an old account', () => {
  const account = {
    ...commissionAccount(),
    neverBound: true as const,
    bindingEvidence: 'Confirmed new',
  };
  expect(firstBindDate(account, '2026-10-01', false)).toBe('2026-10-01');
  expect(() => firstBindDate(account, '2026-10-01', true)).toThrow(/already has policy history/);
  expect(firstBindDate(commissionAccount(), '2026-10-01', false)).toBeUndefined();
});
it('checks Owner history against known binds including original historical adoption', () => {
  const account = { ...commissionAccount(), firstBoundOn: '2026-10-01', bindingEvidence: 'Binder' };
  expect(firstBindDate(account, '2027-10-01', true, '2026-10-01')).toBe('2026-10-01');
  expect(() => firstBindDate(account, '2026-09-30', true)).toThrow(/later than/);
  expect(() => firstBindDate(account, '2027-10-01', true, '2026-09-30')).toThrow(/later than/);
});
it('uses New York bind dates at the cutoff boundary and preserves date-only history', () => {
  expect(bindDay('2026-10-01T03:59:59Z')).toBe('2026-09-30');
  expect(bindDay('2026-10-01T04:00:00Z')).toBe('2026-10-01');
  expect(bindDay('2026-10-01')).toBe('2026-10-01');
  expect(bindDay(undefined)).toBeUndefined();
});
