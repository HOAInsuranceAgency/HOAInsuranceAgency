import { collectCompletePages } from '../storage/pages';

// Complete communication reads must fit the interactive API's 30-second budget
// as well as the worker. History gets more bytes than profiles and model rows;
// none of these limits permits returning an incomplete authoritative snapshot.
const limits = {
  account: { maxPages: 100, maxRows: 10_000, maxBytes: 64 * 1024 * 1024 },
  relations: { maxPages: 100, maxRows: 10_000, maxBytes: 32 * 1024 * 1024 },
  team: { maxPages: 20, maxRows: 2_000, maxBytes: 8 * 1024 * 1024 },
} as const;
type ReadScope = keyof typeof limits;
type Page<T> = { items: T[]; nextToken?: string | null };
type ModelPage<T> = { data: T[]; nextToken?: string | null; errors?: readonly unknown[] };

/** Page-returning APIs and resumable workers keep their own contracts. */
export function readCompleteRows<T>(
  fetch: (cursor?: string) => Promise<Page<T>>, scope: ReadScope, message: string,
): Promise<T[]> {
  return collectCompletePages<T, string>(async cursor => {
    const page = await fetch(cursor);
    return { items: page.items, next: page.nextToken };
  }, { ...limits[scope], budget: { pages: 0, rows: 0, bytes: 0, deadline: Date.now() + 8_000 }, error: () => new Error(message) });
}

/** Amplify reports page errors as values; keep the caller's existing message. */
export function readCompleteModels<T>(
  fetch: (cursor?: string) => Promise<ModelPage<T>>, scope: 'relations' | 'team', message: string,
): Promise<T[]> {
  return readCompleteRows(async cursor => {
    const page = await fetch(cursor);
    if (page.errors?.length) throw new Error(message);
    return { items: page.data, nextToken: page.nextToken };
  }, scope, message);
}
