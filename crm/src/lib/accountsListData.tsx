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
  data: AccountsListData;
  loading: boolean;
  loaded: boolean;
  error: string;
}
type ListCache = Map<Stage, AccountsListData>;
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
function initialState(stage: Stage, cache: ListCache): ResourceState {
  const cached = cache.get(stage);
  return { stage, data: cached ?? emptyData(), loaded: !!cached, loading: true, error: '' };
}

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

/** Read the account set and its follow-up state as one complete snapshot. A
 * failed optional lookup may omit a column, but never hide an access denial. */
async function loadSnapshot(stage: Stage): Promise<AccountsListData> {
  const [accounts, contacts, policies, quotes] = await Promise.allSettled([
    checkedList<Account>(nextToken => client.models.Account.list({ nextToken })),
    checkedList<Contact>(nextToken => client.models.Contact.list({ nextToken })),
    stage === 'CLIENT' ? checkedList<Policy>(nextToken => client.models.Policy.list({ nextToken })) : Promise.resolve([] as Policy[]),
    stage === 'LEAD' ? checkedList<Quote>(nextToken => client.models.Quote.list({ nextToken })) : Promise.resolve([] as Quote[]),
  ]);
  for (const result of [accounts, contacts, policies, quotes]) {
    if (result.status === 'rejected' && isAuthorizationError(result.reason)) throw result.reason;
  }
  if (accounts.status === 'rejected') throw accounts.reason;
  const commercial = await loadCommercial(
    accounts.value.map(account => account.id),
    stage === 'LEAD' ? accounts.value.filter(account => account.stage === 'LEAD').map(account => account.id) : [],
  );
  return {
    accounts: accounts.value,
    contacts: contacts.status === 'fulfilled' ? contacts.value : [],
    policies: policies.status === 'fulfilled' ? policies.value : [],
    quotes: quotes.status === 'fulfilled' ? quotes.value : [],
    commercial,
    quoteError: quotes.status === 'rejected' ? friendlyError(quotes.reason, 'Could not load quoted commissions') : '',
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
  const providedCache = useContext(CacheContext);
  const localCache = useRef<ListCache>(new Map());
  const cache = providedCache ?? localCache.current;
  const [state, setState] = useState(() => initialState(stage, cache));
  const current = useRef(state);
  const mounted = useRef(false);
  const ticket = useRef(0);
  const scope = useRef({ stage, cache });
  scope.current = { stage, cache };

  const publish = useCallback((next: ResourceState) => {
    current.current = next;
    setState(next);
  }, []);

  const run = useCallback(async (commercialOnly: boolean): Promise<void> => {
    if (!mounted.current) return;
    const id = ++ticket.current;
    const previous = current.current.stage === stage ? current.current : initialState(stage, cache);
    publish({ ...previous, loaded: previous.loaded && !previous.error, loading: true, error: '' });
    const stillCurrent = () => mounted.current && ticket.current === id && scope.current.stage === stage && scope.current.cache === cache;
    try {
      const next = commercialOnly && previous.loaded && !previous.error
        ? { ...previous.data, commercial: await loadCommercial(
          previous.data.accounts.map(account => account.id),
          stage === 'LEAD' ? previous.data.accounts.filter(account => account.stage === 'LEAD').map(account => account.id) : [],
        ) }
        : await loadSnapshot(stage);
      if (!stillCurrent()) return;
      const data = { ...next, commercial: mergeCommercial(next.commercial, current.current.data.commercial, next.accounts) };
      cache.set(stage, data);
      publish({ stage, data, loaded: true, loading: false, error: '' });
    } catch (error) {
      if (!stillCurrent()) return;
      if (isAuthorizationError(error)) cache.clear(); else cache.delete(stage);
      publish({ stage, data: emptyData(), loaded: true, loading: false, error: friendlyError(error, 'Could not load accounts and follow-up dates') });
    }
  }, [stage, cache, publish]);

  const refetch = useCallback(() => run(false), [run]);
  const refreshCommercial = useCallback(() => run(true), [run]);
  const setCommercial: Dispatch<SetStateAction<CommercialData>> = useCallback(action => {
    if (!mounted.current || scope.current.stage !== stage || scope.current.cache !== cache) return;
    const previous = current.current;
    if (previous.stage !== stage || !previous.loaded || previous.error) return;
    const commercial = typeof action === 'function' ? action(previous.data.commercial) : action;
    const data = { ...previous.data, commercial };
    cache.set(stage, data);
    publish({ ...previous, data });
  }, [stage, cache, publish]);

  useEffect(() => {
    mounted.current = true;
    publish(initialState(stage, cache));
    void refetch();
    return () => { mounted.current = false; ++ticket.current; };
  }, [stage, cache, refetch, publish]);

  // React may reuse the component between Leads and Clients. Never expose the
  // previous stage while its effect is waiting to initialize the next one.
  const visible = state.stage === stage ? state : initialState(stage, cache);
  return { data: visible.data, loading: visible.loading, loaded: visible.loaded, error: visible.error, refetch, refreshCommercial, setCommercial };
}
