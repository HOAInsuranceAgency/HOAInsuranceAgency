import { expect, it } from 'vitest';
import {
  validatePlan,
  validateCommissionAccount,
  selectCommissionTerms,
  appendEntry,
  type CommissionAccount,
  type CommissionPlan,
} from '../../../shared/commissions';
import { commissionAccount, commissionPolicy, line, statement } from './commissionFixtures';
const plan = (): CommissionPlan => ({
  id: 'producer',
  producerId: 'producer',
  name: 'Producer',
  version: 1,
  terms: [
    {
      from: '2026-01-01',
      newBps: 2000,
      renewalBps: 1000,
      agreement: 'Standard plan',
      gim: {
        newBps: 500,
        renewalBps: 250,
        agreement: 'GIM addendum (test values)',
      },
    },
  ],
});
const gim = (): CommissionAccount => ({
  ...commissionAccount(),
  periods: [
    {
      from: '2026-01-01',
      classification: 'GIM',
      evidence: 'Confirmed GIM house account',
    },
  ],
});
it.each([
  ['STANDARD', 'NEW', 2000, 'Standard plan'],
  ['STANDARD', 'RENEWAL', 1000, 'Standard plan'],
  ['GIM', 'NEW', 500, 'GIM addendum (test values)'],
  ['GIM', 'RENEWAL', 250, 'GIM addendum (test values)'],
] as const)(
  'selects %s %s rates and calculates commission from agency receipts',
  (classification, transaction, rate, agreement) => {
    const account = classification === 'GIM' ? gim() : commissionAccount();
    const originalPlan = validatePlan(plan());
    const selected = selectCommissionTerms(originalPlan, account, '2026-10-28', transaction);
    expect(selected).toMatchObject({
      producerBps: rate,
      agreement,
      accountClassification: { classification, version: 2 },
    });
    const policy = appendEntry(
      { ...commissionPolicy(), ...selected },
      line(),
      statement(),
      'receipt',
    );
    expect(policy.entries[0].producerCents).toBe(rate * 10);
    account.periods[0].evidence = 'Later edit';
    const originalRates =
      classification === 'GIM' ? originalPlan.terms[0].gim! : originalPlan.terms[0];
    originalRates[transaction === 'NEW' ? 'newBps' : 'renewalBps'] = 3000;
    expect(policy.accountClassification?.evidence).not.toBe('Later edit');
    expect(policy.producerBps).toBe(rate);
  },
);
it('fails closed on missing classifications, gaps, and missing GIM terms but permits standard binds', () => {
  const p = plan();
  delete p.terms[0].gim;
  expect(() => selectCommissionTerms(p, undefined, '2026-10-28', 'NEW')).toThrow(/classify/);
  expect(() => selectCommissionTerms(p, gim(), '2025-12-31', 'NEW')).toThrow(/classify/);
  expect(() => selectCommissionTerms(p, gim(), '2026-10-28', 'NEW')).toThrow(
    /GIM house-account rates/,
  );
  expect(selectCommissionTerms(p, commissionAccount(), '2026-10-28', 'NEW').producerBps).toBe(2000);
});
it('honors inclusive boundaries and classification changes on the supplied commission date', () => {
  const account = gim();
  account.periods[0].to = '2026-10-27';
  account.periods.push({
    from: '2026-10-28',
    classification: 'STANDARD',
    evidence: 'GIM relationship ended',
  });
  expect(selectCommissionTerms(plan(), account, '2026-10-27', 'NEW').producerBps).toBe(500);
  expect(selectCommissionTerms(plan(), account, '2026-10-28', 'RENEWAL').producerBps).toBe(1000);
});
it('distinguishes explicit zero GIM rates from missing terms', () => {
  const p = plan();
  p.terms[0].gim!.newBps = 0;
  expect(selectCommissionTerms(validatePlan(p), gim(), '2026-10-28', 'NEW').producerBps).toBe(0);
  p.terms[0].gim!.renewalBps = undefined as unknown as number;
  expect(() => validatePlan(p)).toThrow(/renewal rate/);
});
it.each([-1, 10001, 5.5, NaN])('rejects invalid GIM rates %s', (value) => {
  const p = plan();
  p.terms[0].gim!.newBps = value;
  expect(() => validatePlan(p)).toThrow(/new-business rate/);
});
it('requires agreement evidence and rejects overlapping schedules', () => {
  const p = plan();
  p.terms[0].gim!.agreement = '';
  expect(() => validatePlan(p)).toThrow(/agreement reference/);
  p.terms[0].gim!.agreement = 'Confirmed';
  p.terms.push({ ...p.terms[0] });
  expect(() => validatePlan(p)).toThrow(/overlap/);
});
it('limits classification to Standard or GIM and validates evidence and date periods', () => {
  const account = gim();
  account.periods[0].classification = 'HOUSE' as 'GIM';
  expect(() => validateCommissionAccount(account)).toThrow(/only house-account/);
  account.periods[0].classification = 'GIM';
  account.periods[0].evidence = '';
  expect(() => validateCommissionAccount(account)).toThrow(/classification reference/);
  account.periods[0].evidence = 'Confirmed';
  account.periods[0].from = '2026-02-30';
  expect(() => validateCommissionAccount(account)).toThrow(/calendar/);
  account.periods[0].from = '2026-01-01';
  account.periods.push({ ...account.periods[0] });
  expect(() => validateCommissionAccount(account)).toThrow(/overlap/);
});

