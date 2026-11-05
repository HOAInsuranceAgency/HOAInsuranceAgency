import { decodeApiRecord, isRecord, type ApiRecord } from '../../../shared/apiResponse';
import { assertWebsiteActionsEnabled } from './migrationPreview';

interface PublicApiOptions {
  url?: string; key?: string; configurationError: string;
  httpError?: string | ((status: number) => string);
  graphQLError?: string; invalid?: string; refused?: string; requireOk?: boolean;
  request?: Pick<RequestInit, 'signal' | 'keepalive' | 'credentials' | 'referrerPolicy'>;
}

/** Public API-key transport: never attach private GraphQL error details to UI errors. */
export async function publicApi(query: string, variables: Record<string, unknown>, field: string, options: PublicApiOptions): Promise<ApiRecord> {
  const { url, key } = options;
  if (!url || !key) throw new Error(options.configurationError);
  assertWebsiteActionsEnabled();
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query, variables }), ...options.request,
  });
  if (!response.ok) throw new Error(typeof options.httpError === 'function' ? options.httpError(response.status) : options.httpError ?? `We couldn't reach the server (${response.status}).`);
  const invalid = options.invalid ?? 'The server sent back something unreadable.';
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(invalid); }
  if (!isRecord(body)) throw new Error(invalid);
  if (body.errors != null && !Array.isArray(body.errors)) throw new Error(invalid);
  if (Array.isArray(body.errors) && body.errors.length) throw new Error(options.graphQLError ?? 'The server refused that request. Please retry.');
  return decodeApiRecord({ data: isRecord(body.data) ? body.data[field] : undefined }, {
    requireOk: options.requireOk, fallback: options.refused ?? 'This request is no longer available.', invalid,
  });
}
