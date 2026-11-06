import { allWithAuthorizationPriority } from './allWithAuthorizationPriority';

/** Each dashboard queue keeps four workers, input order and settled-sibling auth priority. */
export async function mapReportReads<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await allWithAuthorizationPriority(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await read(items[index]); }
  }));
  return results;
}

/** Callers choose batch limits and retain their own deduplication/sort policy. */
export function reportBatches<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('Invalid report batch size');
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) batches.push(items.slice(offset, offset + size));
  return batches;
}

export function reportCursorGuard(message: string) {
  const seen = new Set<string>();
  return (token: unknown) => {
    if (!token) return;
    if (typeof token !== 'string' || seen.has(token)) throw new Error(message);
    seen.add(token);
  };
}

/** Consume every page; validation, accumulation and fixed request scope stay with the caller. */
export async function forEachReportPage<T extends { nextToken?: string | null }>(
  read: (nextToken?: string) => Promise<T>, consume: (page: T) => void, cursorMessage: string,
): Promise<void> {
  const check = reportCursorGuard(cursorMessage);
  let nextToken: string | undefined;
  do {
    const page = await read(nextToken);
    consume(page);
    nextToken = page.nextToken ?? undefined;
    check(nextToken);
  } while (nextToken);
}
