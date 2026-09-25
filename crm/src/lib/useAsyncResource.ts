import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction,
} from "react";
import { friendlyError } from "./client";

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
 * Data survives a `refetch()` — the table stays on screen, greyed by
 * `loading`, instead of blanking and re-lengthening. Data is dropped when
 * `deps` change, because that isn't a refresh of the same resource, it's a
 * different one: showing the previous account's quotes under the new account's
 * heading is wrong, not merely jumpy.
 */
const snapshots = new Map<string, { data: unknown; at: number }>();
let cacheGeneration = 0;
/** Memory only, scoped to one authenticated session. In-flight reads cannot refill it after logout. */
export function clearAsyncResourceCache() { snapshots.clear(); cacheGeneration++; }

export interface AsyncResource<T> {
  /** Last successful result. Unchanged by a failed refetch. */
  data: T;
  updatedAt?: number;
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
   * Identity-stable (it is React's own setState).
   */
  setData: Dispatch<SetStateAction<T>>;
}

export interface AsyncResourceOptions<T> {
  /** Value for `data` before the first success and after a `deps` change. */
  initialData?: T;
  /** Fallback passed to `friendlyError` when the thrown value has no message. */
  errorMessage?: string;
  /** Don't fetch on mount or on `deps` change — only when `refetch()` is called. */
  manual?: boolean;
  /** Opt-in short-lived cache for read-only overview/report data. */
  cacheKey?: string;
  cacheMaxAgeMs?: number;
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
  const { initialData, errorMessage = "Couldn't load that — please try again.", manual = false, cacheKey, cacheMaxAgeMs = 30_000 } =
    options;

  const cached = cacheKey ? snapshots.get(cacheKey) : undefined;
  const [data, setData] = useState<T | undefined>(cached ? cached.data as T : initialData);
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(cached?.at);
  const [loading, setLoading] = useState(!manual && (!cached || Date.now() - cached.at >= cacheMaxAgeMs));
  const [loaded, setLoaded] = useState(!!cached);
  const [error, setError] = useState("");

  // The fetcher closes over props and state, so it is a different function
  // every render. Holding the latest one in a ref is what lets `refetch` keep
  // one identity forever while still calling the current closure — the sites
  // that thread `refresh` down as a prop need that, or every render of the
  // parent re-renders the child.
  const fetcherRef = useRef(fetcher);
  const configRef = useRef({ initialData, errorMessage, cacheKey, cacheMaxAgeMs });
  useEffect(() => {
    fetcherRef.current = fetcher;
    configRef.current = { initialData, errorMessage, cacheKey, cacheMaxAgeMs };
  });

  // Declared before the fetch effect so it is set up first on mount and torn
  // down first on unmount.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Monotonic ticket. A response may only touch state if its ticket is still
  // the newest one — that is the whole of the ordering guarantee.
  const ticket = useRef(0);

  const run = useCallback(async (reset: boolean): Promise<void> => {
    const id = ++ticket.current;
    const generation = cacheGeneration;
    const config = configRef.current;
    if (reset) {
      const snapshot = config.cacheKey ? snapshots.get(config.cacheKey) : undefined;
      setData(snapshot ? snapshot.data as T : config.initialData);
      setLoaded(!!snapshot);
      setUpdatedAt(snapshot?.at);
      if (snapshot && Date.now() - snapshot.at < config.cacheMaxAgeMs) { setLoading(false); setError(""); return; }
    }
    setLoading(true);
    setError("");
    try {
      const result = await fetcherRef.current();
      if (!mounted.current || id !== ticket.current) return;
      const at = Date.now();
      if (config.cacheKey && generation === cacheGeneration) snapshots.set(config.cacheKey, { data: result, at });
      setData(result); setUpdatedAt(at);
    } catch (err) {
      if (!mounted.current || id !== ticket.current) return;
      setError(friendlyError(err, configRef.current.errorMessage));
    } finally {
      if (mounted.current && id === ticket.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  const refetch = useCallback(() => run(false), [run]);

  useEffect(() => {
    if (manual) return;
    void run(true);
    // `deps` is the caller's own identity list; `run` is stable for the life
    // of the hook, so it deliberately isn't in here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, loaded, error, refetch, setData, updatedAt };
}
