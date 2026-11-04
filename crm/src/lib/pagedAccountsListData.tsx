import { createContext, useContext, useCallback, useEffect, useRef, useState, type SetStateAction, type ReactNode } from 'react';
import { communicationRequest, type TeamEligibility } from './communications';
import { friendlyError, type Account, type Contact } from './client';
import { isAuthorizationError } from './authorizationError';
import type { AccountsListData } from './accountsListData';
import type { CommercialData } from './commercial';
import type { AccountListCounts, AccountListItem, AccountListPage, AccountListRequest } from '../../../shared/accountList';
import { useAgencyDay } from './useAgencyDay';
import { useIsAdmin } from './auth';

const emptyCounts = () => ({ active: 0, snoozed: 0, due: 0, all: 0 });
type State = { key: string; items: AccountListItem[]; loaded: boolean; loading: boolean; loadingMore: boolean;
  error: string; refreshError: string; nextToken?: string; fallback: boolean; counts: ReturnType<typeof emptyCounts>; countsLoaded: boolean };
const initial = (key: string): State => ({ key, items: [], loaded: false, loading: true, loadingMore: false,
  error: '', refreshError: '', fallback: false, counts: emptyCounts(), countsLoaded: false });
type Cache = { entries: Map<string, State>; fallbackUntil: number };
const CacheContext = createContext<Cache | null>(null);
export function PagedAccountListProvider({ children }: { children: ReactNode }) {
  const [cache] = useState<Cache>(() => ({ entries: new Map(), fallbackUntil: 0 }));
  return <CacheContext.Provider value={cache}>{children}</CacheContext.Provider>;
}

/** List summaries are paged independently of directory display and totals. No
 * CRM rows are persisted, and an unmounted/changed user-role scope discards work. */
