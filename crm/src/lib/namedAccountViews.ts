import { normalizeAccountView, type AccountListStage, type AccountListView } from './accountListView';

export const MAX_NAMED_VIEWS = 20;
export type NamedAccountView = { id: string; name: string; view: AccountListView };
const idPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function viewName(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Use a single line for the view name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Enter a view name.');
  if (name.length > 80) throw new Error('Use 80 characters or fewer for the view name.');
  return name;
}

export function readNamedAccountViews(key: string | null, stage: AccountListStage, admin: boolean): { views: NamedAccountView[]; available: boolean } {
  if (!key) return { views: [], available: false };
  try {
    const raw = window.localStorage.getItem(`${key}:named`);
    if (!raw) return { views: [], available: true };
    if (raw.length > 100_000) throw new Error('Invalid views');
    const saved = JSON.parse(raw);
    if (saved?.version !== 1 || !Array.isArray(saved.views) || saved.views.length > MAX_NAMED_VIEWS) throw new Error('Invalid views');
    const ids = new Set<string>(), names = new Set<string>();
    const views = saved.views.map((item: NamedAccountView) => {
      if (!item || typeof item.id !== 'string' || !idPattern.test(item.id) || typeof item.name !== 'string' || !item.view || typeof item.view !== 'object' || Array.isArray(item.view)) throw new Error('Invalid view');
      const name = viewName(item.name), folded = name.toLocaleLowerCase();
      if (ids.has(item.id) || names.has(folded)) throw new Error('Duplicate view');
      ids.add(item.id); names.add(folded);
      return { id: item.id, name, view: normalizeAccountView(item.view, stage, admin) };
    });
    return { views, available: true };
  } catch { return { views: [], available: false }; }
}

export function putNamedAccountView(views: NamedAccountView[], input: { id?: string; name: string; view: AccountListView }, stage: AccountListStage, admin: boolean) {
  const name = viewName(input.name);
  if (views.some(item => item.id !== input.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('That view name is already in use.');
  if (input.id && !views.some(item => item.id === input.id)) throw new Error('This saved view is no longer available.');
  if (!input.id && views.length >= MAX_NAMED_VIEWS) throw new Error(`You can save up to ${MAX_NAMED_VIEWS} views. Delete a view to add another.`);
  const item = { id: input.id ?? crypto.randomUUID(), name, view: normalizeAccountView(input.view, stage, admin) };
  return input.id ? views.map(old => old.id === input.id ? item : old) : [...views, item];
}

export function writeNamedAccountViews(key: string | null, views: NamedAccountView[], stage: AccountListStage, admin: boolean) {
  if (!key || views.length > MAX_NAMED_VIEWS) throw new Error('Saved views are unavailable in this browser.');
  // Explicitly project safe preferences. Never serialize accounts, contacts,
  // records, report content or a caller's extra object properties.
  const safe = views.map(item => ({ id: item.id, name: viewName(item.name), view: normalizeAccountView(item.view, stage, admin) }));
  try { window.localStorage.setItem(`${key}:named`, JSON.stringify({ version: 1, views: safe })); }
  catch { throw new Error('Could not save views in this browser. Your current filters still work in the URL.'); }
}
