import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { client, friendlyError, listAllPages, type Account, type Contact, type Policy, type Quote } from './client';
import { loadCommercial, type CommercialData, type CommercialEntry } from './commercial';
import { isAuthorizationError } from './authorizationError';
import { useIsAdmin } from './auth';

type Stage = 'LEAD' | 'CLIENT';
export interface AccountsListData {
  accounts: Account[];
  contacts: Contact[];
  policies: Policy[];
  quotes: Quote[];
  commercial: CommercialData;
  quoteError: string;
}
interface ResourceState {
  stage: Stage;
  isAdmin: boolean;
  data: AccountsListData;
  loading: boolean;
  loaded: boolean;
  error: string;
  refreshError: string;
}
interface CacheEntry { data: AccountsListData; detailsAt: number }
type CacheKey = `${Stage}:${'admin' | 'scoped'}`;
type ListCache = Map<CacheKey, CacheEntry>;
const FRESH_MS = 60_000;
const cacheKey = (stage: Stage, isAdmin: boolean): CacheKey => `${stage}:${isAdmin ? 'admin' : 'scoped'}`;
const fresh = (entry?: CacheEntry) => !!entry && entry.detailsAt > 0 && Date.now() - entry.detailsAt < FRESH_MS;
const CacheContext = createContext<ListCache | null>(null);

/** The authenticated shell owns these snapshots. Its user/role remount drops
 * them; ordinary navigation can reuse them without storing CRM data on disk. */
export function AccountsListDataProvider({ children }: { children: ReactNode }) {
  const [cache] = useState<ListCache>(() => new Map());
  return <CacheContext.Provider value={cache}>{children}</CacheContext.Provider>;
}

const emptyData = (): AccountsListData => ({
  accounts: [], contacts: [], policies: [], quotes: [],
  commercial: { entries: {}, team: [] }, quoteError: '',
});
function initialState(stage: Stage, cache: ListCache, isAdmin: boolean): ResourceState {
  // Cached non-admin rows are not authorization: ownership can change while
  // another page is open. Every route entry waits for a new account read.
  const cached = isAdmin ? cache.get(cacheKey(stage, isAdmin)) : undefined;
  return { stage, isAdmin, data: cached?.data ?? emptyData(), loaded: !!cached, loading: true, error: '', refreshError: '' };
}

/** Apply the current account-access result to every dependent collection. */
function restrict(data: AccountsListData, accounts: Account[]): AccountsListData {
  const allowed = new Set(accounts.map(account => account.id));
  return {
    ...data, accounts,
    contacts: data.contacts.filter(row => allowed.has(row.accountId)),
    policies: data.policies.filter(row => allowed.has(row.accountId)),
    quotes: data.quotes.filter(row => allowed.has(row.accountId)),
    commercial: { ...data.commercial, entries: Object.fromEntries(Object.entries(data.commercial.entries).filter(([id]) => allowed.has(id))) },
  };
}
/** Previously hydrated rows may remain visible while reloading. New or
 * converted accounts need fresh commercial/snooze state before classification. */
function surviving(data: AccountsListData, accounts: Account[]): AccountsListData {
  const previous = new Map(data.accounts.map(account => [account.id, account.stage]));
  return restrict(data, accounts.filter(account => previous.has(account.id) && previous.get(account.id) === account.stage));
}
const covered = (entry: CacheEntry, accounts: Account[]) => {
  const previous = new Map(entry.data.accounts.map(account => [account.id, account]));
  return accounts.every(account => {
    const old = previous.get(account.id);
    return old && old.stage === account.stage && old.updatedAt === account.updatedAt;
  });
};

interface ModelPage<T> { data: T[]; nextToken?: string | null; errors?: readonly unknown[] }
async function checkedList<T>(fetchPage: (nextToken?: string) => Promise<ModelPage<T>>): Promise<T[]> {
  return listAllPages(async nextToken => {
    const page = await fetchPage(nextToken);
    if (page.errors?.length) {
      // Keep access failures recognizable even if another field failed first.
      const denied = page.errors.find(isAuthorizationError);
      const raw = denied ?? page.errors[0];
      const message = raw && typeof raw === 'object' && 'message' in raw ? String(raw.message) : String(raw);
      throw Object.assign(new Error(message), denied ? { name: 'Unauthorized' } : {});
    }
    return page;
  });
}

/** Access is validated first. Details can fail independently, but any access
 * denial overrides transient errors and invalidates the entire cached scope. */
