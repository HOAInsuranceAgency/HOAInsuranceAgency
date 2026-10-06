import { isAuthorizationError } from './authorizationError';

/** A transient failure must not hide an access denial from another report
 * read: the UI may retain a snapshot after the former, never the latter. */
export async function allWithAuthorizationPriority<T extends readonly unknown[] | []>(reads: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(reads);
  const failures: PromiseRejectedResult[] = [];
  for (const result of results) if (result.status === 'rejected') failures.push(result);
  const failure = failures.find(result => isAuthorizationError(result.reason)) ?? failures[0];
  if (failure) throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
