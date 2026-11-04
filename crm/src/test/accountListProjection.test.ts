import { expect, it } from 'vitest';
import { accountListNumberKey, accountListSortKey } from '../../../shared/accountListProjection';
import { accountListPartition, accountListScope, ACCOUNT_LIST_SORTS } from '../../../shared/accountList';
import { emptyCommercialPlan, packageTerms } from '../../../shared/quotePackages';
import { buildAccountListProjection, type ProjectionSource } from '../../amplify/functions/account-list/projection';
const day = '2026-11-04', at = `${day}T15:00:00.000Z`;
function source(stage = 'LEAD'): ProjectionSource {
  return { account: { id: 'a', name: 'Elm HOA', stage, type: 'ASSOCIATION', state: 'Massachusetts', currentPolicyExpiration: '2026-12-01', updatedAt: at, privateIntake: 'never return' },
    contacts: [
      { id: 'old', accountId: 'a', name: 'Former primary', isPrimary: true, validUntil: '2026-10-01', updatedAt: at },
      { id: 'current', accountId: 'a', name: 'Current primary', email: 'current@example.com', isPrimary: true, validFrom: '2026-10-01', updatedAt: at, phone: 'not needed here' },
    ], quotes: [], policies: [{ id: 'p', accountId: 'a', status: 'ACTIVE', expirationDate: '2027-01-01', updatedAt: at }],
    communication: new Map([['workflow:a', { id: 'workflow:a', version: 3, data: { accountId: 'a', salespersonId: 'sales', disposition: 'ACTIVE' } }]]),
    profile: { id: 'profile', userId: 'sales', firstName: 'Alice', lastName: 'Sales', updatedAt: at },
  };
}
it('orders numeric values exactly, keeps nulls separate, and normalizes text without truncation', () => {
  const numbers = [-1e15, -100.25, -1, -0.01, 0, 0.01, 1, 1.1, 2, 10, 100.25, 1e15];
  expect([...numbers].reverse().sort((a, b) => accountListNumberKey(a).localeCompare(accountListNumberKey(b)))).toEqual(numbers);
  expect(accountListNumberKey(-0)).toBe(accountListNumberKey(0));
  expect(accountListSortKey(null, 'a')).toEqual({ sk: '\u0000\u0000a', missing: true });
  expect(accountListSortKey('ÉLM', 'a')).toEqual(accountListSortKey('elm', 'a'));
  expect(() => accountListSortKey('中'.repeat(400), 'a')).toThrow('too long');
});
it('projects only allowed row fields and every source revision while retaining primary-contact and current-policy rules', () => {
  const result = buildAccountListProjection('a', source(), day, at)!;
  expect(result.snapshot.item).toMatchObject({ account: { name: 'Elm HOA' }, contact: { id: 'current', name: 'Current primary' }, renewalDate: '2027-01-01', commercial: { salespersonId: 'sales', workflowVersion: 3 } });
  expect(result.snapshot.item.account).not.toHaveProperty('privateIntake');
  expect(result.snapshot.item.contact).not.toHaveProperty('phone');
  expect(result.snapshot.dependencies).toEqual(expect.arrayContaining([
    { model: 'Account', id: 'a', revision: at }, { model: 'Contact', id: 'old', revision: at },
    { model: 'Communication', id: 'commercial:a', revision: '-' }, { model: 'Communication', id: 'deleted-account:a', revision: '-' },
    { model: 'UserProfile', id: 'profile', revision: at },
  ]));
  expect(result.indexes).toHaveLength(ACCOUNT_LIST_SORTS.length * 2);
  expect(result.indexes.every(index => index.state === 'MA' && index.open)).toBe(true);
  expect(result.indexes.find(index => index.pk === accountListPartition(accountListScope(), 'LEAD', 'renewal'))?.sk).toBe('2026-12-01\u0000\u0000a');
  expect(result.indexes.find(index => index.pk === accountListPartition(accountListScope('sales'), 'LEAD', 'salesperson'))?.sk).toBe('alice sales\u0000\u0000a');
});
it('keeps partially bound clients in both stages and strips package terms from the public estimate editor plan', () => {
  const input = source('CLIENT');
  input.quotes = ['BOUND', 'QUOTED'].map((status, i) => ({ id: `q${i}`, accountId: 'a', status, carrierId: 'carrier', premium: 1000, commissionPct: 10, lines: ['GL'], effectiveDate: '2026-12-01', expirationDate: '2027-12-01', updatedAt: at }));
  const terms = Object.fromEntries(input.quotes.map(quote => [String(quote.id), packageTerms(quote as never)]));
  const plan = { ...emptyCommercialPlan('a'), estimatedCents: 90000, requiredLines: ['GL'], selectedOptionId: 'selected', selectedTerms: terms,
    options: [{ id: 'selected', name: 'Chosen', quoteIds: ['q0', 'q1'], reviewed: { at, by: 'sales', terms } }] };
  input.communication.set('commercial:a', { id: 'commercial:a', version: 7, data: plan });
  const result = buildAccountListProjection('a', input, day, at)!;
  expect(result.snapshot.item.forecast).toMatchObject({ unfinished: true, cents: 10000, label: 'Partially bound' });
  expect(result.snapshot.item.commercial.plan).toEqual({ ...emptyCommercialPlan('a'), version: 7, estimatedCents: 90000 });
  expect(new Set(result.indexes.map(index => index.stage))).toEqual(new Set(['LEAD', 'CLIENT']));
  expect(result.indexes.find(index => index.pk === accountListPartition('AGENCY', 'CLIENT', 'renewal'))?.sk).toBe('2027-01-01\u0000\u0000a');
  input.quotes[1].status = 'BOUND';
  const fullyBound = buildAccountListProjection('a', input, day, at)!;
  expect(new Set(fullyBound.indexes.map(index => index.stage))).toEqual(new Set(['CLIENT']));
});
it('does not produce rows for deletion markers or deleted accounts and changes generation on day or dependency changes', () => {
  const input = source();
  const first = buildAccountListProjection('a', input, day, at)!;
  expect(buildAccountListProjection('a', input, day, '2026-11-04T16:00:00.000Z')?.snapshot.generation).toBe(first.snapshot.generation);
  expect(buildAccountListProjection('a', input, '2026-11-05', at)?.snapshot.generation).not.toBe(first.snapshot.generation);
  input.contacts[0].updatedAt = 'new';
  expect(buildAccountListProjection('a', input, day, at)?.snapshot.generation).not.toBe(first.snapshot.generation);
  input.communication.set('deleted-account:a', { id: 'deleted-account:a' });
  expect(buildAccountListProjection('a', input, day, at)).toBeUndefined();
  input.account = undefined;
  expect(buildAccountListProjection('a', input, day, at)).toBeUndefined();
});

it('keeps prefix names before their extensions in the persisted UTF-8 order', () => {
  const names = ['A', 'A B', 'Willow', 'Willow Bay', 'Willow Creek'];
  const sorted = [...names].reverse().sort((a, b) => Buffer.compare(Buffer.from(accountListSortKey(a, 'id').sk), Buffer.from(accountListSortKey(b, 'id').sk)));
  expect(sorted).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  expect(accountListSortKey('A\u0000B', 'id').sk).not.toBe(accountListSortKey('A', '\u0000Bid').sk);
});