async function loadDetails(stage: Stage, accounts: Account[], previous?: AccountsListData, commercialOnly = false) {
  const [contacts, policies, quotes, commercial] = await Promise.allSettled([
    commercialOnly ? Promise.resolve(previous!.contacts) : checkedList<Contact>(nextToken => client.models.Contact.list({ nextToken })),
    commercialOnly ? Promise.resolve(previous!.policies) : stage === 'CLIENT' ? checkedList<Policy>(nextToken => client.models.Policy.list({ nextToken })) : Promise.resolve([] as Policy[]),
    commercialOnly ? Promise.resolve(previous!.quotes) : stage === 'LEAD' ? checkedList<Quote>(nextToken => client.models.Quote.list({ nextToken })) : Promise.resolve([] as Quote[]),
    loadCommercial(accounts.map(account => account.id), stage === 'LEAD' ? accounts.filter(account => account.stage === 'LEAD').map(account => account.id) : []),
  ]);
  const results = [contacts, policies, quotes, commercial];
  for (const result of results) if (result.status === 'rejected' && isAuthorizationError(result.reason)) throw result.reason;
  if (commercial.status === 'rejected' && !previous) throw commercial.reason;
  const warnings = results.flatMap(result => result.status === 'rejected' ? [friendlyError(result.reason, 'Could not refresh account details')] : []);
  const visibleAccounts = commercial.status === 'fulfilled' ? accounts : previous!.accounts;
  return {
    data: restrict({
      accounts,
      contacts: contacts.status === 'fulfilled' ? contacts.value : previous?.contacts ?? [],
      policies: policies.status === 'fulfilled' ? policies.value : previous?.policies ?? [],
      quotes: quotes.status === 'fulfilled' ? quotes.value : previous?.quotes ?? [],
      commercial: commercial.status === 'fulfilled' ? commercial.value : previous!.commercial,
      quoteError: commercialOnly ? previous!.quoteError : quotes.status === 'rejected' ? friendlyError(quotes.reason, 'Could not load quoted commissions') : '',
    }, visibleAccounts),
    refreshError: [...new Set(warnings)].join('; '),
  };
}

/** A refresh may have begun before a confirmed inline save. Keep the newest
 * versions, but never retain an account absent from the newly authorized set. */
function mergeCommercial(fresh: CommercialData, previous: CommercialData, accounts: Account[]): CommercialData {
  const allowed = new Set(accounts.map(account => account.id));
  const entries: Record<string, CommercialEntry> = {};
  for (const [id, entry] of Object.entries(fresh.entries)) {
    if (!allowed.has(id)) continue;
    const old = previous.entries[id];
    entries[id] = {
      ...entry,
      ...((old?.workflowVersion ?? -1) > (entry.workflowVersion ?? -1) ? {
        salespersonId: old.salespersonId, workflowVersion: old.workflowVersion, disposition: old.disposition,
      } : {}),
      ...((old?.snooze?.version ?? -1) > (entry.snooze?.version ?? -1) ? { snooze: old.snooze } : {}),
      ...((old?.plan?.version ?? -1) > (entry.plan?.version ?? -1) ? { plan: old.plan } : {}),
    };
  }
  return { ...fresh, entries };
}

