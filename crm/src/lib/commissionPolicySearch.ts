import { assertApiErrors } from '../../../shared/apiResponse';

export interface CommissionPolicySearchRow {
  id: string;
  policyNumber?: string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  commissionSnapshotId?: string | null;
}
type Page<T> = { data: T[]; nextToken?: string | null; errors?: readonly unknown[] };
/** Carrier statements can put a product code after the core number instead of before it.
 * These are search suggestions only: selecting a policy still requires human review. */
export function policySearchTerms(value: string): string[] {
  const query = value.trim();
  const tokens = query.match(/[a-z0-9]+/gi) ?? [];
  const cores = tokens.filter(token => token.length >= 5 && /[0-9]/.test(token));
  const core = cores.length === 1 ? cores[0] : undefined;
  return [...new Set([query, query.toUpperCase(), ...(core ? [core, core.toUpperCase()] : [])])];
}
/** A filtered storage page can be empty even when later pages contain matches. */
export async function searchPolicyPages<T extends CommissionPolicySearchRow>(
  fetchPage: (nextToken?: string) => Promise<Page<T>>,
  cursor?: string,
): Promise<{ data: T[]; nextToken?: string }> {
  let nextToken = cursor;
  const seen = new Set<string>();
  // Bound each search; a continuation is explicit if a very large list remains.
  for (let page = 0; page < 10; page++) {
    if (nextToken) {
      if (seen.has(nextToken)) throw new Error('Policy search repeated a page. Try searching again.');
      seen.add(nextToken);
    }
    const result = await fetchPage(nextToken);
    assertApiErrors(result, 'Could not search CRM policies. Try again.');
    nextToken = result.nextToken ?? undefined;
    if (nextToken && seen.has(nextToken)) throw new Error('Policy search repeated a page. Try searching again.');
    if (result.data.length || !nextToken) return { data: result.data, nextToken };
  }
  return { data: [], nextToken };
}
