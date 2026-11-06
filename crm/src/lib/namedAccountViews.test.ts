import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountViewKey, normalizeAccountView, type AccountListView } from './accountListView';
import { MAX_NAMED_VIEWS, putNamedAccountView, readNamedAccountViews, viewName, writeNamedAccountViews, type NamedAccountView } from './namedAccountViews';

const key = accountViewKey('user-1:ADMIN', 'LEAD')!;
const base = () => normalizeAccountView({ leadView: 'Follow-up due', salesperson: 'alice', state: 'FL', sortKey: 'followUp', dir: 'desc' }, 'LEAD', true);
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('named account view persistence', () => {
  it('creates, reloads, updates, renames and deletes named preferences without changing the stable view ID', () => {
    expect(readNamedAccountViews(key, 'LEAD', true)).toEqual({ views: [], available: true });
    let views = putNamedAccountView([], { name: '  Florida   follow-ups  ', view: base() }, 'LEAD', true);
    expect(views).toHaveLength(1);
    expect(views[0].id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
    expect(views[0].name).toBe('Florida follow-ups');
    writeNamedAccountViews(key, views, 'LEAD', true);
    views = readNamedAccountViews(key, 'LEAD', true).views;
    expect(views[0].view).toEqual(base());
    const savedId = views[0].id;
    views = putNamedAccountView(views, { id: savedId, name: 'Florida follow-ups', view: { ...base(), sortKey: 'name', dir: 'asc' } }, 'LEAD', true);
    writeNamedAccountViews(key, views, 'LEAD', true);
    expect(readNamedAccountViews(key, 'LEAD', true).views[0]).toMatchObject({ id: savedId, view: { sortKey: 'name', dir: 'asc' } });
    views = putNamedAccountView(views, { ...views[0], name: 'My Florida queue' }, 'LEAD', true);
    writeNamedAccountViews(key, views, 'LEAD', true);
    expect(readNamedAccountViews(key, 'LEAD', true).views[0]).toMatchObject({ id: savedId, name: 'My Florida queue' });
    views = views.filter(view => view.id !== savedId);
    writeNamedAccountViews(key, views, 'LEAD', true);
    expect(readNamedAccountViews(key, 'LEAD', true)).toEqual({ views: [], available: true });
  });

  it('serializes only explicit safe preferences and valid state codes, excluding extra records and report data', () => {
    const unsafe = {
      ...base(), state: ' fl ', accounts: [{ fein: 'private-tax-id' }], contacts: ['private@example.com'], report: 'private report',
    } as AccountListView;
    const views = [{ id: id(1), name: 'Florida', view: unsafe, account: { name: 'private account' } }] as unknown as NamedAccountView[];
    writeNamedAccountViews(key, views, 'LEAD', true);
    const raw = window.localStorage.getItem(`${key}:named`)!;
    expect(raw).not.toMatch(/private|accounts|contacts|report|fein/);
    expect(JSON.parse(raw)).toEqual({ version: 1, views: [{ id: id(1), name: 'Florida', view: { ...base(), state: 'FL' } }] });
    window.localStorage.setItem(`${key}:named`, JSON.stringify({ version: 1, views: [{ ...views[0], view: { ...unsafe, state: 'Florida' } }] }));
    expect(readNamedAccountViews(key, 'LEAD', true).views[0].view.state).toBe('');
  });

  it('revalidates stage and current privilege when loading a saved view', () => {
    writeNamedAccountViews(key, [{ id: id(1), name: 'Assigned Florida leads', view: base() }], 'LEAD', true);
    expect(readNamedAccountViews(key, 'LEAD', false).views[0].view).toEqual({ ...base(), salesperson: '' });
    expect(readNamedAccountViews(key, 'CLIENT', false).views[0].view).toEqual({ leadView: 'Active', salesperson: '', state: 'FL', sortKey: 'renewal', dir: 'desc' });
  });

  it('separates different users, every exact active role and lead/client lists', () => {
    const original = [{ id: id(1), name: 'My work', view: base() }];
    writeNamedAccountViews(key, original, 'LEAD', true);
    for (const scope of ['user-2:ADMIN', 'user-1:OWNER', 'user-1:STAFF', 'user-1:PRODUCER']) {
      expect(readNamedAccountViews(accountViewKey(scope, 'LEAD'), 'LEAD', true)).toEqual({ views: [], available: true });
    }
    expect(readNamedAccountViews(accountViewKey('user-1:ADMIN', 'CLIENT'), 'CLIENT', true)).toEqual({ views: [], available: true });
    expect(readNamedAccountViews(key, 'LEAD', true).views).toEqual(original);
    expect(readNamedAccountViews(accountViewKey('email@example.com:ADMIN', 'LEAD'), 'LEAD', true)).toEqual({ views: [], available: false });
  });
});

describe('named view limits and names', () => {
  it('allows 20 views and updating the twentieth, but rejects adding or writing a twenty-first', () => {
    let views: NamedAccountView[] = [];
    for (let index = 0; index < MAX_NAMED_VIEWS; index++) views = putNamedAccountView(views, { name: `View ${index + 1}`, view: base() }, 'LEAD', true);
    writeNamedAccountViews(key, views, 'LEAD', true);
    expect(readNamedAccountViews(key, 'LEAD', true).views).toHaveLength(20);
    expect(() => putNamedAccountView(views, { name: 'View 21', view: base() }, 'LEAD', true)).toThrow(/up to 20/);
    const updated = putNamedAccountView(views, { id: views[19].id, name: 'Renamed twentieth', view: base() }, 'LEAD', true);
    expect(updated).toHaveLength(20);
    expect(updated[19].name).toBe('Renamed twentieth');
    expect(() => writeNamedAccountViews(key, [...views, { id: id(21), name: 'View 21', view: base() }], 'LEAD', true)).toThrow(/unavailable/);
    expect(readNamedAccountViews(key, 'LEAD', true).views).toHaveLength(20);
  });

  it.each(['', ' ', '\t', '\n', 'Two\nlines', 'Carriage\rreturn', 'Hidden\u0000control', 'Delete\u007fcontrol'])('rejects blank or control-character names: %j', name => {
    expect(() => putNamedAccountView([], { name, view: base() }, 'LEAD', true)).toThrow();
  });

  it('accepts an 80-character name and refuses 81 characters', () => {
    expect(viewName('x'.repeat(80))).toHaveLength(80);
    expect(() => viewName('x'.repeat(81))).toThrow(/80 characters/);
  });

  it('prevents case-insensitive duplicate names on create and rename, allowing self-renaming', () => {
    let views = putNamedAccountView([], { name: 'My Queue', view: base() }, 'LEAD', true);
    expect(() => putNamedAccountView(views, { name: '  my   queue ', view: base() }, 'LEAD', true)).toThrow(/already in use/);
    views = putNamedAccountView(views, { name: 'Another queue', view: base() }, 'LEAD', true);
    expect(() => putNamedAccountView(views, { id: views[1].id, name: 'MY QUEUE', view: base() }, 'LEAD', true)).toThrow(/already in use/);
    expect(putNamedAccountView(views, { id: views[0].id, name: 'MY QUEUE', view: base() }, 'LEAD', true)[0].name).toBe('MY QUEUE');
    expect(() => putNamedAccountView(views, { id: id(404), name: 'Missing', view: base() }, 'LEAD', true)).toThrow(/no longer available/);
  });
});

describe('unavailable and malformed saved views', () => {
  it('reports unavailable storage honestly and refuses to claim a blocked write succeeded', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    expect(readNamedAccountViews(key, 'LEAD', true)).toEqual({ views: [], available: false });
    expect(() => writeNamedAccountViews(key, [{ id: id(1), name: 'Queue', view: base() }], 'LEAD', true)).toThrow(/Could not save views.*current filters still work in the URL/);
    expect(() => writeNamedAccountViews(null, [], 'LEAD', true)).toThrow(/unavailable/);
  });

  it.each([
    '{', 'null', JSON.stringify({ version: 2, views: [] }), JSON.stringify({ version: 1, views: {} }), 'x'.repeat(100_001),
  ])('marks an invalid envelope unavailable rather than silently showing an empty saved list', raw => {
    window.localStorage.setItem(`${key}:named`, raw);
    expect(readNamedAccountViews(key, 'LEAD', true)).toEqual({ views: [], available: false });
  });

  it('rejects invalid IDs, duplicate IDs/names, malformed view values and oversized collections', () => {
    const first = { id: id(1), name: 'Queue', view: base() };
    for (const views of [
      [{ ...first, id: 'invalid' }], [first, { ...first, name: 'Different name' }], [first, { ...first, id: id(2), name: 'QUEUE' }],
      [{ ...first, view: null }], [{ ...first, view: [] }],
      Array.from({ length: 21 }, (_, index) => ({ ...first, id: id(index + 1), name: `Queue ${index + 1}` })),
    ]) {
      window.localStorage.setItem(`${key}:named`, JSON.stringify({ version: 1, views }));
      expect(readNamedAccountViews(key, 'LEAD', true)).toEqual({ views: [], available: false });
    }
  });
});
