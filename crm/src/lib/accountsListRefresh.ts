import type { Account, Contact, Policy, Quote } from './client';
import type { CommercialData } from './commercial';
import type { AccountsListData } from './accountsListData';
import { isAuthorizationError } from './authorizationError';

export const ACCOUNT_REFRESH_PAGE_SIZE = 100;
export const ACCOUNT_REFRESH_COMMERCIAL_SIZE = 25;
export interface ModelPage<T> { data: T[]; nextToken?: string | null; errors?: readonly unknown[] }
export interface AccountRefreshLoaders {
  accounts: (nextToken?: string) => Promise<ModelPage<Account>>;
  contacts: (nextToken?: string) => Promise<ModelPage<Contact>>;
  policies: (nextToken?: string) => Promise<ModelPage<Policy>>;
  quotes: (nextToken?: string) => Promise<ModelPage<Quote>>;
  commercial: (ids: string[], snoozeIds: string[]) => Promise<CommercialData>;
}
type Pages<T> = { rows: Map<string, T>; token?: string; seen: Set<string>; count: number; complete: boolean; failed: boolean };
const pages = <T>(): Pages<T> => ({ rows: new Map(), seen: new Set(), count: 0, complete: false, failed: false });
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not update the complete account list.';

/** A turn reads no more than one page per model and one 25-account settings
 * batch. Cursors survive unrelated events; only a complete cycle is publishable. */
export function createAccountListRefreshCycle(stage: 'LEAD' | 'CLIENT', previous: AccountsListData,
  loaders: AccountRefreshLoaders, onDenied?: (error: unknown) => void) {
  const accounts = pages<Account>(), contacts = pages<Contact>(), policies = pages<Policy>(), quotes = pages<Quote>();
  const warnings = new Set<string>();
  let authorized: Account[] | undefined, allowed = new Set<string>(), commercialOffset = 0, commercialFailed = false;
  let commercial: CommercialData = { entries: {}, team: [] };
  if (stage === 'LEAD') policies.complete = true; else quotes.complete = true;

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (isAuthorizationError(error)) onDenied?.(error); throw error; }
  }
  async function readPage<T extends { id: string }>(state: Pages<T>, load: (token?: string) => Promise<ModelPage<T>>, keep: (row: T) => boolean = () => true) {
    if (state.complete) return;
    if (state.count >= 1_000) throw new Error('The account update could not finish safely. Retry the complete list.');
    const result = await load(state.token);
    if (result.errors?.length) {
      const denied = result.errors.find(isAuthorizationError), raw = denied ?? result.errors[0];
      const text = raw && typeof raw === 'object' && 'message' in raw ? String(raw.message) : message(raw);
      throw Object.assign(new Error(text), denied ? { name: 'Unauthorized' } : {});
    }
    if (!Array.isArray(result.data) || result.data.length > ACCOUNT_REFRESH_PAGE_SIZE ||
      result.data.some(row => !row || typeof row.id !== 'string' || !row.id) ||
      result.nextToken != null && (typeof result.nextToken !== 'string' || !result.nextToken || result.nextToken.length > 32_768))
      throw new Error('The account update returned an invalid page. Retry the complete list.');
    const next = result.nextToken ?? undefined;
    if (next && (next === state.token || state.seen.has(next))) throw new Error('The account update did not advance. Retry the complete list.');
    for (const row of result.data) if (keep(row)) state.rows.set(row.id, row);
    state.count++;
    state.token = next;
    state.complete = !next;
    if (next) state.seen.add(next);
  }
  async function related<T extends { id: string; accountId: string }>(state: Pages<T>, load: (token?: string) => Promise<ModelPage<T>>) {
    try { await guarded(() => readPage(state, load, row => allowed.has(row.accountId))); }
    catch (error) {
      if (isAuthorizationError(error)) throw error;
      state.failed = true; state.complete = true; state.rows.clear(); warnings.add(message(error));
    }
  }
  return {
    async advance(): Promise<{ complete: boolean; accounts?: Account[]; snapshot?: AccountsListData; refreshError?: string }> {
      if (!accounts.complete) await guarded(() => readPage(accounts, loaders.accounts));
      if (!accounts.complete) return { complete: false };
      if (!authorized) { authorized = [...accounts.rows.values()]; allowed = new Set(authorized.map(account => account.id)); }
      const nextIds = authorized.slice(commercialOffset, commercialOffset + ACCOUNT_REFRESH_COMMERCIAL_SIZE).map(account => account.id);
      const jobs = await Promise.allSettled([
        related(contacts, loaders.contacts), related(policies, loaders.policies), related(quotes, loaders.quotes),
        (async () => {
          if (commercialFailed || !nextIds.length) return;
          try {
            const snooze = stage === 'LEAD' ? authorized!.filter(account => nextIds.includes(account.id) && account.stage === 'LEAD').map(account => account.id) : [];
            const result = await guarded(() => loaders.commercial(nextIds, snooze));
            if (!Array.isArray(result.team) || nextIds.some(id => result.entries[id]?.accountId !== id)) throw new Error('Account assignment details were incomplete.');
            for (const id of nextIds) commercial.entries[id] = result.entries[id];
            commercial.team = result.team;
            commercialOffset += nextIds.length;
          } catch (error) {
            if (isAuthorizationError(error)) throw error;
            commercialFailed = true; warnings.add(message(error));
          }
        })(),
      ]);
      const rejected = jobs.find((job): job is PromiseRejectedResult => job.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (!contacts.complete || !policies.complete || !quotes.complete || !commercialFailed && commercialOffset < authorized.length)
        return { complete: false, accounts: authorized };
      const oldStages = new Map(previous.accounts.map(account => [account.id, account.stage]));
      const visible = commercialFailed ? authorized.filter(account => oldStages.get(account.id) === account.stage) : authorized;
      const visibleIds = new Set(visible.map(account => account.id));
      const authorizedRows = <T extends { accountId: string }>(rows: T[]) => rows.filter(row => visibleIds.has(row.accountId));
      if (commercialFailed) commercial = previous.commercial;
      return { complete: true, accounts: authorized, refreshError: [...warnings].join('; '), snapshot: {
        accounts: visible,
        contacts: authorizedRows(contacts.failed ? previous.contacts : [...contacts.rows.values()]),
        policies: authorizedRows(policies.failed ? previous.policies : [...policies.rows.values()]),
        quotes: authorizedRows(quotes.failed ? previous.quotes : [...quotes.rows.values()]),
        commercial: { team: commercial.team, entries: Object.fromEntries(Object.entries(commercial.entries).filter(([id]) => visibleIds.has(id))) },
        quoteError: quotes.failed ? [...warnings].join('; ') : '',
      } };
    },
  };
}
