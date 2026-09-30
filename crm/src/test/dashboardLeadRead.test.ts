import { beforeEach, expect, it, vi } from 'vitest';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../amplify/functions/communications/store', () => ({ query: h.query }));
import { dashboardLeadPlansPage } from '../../amplify/functions/communications/dashboardLeadRead';

beforeEach(() => h.query.mockReset());

it('reads one bounded indexed page and strips full package terms and signatures', async () => {
  h.query.mockResolvedValue({ items: [{ id: 'commercial:a', data: {
    ...emptyCommercialPlan('a'), selectedOptionId: 'chosen', selectedTerms: { q1: 'private selected terms' },
    options: [{ id: 'chosen', name: 'Chosen', quoteIds: ['q1'], reviewed: { terms: { q1: 'private reviewed terms' } } }, { id: 'alternative', quoteIds: ['q1', 'q2'] }],
  } }], nextToken: 'next-page' });
  const token = Buffer.from(JSON.stringify({ id: 'commercial:prior', kind: 'COMMERCIAL_PLAN' })).toString('base64url');
  expect(await dashboardLeadPlansPage({ nextToken: token })).toEqual({
    items: [{ accountId: 'a', selectedQuoteIds: ['q1'], alternativeQuoteIds: ['q2'] }], nextToken: 'next-page',
  });
  expect(h.query).toHaveBeenCalledExactlyOnceWith('kind', 'COMMERCIAL_PLAN', token, 100);
});

it('advances across a page containing only unselected plans', async () => {
  h.query.mockResolvedValue({ items: [{ id: 'commercial:a', data: emptyCommercialPlan('a') }], nextToken: 'keep-going' });
  expect(await dashboardLeadPlansPage({})).toEqual({ items: [], nextToken: 'keep-going' });
});

it('keeps unvisited plans in the continuation when compact output reaches its byte budget', async () => {
  const records = ['a', 'b', 'c', 'd'].map(accountId => ({ id: `commercial:${accountId}`, data: {
    ...emptyCommercialPlan(accountId), selectedOptionId: 'chosen', options: [
      { id: 'chosen', name: 'Chosen', quoteIds: ['q1'] },
      { id: 'alternative', name: 'Alternative', quoteIds: Array.from({ length: 2000 }, (_, index) => `${index}-${'x'.repeat(90)}`) },
    ],
  } }));
  h.query.mockResolvedValue({ items: records });
  const result = await dashboardLeadPlansPage({});
  expect(result.items.map(item => item.accountId)).toEqual(['a', 'b']);
  expect(JSON.parse(Buffer.from(result.nextToken!, 'base64url').toString())).toEqual({ id: 'commercial:b', kind: 'COMMERCIAL_PLAN' });
});

it('refuses malformed continuation tokens before querying', async () => {
  await expect(dashboardLeadPlansPage({ nextToken: 12 })).rejects.toThrow('Invalid page token');
  await expect(dashboardLeadPlansPage({ nextToken: Buffer.from(JSON.stringify({ id: 'workflow:a', kind: 'WORKFLOW' })).toString('base64url') })).rejects.toThrow('Invalid page token');
  await expect(dashboardLeadPlansPage({ nextToken: Buffer.from(JSON.stringify({ id: 'commercial:a', kind: 'COMMERCIAL_PLAN', extra: true })).toString('base64url') })).rejects.toThrow('Invalid page token');
  expect(h.query).not.toHaveBeenCalled();
});
