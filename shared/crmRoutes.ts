/** Internal CRM navigation only. Callers retain authorization, origin checks,
 * routing history, and public/provider/payment URL ownership. IDs are raw model
 * values; encode each path segment once rather than accepting pre-encoded IDs. */
export const ACCOUNT_TABS = [
  'overview', 'property', 'priorcarrier', 'losses', 'submissions', 'quotes',
  'policies', 'invoices', 'financing', 'documents', 'certificates', 'activity',
] as const;
export type AccountTab = typeof ACCOUNT_TABS[number];
export type AccountAnchor = 'contacts' | 'lead-workspace' | 'carrier-work';
export interface AccountQuery {
  tab?: AccountTab;
  management?: true;
  partyId?: string;
  estimate?: string;
}
export interface AccountLinkOptions extends AccountQuery { hash?: AccountAnchor }

function requiredId(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A record ID is required for this CRM link.');
  return value;
}
function segment(value: string): string {
  requiredId(value);
  // Browsers normalize both literal and percent-encoded dot-only segments.
  if (value === '.' || value === '..') throw new Error('Choose a record ID rather than a path segment.');
  return encodeURIComponent(value);
}
function validTab(tab: AccountTab) {
  if (!ACCOUNT_TABS.includes(tab)) throw new Error('Choose a valid account tab.');
}

/** New links preserve the existing encodeURIComponent query spelling. */
export function accountSearch(options: AccountQuery): string {
  const pairs: string[] = [];
  if (options.tab !== undefined) { validTab(options.tab); pairs.push(`tab=${options.tab}`); }
  if (options.management) pairs.push('management=1');
  if (options.partyId !== undefined) pairs.push(`partyId=${encodeURIComponent(requiredId(options.partyId))}`);
  if (options.estimate !== undefined) pairs.push(`estimate=${encodeURIComponent(requiredId(options.estimate))}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}
export function accountPath(accountId: string, options: AccountLinkOptions = {}): string {
  if (options.hash !== undefined && !['contacts', 'lead-workspace', 'carrier-work'].includes(options.hash)) throw new Error('Choose a valid account anchor.');
  return `/accounts/${segment(accountId)}${accountSearch(options)}${options.hash ? `#${options.hash}` : ''}`;
}
export const accountManagementPath = (accountId: string, partyId?: string) => accountPath(accountId, { management: true, partyId });
export const carrierPath = (carrierId: string) => `/carriers/${segment(carrierId)}`;
export const relationshipPath = (partyId: string) => `/relationships/${segment(partyId)}`;
function searchPath(path: string, query: string): string {
  if (typeof query !== 'string') throw new Error('A search query is required for this CRM link.');
  return `${path}?q=${encodeURIComponent(query)}`;
}
export const crmSearchPath = (query: string) => searchPath('/search', query);
export const relationshipsPath = (query?: string) => query === undefined ? '/relationships' : searchPath('/relationships', query);
export const newLeadPath = (relatedParty?: string) => relatedParty === undefined ? '/leads/new' : `/leads/new?relatedParty=${encodeURIComponent(requiredId(relatedParty))}`;

/** Tab clicks preserve every unrelated query pair and deliberately clear the
 * old scroll anchor. The caller retains navigate(..., { replace: true }). */
export function accountTabLocation(search: string | URLSearchParams, tab: AccountTab): { search: string; hash: '' } {
  validTab(tab);
  const next = new URLSearchParams(search);
  next.set('tab', tab);
  return { search: `?${next.toString()}`, hash: '' };
}

/** Add a tab to an already-authorized account href supplied by the CRM.
 * Preserve its absolute origin/path prefix and fragment; do not normalize or
 * authorize hosts here. This is not for signed or payment URLs. */
export function withAccountTab(href: string, tab: AccountTab): string {
  if (typeof href !== 'string' || !href.trim()) throw new Error('An account link is required.');
  const hashAt = href.indexOf('#');
  const fragment = hashAt < 0 ? '' : href.slice(hashAt);
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const search = queryAt < 0 ? '' : beforeHash.slice(queryAt);
  return `${path}${accountTabLocation(search, tab).search}${fragment}`;
}
