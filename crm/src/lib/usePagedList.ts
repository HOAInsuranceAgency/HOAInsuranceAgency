import { isAuthorizationError } from './authorizationError';
import { useEffect, useRef, useState, type DependencyList } from 'react';
export interface Page<T> {
  items: T[];
  nextToken?: string;
}
/** Pages are requested only on navigation; stale scope responses never append. */
export function usePagedList<T extends { id: string }>(
  fetch: (token?: string) => Promise<Page<T>>,
  deps: DependencyList,
  enabled = true,
) {
  const [state, setState] = useState<{ items: T[]; nextToken?: string; loading: boolean; error: string }>({
    items: [],
    loading: enabled,
    error: '',
  });
  const generation = useRef(0),
    pending = useRef(false),
    fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  async function run(token?: string, fresh = false) {
    if (pending.current && !fresh) return;
    if (fresh) generation.current++;
    const version = generation.current;
    pending.current = true;
    setState((old) => ({ ...(fresh ? { items: [] } : old), loading: true, error: '' }));
    try {
      const page = await fetchRef.current(token);
      if (version !== generation.current) return;
      if (!Array.isArray(page.items) || (page.nextToken && page.nextToken === token))
        throw new Error('Could not load this page. Please retry.');
      setState((old) => ({
        items: [
          ...new Map([...(fresh ? [] : old.items), ...page.items].map((item) => [item.id, item])).values(),
        ],
        nextToken: page.nextToken,
        loading: false,
        error: '',
      }));
    } catch (e) {
      if (version === generation.current)
        setState((old) => ({
          ...(isAuthorizationError(e) ? { items: [] } : old),
          loading: false,
          error: e instanceof Error ? e.message : 'Could not load records.',
        }));
    } finally {
      if (version === generation.current) pending.current = false;
    }
  }
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setState({ items: [], loading: enabled, error: '' });
    if (enabled) void run(undefined, true);
    return () => {
      generation.current++;
      pending.current = false;
    };
    // Caller supplies the data scope, like useAsyncResource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  return { ...state, more: () => run(state.nextToken), reload: () => run(undefined, true) };
}
