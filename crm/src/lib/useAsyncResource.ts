import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction,
} from "react";
import { friendlyError } from "./client";
import { isAuthorizationError } from "./authorizationError";

/**
 * One async read, one state machine.
 *
 * Every list-bearing component used to hand-roll the same `useState` triple +
 * `useEffect` + `catch → setError`, and each one dropped a different piece of
 * it: no error state at all, `setLoading(false)` on the success path only, a
 * `refresh()` with no `.catch()`, three spellings of the loaded flag. This
 * hook is the union of what those sites got right, and the pieces they got
 * wrong are unreachable from here rather than merely absent:
 *
 *  - `error` always exists, and is always written on a throw — a failed read
 *    can't render as an empty table.
 *  - `loading` is cleared in a `finally`, so a throw can't wedge it true.
 *  - `refetch` catches internally and resolves to `void`, so calling it
 *    fire-and-forget can't raise an unhandled rejection.
 *  - There is exactly one loaded flag (`loaded`) and one in-flight flag
 *    (`loading`); callers have nothing left to invent a third spelling for.
 *  - Responses from a superseded or unmounted fetch are dropped, so a slow
 *    first request can't overwrite a fast second one and an unmount mid-flight
 *    can't set state afterwards.
 *
 * Errors go through `friendlyError` here rather than at the call site: the
 * callers were split between `friendlyError` and a hand-rolled
 * `e instanceof Error ? e.message : fallback`, and `friendlyError` degrades to
 * exactly that hand-rolled form when it has no rule to apply. Normalizing
 * inside is therefore a strict improvement everywhere and removes the choice.
 *
 * Data survives a `refetch()` by default — the table stays on screen, greyed by
 * `loading`, instead of blanking and re-lengthening. Data is dropped when
 * `deps` change, because that isn't a refresh of the same resource, it's a
 * different one: showing the previous account's quotes under the new account's
 * heading is wrong, not merely jumpy. Access failures clear cached data by
 * default; `clearDataOnError` can specify a stricter policy for sensitive views.
 */
export interface AsyncResource<T> {
  /** Last successful result, unless cleared by the configured error policy. */
  data: T;
  /** A fetch is in flight right now. True on the first render unless `manual`. */
  loading: boolean;
  /**
   * A fetch for the *current* `deps` has settled at least once, successfully
   * or not. Resets to false when `deps` change, so `!loaded` is the one
   * correct "still waiting, show a placeholder" gate.
   */
  loaded: boolean;
  /** Empty string when there is no error. Cleared at the start of every fetch. */
  error: string;
  /**
   * Re-run the fetcher. Identity-stable for the life of the hook, so it is
   * safe to pass as a prop or list in a dependency array. Never rejects.
   */
  refetch: () => Promise<void>;
  /**
   * Patch the cached data locally, for the read-modify-write case where the
   * component already knows the new row and a full re-read would be a waste.
   * Stable within one resource. Old-resource setters cannot patch a new one.
   */
  setData: Dispatch<SetStateAction<T>>;
  /** Clear cached data and invalidate pending reads after an external denial. */
  invalidate: (error: unknown) => void;
}

export interface AsyncResourceOptions<T> {
  /** Value for `data` before the first success and after a `deps` change. */
  initialData?: T;
  /** Fallback passed to `friendlyError` when the thrown value has no message. */
  errorMessage?: string;
  /** Don't fetch on mount or on `deps` change — only when `refetch()` is called. */
  manual?: boolean;
  /** Error policy; defaults to clearing cached data on access failures. */
  clearDataOnError?: (error: unknown) => boolean;
}

export function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options: AsyncResourceOptions<T> & { initialData: T }
): AsyncResource<T>;
export function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options?: AsyncResourceOptions<T>
): AsyncResource<T | undefined>;
export function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options: AsyncResourceOptions<T> = {}
): AsyncResource<T | undefined> {
  const { initialData, errorMessage = "Couldn't load that — please try again.", manual = false, clearDataOnError = isAuthorizationError } =
    options;

  // Scope is part of the state, not just an effect dependency. A new account
  // must never render the previous account's rows even for the render before
  // its fetch effect runs. Manual resources need the same isolation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scope = useMemo(() => ({}), deps);
  const [state, setState] = useState(() => ({
    scope, data: initialData, loading: !manual, loaded: false, error: "",
  }));
  const latest = useRef({ scope, fetcher, initialData, errorMessage, clearDataOnError });
  latest.current = { scope, fetcher, initialData, errorMessage, clearDataOnError };
  const mounted = useRef(true);
  const ticket = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++ticket.current; };
  }, []);

  const run = useCallback(async (reset: boolean): Promise<void> => {
    if (!mounted.current) return;
    const config = latest.current;
    const id = ++ticket.current;
    const current = () => mounted.current && id === ticket.current && latest.current.scope === config.scope;
    setState(previous => ({
      scope: config.scope,
      data: reset || previous.scope !== config.scope ? config.initialData : previous.data,
      loaded: !reset && previous.scope === config.scope && previous.loaded,
      loading: true, error: "",
    }));
    try {
      const data = await config.fetcher();
      if (current()) setState(previous => ({ ...previous, data }));
    } catch (err) {
      if (current()) setState(previous => ({
        ...previous,
        ...(config.clearDataOnError?.(err) ? { data: config.initialData } : {}),
        error: friendlyError(err, config.errorMessage),
      }));
    } finally {
      if (current()) setState(previous => ({ ...previous, loading: false, loaded: true }));
    }
  }, []);

  const refetch = useCallback(() => run(false), [run]);
  const setData: Dispatch<SetStateAction<T | undefined>> = useCallback(action => {
    if (!mounted.current || latest.current.scope !== scope) return;
    setState(previous => {
      if (previous.scope !== scope) return previous;
      return { ...previous, data: typeof action === 'function'
        ? (action as (value: T | undefined) => T | undefined)(previous.data) : action };
    });
  }, [scope]);
  const invalidate = useCallback((err: unknown) => {
    if (!mounted.current || latest.current.scope !== scope) return;
    ++ticket.current;
    const config = latest.current;
    setState({ scope, data: config.initialData, error: friendlyError(err, config.errorMessage), loading: false, loaded: true });
  }, [scope]);

  useEffect(() => {
    if (manual) {
      ++ticket.current;
      setState({ scope, data: latest.current.initialData, loading: false, loaded: false, error: "" });
    } else void run(true);
    return () => { ++ticket.current; };
  }, [scope, manual, run]);

  const visible = state.scope === scope ? state : {
    data: initialData, loading: !manual, loaded: false, error: "",
  };
  return { ...visible, refetch, setData, invalidate };
}
