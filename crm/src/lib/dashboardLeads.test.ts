import { describe, expect, it } from 'vitest';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import type { CommercialEntry } from './commercial';
import { isOpenLead, leadPersonMetrics } from './dashboardLeads';
import { salespersonSeries } from './dashboardPeople';

const now = new Date('2026-09-29T16:00:00Z');
const entry = (accountId: string, salespersonId?: string, disposition: CommercialEntry['disposition'] = 'ACTIVE'): CommercialEntry => ({ accountId, salespersonId, disposition, plan: emptyCommercialPlan(accountId) });
const entries = { a: entry('a', 'alice'), b: entry('b', 'bob'), lost: entry('lost', 'alice', 'LOST'), unassigned: entry('unassigned'), bound: entry('bound', 'bob', 'BOUND') };
const series = salespersonSeries({ entries, team: [] });
const run = (overrides: Partial<Parameters<typeof leadPersonMetrics>[0]> = {}) => leadPersonMetrics({ accounts: [], quotes: [], policies: [], pipelineAccounts: [], entries, series, now, ...overrides });
const value = (rows: ReturnType<typeof run>['open'], person: string) => rows.find(row => row.key === person)?.values[person];

describe('salesperson lead metrics', () => {
  it('counts only open lead accounts and preserves unassigned accounts', () => {
    const accounts = [{ id: 'a', stage: 'LEAD' }, { id: 'b', stage: 'CLIENT' }, { id: 'lost', stage: 'LEAD' }, { id: 'unassigned', stage: 'LEAD' }, { id: 'bound', stage: 'LEAD' }];
    const metrics = run({ accounts });
    expect(value(metrics.open, 'alice')).toBe(1);
    expect(value(metrics.open, 'bob')).toBe(0);
    expect(value(metrics.open, 'unassigned')).toBe(1);
    expect(isOpenLead({ id: 'a', stage: 'LEAD' }, { a: entry('a', 'alice', 'DISQUALIFIED') })).toBe(false);
  });

  it('counts recent lead arrivals even after conversion, excluding direct clients and out-of-window creation', () => {
    const dates = ['2026-08-30T16:00:00Z', '2026-09-29T16:00:00Z', '2026-08-30T15:59:59Z', '2026-09-29T16:00:01Z', null, 'invalid'];
    const accounts = dates.map((createdAt, index) => ({ id: `lead-${index}`, stage: 'LEAD', createdAt }));
    const metrics = run({ accounts: [
      ...accounts,
      { id: 'b', stage: 'CLIENT', createdAt: '2026-09-20T00:00:00Z', convertedAt: '2026-09-25T00:00:00Z' },
      { id: 'a', stage: 'CLIENT', createdAt: '2026-09-20T00:00:00Z' },
      { id: 'lost', stage: 'LEAD', createdAt: '2026-09-20T00:00:00Z' },
    ] });
    expect(value(metrics.created, 'unassigned')).toBe(2);
    expect(value(metrics.created, 'bob')).toBe(1);
    // Arrivals include leads subsequently lost, because disposition is not an arrival filter.
    expect(value(metrics.created, 'alice')).toBe(1);
  });

  it('counts every open quote while excluding terminal lead accounts', () => {
    const metrics = run({ quotes: [
      ...['DRAFT', 'SUBMITTED', 'QUOTED', 'PRESENTED', 'BOUND', 'DECLINED', 'LOST'].map(status => ({ accountId: 'a', status })),
      { accountId: 'lost', status: 'PRESENTED' },
      { accountId: 'bound', status: 'DRAFT' },
      { accountId: 'unknown', status: 'SUBMITTED' },
    ] });
    expect(value(metrics.quotes, 'alice')).toBe(4);
    expect(value(metrics.quotes, 'bob')).toBe(1);
    expect(value(metrics.quotes, 'unassigned')).toBe(1);
  });

  it('retires package alternatives from quote counts and pipeline standing only after selection', () => {
    const account = entry('a', 'alice');
    account.plan.options = [{ id: 'chosen', name: 'Chosen', quoteIds: ['q1'] }, { id: 'alternative', name: 'Alternative', quoteIds: ['q2'] }];
    const quotes = [{ id: 'q1', accountId: 'a', status: 'DRAFT' }, { id: 'q2', accountId: 'a', status: 'PRESENTED' }];
    const calculate = () => run({ quotes, entries: { a: account }, pipelineAccounts: [{ id: 'a', stage: 'LEAD' }] });
    const unselected = calculate();
    expect(value(unselected.quotes, 'alice')).toBe(2);
    expect(unselected.pipeline.find(row => row.key === 'alice')?.values.presented).toBe(1);

    account.plan.selectedOptionId = 'chosen';
    const selected = calculate();
    expect(value(selected.quotes, 'alice')).toBe(1);
    expect(selected.pipeline.find(row => row.key === 'alice')?.values.marketing).toBe(1);
    expect(selected.pipeline.find(row => row.key === 'alice')?.values.presented).toBe(0);

    quotes[0].status = 'BOUND';
    const bound = calculate();
    expect(value(bound.quotes, 'alice')).toBe(0);
    expect(bound.pipeline.find(row => row.key === 'alice')?.values.binding).toBe(1);
    expect(bound.pipeline.find(row => row.key === 'alice')?.values.presented).toBe(0);
  });

  it('uses actual recorded bind timestamps and current assignments, never effective or conversion dates', () => {
    const policies = [
      { accountId: 'a', datePolicyBound: '2026-08-30T16:00:00Z' },
      { accountId: 'a', datePolicyBound: '2026-09-29T16:00:00Z' },
      { accountId: 'b', datePolicyBound: '2026-08-30T15:59:59Z' },
      { accountId: 'b', datePolicyBound: '2026-09-29T16:00:01Z' },
      { accountId: 'b', effectiveDate: '2026-09-20', datePolicyBound: null },
      { accountId: 'unknown', datePolicyBound: '2026-09-28T12:00:00Z' },
    ];
    const metrics = run({ policies, accounts: [{ id: 'b', stage: 'CLIENT', convertedAt: '2026-09-28T12:00:00Z' }] });
    expect(value(metrics.binds, 'alice')).toBe(2);
    expect(value(metrics.binds, 'bob')).toBe(0);
    expect(value(metrics.binds, 'unassigned')).toBe(1);
  });

  it('partitions opportunities by quote standing without dropping closed quotes or partially bound clients', () => {
    const ids = ['unworked', 'draft', 'presented', 'declined', 'partial', 'unknown'];
    const localEntries = Object.fromEntries(ids.map(id => [id, entry(id, 'alice')]));
    const metrics = run({
      entries: localEntries,
      pipelineAccounts: ids.map(id => ({ id, stage: id === 'partial' ? 'CLIENT' : 'LEAD' })),
      quotes: [
        { accountId: 'draft', status: 'DRAFT' }, { accountId: 'draft', status: 'LOST' },
        { accountId: 'presented', status: 'QUOTED' }, { accountId: 'presented', status: 'PRESENTED' },
        { accountId: 'declined', status: 'DECLINED' },
        { accountId: 'partial', status: 'BOUND' }, { accountId: 'partial', status: 'PRESENTED' },
        { accountId: 'unknown', status: 'UNRECOGNIZED' },
      ],
    });
    expect(metrics.pipeline.find(row => row.key === 'alice')?.values).toEqual({ unworked: 1, marketing: 1, presented: 1, binding: 1, closed: 1, other: 1 });
  });
});
