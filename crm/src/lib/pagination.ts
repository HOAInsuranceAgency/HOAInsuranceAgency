import { isAuthorizationError } from './authorizationError';

/**
 * Page through a filtered list until it's exhausted.
 *
 * DynamoDB applies `filter` AFTER reading a page of rows, so a single
 * `list({ filter })` silently returns nothing once the matching rows sit
 * outside the first page — a bug that only appears as a table grows. Any
 * filtered list that must be complete goes through here.
 *
 * Generic over the page shape rather than deriving the model type — naming
 * the client's return type directly (ReturnType<typeof ...list>) makes tsc
 * bail with "type instantiation is excessively deep".
 *
 * Lives here rather than in client.ts so the Lambdas can import it: client.ts
 * calls generateClient() at module scope, and a handler must not pull the
 * browser data client into its bundle. Its error helper has no SDK dependencies.
 */
export async function listAllPages<T>(
  fetchPage: (
    nextToken?: string
  ) => Promise<{ data: T[]; nextToken?: string | null; errors?: readonly unknown[] }>,
  options?: {
    /** Stop after this many pages instead of reading to the end. */
    maxPages?: number;
  }
): Promise<T[]> {
  const out: T[] = [];
  const maxPages = options?.maxPages ?? Infinity;
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(token);
    // Amplify resolves GraphQL failures instead of rejecting. Never turn a
    // failed page into a successful empty/partial list or report.
    if (page.errors?.length) {
      const denied = page.errors.find(isAuthorizationError);
      const cause = denied ?? page.errors[0];
      const message = cause && typeof cause === 'object' && 'message' in cause
        ? String(cause.message) : typeof cause === 'string' ? cause : 'Could not load all records. Please try again.';
      throw Object.assign(new Error(message), denied ? { name: 'Unauthorized' } : {});
    }
    out.push(...page.data);
    token = page.nextToken ?? undefined;
    pages++;
  } while (token && pages < maxPages);
  return out;
}
