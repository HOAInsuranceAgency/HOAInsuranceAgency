import { describe, expect, it } from 'vitest';
import { emptyCommercialPlan } from '../../../shared/quotePackages';
import type { TeamEligibility } from './communications';
import { isInLast30Days, salespersonKey, salespersonSeries } from './dashboardPeople';

describe('dashboard attribution', () => {
  it('keeps disabled and missing owners separate, distinguishes duplicate names, and retains unassigned', () => {
    const team = [
      { userId: 'a', name: 'Alex', salesperson: true, enabled: true },
      { userId: 'b', name: 'Alex', salesperson: false, enabled: false },
      { userId: 'admin', name: 'Admin', salesperson: false, enabled: true },
    ] as TeamEligibility[];
    const entries = Object.fromEntries(['a', 'b', 'missing'].map(id => [id, { accountId: id, salespersonId: id, plan: emptyCommercialPlan(id) }]));
    const series = salespersonSeries({ entries, team });
    expect(new Set(series.map(person => person.key))).toEqual(new Set(['a', 'b', 'missing', 'unassigned']));
    expect(new Set(series.map(person => person.label)).size).toBe(4);
    expect(new Set(series.map(person => person.color)).size).toBe(4);
    expect(salespersonKey('b', entries)).toBe('b');
    expect(salespersonKey('deleted', entries)).toBe('unassigned');
  });
  it('assigns different colors to hash collisions consistently across roster order', () => {
    const team = ['sam', 'christina', 'avery', 'jake', 'blake'].map(userId => ({ userId, name: userId, salesperson: true })) as TeamEligibility[];
    const series = salespersonSeries({ team, entries: {} });
    expect(new Set(series.map(person => person.color)).size).toBe(series.length);
    expect(salespersonSeries({ team: [...team].reverse(), entries: {} })).toEqual(series);
  });
  it('bounds recent activity by a fixed snapshot, including cutoff and excluding future events', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    expect(isInLast30Days('2026-08-30T12:00:00Z', now)).toBe(true);
    expect(isInLast30Days('2026-08-30T11:59:59Z', now)).toBe(false);
    expect(isInLast30Days(now.toISOString(), now)).toBe(true);
    for (const value of ['2026-09-29T12:00:01Z', 'invalid', '', null]) expect(isInLast30Days(value, now)).toBe(false);
  });
});
