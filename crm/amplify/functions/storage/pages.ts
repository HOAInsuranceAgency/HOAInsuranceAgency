export type StorageCursor = string | Record<string, unknown>;
export interface ReadBudget { pages: number; rows: number; bytes: number; deadline?: number }
export interface CompletePage<T, C extends StorageCursor> { items: T[]; next?: C | null }
export interface CompletePageOptions {
  maxPages: number;
  maxRows?: number;
  maxBytes?: number;
  budget?: ReadBudget;
  error: () => Error;
  sizeError?: () => Error;
  cursorError?: () => Error;
}
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Complete reads fail closed on a budget or a cursor cycle. Resumable workers
 * and endpoints returning a page deliberately keep their separate contracts. */
export async function collectCompletePages<T, C extends StorageCursor = Record<string, unknown>>(
  fetch: (cursor?: C) => Promise<CompletePage<T, C>>, options: CompletePageOptions,
): Promise<T[]> {
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1) throw new Error('Invalid complete-read configuration.');
  const budget = options.budget ?? { pages: 0, rows: 0, bytes: 0 };
  const rows: T[] = [], seen = new Set<string>();
  let cursor: C | undefined;
  for (;;) {
    if (budget.pages >= options.maxPages || budget.deadline != null && Date.now() > budget.deadline) throw options.error();
    budget.pages++;
    const page = await fetch(cursor);
    if (!Array.isArray(page.items)) throw options.error();
    budget.rows += page.items.length;
    if (options.maxBytes != null || options.budget) budget.bytes += Buffer.byteLength(JSON.stringify(page.items), 'utf8');
    if (budget.rows > (options.maxRows ?? Infinity) || budget.bytes > (options.maxBytes ?? Infinity)) throw (options.sizeError ?? options.error)();
    rows.push(...page.items);
    const next = page.next;
    if (next == null || typeof next === 'object' && !Array.isArray(next) && !Object.keys(next).length) return rows;
    if (typeof next !== 'string' && (typeof next !== 'object' || Array.isArray(next)) || next === '') throw (options.cursorError ?? options.error)();
    const token = fingerprint(next);
    if (seen.has(token)) throw (options.cursorError ?? options.error)();
    seen.add(token); cursor = next;
  }
}