export function useAccountsListData(stage: Stage) {
  const isAdmin = useIsAdmin();
  const providedCache = useContext(CacheContext);
  const localCache = useRef<ListCache>(new Map());
  const cache = providedCache ?? localCache.current;
  const key = cacheKey(stage, isAdmin);
  const [state, setState] = useState(() => initialState(stage, cache, isAdmin));
  const current = useRef(state);
  const mounted = useRef(false);
  const ticket = useRef(0);
  const scope = useRef({ key, cache });
  scope.current = { key, cache };

  const publish = useCallback((next: ResourceState) => {
    current.current = next;
    setState(next);
  }, []);

  const run = useCallback(async (mode: 'initial' | 'all' | 'commercial'): Promise<void> => {
    if (!mounted.current) return;
    const id = ++ticket.current;
    const previous = current.current.stage === stage && current.current.isAdmin === isAdmin ? current.current : initialState(stage, cache, isAdmin);
    const cached = cache.get(key);
    publish({ ...previous, loaded: previous.loaded && !previous.error, loading: true, error: '', refreshError: '' });
    const stillCurrent = () => mounted.current && ticket.current === id && scope.current.key === key && scope.current.cache === cache;
    // Only a snapshot authorized in this mounted view can survive a failed
    // account read. A non-admin route entry has no such snapshot yet.
    let fallback = previous.loaded && !previous.error ? previous.data : undefined;
    try {
      const accounts = await checkedList<Account>(nextToken => client.models.Account.list({ nextToken }));
      if (!stillCurrent()) return;
      const reuseDetails = mode === 'initial' && fresh(cached) && covered(cached!, accounts);
      const latest = current.current.loaded && !current.current.error ? current.current.data : fallback ?? cache.get(key)?.data;
      fallback = latest ? surviving(latest, accounts) : undefined;
      // Revoke immediately, before optional reads or commercial hydration can
      // fail. Both stage caches contain the same authorized account universe.
      for (const [otherKey, entry] of cache) {
        if (!otherKey.endsWith(isAdmin ? ':admin' : ':scoped')) continue;
        cache.set(otherKey, { data: surviving(entry.data, accounts), detailsAt: covered(entry, accounts) ? entry.detailsAt : 0 });
      }
      if (fallback) publish({ stage, isAdmin, data: fallback, loaded: true, loading: true, error: '', refreshError: '' });
      if (reuseDetails) {
        const data = fallback!;
        cache.set(key, { data, detailsAt: cached!.detailsAt });
        publish({ stage, isAdmin, data, loaded: true, loading: false, error: '', refreshError: '' });
        return;
      }
      // A successful commercial-only read cannot repair other stale columns.
      // Missing/changed accounts and failed detail reads invalidate detailsAt.
      const commercialOnly = mode === 'commercial' && !!fallback &&
        (cache.get(key)?.detailsAt ?? 0) > 0 && !previous.refreshError;
      const next = await loadDetails(stage, accounts, fallback, commercialOnly);
      if (!stillCurrent()) return;
      const data = { ...next.data, commercial: mergeCommercial(next.data.commercial, current.current.data.commercial, next.data.accounts) };
      cache.set(key, { data, detailsAt: next.refreshError ? 0 : commercialOnly ? cached?.detailsAt ?? 0 : Date.now() });
      publish({ stage, isAdmin, data, loaded: true, loading: false, error: '', refreshError: next.refreshError });
    } catch (error) {
      if (!stillCurrent()) return;
      const message = friendlyError(error, 'Could not load accounts and follow-up dates');
      if (isAuthorizationError(error)) {
        cache.clear();
        publish({ stage, isAdmin, data: emptyData(), loaded: true, loading: false, error: message, refreshError: '' });
      } else if (fallback) {
        // Include inline saves confirmed while this read was pending.
        const data = { ...fallback, commercial: mergeCommercial(fallback.commercial, current.current.data.commercial, fallback.accounts) };
        cache.set(key, { data, detailsAt: 0 });
        publish({ stage, isAdmin, data, loaded: true, loading: false, error: '', refreshError: message });
      } else {
        if (cached) cache.set(key, { ...cached, detailsAt: 0 });
        publish({ stage, isAdmin, data: emptyData(), loaded: true, loading: false, error: message, refreshError: '' });
      }
    }
  }, [stage, cache, key, isAdmin, publish]);

  const refetch = useCallback(() => run('all'), [run]);
  const refreshCommercial = useCallback(() => run('commercial'), [run]);
  const setCommercial: Dispatch<SetStateAction<CommercialData>> = useCallback(action => {
    if (!mounted.current || scope.current.key !== key || scope.current.cache !== cache) return;
    const previous = current.current;
    if (previous.stage !== stage || previous.isAdmin !== isAdmin || !previous.loaded || previous.error) return;
    const commercial = typeof action === 'function' ? action(previous.data.commercial) : action;
    const data = restrict({ ...previous.data, commercial }, previous.data.accounts);
    cache.set(key, { data, detailsAt: cache.get(key)?.detailsAt ?? 0 });
    // Both lists may include a partially bound client. A confirmed edit must
    // not regress when navigating to the other stage's still-fresh snapshot.
    for (const [otherKey, entry] of cache) {
      if (otherKey === key || !otherKey.endsWith(isAdmin ? ':admin' : ':scoped')) continue;
      cache.set(otherKey, { ...entry, data: { ...entry.data,
        commercial: mergeCommercial(entry.data.commercial, commercial, entry.data.accounts),
      } });
    }
    publish({ ...previous, data });
  }, [stage, cache, key, isAdmin, publish]);

  useEffect(() => {
    mounted.current = true;
    publish(initialState(stage, cache, isAdmin));
    void run('initial');
    return () => { mounted.current = false; ++ticket.current; };
  }, [stage, cache, isAdmin, run, publish]);

  // React may reuse the component between Leads and Clients or role views.
  // Never expose the previous scope while its effect is waiting to initialize.
  const visible = state.stage === stage && state.isAdmin === isAdmin ? state : initialState(stage, cache, isAdmin);
  return { data: visible.data, loading: visible.loading, loaded: visible.loaded, error: visible.error, refreshError: visible.refreshError, refetch, refreshCommercial, setCommercial };
}
