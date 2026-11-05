import { beforeEach, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsAdmin, useIsOwner, fetchUserGroups } from '../../scripts/preview-support/auth';
import { account, quote } from '../../fixtures/builders';
import { createCommercialScenario } from '../../fixtures/commercial';
import { commissionPolicy, line, statement } from '../../fixtures/commissions';
import { client, commercialFixtures, communicationRequest, resetCommercialFixtures } from './fixtures/commercialClient';

beforeEach(resetCommercialFixtures);

it('denies privileged controls and session lookup unless a preview explicitly supplies auth', async () => {
  const { result } = renderHook(() => ({ admin: useIsAdmin(), owner: useIsOwner() }));
  expect(result.current).toEqual({ admin: false, owner: false });
  await expect(fetchUserGroups()).rejects.toThrow('no signed-in session');
});

it('owns nested fixture overrides instead of mutating the supplied data or another record', () => {
  const input = { id: 'priced', lines: ['Property', 'D&O'] };
  const first = quote(input), second = quote(input);
  first.lines!.push('Crime');
  expect(input.lines).toEqual(['Property', 'D&O']);
  expect(second.lines).toEqual(['Property', 'D&O']);
  expect(first).not.toHaveProperty('account', expect.any(Function));
  expect(account()).toMatchObject({ stage: 'LEAD', type: 'ASSOCIATION' });
});

it('creates independent commercial and financial scenarios down to reviewed terms and schedules', () => {
  const first = createCommercialScenario(), second = createCommercialScenario();
  first.accounts[0].name = 'Edited';
  first.quotes[0].lines!.push('Crime');
  first.plans.willow.options[0].reviewed!.terms.bundle = 'Edited';
  first.team[0].enabled = false;
  expect(second.accounts[0].name).toBe('Willow Court Condominium');
  expect(second.quotes[0].lines).toEqual(['Property', 'D&O']);
  expect(second.plans.willow.options[0].reviewed!.terms.bundle).not.toBe('Edited');
  expect(second.team[0].enabled).toBe(true);
  const policy = commissionPolicy(), another = commissionPolicy();
  policy.carrierTerms.name = 'Edited';
  expect(another.carrierTerms.name).toBe('Carrier');
  const receipt = statement(), otherReceipt = statement();
  receipt.lines.push(line());
  expect(otherReceipt.lines).toEqual([]);
});

it('returns independent, paginated model reads and explicitly resets each test scenario', async () => {
  const first = await client.models.Account.list({ filter: { stage: { eq: 'LEAD' } }, limit: 1 });
  expect(first.data.map(row => row.id)).toEqual(['willow']);
  expect(first.nextToken).toBe('1');
  first.data[0].name = 'Response mutation';
  const next = await client.models.Account.list({ filter: { stage: { eq: 'LEAD' } }, limit: 1, nextToken: first.nextToken });
  expect(next.data.map(row => row.id)).toEqual(['pine']);
  expect(next.nextToken).toBeNull();
  commercialFixtures.accounts[0].name = 'Test-owned edit';
  commercialFixtures.plans.willow.options[0].quoteIds.push('Test-owned option');
  resetCommercialFixtures();
  expect(commercialFixtures.accounts[0].name).toBe('Willow Court Condominium');
  expect(commercialFixtures.plans.willow.options[0].quoteIds).toEqual(['bundle']);
  await expect(client.models.Account.list({ nextToken: 'invalid' })).rejects.toThrow('Invalid fictional page');
});

it('cannot silently authorize an unexpected read or invent a successful write', async () => {
  await expect(communicationRequest('team', {}, true)).rejects.toThrow('Declare writes');
  await expect(communicationRequest('saveCommercial', { accountId: 'willow' })).rejects.toThrow('Unexpected fictional operation');
  await expect(communicationRequest('unknown')).rejects.toThrow('Unexpected fictional operation');
  await expect(communicationRequest('commercialTable', { accountIds: ['real-account'] })).rejects.toThrow('fictional account');
  expect(client.models.Account).not.toHaveProperty('create');
  const result = await communicationRequest('commercialTable', { accountIds: ['willow'] });
  expect('items' in result && result.items).toHaveLength(1);
});

// TypeScript checks persisted fields without claiming to construct lazy SDK relationships.
function typedOverrides() {
  // @ts-expect-error unknown model state
  account({ stage: 'NOT_A_STAGE' });
  // @ts-expect-error invented model field
  quote({ madeUpCharge: 500 });
}
it('checks typed overrides through the standard TypeScript build', () => {
  expect(typedOverrides).toBeTypeOf('function');
});
