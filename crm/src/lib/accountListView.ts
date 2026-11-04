import type { SortDir } from './useSort';
import { US_STATE_NAMES } from './usMap';

export type AccountListStage = 'LEAD' | 'CLIENT';
export const LEAD_VIEWS = ['Active', 'Snoozed', 'Follow-up due', 'All leads'] as const;
export type LeadView = typeof LEAD_VIEWS[number];
export type AccountListView = { leadView: LeadView; salesperson: string; state: string; sortKey: string; dir: SortDir };
export { US_STATE_NAMES };
const viewIds = { Active: 'active', Snoozed: 'snoozed', 'Follow-up due': 'due', 'All leads': 'all' } as const;
const parameters = ['view', 'salesperson', 'state', 'sort', 'dir'] as const;
const commonSorts = ['name', 'type', 'contact', 'city', 'state', 'units', 'tiv', 'renewal'];
const leadSorts = ['followUp', 'source', 'form', 'estimate', 'pending', 'entered'];
const defaults: AccountListView = { leadView: 'Active', salesperson: '', state: '', sortKey: 'renewal', dir: 'asc' };

export function accountStateCode(value: string | null | undefined) {
  const text = value?.trim().toUpperCase();
  return text ? Object.keys(US_STATE_NAMES).find(code => code === text || US_STATE_NAMES[code].toUpperCase() === text) ?? '' : '';
}

export function accountViewKey(scope: string | undefined, stage: AccountListStage) {
  // App supplies an opaque Cognito sub plus the exact active role. Never use
  // a person's name/email or the browser's last signed-in account as a fallback.
  return scope && /^[a-zA-Z0-9_-]{1,128}:(OWNER|ADMIN|STAFF|PRODUCER)$/.test(scope)
    ? `hoa-crm:account-view:v1:${scope}:${stage}` : null;
}

export function normalizeAccountView(raw: Partial<Record<keyof AccountListView, unknown>>, stage: AccountListStage, admin: boolean): AccountListView {
  const sorts = [...commonSorts, ...(stage === 'LEAD' ? leadSorts : []), ...(admin ? ['salesperson'] : [])];
  return {
    leadView: stage === 'LEAD' && LEAD_VIEWS.includes(raw.leadView as LeadView) ? raw.leadView as LeadView : defaults.leadView,
    salesperson: admin && typeof raw.salesperson === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.salesperson) ? raw.salesperson : '',
    state: typeof raw.state === 'string' && raw.state.trim().length === 2 ? accountStateCode(raw.state) : '',
    sortKey: typeof raw.sortKey === 'string' && sorts.includes(raw.sortKey) ? raw.sortKey : defaults.sortKey,
    dir: raw.dir === 'desc' ? 'desc' : 'asc',
  };
}

export function hasAccountViewParams(params: URLSearchParams) {
  return parameters.some(key => params.has(key));
}

export function accountViewFromParams(params: URLSearchParams, stage: AccountListStage, admin: boolean) {
  return normalizeAccountView({
    leadView: LEAD_VIEWS.find(view => viewIds[view] === params.get('view')),
    salesperson: params.get('salesperson'), state: params.get('state'), sortKey: params.get('sort'), dir: params.get('dir'),
  }, stage, admin);
}

export function accountViewParams(current: URLSearchParams, view: AccountListView, stage: AccountListStage) {
  const next = new URLSearchParams(current);
  parameters.forEach(key => next.delete(key));
  if (stage === 'LEAD') next.set('view', viewIds[view.leadView]);
  if (view.salesperson) next.set('salesperson', view.salesperson);
  if (view.state) next.set('state', view.state);
  next.set('sort', view.sortKey); next.set('dir', view.dir);
  return next;
}

export function readAccountView(key: string | null, stage: AccountListStage, admin: boolean) {
  try {
    const stored = key ? JSON.parse(window.localStorage.getItem(key) ?? 'null') : null;
    if (stored?.version === 1) return normalizeAccountView(stored, stage, admin);
  } catch { /* Disabled storage or malformed preferences must not block work. */ }
  return normalizeAccountView({}, stage, admin);
}

export function saveAccountView(key: string | null, view: AccountListView) {
  try { if (key) window.localStorage.setItem(key, JSON.stringify({ version: 1, ...view })); }
  catch { /* URL navigation still works when browser storage is unavailable. */ }
}