it.each(['STANDARD', 'GIM'] as const)(
  'permanently excludes pre-cutoff %s accounts on new business and later renewals',
  (classification) => {
    const p = plan();
    p.accountBoundFrom = '2026-10-01';
    p.receiptsFrom = '2026-10-01';
    const account = classification === 'GIM' ? gim() : commissionAccount();
    for (const transaction of ['NEW', 'RENEWAL'] as const) {
      const selected = selectCommissionTerms(p, account, '2027-01-01', transaction, '2026-09-30');
      expect(selected).toMatchObject({
        producerBps: 0,
        eligibility: { eligible: false, accountFirstBoundOn: '2026-09-30' },
      });
      const policy = { ...commissionPolicy(), ...selected };
      expect(() => appendEntry(policy, line(), statement(), 'receipt')).toThrow(/later renewals/);
      expect(
        appendEntry(policy, line({ eligible: false }), statement(), 'receipt').entries[0],
      ).toMatchObject({ agencyCents: 100000, producerCents: 0, eligible: false });
    }
  },
);
it('includes the cutoff day, rejects unknown history and enforces the separate agency receipt cutoff', () => {
  const p = plan();
  p.accountBoundFrom = '2026-10-01';
  p.receiptsFrom = '2026-10-01';
  expect(() => selectCommissionTerms(p, gim(), '2026-10-28', 'NEW')).toThrow(/first bind history/);
  const selected = selectCommissionTerms(p, gim(), '2026-10-28', 'NEW', '2026-10-01');
  expect(selected).toMatchObject({ producerBps: 500, eligibility: { eligible: true } });
  const policy = { ...commissionPolicy(), ...selected };
  expect(() =>
    appendEntry(policy, line(), { ...statement(), receivedOn: '2026-09-30' }, 'receipt'),
  ).toThrow(/received before/);
  expect(appendEntry(policy, line(), statement(), 'receipt').entries[0].producerCents).toBe(5000);
});
it('validates account first-bind evidence and producer cutoff dates', () => {
  expect(() =>
    validateCommissionAccount({
      ...commissionAccount(),
      neverBound: true,
      firstBoundOn: '2026-10-01',
    }),
  ).toThrow(/Choose/);
  expect(() =>
    validateCommissionAccount({ ...commissionAccount(), firstBoundOn: '2026-10-01' }),
  ).toThrow(/history reference/);
  expect(() => validatePlan({ ...plan(), accountBoundFrom: '2026-02-30' })).toThrow(/calendar/);
  expect(() => validatePlan({ ...plan(), receiptsFrom: 'invalid' })).toThrow(/calendar/);
});
