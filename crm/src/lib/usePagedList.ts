import { isAuthorizationError } from './authorizationError';
import { useEffect, useMemo, useRef, useState, type DependencyList } from 'react';
import { liveUpdates } from './liveUpdates';
import { useLiveRefresh } from './useLiveUpdates';
export interface Page<T> {
  items: T[];
  nextToken?: string;
}
/** Refresh exactly the page depth the user opened, never drain unseen history. */
export async function readLoadedPages<T extends { id: string }>(fetch: (token?: string) => Promise<Page<T>>, depth: number, active = () => true) {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 100) throw new Error('Too many loaded pages to refresh safely.');
  const rows = new Map<string, T>(), seen = new Set<string>();
  let cursor: string | undefined, pages = 0;
  for (; pages < depth; pages++) {
    if (!active()) return undefined;
    const page = await fetch(cursor);
    if (!Array.isArray(page.items) || page.nextToken && (page.nextToken === cursor || seen.has(page.nextToken)))
      throw new Error('Could not refresh all loaded pages. Please retry.');
    for (const row of page.items) rows.set(row.id, row);
    cursor = page.nextToken;
    if (!cursor) { pages++; break; }
    seen.add(cursor);
  }
  return { items: [...rows.values()], nextToken: cursor, pages };
}
/** Pages are requested only on navigation; stale scope responses never append. */
export function usePagedList<T extends { id: string }>(
  fetch: (token?: string) => Promise<Page<T>>,
  deps: DependencyList,
  enabled = true,
) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scope = useMemo(() => ({}), [...deps, enabled]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [state, setState] = useState<{ scope: object; items: T[]; nextToken?: string; loading: boolean; error: string; refreshing: boolean; refreshError: string }>({
    scope,
    items: [],
    loading: enabled,
    error: '',
    refreshing: false, refreshError: '',
  });
  const generation = useRef(0),
    pending = useRef(false),
    fetchRef = useRef(fetch);
  const loadedPages = useRef(0), backgroundPending = useRef(false);
  fetchRef.current = fetch;
  async function run(token?: string, fresh = false) {
    if (pending.current && !fresh) return;
    const version = ++generation.current;
    pending.current = true;
    if (fresh) loadedPages.current = 0;
    const current = () => version === generation.current && currentScope.current === scope;
    setState((old) => ({ ...old, scope, ...(fresh ? { items: [], nextToken: undefined } : {}), loading: true, error: '', refreshing: false, refreshError: '' }));
    try {
      const page = await fetchRef.current(token);
      if (!current()) return;
      if (!Array.isArray(page.items) || (page.nextToken && page.nextToken === token))
        throw new Error('Could not load this page. Please retry.');
      setState((old) => ({
        ...old, scope,
        items: [
          ...new Map([...(fresh ? [] : old.items), ...page.items].map((item) => [item.id, item])).values(),
        ],
        nextToken: page.nextToken,
        loading: false,
        error: '',
      }));
      loadedPages.current = fresh ? 1 : loadedPages.current + 1;
    } catch (e) {
      if (current())
        setState((old) => ({
          ...old,
          ...(isAuthorizationError(e) ? { items: [], nextToken: undefined } : {}),
          loading: false,
          error: e instanceof Error ? e.message : 'Could not load records.',
        }));
    } finally {
      if (current()) pending.current = false;
    }
  }
  const deny = (error: unknown) => {
    generation.current++; pending.current = false; loadedPages.current = 0;
    setState({ scope, items: [], loading: false, refreshing: false, refreshError: '', error: error instanceof Error ? error.message : 'Access changed.' });
  };
  async function refreshInBackground() {
    if (!enabled || pending.current || backgroundPending.current || !loadedPages.current) return false;
    const fence = liveUpdates.getSnapshot(), version = generation.current;
    if (!liveUpdates.canPublish(fence)) return false;
    const current = () => version === generation.current && currentScope.current === scope;
    backgroundPending.current = true;
    setState(old => ({ ...old, refreshing: true, refreshError: '' }));
    try {
      const fresh = await readLoadedPages(fetchRef.current, loadedPages.current, () => current() && liveUpdates.canPublish(fence));
      if (!current()) return true;
      if (!fresh || !liveUpdates.canPublish(fence)) return false;
      loadedPages.current = fresh.pages;
      setState(old => ({ ...old, items: fresh.items, nextToken: fresh.nextToken, error: '', refreshError: '' }));
    } catch (error) {
      if (!current()) return true;
      if (isAuthorizationError(error)) deny(error);
      else if (!liveUpdates.canPublish(fence)) return false;
      else setState(old => ({ ...old, refreshError: error instanceof Error ? error.message : 'Could not refresh records.' }));
    } finally {
      backgroundPending.current = false;
      if (current()) setState(old => ({ ...old, refreshing: false }));
    }
    return true;
  }
  useLiveRefresh(refreshInBackground, { enabled, paused: state.loading || pending.current || !loadedPages.current, onDenied: deny });
  useEffect(() => {
    generation.current++;
    pending.current = false;
    loadedPages.current = 0; backgroundPending.current = false;
    setState({ scope, items: [], loading: enabled, error: '', refreshing: false, refreshError: '' });
    if (enabled) void run(undefined, true);
    return () => {
      generation.current++;
      pending.current = false;
    };
    // Caller supplies the data scope, like useAsyncResource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const visible = state.scope === scope ? state : { items: [] as T[], nextToken: undefined, loading: enabled, error: '', refreshing: false, refreshError: '' };
  return { ...visible, more: () => run(visible.nextToken), reload: () => run(undefined, true) };
}
