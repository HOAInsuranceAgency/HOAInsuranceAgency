import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  accountViewFromParams, accountViewKey, accountViewParams, normalizeAccountView,
  readAccountView, saveAccountView,
} from './accountListView';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('validates URL preferences by stage and active privilege without retaining arbitrary data', () => {
  const malicious = new URLSearchParams('view=snoozed&salesperson=other%40example.com&sort=salary&dir=sideways');
  expect(accountViewFromParams(malicious, 'LEAD', false)).toEqual({ leadView: 'Snoozed', salesperson: '', sortKey: 'renewal', dir: 'asc' });
  expect(accountViewFromParams(new URLSearchParams('view=all&salesperson=alice&sort=salesperson&dir=desc'), 'LEAD', false))
    .toEqual({ leadView: 'All leads', salesperson: '', sortKey: 'renewal', dir: 'desc' });
  expect(accountViewFromParams(new URLSearchParams('view=due&sort=followUp'), 'CLIENT', true))
    .toEqual({ leadView: 'Active', salesperson: '', sortKey: 'renewal', dir: 'asc' });
});

it('keeps unrelated URL parameters and produces a complete shareable view', () => {
  const view = normalizeAccountView({ leadView: 'Follow-up due', salesperson: 'alice', sortKey: 'name', dir: 'desc' }, 'LEAD', true);
  expect(accountViewParams(new URLSearchParams('other=keep&sort=old'), view, 'LEAD').toString())
    .toBe('other=keep&view=due&salesperson=alice&sort=name&dir=desc');
  expect(accountViewParams(new URLSearchParams('view=all'), normalizeAccountView({}, 'CLIENT', false), 'CLIENT').toString())
    .toBe('sort=renewal&dir=asc');
});

it('separates users, exact roles and lead/client preferences, and persists only safe view fields', () => {
  const key = accountViewKey('user-1:ADMIN', 'LEAD')!;
  const view = normalizeAccountView({ leadView: 'All leads', salesperson: 'alice', sortKey: 'name', dir: 'desc' }, 'LEAD', true);
  saveAccountView(key, view);
  expect(readAccountView(key, 'LEAD', true)).toEqual(view);
  for (const scope of ['user-2:ADMIN', 'user-1:PRODUCER', 'user-1:OWNER']) {
    expect(readAccountView(accountViewKey(scope, 'LEAD'), 'LEAD', true).sortKey).toBe('renewal');
  }
  expect(readAccountView(accountViewKey('user-1:ADMIN', 'CLIENT'), 'CLIENT', true).sortKey).toBe('renewal');
  expect(Object.keys(JSON.parse(window.localStorage.getItem(key)!)).sort()).toEqual(['version', 'leadView', 'salesperson', 'sortKey', 'dir'].sort());
  expect(accountViewKey('person@example.com:ADMIN', 'LEAD')).toBeNull();
  expect(accountViewKey(undefined, 'LEAD')).toBeNull();
});

it('falls back safely for old, malformed or unavailable storage', () => {
  const key = accountViewKey('user-1:ADMIN', 'LEAD')!;
  for (const bad of ['{', JSON.stringify({ version: 2, sortKey: 'name' }), 'null']) {
    window.localStorage.setItem(key, bad);
    expect(readAccountView(key, 'LEAD', true).sortKey).toBe('renewal');
  }
  vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
  expect(readAccountView(key, 'LEAD', true).sortKey).toBe('renewal');
  expect(() => saveAccountView(key, normalizeAccountView({}, 'LEAD', true))).not.toThrow();
});