export function usePagedAccountsListData(request?: AccountListRequest) {
  const today = useAgencyDay();
  const key = request ? JSON.stringify({ ...request, nextToken: undefined, today }) : '';
  const isAdmin = useIsAdmin();
  const provided = useContext(CacheContext), local = useRef<Cache>({ entries: new Map(), fallbackUntil: 0 });
  const cache = provided ?? local.current;
  const initialState = (value: string) => cache.fallbackUntil > Date.now()
    ? { ...initial(value), fallback: true, loading: false }
    : isAdmin && cache.entries.has(value) ? { ...cache.entries.get(value)!, loading: true, loadingMore: false } : initial(value);
  const latest = useRef(request); latest.current = request;
  const [state, setState] = useState(() => initialState(key));
  const [team, setTeam] = useState<TeamEligibility[]>([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [teamError, setTeamError] = useState('');
  const scope = useRef({ key, active: false, generation: 0 });
  scope.current.key = key;
  const current = useRef(state); current.current = state;
  const moreFlight = useRef(false);

  const refresh = useCallback(async () => {
    const input = latest.current;
    if (!input || !scope.current.active) return;
    const captured = scope.current.key, generation = ++scope.current.generation;
    moreFlight.current = false;
    const valid = () => scope.current.active && scope.current.key === captured && scope.current.generation === generation;
    setState(old => ({ ...(old.key === captured ? old : initial(captured)), loading: true, error: '', refreshError: '' }));
    try {
      let page = await communicationRequest<AccountListPage>('accountListPage', input);
      if (!valid()) return;
      if (!page.ready) { cache.fallbackUntil = Date.now() + 30_000; setState({ ...initial(captured), fallback: true, loading: false }); return; }
      cache.fallbackUntil = 0;
      const targetLength = current.current.key === captured && current.current.loaded ? current.current.items.length : 0;
      const items = [...page.items];
      // Revalidate the previously loaded window before replacing an Admin
      // snapshot, so returning to a deep row does not collapse to page one.
      while (page.nextToken && items.length < targetLength) {
        const token = page.nextToken;
        page = await communicationRequest<AccountListPage>('accountListPage', { ...input, nextToken: token });
        if (!valid()) return;
        if (!page.ready) { cache.fallbackUntil = Date.now() + 30_000; setState({ ...initial(captured), fallback: true, loading: false }); return; }
        if (page.nextToken === token) throw new Error('Account pagination did not advance.');
        items.push(...page.items.filter(item => !items.some(old => old.account.id === item.account.id)));
      }
      setState({ ...initial(captured), items, nextToken: page.nextToken, loaded: true, loading: false });
      // Totals may traverse further metadata pages, but cannot hold up rows.
      void (async () => {
        const counts = emptyCounts(); let nextToken: string | undefined;
        do {
          const summary = await communicationRequest<AccountListCounts>('accountListCounts', { ...input, nextToken });
          if (!valid() || !summary.ready) return;
          for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] += summary.counts[name];
          if (summary.nextToken && summary.nextToken === nextToken) throw new Error('Account totals did not advance.');
          nextToken = summary.nextToken;
        } while (nextToken);
        if (valid()) setState(old => ({ ...old, counts, countsLoaded: true }));
      })().catch(error => { if (valid()) {
        if (isAuthorizationError(error)) { ++scope.current.generation; moreFlight.current = false; cache.entries.clear(); }
        setState(old => isAuthorizationError(error)
          ? { ...initial(captured), loaded: true, loading: false, error: friendlyError(error, 'Access denied.') }
          : { ...old, refreshError: friendlyError(error, 'Could not load account totals.') });
      } });
    } catch (error) {
      if (!valid()) return;
      // A backend-first rollout can retain the existing list while its new
      // projection initializes. Access failures never enter that fallback.
      if (!isAuthorizationError(error) && error instanceof Error && error.message === 'Unknown read operation') {
        cache.fallbackUntil = Date.now() + 30_000;
        setState({ ...initial(captured), fallback: true, loading: false }); return;
      }
      if (isAuthorizationError(error)) { ++scope.current.generation; moreFlight.current = false; cache.entries.clear(); }
      setState(old => isAuthorizationError(error)
        ? { ...initial(captured), loaded: true, loading: false, error: friendlyError(error, 'Access denied.') }
        : { ...old, loading: false, loaded: true, ...(old.items.length ? { refreshError: friendlyError(error, 'Could not refresh accounts.') } : { error: friendlyError(error, 'Could not load accounts.') }) });
    }
  }, [cache]);

  useEffect(() => {
    scope.current.active = true;
    if (!request) return;
    if (current.current.fallback) {
      setState({ ...initial(key), fallback: true, loading: false });
      return () => { scope.current.active = false; ++scope.current.generation; };
    }
    setState(initialState(key)); moreFlight.current = false;
    if (cache.fallbackUntil > Date.now()) return () => { scope.current.active = false; ++scope.current.generation; };
    void refresh();
    return () => { scope.current.active = false; ++scope.current.generation; };
  }, [key, refresh]);
  useEffect(() => {
    if (state.key === key && state.loaded && !state.error && !state.fallback) {
      cache.entries.delete(key); cache.entries.set(key, state);
      if (cache.entries.size > 20) cache.entries.delete(cache.entries.keys().next().value!);
    }
  }, [state, key, cache]);
  useEffect(() => {
    if (!request) return;
    let active = true;
    setTeamLoading(true); setTeamError('');
    communicationRequest<{ team: TeamEligibility[] }>('team').then(value => { if (active) setTeam(value.team); })
      .catch(error => { if (active) { setTeam([]); setTeamError(friendlyError(error, 'Could not load teammates.'));
        if (isAuthorizationError(error)) { ++scope.current.generation; cache.entries.clear(); setState({ ...initial(scope.current.key), loading: false, loaded: true, error: friendlyError(error, 'Access denied.') }); }
      } })
      .finally(() => { if (active) setTeamLoading(false); });
    return () => { active = false; };
  }, [!!request]);

  const loadMore = useCallback(async () => {
    const input = latest.current, previous = current.current;
    if (!input || moreFlight.current || !previous.nextToken || previous.key !== scope.current.key) return;
    moreFlight.current = true;
    const captured = scope.current.key, generation = scope.current.generation;
    const valid = () => scope.current.active && scope.current.key === captured && scope.current.generation === generation;
    setState(old => ({ ...old, loadingMore: true, refreshError: '' }));
    try {
      const page = await communicationRequest<AccountListPage>('accountListPage', { ...input, nextToken: previous.nextToken });
      if (!valid()) return;
      if (!page.ready) { await refresh(); return; }
      if (page.nextToken === previous.nextToken) throw new Error('Account pagination did not advance.');
      setState(old => ({ ...old, items: [...old.items, ...page.items.filter(item => !old.items.some(existing => existing.account.id === item.account.id))], nextToken: page.nextToken, loadingMore: false }));
    } catch (error) {
      if (valid()) { if (isAuthorizationError(error)) { ++scope.current.generation; moreFlight.current = false; cache.entries.clear(); } setState(old => isAuthorizationError(error)
        ? { ...initial(captured), loaded: true, loading: false, error: friendlyError(error, 'Access denied.') }
        : { ...old, loadingMore: false, refreshError: friendlyError(error, 'Could not load the next page.') }); }
    } finally { if (valid()) moreFlight.current = false; }
  }, [refresh]);
  const exportAll = useCallback(async () => {
    const input = latest.current, captured = scope.current.key, generation = scope.current.generation;
    if (!input) return [];
    const items = new Map<string, AccountListItem>(); let nextToken: string | undefined;
    do {
      let page: AccountListPage;
      try { page = await communicationRequest<AccountListPage>('accountListPage', { ...input, limit: 50, nextToken }); }
      catch (error) { if (isAuthorizationError(error) && scope.current.active && scope.current.key === captured && scope.current.generation === generation) {
        ++scope.current.generation; moreFlight.current = false; cache.entries.clear();
        setState({ ...initial(captured), loaded: true, loading: false, error: friendlyError(error, 'Access denied.') });
      } throw error; }
      if (!scope.current.active || scope.current.key !== captured || scope.current.generation !== generation) throw new Error('The account view changed. Download again.');
      if (!page.ready) throw new Error('Account lists are refreshing. Try the download again shortly.');
      for (const item of page.items) { items.delete(item.account.id); items.set(item.account.id, item); }
      if (page.nextToken && page.nextToken === nextToken || items.size > 50_000) throw new Error('This report is too large. Narrow the filters and download again.');
      nextToken = page.nextToken;
    } while (nextToken);
    return [...items.values()];
  }, []);
  const setCommercial = useCallback((action: SetStateAction<CommercialData>) => {
    if (!scope.current.active) return;
    setState(old => {
      const data = { team, entries: Object.fromEntries(old.items.map(item => [item.account.id, item.commercial])) };
      const next = typeof action === 'function' ? action(data) : action;
      return { ...old, items: old.items.map(item => ({ ...item, commercial: next.entries[item.account.id] ?? item.commercial })) };
    });
  }, [team]);
  const visible = state.key === key ? state : state.fallback ? { ...initial(key), fallback: true, loading: false } : initialState(key);
  const data: AccountsListData = { accounts: visible.items.map(item => item.account) as Account[],
    contacts: visible.items.flatMap(item => item.contact ? [item.contact] : []) as Contact[], policies: [], quotes: [], quoteError: '',
    commercial: { team, entries: Object.fromEntries(visible.items.map(item => [item.account.id, item.commercial])) } };
  return { ...visible, data, paged: true as const, teamLoading, teamError, refetch: refresh, refreshCommercial: refresh, setCommercial, loadMore, exportAll,
    forecasts: Object.fromEntries(visible.items.map(item => [item.account.id, item.forecast])), renewals: Object.fromEntries(visible.items.map(item => [item.account.id, item.renewalDate])) };
}
